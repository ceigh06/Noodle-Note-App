import {
  env,
  FeatureExtractionPipeline,
  pipeline,
  ProgressInfo,
} from '@huggingface/transformers';
import {Pillar, SearchResultItem} from '../types/noodle';
import {computeCosineSimilarity} from './chunker';

env.allowLocalModels = false;
env.useBrowserCache = true;

interface WorkerScope {
  postMessage: (message: unknown) => void;
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<EmbeddingWorkerRequest>) => void,
  ) => void;
}

export interface SearchableVectorChunk {
  id: string;
  noteId: string;
  blockId: string;
  kind: 'note' | 'source';
  pillar: Pillar;
  title: string;
  path: string;
  headingPath: string[];
  text: string;
  vector: number[];
}

export type EmbeddingWorkerRequest =
  | {
      type: 'init-model';
      jobId: string;
      modelId: string;
    }
  | {
      type: 'embed-batch';
      jobId: string;
      modelId: string;
      items: Array<{id: string; text: string}>;
    }
  | {
      type: 'search-semantic';
      jobId: string;
      modelId: string;
      query: string;
      topK: number;
      chunks: SearchableVectorChunk[];
    }
  | {
      type: 'suggest-connections';
      jobId: string;
      modelId: string;
      fromNoteId: string;
      sourceVectors: number[][];
      candidateChunks: SearchableVectorChunk[];
      topK: number;
    };

const ctx = globalThis as unknown as WorkerScope;

let activeModelId: string | null = null;
let activeExtractor: FeatureExtractionPipeline | null = null;
let activeLoadPromise: Promise<FeatureExtractionPipeline> | null = null;

function extractVectorsFromTensor(
  tensor: {data: ArrayLike<number>; dims: number[]},
  count: number,
): number[][] {
  const dims = tensor.dims;
  const hiddenSize = dims[dims.length - 1] || 384;
  const vectors: number[][] = [];
  for (let i = 0; i < count; i += 1) {
    const start = i * hiddenSize;
    const slice: number[] = new Array(hiddenSize);
    for (let j = 0; j < hiddenSize; j += 1) {
      slice[j] = Number(tensor.data[start + j] ?? 0);
    }
    vectors.push(slice);
  }
  return vectors;
}

async function getExtractor(
  modelId: string,
  jobId: string,
): Promise<FeatureExtractionPipeline> {
  if (activeExtractor && activeModelId === modelId) {
    return activeExtractor;
  }
  if (activeLoadPromise && activeModelId === modelId) {
    return activeLoadPromise;
  }

  activeExtractor = null;
  activeModelId = modelId;

  const fileBytes = new Map<string, {loaded: number; total: number}>();

  activeLoadPromise = (async () => {
    const extractor = await pipeline('feature-extraction', modelId, {
      progress_callback: (info: ProgressInfo) => {
        if (info.status === 'progress_total') {
          ctx.postMessage({
            type: 'model-progress',
            jobId,
            modelId,
            progress: info.progress,
            loadedBytes: info.loaded,
            totalBytes: info.total,
            status: 'downloading',
          });
          return;
        }

        if (info.status === 'initiate' || info.status === 'download') {
          ctx.postMessage({
            type: 'model-progress',
            jobId,
            modelId,
            progress: 0,
            loadedBytes: 0,
            totalBytes: 0,
            currentFile: info.file,
            status: 'downloading',
          });
          return;
        }

        if (info.status === 'progress') {
          fileBytes.set(info.file, {loaded: info.loaded, total: info.total});
          let loadedSum = 0;
          let totalSum = 0;
          for (const entry of fileBytes.values()) {
            loadedSum += entry.loaded;
            totalSum += entry.total;
          }
          const pct =
            totalSum > 0 ? Math.min(100, (loadedSum / totalSum) * 100) : info.progress;
          ctx.postMessage({
            type: 'model-progress',
            jobId,
            modelId,
            progress: pct,
            loadedBytes: loadedSum,
            totalBytes: totalSum,
            currentFile: info.file,
            status: 'downloading',
          });
          return;
        }

        if (info.status === 'done') {
          ctx.postMessage({
            type: 'model-progress',
            jobId,
            modelId,
            progress: 100,
            loadedBytes: 0,
            totalBytes: 0,
            currentFile: info.file,
            status: 'loading',
          });
        }
      },
    });
    activeExtractor = extractor;
    return extractor;
  })();

  try {
    return await activeLoadPromise;
  } finally {
    activeLoadPromise = null;
  }
}

ctx.addEventListener('message', async (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'init-model') {
      const extractor = await getExtractor(msg.modelId, msg.jobId);
      const probe = await extractor('Noodle local search warmup', {
        pooling: 'mean',
        normalize: true,
      });
      const vectorSize = probe.dims[probe.dims.length - 1] || 384;
      ctx.postMessage({
        type: 'init-model-done',
        jobId: msg.jobId,
        modelId: msg.modelId,
        vectorSize,
      });
      return;
    }

    if (msg.type === 'embed-batch') {
      const extractor = await getExtractor(msg.modelId, msg.jobId);
      const results: Array<{id: string; vector: number[]}> = [];
      const batchSize = 8;

      for (let i = 0; i < msg.items.length; i += batchSize) {
        const slice = msg.items.slice(i, i + batchSize);
        const texts = slice.map((item) => item.text);
        const output = await extractor(texts, {
          pooling: 'mean',
          normalize: true,
        });
        const vecs = extractVectorsFromTensor(output, slice.length);
        for (let k = 0; k < slice.length; k += 1) {
          results.push({id: slice[k].id, vector: vecs[k]});
        }
        ctx.postMessage({
          type: 'embed-progress',
          jobId: msg.jobId,
          done: Math.min(msg.items.length, i + slice.length),
          total: msg.items.length,
        });
      }

      ctx.postMessage({
        type: 'embed-batch-done',
        jobId: msg.jobId,
        modelId: msg.modelId,
        embeddings: results,
      });
      return;
    }

    if (msg.type === 'search-semantic') {
      const extractor = await getExtractor(msg.modelId, msg.jobId);
      const qTensor = await extractor(msg.query, {
        pooling: 'mean',
        normalize: true,
      });
      const [queryVec] = extractVectorsFromTensor(qTensor, 1);

      const scored: SearchResultItem[] = msg.chunks
        .filter((c) => c.vector && c.vector.length === queryVec.length)
        .map((chunk) => ({
          chunkId: chunk.id,
          noteId: chunk.noteId,
          blockId: chunk.blockId,
          kind: chunk.kind,
          pillar: chunk.pillar,
          title: chunk.title,
          path: chunk.path,
          headingPath: chunk.headingPath,
          text: chunk.text,
          score: Number(
            Math.max(0, computeCosineSimilarity(queryVec, chunk.vector)).toFixed(4),
          ),
          scoreLabel: 'semantic similarity' as const,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, msg.topK);

      ctx.postMessage({
        type: 'search-semantic-done',
        jobId: msg.jobId,
        results: scored,
      });
      return;
    }

    if (msg.type === 'suggest-connections') {
      const bestByTargetNote = new Map<
        string,
        {chunk: SearchableVectorChunk; score: number}
      >();

      for (const candidate of msg.candidateChunks) {
        if (candidate.noteId === msg.fromNoteId || !candidate.vector?.length) {
          continue;
        }
        let maxSim = 0;
        for (const srcVec of msg.sourceVectors) {
          if (srcVec.length !== candidate.vector.length) {
            continue;
          }
          const sim = computeCosineSimilarity(srcVec, candidate.vector);
          if (sim > maxSim) {
            maxSim = sim;
          }
        }
        if (maxSim <= 0.15) {
          continue;
        }
        const existing = bestByTargetNote.get(candidate.noteId);
        if (!existing || maxSim > existing.score) {
          bestByTargetNote.set(candidate.noteId, {chunk: candidate, score: maxSim});
        }
      }

      const suggestions = Array.from(bestByTargetNote.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, msg.topK)
        .map(({chunk, score}) => ({
          suggestionKey: `${msg.fromNoteId}::${chunk.noteId}::${chunk.blockId}`,
          fromNoteId: msg.fromNoteId,
          targetNoteId: chunk.noteId,
          targetBlockId: chunk.blockId,
          targetKind: chunk.kind,
          targetPillar: chunk.pillar,
          targetTitle: chunk.title,
          targetPath: chunk.path,
          targetExcerpt: chunk.text.slice(0, 180),
          headingPath: chunk.headingPath,
          score: Number(score.toFixed(4)),
          scoreLabel: 'semantic similarity' as const,
        }));

      ctx.postMessage({
        type: 'suggest-connections-done',
        jobId: msg.jobId,
        suggestions,
      });
    }
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      jobId: msg.jobId,
      error: (err as Error).message || 'Embedding worker failed.',
    });
  }
});
