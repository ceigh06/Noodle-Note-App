import Dexie, {Table} from 'dexie';
import {
  BacklinkRecord,
  Category,
  CloudProviderId,
  EmbeddingModelConfig,
  EncryptedKeyRecord,
  PdfAnnotationRecord,
  PdfHighlightColor,
  Pillar,
  SourceDocumentEntry,
  StoredNoteEntry,
} from '../types/noodle';
import {sortPdfAnnotations} from '../pdf/pdfAnnotations';

export interface WorkspaceHandleRow {
  key: 'current';
  handle: FileSystemDirectoryHandle;
  folderName: string;
  directManualRoot?: boolean;
  updatedAt: string;
}

export interface NoteIndexRow {
  id: string;
  path: string;
  pillar: Pillar;
  fileName: string;
  title: string;
  category: Category;
  subfolder?: string;
  updatedAt: string;
  size: number;
  lastModified: number;
  contentHash: string;
}

export interface NoteAssetRow {
  id: string; // `${noteId}::${assetPath}`
  noteId: string;
  assetPath: string;
}

export interface AssetMetaRow {
  assetPath: string;
  sha256: string;
  byteSize: number;
  updatedAt: string;
}

export interface AppSettingRow {
  key: string;
  value: boolean | string | number;
}

export interface EmbeddingChunkRow {
  id: string; // `${noteId}::${blockId}`
  noteId: string;
  blockId: string;
  kind: 'note' | 'source';
  pillar: Pillar;
  title: string;
  path: string;
  headingPath: string[];
  text: string;
  contentHash: string;
  modelId: string;
  vectorSize: number;
  vector: number[];
}

export interface IndexedFileRow {
  docId: string;
  kind: 'note' | 'source';
  path: string;
  title: string;
  pillar: Pillar;
  contentHash: string;
  modelId: string;
  chunkCount: number;
  updatedAt: string;
}

export interface EmbeddingMetaRow {
  key: 'current';
  modelId: string;
  vectorSize: number;
  isDownloaded: boolean;
  cachedAt?: string;
}

export interface DismissedSuggestionRow {
  id: string; // `${fromNoteId}::${targetNoteId}`
  fromNoteId: string;
  targetNoteId: string;
  targetBlockId: string;
  dismissedAt: string;
}

export interface BatchMoveItemRecord {
  noteId: string;
  uuid: string;
  fromPath: string;
  toPath: string;
  contentHashBefore: string;
  mtimeBefore: number;
}

export interface BatchMoveRecord {
  batchId: string;
  timestamp: string;
  items: BatchMoveItemRecord[];
  rolledBack?: boolean;
}

export interface DemoSourceFileRow {
  id: string;
  path: string;
  fileName: string;
  title: string;
  size: number;
  lastModified: number;
  contentHash: string;
  bytes: ArrayBuffer;
  updatedAt: string;
}

class NoodleDatabase extends Dexie {
  workspaceHandles!: Table<WorkspaceHandleRow, string>;
  notesIndex!: Table<NoteIndexRow, string>;
  noteAssets!: Table<NoteAssetRow, string>;
  assetsMeta!: Table<AssetMetaRow, string>;
  appSettings!: Table<AppSettingRow, string>;
  embeddingChunks!: Table<EmbeddingChunkRow, string>;
  indexedFiles!: Table<IndexedFileRow, string>;
  embeddingMeta!: Table<EmbeddingMetaRow, string>;
  sourceDocuments!: Table<SourceDocumentEntry, string>;
  backlinks!: Table<BacklinkRecord, string>;
  dismissedSuggestions!: Table<DismissedSuggestionRow, string>;
  encryptedKeys!: Table<EncryptedKeyRecord, CloudProviderId>;
  batchMoves!: Table<BatchMoveRecord, string>;
  pdfAnnotations!: Table<PdfAnnotationRecord, string>;
  demoSourceFiles!: Table<DemoSourceFileRow, string>;

  constructor() {
    super('noodle_local_db');
    this.version(1).stores({
      workspaceHandles: 'key, updatedAt',
      notesIndex: 'id, pillar, category, updatedAt, fileName',
    });
    this.version(2).stores({
      workspaceHandles: 'key, updatedAt',
      notesIndex: 'id, pillar, category, updatedAt, fileName',
      noteAssets: 'id, noteId, assetPath',
      assetsMeta: 'assetPath, sha256',
      appSettings: 'key',
    });
    this.version(3)
      .stores({
        workspaceHandles: 'key, updatedAt',
        notesIndex: 'id, path, pillar, category, updatedAt, fileName, contentHash',
        noteAssets: 'id, noteId, assetPath',
        assetsMeta: 'assetPath, sha256',
        appSettings: 'key',
      })
      .upgrade((tx) =>
        tx
          .table('notesIndex')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.path !== 'string') {
              row.path = `${String(row.pillar ?? 'manual')}/${String(row.fileName ?? '')}`;
            }
            if (typeof row.size !== 'number') {
              row.size = 0;
            }
            if (typeof row.lastModified !== 'number') {
              row.lastModified = 0;
            }
          }),
      );
    this.version(4).stores({
      workspaceHandles: 'key, updatedAt',
      notesIndex: 'id, path, pillar, category, updatedAt, fileName, contentHash',
      noteAssets: 'id, noteId, assetPath',
      assetsMeta: 'assetPath, sha256',
      appSettings: 'key',
      embeddingChunks: 'id, noteId, blockId, modelId, contentHash, pillar',
      indexedFiles: 'docId, path, contentHash, modelId',
      embeddingMeta: 'key',
      sourceDocuments: 'id, path, contentHash, kind',
      backlinks: 'id, sourceNoteId, targetNoteId, sourceBlockId, targetBlockId',
      dismissedSuggestions: 'id, fromNoteId, targetNoteId',
    });
    this.version(5).stores({
      workspaceHandles: 'key, updatedAt',
      notesIndex: 'id, path, pillar, category, updatedAt, fileName, contentHash',
      noteAssets: 'id, noteId, assetPath',
      assetsMeta: 'assetPath, sha256',
      appSettings: 'key',
      embeddingChunks: 'id, noteId, blockId, modelId, contentHash, pillar',
      indexedFiles: 'docId, path, contentHash, modelId',
      embeddingMeta: 'key',
      sourceDocuments: 'id, path, contentHash, kind',
      backlinks: 'id, sourceNoteId, targetNoteId, sourceBlockId, targetBlockId',
      dismissedSuggestions: 'id, fromNoteId, targetNoteId',
      encryptedKeys: 'provider, updatedAt',
    });
    this.version(6).stores({
      workspaceHandles: 'key, updatedAt',
      notesIndex: 'id, path, pillar, category, updatedAt, fileName, contentHash',
      noteAssets: 'id, noteId, assetPath',
      assetsMeta: 'assetPath, sha256',
      appSettings: 'key',
      embeddingChunks: 'id, noteId, blockId, modelId, contentHash, pillar',
      indexedFiles: 'docId, path, contentHash, modelId',
      embeddingMeta: 'key',
      sourceDocuments: 'id, path, contentHash, kind',
      backlinks: 'id, sourceNoteId, targetNoteId, sourceBlockId, targetBlockId',
      dismissedSuggestions: 'id, fromNoteId, targetNoteId',
      encryptedKeys: 'provider, updatedAt',
      batchMoves: 'batchId, timestamp',
    });
    this.version(7).stores({
      workspaceHandles: 'key, updatedAt',
      notesIndex: 'id, path, pillar, category, updatedAt, fileName, contentHash',
      noteAssets: 'id, noteId, assetPath',
      assetsMeta: 'assetPath, sha256',
      appSettings: 'key',
      embeddingChunks: 'id, noteId, blockId, modelId, contentHash, pillar',
      indexedFiles: 'docId, path, contentHash, modelId',
      embeddingMeta: 'key',
      sourceDocuments: 'id, path, contentHash, kind',
      backlinks: 'id, sourceNoteId, targetNoteId, sourceBlockId, targetBlockId',
      dismissedSuggestions: 'id, fromNoteId, targetNoteId',
      encryptedKeys: 'provider, updatedAt',
      batchMoves: 'batchId, timestamp',
      pdfAnnotations: 'id, contentHash, coordKey, createdAt',
      demoSourceFiles: 'id, path, contentHash',
    });
  }
}

export const noodleDb = new NoodleDatabase();

export async function saveBatchMoveLog(record: BatchMoveRecord): Promise<void> {
  await noodleDb.batchMoves.put(record);
}

export async function getBatchMoveLogs(): Promise<BatchMoveRecord[]> {
  return noodleDb.batchMoves.orderBy('timestamp').reverse().toArray();
}

export async function markBatchRolledBack(batchId: string): Promise<void> {
  await noodleDb.batchMoves.update(batchId, {rolledBack: true});
}

export async function saveWorkspaceHandle(
  handle: FileSystemDirectoryHandle,
  directManualRoot = false,
): Promise<void> {
  await noodleDb.workspaceHandles.put({
    key: 'current',
    handle,
    folderName: handle.name,
    ...(directManualRoot ? {directManualRoot: true} : {}),
    updatedAt: new Date().toISOString(),
  });
}

export async function loadWorkspaceHandle(): Promise<
  WorkspaceHandleRow | undefined
> {
  return noodleDb.workspaceHandles.get('current');
}

export async function clearWorkspaceHandle(): Promise<void> {
  await noodleDb.workspaceHandles.delete('current');
}

export async function readNotesIndex(): Promise<NoteIndexRow[]> {
  return noodleDb.notesIndex.toArray();
}

export function buildNoteIndexRow(entry: StoredNoteEntry): NoteIndexRow {
  const path = entry.path ?? `${entry.pillar}/${entry.fileName}`;
  return {
    id: entry.note.id,
    path,
    pillar: entry.pillar,
    fileName: entry.fileName,
    title: entry.note.title,
    category: entry.note.category,
    ...(entry.note.subfolder ? {subfolder: entry.note.subfolder} : {}),
    updatedAt: entry.note.updatedAt,
    size: entry.size ?? 0,
    lastModified: entry.lastModified ?? 0,
    contentHash: entry.note.contentHash,
  };
}

export async function upsertSingleNoteIndex(
  entry: StoredNoteEntry,
  assetPaths: string[],
): Promise<void> {
  await noodleDb.transaction(
    'rw',
    noodleDb.notesIndex,
    noodleDb.noteAssets,
    async () => {
      await noodleDb.notesIndex.put(buildNoteIndexRow(entry));
      await noodleDb.noteAssets.where('noteId').equals(entry.note.id).delete();
      if (assetPaths.length > 0) {
        await noodleDb.noteAssets.bulkPut(
          assetPaths.map((assetPath) => ({
            id: `${entry.note.id}::${assetPath}`,
            noteId: entry.note.id,
            assetPath,
          })),
        );
      }
    },
  );
}

export async function deleteSingleNoteIndex(noteId: string): Promise<void> {
  await noodleDb.transaction(
    'rw',
    noodleDb.notesIndex,
    noodleDb.noteAssets,
    async () => {
      await noodleDb.notesIndex.delete(noteId);
      await noodleDb.noteAssets.where('noteId').equals(noteId).delete();
    },
  );
}

export async function applyBatchIndexChanges(params: {
  upserts: Array<{entry: StoredNoteEntry; assetPaths: string[]}>;
  deleteNoteIds: string[];
}): Promise<void> {
  const {upserts, deleteNoteIds} = params;
  if (upserts.length === 0 && deleteNoteIds.length === 0) {
    return;
  }

  await noodleDb.transaction(
    'rw',
    noodleDb.notesIndex,
    noodleDb.noteAssets,
    async () => {
      if (deleteNoteIds.length > 0) {
        await noodleDb.notesIndex.bulkDelete(deleteNoteIds);
        await noodleDb.noteAssets.where('noteId').anyOf(deleteNoteIds).delete();
      }

      if (upserts.length > 0) {
        const indexRows = upserts.map(({entry}) => buildNoteIndexRow(entry));
        const upsertIds = indexRows.map((row) => row.id);
        await noodleDb.notesIndex.bulkPut(indexRows);
        await noodleDb.noteAssets.where('noteId').anyOf(upsertIds).delete();

        const assetRows: NoteAssetRow[] = [];
        for (const {entry, assetPaths} of upserts) {
          for (const assetPath of assetPaths) {
            assetRows.push({
              id: `${entry.note.id}::${assetPath}`,
              noteId: entry.note.id,
              assetPath,
            });
          }
        }
        if (assetRows.length > 0) {
          await noodleDb.noteAssets.bulkPut(assetRows);
        }
      }
    },
  );
}

export async function rebuildNotesIndex(
  entries: StoredNoteEntry[],
  extractAssets: (entry: StoredNoteEntry) => string[],
): Promise<void> {
  await noodleDb.transaction(
    'rw',
    noodleDb.notesIndex,
    noodleDb.noteAssets,
    async () => {
      await noodleDb.notesIndex.clear();
      await noodleDb.noteAssets.clear();

      if (entries.length > 0) {
        await noodleDb.notesIndex.bulkPut(entries.map(buildNoteIndexRow));

        const assetRows: NoteAssetRow[] = [];
        for (const entry of entries) {
          const paths = extractAssets(entry);
          for (const assetPath of paths) {
            assetRows.push({
              id: `${entry.note.id}::${assetPath}`,
              noteId: entry.note.id,
              assetPath,
            });
          }
        }
        if (assetRows.length > 0) {
          await noodleDb.noteAssets.bulkPut(assetRows);
        }
      }
    },
  );
}

export async function upsertNoteAssets(
  noteId: string,
  assetPaths: string[],
): Promise<void> {
  await noodleDb.transaction('rw', noodleDb.noteAssets, async () => {
    await noodleDb.noteAssets.where('noteId').equals(noteId).delete();
    if (assetPaths.length > 0) {
      await noodleDb.noteAssets.bulkPut(
        assetPaths.map((assetPath) => ({
          id: `${noteId}::${assetPath}`,
          noteId,
          assetPath,
        })),
      );
    }
  });
}

export async function removeNoteAssets(noteId: string): Promise<void> {
  await noodleDb.noteAssets.where('noteId').equals(noteId).delete();
}

export async function findOrphanAssetsForNote(
  noteId: string,
  candidatePaths: string[],
): Promise<string[]> {
  if (candidatePaths.length === 0) {
    return [];
  }
  const orphans: string[] = [];
  for (const assetPath of candidatePaths) {
    const usages = await noodleDb.noteAssets
      .where('assetPath')
      .equals(assetPath)
      .toArray();
    const usedByOther = usages.some((row) => row.noteId !== noteId);
    if (!usedByOther) {
      orphans.push(assetPath);
    }
  }
  return orphans;
}

export async function upsertAssetMeta(meta: AssetMetaRow): Promise<void> {
  await noodleDb.assetsMeta.put(meta);
}

export async function findAssetMetaBySha256(
  sha256: string,
): Promise<AssetMetaRow | undefined> {
  return noodleDb.assetsMeta.where('sha256').equals(sha256).first();
}

export async function removeAssetMeta(assetPath: string): Promise<void> {
  await noodleDb.assetsMeta.delete(assetPath);
}

export async function hasConfirmedAssetCleanup(): Promise<boolean> {
  const row = await noodleDb.appSettings.get('assetCleanupConfirmed');
  return row?.value === true;
}

export async function markAssetCleanupConfirmed(): Promise<void> {
  await noodleDb.appSettings.put({
    key: 'assetCleanupConfirmed',
    value: true,
  });
}

// ---------- LOCAL EMBEDDINGS, SOURCE DOCS & BACKLINKS (Milestone 6) ----------

export async function getEmbeddingMeta(): Promise<EmbeddingMetaRow | undefined> {
  return noodleDb.embeddingMeta.get('current');
}

export async function saveEmbeddingMeta(
  config: EmbeddingModelConfig,
): Promise<void> {
  await noodleDb.embeddingMeta.put({
    key: 'current',
    modelId: config.modelId,
    vectorSize: config.vectorSize,
    isDownloaded: config.isDownloaded,
    cachedAt: config.cachedAt,
  });
}

export async function clearEmbeddingsForModelChange(
  newModelId: string,
  vectorSize = 0,
  isDownloaded = false,
): Promise<void> {
  await noodleDb.transaction(
    'rw',
    noodleDb.embeddingChunks,
    noodleDb.indexedFiles,
    noodleDb.embeddingMeta,
    async () => {
      await noodleDb.embeddingChunks.clear();
      await noodleDb.indexedFiles.clear();
      await noodleDb.embeddingMeta.put({
        key: 'current',
        modelId: newModelId,
        vectorSize,
        isDownloaded,
      });
    },
  );
}

export async function getIndexedFilesList(): Promise<IndexedFileRow[]> {
  return noodleDb.indexedFiles.toArray();
}

export async function getEmbeddingChunks(
  modelId?: string,
): Promise<EmbeddingChunkRow[]> {
  if (modelId) {
    return noodleDb.embeddingChunks.where('modelId').equals(modelId).toArray();
  }
  return noodleDb.embeddingChunks.toArray();
}

export async function applyChunkIndexChanges(params: {
  deleteDocIds: string[];
  upserts: Array<{file: IndexedFileRow; chunks: EmbeddingChunkRow[]}>;
}): Promise<void> {
  const {deleteDocIds, upserts} = params;
  if (deleteDocIds.length === 0 && upserts.length === 0) {
    return;
  }

  await noodleDb.transaction(
    'rw',
    noodleDb.embeddingChunks,
    noodleDb.indexedFiles,
    async () => {
      if (deleteDocIds.length > 0) {
        await noodleDb.indexedFiles.bulkDelete(deleteDocIds);
        await noodleDb.embeddingChunks
          .where('noteId')
          .anyOf(deleteDocIds)
          .delete();
      }

      if (upserts.length > 0) {
        const docIds = upserts.map((u) => u.file.docId);
        await noodleDb.embeddingChunks.where('noteId').anyOf(docIds).delete();
        await noodleDb.indexedFiles.bulkPut(upserts.map((u) => u.file));

        const allChunks = upserts.flatMap((u) => u.chunks);
        if (allChunks.length > 0) {
          await noodleDb.embeddingChunks.bulkPut(allChunks);
        }
      }
    },
  );
}

export async function updateIndexedDocsLocationMetadata(
  updates: Array<{docId: string; path: string; pillar: Pillar; title: string}>,
): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  await noodleDb.transaction(
    'rw',
    noodleDb.embeddingChunks,
    noodleDb.indexedFiles,
    async () => {
      for (const u of updates) {
        await noodleDb.indexedFiles
          .where('docId')
          .equals(u.docId)
          .modify({path: u.path, pillar: u.pillar, title: u.title});
        await noodleDb.embeddingChunks
          .where('noteId')
          .equals(u.docId)
          .modify({path: u.path, pillar: u.pillar, title: u.title});
      }
    },
  );
}

export async function getStoredSourceDocuments(): Promise<SourceDocumentEntry[]> {
  return noodleDb.sourceDocuments.toArray();
}

export async function replaceStoredSourceDocuments(
  docs: SourceDocumentEntry[],
): Promise<void> {
  await noodleDb.transaction('rw', noodleDb.sourceDocuments, async () => {
    await noodleDb.sourceDocuments.clear();
    if (docs.length > 0) {
      await noodleDb.sourceDocuments.bulkPut(docs);
    }
  });
}

export async function getBacklinksForDocument(
  noteId: string,
): Promise<BacklinkRecord[]> {
  const [outgoing, incoming] = await Promise.all([
    noodleDb.backlinks.where('sourceNoteId').equals(noteId).toArray(),
    noodleDb.backlinks.where('targetNoteId').equals(noteId).toArray(),
  ]);
  const merged = new Map<string, BacklinkRecord>();
  for (const row of [...outgoing, ...incoming]) {
    merged.set(row.id, row);
  }
  return Array.from(merged.values()).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

export async function addExplicitBacklink(
  record: BacklinkRecord,
): Promise<void> {
  await noodleDb.backlinks.put(record);
}

export async function removeExplicitBacklink(id: string): Promise<void> {
  await noodleDb.backlinks.delete(id);
}

export async function getDismissedTargetIds(
  fromNoteId: string,
): Promise<Set<string>> {
  const rows = await noodleDb.dismissedSuggestions
    .where('fromNoteId')
    .equals(fromNoteId)
    .toArray();
  return new Set(rows.map((r) => `${r.targetNoteId}::${r.targetBlockId}`));
}

export async function dismissConnectionSuggestion(params: {
  fromNoteId: string;
  targetNoteId: string;
  targetBlockId: string;
}): Promise<void> {
  const id = `${params.fromNoteId}::${params.targetNoteId}::${params.targetBlockId}`;
  await noodleDb.dismissedSuggestions.put({
    id,
    fromNoteId: params.fromNoteId,
    targetNoteId: params.targetNoteId,
    targetBlockId: params.targetBlockId,
    dismissedAt: new Date().toISOString(),
  });
}

// ---------- ENCRYPTED BYOK CLOUD KEY STORAGE (Milestone 7) ----------

export async function getEncryptedKeyRecord(
  provider: CloudProviderId,
): Promise<EncryptedKeyRecord | undefined> {
  return noodleDb.encryptedKeys.get(provider);
}

export async function listEncryptedKeyRecords(): Promise<EncryptedKeyRecord[]> {
  return noodleDb.encryptedKeys.toArray();
}

export async function saveEncryptedKeyRecord(
  record: EncryptedKeyRecord,
): Promise<void> {
  await noodleDb.encryptedKeys.put(record);
}

export async function deleteEncryptedKeyRecord(
  provider: CloudProviderId,
): Promise<void> {
  await noodleDb.encryptedKeys.delete(provider);
}

export async function getActiveProviderSetting(): Promise<{
  provider: CloudProviderId;
  model?: string;
} | null> {
  const providerRow = await noodleDb.appSettings.get('cloudProvider');
  if (
    !providerRow ||
    (providerRow.value !== 'openai' &&
      providerRow.value !== 'anthropic' &&
      providerRow.value !== 'gemini')
  ) {
    return null;
  }
  const modelRow = await noodleDb.appSettings.get(`cloudModel:${providerRow.value}`);
  return {
    provider: providerRow.value,
    model: typeof modelRow?.value === 'string' ? modelRow.value : undefined,
  };
}

export async function saveActiveProviderSetting(
  provider: CloudProviderId,
  model: string,
): Promise<void> {
  await noodleDb.transaction('rw', noodleDb.appSettings, async () => {
    await noodleDb.appSettings.put({key: 'cloudProvider', value: provider});
    await noodleDb.appSettings.put({key: `cloudModel:${provider}`, value: model});
  });
}

// ---------- PDF ANNOTATIONS (KEYED BY CONTENT HASH + TEXT-LAYER COORDS) ----------

export async function listPdfAnnotationsByHash(
  contentHash: string,
): Promise<PdfAnnotationRecord[]> {
  if (!contentHash) {
    return [];
  }
  const rows = await noodleDb.pdfAnnotations
    .where('contentHash')
    .equals(contentHash)
    .toArray();
  return sortPdfAnnotations(rows);
}

export async function savePdfAnnotation(
  record: PdfAnnotationRecord,
): Promise<void> {
  await noodleDb.pdfAnnotations.put(record);
}

export async function updatePdfAnnotation(
  id: string,
  patch: {comment?: string; color?: PdfHighlightColor},
): Promise<PdfAnnotationRecord | null> {
  const existing = await noodleDb.pdfAnnotations.get(id);
  if (!existing) {
    return null;
  }
  const updated: PdfAnnotationRecord = {
    ...existing,
    comment: patch.comment !== undefined ? patch.comment : existing.comment,
    color: patch.color !== undefined ? patch.color : existing.color,
    updatedAt: new Date().toISOString(),
  };
  await noodleDb.pdfAnnotations.put(updated);
  return updated;
}

export async function deletePdfAnnotation(id: string): Promise<void> {
  await noodleDb.pdfAnnotations.delete(id);
}

export async function clearPdfAnnotationsByHash(
  contentHash: string,
): Promise<void> {
  await noodleDb.pdfAnnotations
    .where('contentHash')
    .equals(contentHash)
    .delete();
}

export async function listDemoSourceFiles(): Promise<DemoSourceFileRow[]> {
  return noodleDb.demoSourceFiles.toArray();
}

export async function saveDemoSourceFile(
  row: DemoSourceFileRow,
): Promise<void> {
  await noodleDb.demoSourceFiles.put(row);
}

export async function getDemoSourceBytesByPathOrHash(
  path: string,
  contentHash?: string,
): Promise<ArrayBuffer | null> {
  const byPath = await noodleDb.demoSourceFiles
    .where('path')
    .equals(path)
    .first();
  if (byPath?.bytes) {
    return byPath.bytes.slice(0);
  }
  if (contentHash) {
    const byHash = await noodleDb.demoSourceFiles
      .where('contentHash')
      .equals(contentHash)
      .first();
    if (byHash?.bytes) {
      return byHash.bytes.slice(0);
    }
  }
  return null;
}
