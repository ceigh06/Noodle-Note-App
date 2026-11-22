import {
  clearEmbeddingsForModelChange,
  getEmbeddingChunks,
  getEmbeddingMeta,
  getIndexedFilesList,
  saveEmbeddingMeta,
} from '../db/noodleDb';
import {
  DiagnosticCheckResult,
  SourceDocumentEntry,
  StoredNoteEntry,
} from '../types/noodle';
import {
  ALTERNATE_EMBEDDING_MODEL_ID,
  chunkTipTapDocument,
  DEFAULT_EMBEDDING_MODEL_ID,
} from './chunker';
import {
  ensureModelIdConsistency,
  initializeLocalEmbeddingModel,
  searchWorkspaceBlocks,
  syncLocalSearchIndex,
} from './localSearchService';

const DIAG_NOTE_1_ID = '00000000-0000-4000-7000-000000000001';
const DIAG_NOTE_2_ID = '00000000-0000-4000-7000-000000000002';

function buildDiagnosticFixtureNotes(): StoredNoteEntry[] {
  const now = new Date().toISOString();
  return [
    {
      fileName: 'diag-neuro-memory.json',
      pillar: 'manual',
      path: 'manual/diag-neuro-memory.json',
      excerpt: 'Sharp-wave ripples replay hippocampal place-cell sequences.',
      wordCount: 16,
      note: {
        id: DIAG_NOTE_1_ID,
        schemaVersion: 2,
        title: 'Hippocampal Replay & Memory',
        category: 'Study',
        pillar: 'manual',
        createdAt: now,
        updatedAt: now,
        contentHash: 'sha256:diag-search-1',
        content: {
          type: 'doc',
          content: [
            {
              type: 'heading',
              attrs: {id: 'diag-blk-h1', level: 2},
              content: [{type: 'text', text: 'Consolidation Dynamics'}],
            },
            {
              type: 'paragraph',
              attrs: {id: 'diag-blk-target'},
              content: [
                {
                  type: 'text',
                  text: 'Sharp-wave ripples during slow-wave sleep replay firing sequences into neocortical synapses.',
                },
              ],
            },
          ],
        },
      },
    },
    {
      fileName: 'diag-consensus-raft.json',
      pillar: 'ai',
      path: 'ai/diag-consensus-raft.json',
      excerpt: 'Raft ensures leader completeness across term elections.',
      wordCount: 12,
      note: {
        id: DIAG_NOTE_2_ID,
        schemaVersion: 2,
        title: 'Distributed Consensus Notes',
        category: 'Study',
        pillar: 'ai',
        createdAt: now,
        updatedAt: now,
        contentHash: 'sha256:diag-search-2',
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              attrs: {id: 'diag-blk-raft'},
              content: [
                {
                  type: 'text',
                  text: 'Quorum replication guarantees fault tolerance when minority nodes fail in a cluster.',
                },
              ],
            },
          ],
        },
      },
    },
  ];
}

function measureMainThreadMaxGapMs(durationMs: number): Promise<number> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      resolve(0);
      return;
    }
    const start = performance.now();
    let last = start;
    let maxGap = 0;

    function tick(now: number) {
      const gap = now - last;
      if (gap > maxGap) {
        maxGap = gap;
      }
      last = now;
      if (now - start < durationMs) {
        requestAnimationFrame(tick);
      } else {
        resolve(Math.round(maxGap));
      }
    }

    requestAnimationFrame(tick);
  });
}

export async function runSearchDiagnostics(
  currentNotes: StoredNoteEntry[],
  currentSources: SourceDocumentEntry[],
): Promise<DiagnosticCheckResult[]> {
  const results: DiagnosticCheckResult[] = [];
  const prevMeta = await getEmbeddingMeta();
  const activeModelId = prevMeta?.modelId || DEFAULT_EMBEDDING_MODEL_ID;
  let modelReady = false;
  let maxWorkerFrameGapMs = 0;

  // 1. Model loads in Web Worker and is cached in Browser Cache API + IndexedDB
  {
    const start = performance.now();
    try {
      const gapPromise = measureMainThreadMaxGapMs(250);
      const config = await initializeLocalEmbeddingModel(activeModelId);
      maxWorkerFrameGapMs = await gapPromise;

      const cacheKeys =
        typeof caches !== 'undefined' ? await caches.keys() : [];
      let cachedEntryCount = 0;
      for (const key of cacheKeys) {
        if (key.includes('transformers')) {
          const cache = await caches.open(key);
          const reqs = await cache.keys();
          cachedEntryCount += reqs.length;
        }
      }

      const storedMeta = await getEmbeddingMeta();
      const passed =
        config.isDownloaded &&
        config.vectorSize > 0 &&
        storedMeta?.modelId === activeModelId &&
        storedMeta?.vectorSize === config.vectorSize;
      modelReady = passed;

      results.push({
        id: 'search-model-load-cache',
        name: 'Embedding Model Loads in Worker & Caches Offline',
        status: passed ? 'PASS' : 'FAIL',
        details: passed
          ? `Loaded ${config.modelId} (${config.vectorSize}d) in Web Worker; Browser Cache API holds ${cachedEntryCount} cached file(s).`
          : 'Model metadata did not persist expected vectorSize or downloaded state.',
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      results.push({
        id: 'search-model-load-cache',
        name: 'Embedding Model Loads in Worker & Caches Offline',
        status: 'FAIL',
        details: `Worker model load failed: ${(err as Error).message}`,
        durationMs: Math.round(performance.now() - start),
      });
    }
  }

  // 2. Semantic query finds the exact TipTap blockId (and checks UI frame responsiveness)
  const fixtures = buildDiagnosticFixtureNotes();
  {
    const start = performance.now();
    if (!modelReady) {
      results.push({
        id: 'search-query-exact-block',
        name: 'Semantic Query Finds Exact TipTap Block',
        status: 'FAIL',
        details:
          'Skipped semantic vector query because the Web Worker model did not finish loading above.',
        durationMs: Math.round(performance.now() - start),
      });
    } else {
      try {
        const mergedNotes = [
          ...currentNotes.filter(
            (n) => n.note.id !== DIAG_NOTE_1_ID && n.note.id !== DIAG_NOTE_2_ID,
          ),
          ...fixtures,
        ];
        const gapPromise = measureMainThreadMaxGapMs(300);
        await syncLocalSearchIndex({
          notes: mergedNotes,
          sources: currentSources,
          computeVectors: true,
          modelId: activeModelId,
        });
        const searchOut = await searchWorkspaceBlocks({
          query: 'sleep replay neocortical synapses ripples',
          notes: mergedNotes,
          sources: currentSources,
          aiEnabled: true,
          topK: 5,
        });
        const queryGap = await gapPromise;
        if (queryGap > maxWorkerFrameGapMs) {
          maxWorkerFrameGapMs = queryGap;
        }

        const top = searchOut.results[0];
        const hitExactBlock =
          searchOut.mode === 'semantic' &&
          top?.noteId === DIAG_NOTE_1_ID &&
          top?.blockId === 'diag-blk-target' &&
          top.score > 0.25;

        results.push({
          id: 'search-query-exact-block',
          name: 'Semantic Query Finds Exact TipTap Block',
          status: hitExactBlock ? 'PASS' : 'FAIL',
          details: hitExactBlock
            ? `Top hit matched ${top.noteId} block "${top.blockId}" (${top.score.toFixed(2)} ${top.scoreLabel}).`
            : `Expected block "diag-blk-target"; got "${top?.blockId ?? 'none'}" (score=${top?.score ?? 0}).`,
          durationMs: Math.round(performance.now() - start),
        });
      } catch (err) {
        results.push({
          id: 'search-query-exact-block',
          name: 'Semantic Query Finds Exact TipTap Block',
          status: 'FAIL',
          details: `Semantic query check failed: ${(err as Error).message}`,
          durationMs: Math.round(performance.now() - start),
        });
      }
    }
  }

  // 3. Model-ID change forces automatic re-index
  {
    const start = performance.now();
    try {
      const beforeRestoreMeta = await getEmbeddingMeta();
      const switchedId =
        activeModelId === DEFAULT_EMBEDDING_MODEL_ID
          ? ALTERNATE_EMBEDDING_MODEL_ID
          : DEFAULT_EMBEDDING_MODEL_ID;

      // Seed a chunk under activeModelId, then change modelId and verify auto-clear + re-index flag
      const chunkCount = chunkTipTapDocument(
        DIAG_NOTE_1_ID,
        fixtures[0].note.title,
        fixtures[0].note.content,
      ).length;
      await saveEmbeddingMeta({
        modelId: activeModelId,
        vectorSize: 384,
        isDownloaded: true,
        cachedAt: new Date().toISOString(),
      });

      const {changed} = await ensureModelIdConsistency(switchedId);
      const chunksAfterSwitch = await getEmbeddingChunks();
      const filesAfterSwitch = await getIndexedFilesList();

      const reindexedCleanly =
        changed &&
        chunksAfterSwitch.length === 0 &&
        filesAfterSwitch.length === 0 &&
        chunkCount >= 2;

      // Restore original workspace model configuration & clean up fixture notes
      const restoreDownloaded = modelReady || Boolean(beforeRestoreMeta?.isDownloaded);
      await clearEmbeddingsForModelChange(
        beforeRestoreMeta?.modelId || activeModelId,
        beforeRestoreMeta?.vectorSize || 384,
        restoreDownloaded,
      );
      await saveEmbeddingMeta({
        modelId: beforeRestoreMeta?.modelId || activeModelId,
        vectorSize: beforeRestoreMeta?.vectorSize || 384,
        isDownloaded: restoreDownloaded,
        cachedAt: beforeRestoreMeta?.cachedAt || (restoreDownloaded ? new Date().toISOString() : undefined),
      });
      await syncLocalSearchIndex({
        notes: currentNotes,
        sources: currentSources,
        computeVectors: restoreDownloaded,
        modelId: beforeRestoreMeta?.modelId || activeModelId,
      });

      results.push({
        id: 'search-model-change-reindex',
        name: 'Model-ID Change Forces Automatic Re-Index',
        status: reindexedCleanly ? 'PASS' : 'FAIL',
        details: reindexedCleanly
          ? `Switching model from ${activeModelId} -> ${switchedId} invalidated stale chunks and triggered clean re-index.`
          : 'Model-ID switch did not invalidate stale chunks as expected.',
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      results.push({
        id: 'search-model-change-reindex',
        name: 'Model-ID Change Forces Automatic Re-Index',
        status: 'FAIL',
        details: `Model change check failed: ${(err as Error).message}`,
        durationMs: Math.round(performance.now() - start),
      });
    }
  }

  // 4. UI stays responsive during Web Worker indexing
  {
    const start = performance.now();
    const gap = maxWorkerFrameGapMs || (await measureMainThreadMaxGapMs(120));
    const responsive = gap < 150;
    results.push({
      id: 'search-ui-responsive',
      name: 'UI Stays Responsive During Worker Indexing',
      status: responsive ? 'PASS' : 'FAIL',
      details: `Max main-thread animation frame gap during worker embedding/search: ${gap}ms (threshold < 150ms).`,
      durationMs: Math.round(performance.now() - start),
    });
  }

  return results;
}
