import {
  addExplicitBacklink,
  applyChunkIndexChanges,
  clearEmbeddingsForModelChange,
  dismissConnectionSuggestion,
  getBacklinksForDocument,
  getDismissedTargetIds,
  getEmbeddingChunks,
  getEmbeddingMeta,
  getIndexedFilesList,
  IndexedFileRow,
  removeExplicitBacklink,
  saveEmbeddingMeta,
  updateIndexedDocsLocationMetadata,
} from '../db/noodleDb';
import {
  BacklinkRecord,
  EmbeddingModelConfig,
  EmbeddingProgressState,
  Pillar,
  SearchResultItem,
  SourceDocumentEntry,
  StoredNoteEntry,
  SuggestedConnection,
} from '../types/noodle';
import {
  chunkNoteEntry,
  chunkSourceEntry,
  DEFAULT_EMBEDDING_MODEL_ID,
  DocumentChunkSpec,
  scoreWordMatch,
} from './chunker';
import type {
  EmbeddingWorkerRequest,
  SearchableVectorChunk,
} from './embeddingWorker';

interface WorkerMessage {
  type: string;
  jobId: string;
  modelId?: string;
  vectorSize?: number;
  progress?: number;
  loadedBytes?: number;
  totalBytes?: number;
  currentFile?: string;
  status?: 'downloading' | 'loading';
  done?: number;
  total?: number;
  embeddings?: Array<{id: string; vector: number[]}>;
  results?: SearchResultItem[];
  suggestions?: SuggestedConnection[];
  error?: string;
}

type ProgressListener = (state: EmbeddingProgressState) => void;

const progressListeners = new Set<ProgressListener>();

let workerInstance: Worker | null = null;
let loadedWorkerModelId: string | null = null;
let jobCounter = 0;
let activeGeneration = 0;

let currentProgressState: EmbeddingProgressState = {
  status: 'idle',
  modelId: DEFAULT_EMBEDDING_MODEL_ID,
  vectorSize: 384,
  progress: 0,
  loadedBytes: 0,
  totalBytes: 0,
};

const pendingJobs = new Map<
  string,
  {
    generation: number;
    resolve: (msg: WorkerMessage) => void;
    reject: (err: Error) => void;
    onBatchProgress?: (done: number, total: number) => void;
  }
>();

function emitProgress(patch: Partial<EmbeddingProgressState>): void {
  currentProgressState = {
    ...currentProgressState,
    ...patch,
  };
  for (const listener of progressListeners) {
    listener(currentProgressState);
  }
}

export function subscribeEmbeddingProgress(
  listener: ProgressListener,
): () => void {
  progressListeners.add(listener);
  listener(currentProgressState);
  return () => {
    progressListeners.delete(listener);
  };
}

export function getEmbeddingProgressSnapshot(): EmbeddingProgressState {
  return currentProgressState;
}

function terminateWorker(): void {
  if (workerInstance) {
    workerInstance.terminate();
    workerInstance = null;
  }
  loadedWorkerModelId = null;
}

function getOrCreateWorker(): Worker {
  if (!workerInstance) {
    workerInstance = new Worker(
      new URL('./embeddingWorker.ts', import.meta.url),
      {type: 'module'},
    );
    workerInstance.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const msg = event.data;
      if (msg.type === 'model-progress') {
        const pending = pendingJobs.get(msg.jobId);
        if (!pending || pending.generation !== activeGeneration) {
          return;
        }
        emitProgress({
          status: msg.status === 'loading' ? 'loading' : 'downloading',
          modelId: msg.modelId ?? currentProgressState.modelId,
          progress: Math.round(msg.progress ?? 0),
          loadedBytes: msg.loadedBytes ?? 0,
          totalBytes: msg.totalBytes ?? 0,
          currentFile: msg.currentFile,
        });
        return;
      }

      if (msg.type === 'embed-progress') {
        const pending = pendingJobs.get(msg.jobId);
        if (pending && pending.generation === activeGeneration) {
          pending.onBatchProgress?.(msg.done ?? 0, msg.total ?? 0);
        }
        return;
      }

      const pending = pendingJobs.get(msg.jobId);
      if (!pending) {
        return;
      }
      pendingJobs.delete(msg.jobId);
      if (pending.generation !== activeGeneration) {
        pending.reject(new Error('Operation cancelled by user.'));
        return;
      }
      if (msg.type === 'error') {
        pending.reject(new Error(msg.error || 'Local embedding worker failed.'));
      } else {
        pending.resolve(msg);
      }
    };
    workerInstance.onerror = (event) => {
      const err = new Error(event.message || 'Embedding worker error.');
      for (const [, pending] of pendingJobs.entries()) {
        pending.reject(err);
      }
      pendingJobs.clear();
      terminateWorker();
    };
  }
  return workerInstance;
}

function runWorkerRequest(
  payload: EmbeddingWorkerRequest,
  onBatchProgress?: (done: number, total: number) => void,
): Promise<WorkerMessage> {
  if (typeof Worker === 'undefined') {
    return Promise.reject(
      new Error('Web Workers are unavailable in this environment.'),
    );
  }
  const generation = activeGeneration;
  const worker = getOrCreateWorker();
  return new Promise<WorkerMessage>((resolve, reject) => {
    pendingJobs.set(payload.jobId, {
      generation,
      resolve,
      reject,
      onBatchProgress,
    });
    worker.postMessage(payload);
  });
}

function nextJobId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++jobCounter}`;
}

export function cancelEmbeddingDownloadOrIndexing(): void {
  activeGeneration += 1;
  for (const [, pending] of pendingJobs.entries()) {
    pending.reject(new Error('Cancelled by user.'));
  }
  pendingJobs.clear();
  terminateWorker();
  emitProgress({
    status: 'cancelled',
    progress: 0,
    loadedBytes: 0,
    totalBytes: 0,
    currentFile: undefined,
    message: 'Cancelled by user. Falling back to word-match search.',
  });
}

export async function getStoredEmbeddingConfig(): Promise<EmbeddingModelConfig> {
  const row = await getEmbeddingMeta();
  if (row) {
    return {
      modelId: row.modelId,
      vectorSize: row.vectorSize || 384,
      isDownloaded: row.isDownloaded,
      cachedAt: row.cachedAt,
    };
  }
  return {
    modelId: DEFAULT_EMBEDDING_MODEL_ID,
    vectorSize: 384,
    isDownloaded: false,
  };
}

/**
 * Ensures stored IndexedDB embeddings match `targetModelId`.
 * Hard Rule 5: changing modelId wipes stale embeddings and returns `reindexed = true`.
 */
export async function ensureModelIdConsistency(
  targetModelId: string,
): Promise<{changed: boolean; config: EmbeddingModelConfig}> {
  const existing = await getEmbeddingMeta();
  if (!existing) {
    const initial: EmbeddingModelConfig = {
      modelId: targetModelId,
      vectorSize: 384,
      isDownloaded: false,
    };
    await saveEmbeddingMeta(initial);
    emitProgress({modelId: targetModelId, status: 'idle'});
    return {changed: false, config: initial};
  }

  if (existing.modelId !== targetModelId) {
    await clearEmbeddingsForModelChange(targetModelId, 0, false);
    loadedWorkerModelId = null;
    emitProgress({
      status: 'idle',
      modelId: targetModelId,
      vectorSize: 0,
      progress: 0,
      loadedBytes: 0,
      totalBytes: 0,
      message: `Switched model to ${targetModelId}. Re-indexing required.`,
    });
    return {
      changed: true,
      config: {
        modelId: targetModelId,
        vectorSize: 0,
        isDownloaded: false,
      },
    };
  }

  emitProgress({
    modelId: existing.modelId,
    vectorSize: existing.vectorSize || 384,
    status: existing.isDownloaded
      ? loadedWorkerModelId === existing.modelId
        ? 'ready'
        : currentProgressState.status === 'cancelled'
          ? 'cancelled'
          : 'idle'
      : currentProgressState.status === 'cancelled'
        ? 'cancelled'
        : 'idle',
  });

  return {
    changed: false,
    config: {
      modelId: existing.modelId,
      vectorSize: existing.vectorSize || 384,
      isDownloaded: existing.isDownloaded,
      cachedAt: existing.cachedAt,
    },
  };
}

/**
 * Downloads (if not yet cached) and initializes the embedding model in the Web Worker.
 * Browser Cache API caches weights for offline reuse on later sessions.
 */
export async function initializeLocalEmbeddingModel(
  modelId?: string,
): Promise<EmbeddingModelConfig> {
  const stored = await getStoredEmbeddingConfig();
  const targetModelId = modelId ?? stored.modelId ?? DEFAULT_EMBEDDING_MODEL_ID;
  await ensureModelIdConsistency(targetModelId);

  emitProgress({
    status: stored.isDownloaded ? 'loading' : 'downloading',
    modelId: targetModelId,
    progress: 0,
    loadedBytes: 0,
    totalBytes: 0,
    message: stored.isDownloaded
      ? 'Loading cached model from browser storage...'
      : `Downloading ${targetModelId} for offline local search...`,
  });

  try {
    const res = await runWorkerRequest({
      type: 'init-model',
      jobId: nextJobId('init'),
      modelId: targetModelId,
    });
    const vectorSize = res.vectorSize ?? 384;
    loadedWorkerModelId = targetModelId;

    const config: EmbeddingModelConfig = {
      modelId: targetModelId,
      vectorSize,
      isDownloaded: true,
      cachedAt: new Date().toISOString(),
    };
    await saveEmbeddingMeta(config);

    emitProgress({
      status: 'ready',
      modelId: targetModelId,
      vectorSize,
      progress: 100,
      message: `Ready offline (${targetModelId}, ${vectorSize}d).`,
    });
    return config;
  } catch (err) {
    const msg = (err as Error).message || 'Failed to load embedding model.';
    if (!/cancel/i.test(msg)) {
      emitProgress({
        status: 'error',
        modelId: targetModelId,
        message: msg,
      });
    }
    throw err;
  }
}

interface IndexableDoc {
  docId: string;
  kind: 'note' | 'source';
  pillar: Pillar;
  title: string;
  path: string;
  contentHash: string;
  updatedAt: string;
  chunks: DocumentChunkSpec[];
}

function buildIndexableDocs(
  notes: StoredNoteEntry[],
  sources: SourceDocumentEntry[],
): IndexableDoc[] {
  const docs: IndexableDoc[] = [];

  for (const entry of notes) {
    const path = entry.path ?? `${entry.pillar}/${entry.fileName}`;
    docs.push({
      docId: entry.note.id,
      kind: 'note',
      pillar: entry.pillar,
      title: entry.note.title,
      path,
      contentHash: entry.note.contentHash,
      updatedAt: entry.note.updatedAt,
      chunks: chunkNoteEntry(entry),
    });
  }

  for (const src of sources) {
    if (src.kind === 'unsupported-pptx' || src.chunks.length === 0) {
      continue;
    }
    docs.push({
      docId: src.id,
      kind: 'source',
      pillar: 'sources',
      title: src.title,
      path: src.path,
      contentHash: src.contentHash,
      updatedAt: src.updatedAt,
      chunks: chunkSourceEntry(src),
    });
  }

  return docs;
}

/**
 * Re-indexes only changed, added, or model-mismatched files.
 * - Moves with unchanged contentHash only update location metadata in Dexie.
 * - When `computeVectors` is false (model not downloaded yet), stores lexical chunks
 *   with empty vectors so word-match search covers PDF/.txt/.md + notes immediately.
 */
export async function syncLocalSearchIndex(params: {
  notes: StoredNoteEntry[];
  sources: SourceDocumentEntry[];
  computeVectors: boolean;
  modelId?: string;
}): Promise<{
  reindexedDocs: number;
  movedDocs: number;
  deletedDocs: number;
  skippedUnchangedDocs: number;
}> {
  const stored = await getStoredEmbeddingConfig();
  const targetModelId = params.modelId ?? stored.modelId ?? DEFAULT_EMBEDDING_MODEL_ID;
  await ensureModelIdConsistency(targetModelId);

  const docs = buildIndexableDocs(params.notes, params.sources);
  const docsById = new Map<string, IndexableDoc>(docs.map((d) => [d.docId, d]));

  const existingFiles = await getIndexedFilesList();
  const existingById = new Map<string, IndexedFileRow>(
    existingFiles.map((row) => [row.docId, row]),
  );

  const deleteDocIds = existingFiles
    .filter((row) => !docsById.has(row.docId))
    .map((row) => row.docId);

  const movedMetadataUpdates: Array<{
    docId: string;
    path: string;
    pillar: Pillar;
    title: string;
  }> = [];
  const docsToIndex: IndexableDoc[] = [];
  let skippedUnchangedDocs = 0;

  for (const doc of docs) {
    const prev = existingById.get(doc.docId);
    const desiredModelTag = params.computeVectors ? targetModelId : '';
    const hasFreshContent =
      prev &&
      prev.contentHash === doc.contentHash &&
      (params.computeVectors
        ? prev.modelId === targetModelId
        : prev.modelId === targetModelId || prev.modelId === '');

    if (hasFreshContent) {
      if (
        prev.path !== doc.path ||
        prev.pillar !== doc.pillar ||
        prev.title !== doc.title
      ) {
        movedMetadataUpdates.push({
          docId: doc.docId,
          path: doc.path,
          pillar: doc.pillar,
          title: doc.title,
        });
      } else {
        skippedUnchangedDocs += 1;
      }
      continue;
    }

    // Re-index if content changed, new file, or modelId changed (including upgrading empty-vector lexical chunks once model downloads)
    if (desiredModelTag !== prev?.modelId || prev?.contentHash !== doc.contentHash) {
      docsToIndex.push(doc);
    }
  }

  await updateIndexedDocsLocationMetadata(movedMetadataUpdates);

  if (docsToIndex.length === 0) {
    if (deleteDocIds.length > 0) {
      await applyChunkIndexChanges({deleteDocIds, upserts: []});
    }
    return {
      reindexedDocs: 0,
      movedDocs: movedMetadataUpdates.length,
      deletedDocs: deleteDocIds.length,
      skippedUnchangedDocs,
    };
  }

  if (!params.computeVectors) {
    const upserts = docsToIndex.map((doc) => ({
      file: {
        docId: doc.docId,
        kind: doc.kind,
        path: doc.path,
        title: doc.title,
        pillar: doc.pillar,
        contentHash: doc.contentHash,
        modelId: '',
        chunkCount: doc.chunks.length,
        updatedAt: doc.updatedAt,
      },
      chunks: doc.chunks.map((chunk) => ({
        id: chunk.id,
        noteId: doc.docId,
        blockId: chunk.blockId,
        kind: doc.kind,
        pillar: doc.pillar,
        title: doc.title,
        path: doc.path,
        headingPath: chunk.headingPath,
        text: chunk.text,
        contentHash: doc.contentHash,
        modelId: '',
        vectorSize: 0,
        vector: [],
      })),
    }));

    await applyChunkIndexChanges({deleteDocIds, upserts});
    return {
      reindexedDocs: docsToIndex.length,
      movedDocs: movedMetadataUpdates.length,
      deletedDocs: deleteDocIds.length,
      skippedUnchangedDocs,
    };
  }

  // Ensure model is loaded in worker
  const modelConfig = await initializeLocalEmbeddingModel(targetModelId);

  const itemsToEmbed = docsToIndex.flatMap((doc) =>
    doc.chunks.map((chunk) => ({
      id: chunk.id,
      text: chunk.embedText,
    })),
  );

  emitProgress({
    status: 'indexing',
    modelId: targetModelId,
    vectorSize: modelConfig.vectorSize,
    progress: 0,
    indexedCount: 0,
    totalToIndex: itemsToEmbed.length,
    message: `Embedding ${itemsToEmbed.length} blocks across ${docsToIndex.length} changed file(s)...`,
  });

  const vectorByChunkId = new Map<string, number[]>();
  if (itemsToEmbed.length > 0) {
    const res = await runWorkerRequest(
      {
        type: 'embed-batch',
        jobId: nextJobId('embed'),
        modelId: targetModelId,
        items: itemsToEmbed,
      },
      (done, total) => {
        emitProgress({
          status: 'indexing',
          modelId: targetModelId,
          progress: total > 0 ? Math.round((done / total) * 100) : 100,
          indexedCount: done,
          totalToIndex: total,
          message: `Indexed ${done}/${total} blocks in Web Worker...`,
        });
      },
    );
    for (const pair of res.embeddings ?? []) {
      vectorByChunkId.set(pair.id, pair.vector);
    }
  }

  const upserts = docsToIndex.map((doc) => ({
    file: {
      docId: doc.docId,
      kind: doc.kind,
      path: doc.path,
      title: doc.title,
      pillar: doc.pillar,
      contentHash: doc.contentHash,
      modelId: targetModelId,
      chunkCount: doc.chunks.length,
      updatedAt: doc.updatedAt,
    },
    chunks: doc.chunks.map((chunk) => {
      const vec = vectorByChunkId.get(chunk.id) ?? [];
      return {
        id: chunk.id,
        noteId: doc.docId,
        blockId: chunk.blockId,
        kind: doc.kind,
        pillar: doc.pillar,
        title: doc.title,
        path: doc.path,
        headingPath: chunk.headingPath,
        text: chunk.text,
        contentHash: doc.contentHash,
        modelId: targetModelId,
        vectorSize: vec.length || modelConfig.vectorSize,
        vector: vec,
      };
    }),
  }));

  await applyChunkIndexChanges({deleteDocIds, upserts});

  emitProgress({
    status: 'ready',
    modelId: targetModelId,
    vectorSize: modelConfig.vectorSize,
    progress: 100,
    indexedCount: itemsToEmbed.length,
    totalToIndex: itemsToEmbed.length,
    message: `Ready offline (${targetModelId}, ${modelConfig.vectorSize}d).`,
  });

  return {
    reindexedDocs: docsToIndex.length,
    movedDocs: movedMetadataUpdates.length,
    deletedDocs: deleteDocIds.length,
    skippedUnchangedDocs,
  };
}

/**
 * Searches across all folders (`sources/`, `manual/`, `ai/`).
 * Uses Web Worker cosine similarity when the embedding model is downloaded and `aiEnabled`,
 * or falls back cleanly to honestly-labeled word-match search.
 */
export async function searchWorkspaceBlocks(params: {
  query: string;
  notes: StoredNoteEntry[];
  sources: SourceDocumentEntry[];
  aiEnabled: boolean;
  topK?: number;
}): Promise<{
  mode: 'semantic' | 'word-match';
  results: SearchResultItem[];
}> {
  const trimmed = params.query.trim();
  const topK = params.topK ?? 12;
  if (!trimmed) {
    return {mode: 'word-match', results: []};
  }

  const config = await getStoredEmbeddingConfig();

  if (params.aiEnabled && config.isDownloaded) {
    const chunks = await getEmbeddingChunks(config.modelId);
    const vectorized = chunks.filter((c) => c.vector && c.vector.length > 0);
    if (vectorized.length > 0) {
      const workerChunks: SearchableVectorChunk[] = vectorized.map((c) => ({
        id: c.id,
        noteId: c.noteId,
        blockId: c.blockId,
        kind: c.kind,
        pillar: c.pillar,
        title: c.title,
        path: c.path,
        headingPath: c.headingPath,
        text: c.text,
        vector: c.vector,
      }));
      const res = await runWorkerRequest({
        type: 'search-semantic',
        jobId: nextJobId('search'),
        modelId: config.modelId,
        query: trimmed,
        topK,
        chunks: workerChunks,
      });
      return {
        mode: 'semantic',
        results: (res.results ?? []).filter((r) => r.score > 0.05),
      };
    }
  }

  // Fallback: honest word-match search across all notes and extracted sources
  const docs = buildIndexableDocs(params.notes, params.sources);
  const matches: SearchResultItem[] = [];
  for (const doc of docs) {
    for (const chunk of doc.chunks) {
      const score = scoreWordMatch(
        trimmed,
        chunk.text,
        doc.title,
        chunk.headingPath,
      );
      if (score > 0) {
        matches.push({
          chunkId: chunk.id,
          noteId: doc.docId,
          blockId: chunk.blockId,
          kind: doc.kind,
          pillar: doc.pillar,
          title: doc.title,
          path: doc.path,
          headingPath: chunk.headingPath,
          text: chunk.text,
          score,
          scoreLabel: 'word match',
        });
      }
    }
  }
  matches.sort((a, b) => b.score - a.score);
  return {
    mode: 'word-match',
    results: matches.slice(0, topK),
  };
}

/**
 * Computes suggested connections from OTHER folders (`pillar !== currentPillar`)
 * in the Web Worker when embeddings are available, or via word-match fallback.
 * Filters out already-linked and dismissed connections. Never auto-links.
 */
export async function findSuggestedConnections(params: {
  fromNoteId: string;
  fromPillar: Pillar;
  fromTitle: string;
  notes: StoredNoteEntry[];
  sources: SourceDocumentEntry[];
  aiEnabled: boolean;
  topK?: number;
}): Promise<{
  mode: 'semantic' | 'word-match';
  suggestions: SuggestedConnection[];
}> {
  const topK = params.topK ?? 5;
  const [backlinks, dismissedKeys, config] = await Promise.all([
    getBacklinksForDocument(params.fromNoteId),
    getDismissedTargetIds(params.fromNoteId),
    getStoredEmbeddingConfig(),
  ]);

  const linkedTargetNotes = new Set<string>();
  for (const b of backlinks) {
    linkedTargetNotes.add(
      b.sourceNoteId === params.fromNoteId ? b.targetNoteId : b.sourceNoteId,
    );
  }

  const isExcluded = (targetNoteId: string, targetBlockId: string) =>
    targetNoteId === params.fromNoteId ||
    linkedTargetNotes.has(targetNoteId) ||
    dismissedKeys.has(`${targetNoteId}::${targetBlockId}`);

  if (params.aiEnabled && config.isDownloaded) {
    const allChunks = await getEmbeddingChunks(config.modelId);
    const sourceVectors = allChunks
      .filter((c) => c.noteId === params.fromNoteId && c.vector.length > 0)
      .map((c) => c.vector);

    const candidateChunks: SearchableVectorChunk[] = allChunks
      .filter(
        (c) =>
          c.pillar !== params.fromPillar &&
          c.noteId !== params.fromNoteId &&
          c.vector.length > 0 &&
          !isExcluded(c.noteId, c.blockId),
      )
      .map((c) => ({
        id: c.id,
        noteId: c.noteId,
        blockId: c.blockId,
        kind: c.kind,
        pillar: c.pillar,
        title: c.title,
        path: c.path,
        headingPath: c.headingPath,
        text: c.text,
        vector: c.vector,
      }));

    if (sourceVectors.length > 0 && candidateChunks.length > 0) {
      const res = await runWorkerRequest({
        type: 'suggest-connections',
        jobId: nextJobId('suggest'),
        modelId: config.modelId,
        fromNoteId: params.fromNoteId,
        sourceVectors,
        candidateChunks,
        topK,
      });
      return {
        mode: 'semantic',
        suggestions: (res.suggestions ?? []).filter(
          (s) => !isExcluded(s.targetNoteId, s.targetBlockId),
        ),
      };
    }
  }

  // Lexical word-match fallback across other folders
  const docs = buildIndexableDocs(params.notes, params.sources);
  const currentDoc = docs.find((d) => d.docId === params.fromNoteId);
  const sourceQueryText = currentDoc
    ? `${currentDoc.title} ${currentDoc.chunks.map((c) => c.text).join(' ')}`
    : params.fromTitle;

  const bestByNote = new Map<string, SuggestedConnection>();
  for (const doc of docs) {
    if (doc.pillar === params.fromPillar || doc.docId === params.fromNoteId) {
      continue;
    }
    for (const chunk of doc.chunks) {
      if (isExcluded(doc.docId, chunk.blockId)) {
        continue;
      }
      const score = scoreWordMatch(
        sourceQueryText,
        chunk.text,
        doc.title,
        chunk.headingPath,
      );
      if (score <= 0.1) {
        continue;
      }
      const prev = bestByNote.get(doc.docId);
      if (!prev || score > prev.score) {
        bestByNote.set(doc.docId, {
          suggestionKey: `${params.fromNoteId}::${doc.docId}::${chunk.blockId}`,
          fromNoteId: params.fromNoteId,
          targetNoteId: doc.docId,
          targetBlockId: chunk.blockId,
          targetKind: doc.kind,
          targetPillar: doc.pillar,
          targetTitle: doc.title,
          targetPath: doc.path,
          targetExcerpt: chunk.text.slice(0, 180),
          headingPath: chunk.headingPath,
          score,
          scoreLabel: 'word match',
        });
      }
    }
  }

  return {
    mode: 'word-match',
    suggestions: Array.from(bestByNote.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, topK),
  };
}

export async function linkSuggestedConnection(params: {
  suggestion: SuggestedConnection;
  sourceBlockId: string;
  sourceTitle: string;
}): Promise<BacklinkRecord> {
  const {suggestion, sourceBlockId, sourceTitle} = params;
  const record: BacklinkRecord = {
    id: `${suggestion.fromNoteId}::${sourceBlockId}->${suggestion.targetNoteId}::${suggestion.targetBlockId}`,
    sourceNoteId: suggestion.fromNoteId,
    sourceBlockId,
    sourceTitle,
    targetNoteId: suggestion.targetNoteId,
    targetBlockId: suggestion.targetBlockId,
    targetTitle: suggestion.targetTitle,
    targetPillar: suggestion.targetPillar,
    targetKind: suggestion.targetKind,
    score: suggestion.score,
    scoreLabel: suggestion.scoreLabel,
    createdAt: new Date().toISOString(),
  };
  await addExplicitBacklink(record);
  return record;
}

export async function dismissConnection(
  suggestion: SuggestedConnection,
): Promise<void> {
  await dismissConnectionSuggestion({
    fromNoteId: suggestion.fromNoteId,
    targetNoteId: suggestion.targetNoteId,
    targetBlockId: suggestion.targetBlockId,
  });
}

export {getBacklinksForDocument, removeExplicitBacklink};
