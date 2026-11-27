import {
  applyBatchIndexChanges,
  clearWorkspaceHandle,
  deleteSingleNoteIndex,
  findAssetMetaBySha256,
  findOrphanAssetsForNote,
  getDemoSourceBytesByPathOrHash,
  getStoredSourceDocuments,
  hasConfirmedAssetCleanup,
  listDemoSourceFiles,
  loadWorkspaceHandle,
  markAssetCleanupConfirmed,
  NoteIndexRow,
  readNotesIndex,
  rebuildNotesIndex,
  removeAssetMeta,
  removeNoteAssets,
  replaceStoredSourceDocuments,
  saveDemoSourceFile,
  saveWorkspaceHandle,
  upsertAssetMeta,
  upsertNoteAssets,
  upsertSingleNoteIndex,
} from '../db/noodleDb';
import {buildSampleAcademicPdfBytes} from '../pdf/pdfAnnotations';
import {
  ALLOWED_IMAGE_EXTENSIONS,
  ALLOWED_IMAGE_MIME_TYPES,
  computeCanonicalContentHash,
  CURRENT_SCHEMA_VERSION,
  ensureBlockIds,
  extractAssetPathsFromDoc,
  formatMissingImageMessage,
  isWorkspaceRelativeAssetPath,
  MAX_IMAGE_BYTES,
  migrateNote,
  shouldScheduleAutosave,
  validateNoteAssetPaths,
} from '../editor/noteSchema';
import {extractPlainText} from '../editor/plainText';
import {chunkPdfPages, chunkPlainTextSource} from '../search/chunker';
import {extractPdfPagesInWorker} from '../search/pdfExtractor';
import {
  AiNoteMetadata,
  Category,
  DiagnosticCheckResult,
  NoteRecord,
  Pillar,
  ScanProblem,
  SourceDocumentEntry,
  StoredNoteEntry,
  TipTapDoc,
  WorkspaceScanSummary,
  WritablePillar,
} from '../types/noodle';
import {sanitizeCategoryLabel} from './categoryConfig';
import {
  OwnWriteExpectation,
  reconcileWorkspaceSnapshot,
} from './changeDetector';

/**
 * SINGLE STORAGE MODULE
 * This module is the ONLY code in Noodle allowed to touch the File System Access API.
 */

const NOODLE_WORK_DIRS = ['sources', 'manual', 'ai', 'assets', '.noodle'] as const;
const PROJECT_DEPENDENCY_MARKERS = new Set([
  'node_modules',
  '.git',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.venv',
  'venv',
  'cargo.toml',
  'go.mod',
]);
const PILLAR_DIRS: Pillar[] = ['sources', 'manual', 'ai'];
const MAX_NAME_LENGTH = 120;
const RESERVED_WINDOWS_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

export type StorageErrorCode =
  | 'UNSUPPORTED'
  | 'BLOCKED_IFRAME'
  | 'USER_GESTURE_REQUIRED'
  | 'USER_CANCELLED'
  | 'PERMISSION_DENIED'
  | 'NO_WORKSPACE'
  | 'INVALID_NAME'
  | 'PATH_TRAVERSAL'
  | 'SOURCES_IMMUTABLE'
  | 'NOT_FOUND'
  | 'INVALID_NOTE'
  | 'INVALID_IMAGE_PATH'
  | 'INVALID_IMAGE_TYPE'
  | 'FILE_TOO_LARGE'
  | 'IO_ERROR';

export class StorageError extends Error {
  code: StorageErrorCode;
  pendingHandle?: FileSystemDirectoryHandle;

  constructor(
    code: StorageErrorCode,
    message: string,
    pendingHandle?: FileSystemDirectoryHandle,
  ) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.pendingHandle = pendingHandle;
  }
}

interface PermissionCapableHandle extends FileSystemDirectoryHandle {
  queryPermission?: (descriptor?: {
    mode?: 'read' | 'readwrite';
  }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: {
    mode?: 'read' | 'readwrite';
  }) => Promise<PermissionState>;
}

interface MovableFileHandle extends FileSystemFileHandle {
  move?: (
    destination: FileSystemDirectoryHandle | string,
    newName?: string,
  ) => Promise<void>;
}

interface PickerWindow extends Window {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
  }) => Promise<FileSystemDirectoryHandle>;
}

export interface FolderInspection {
  folderName: string;
  isEmpty: boolean;
  entryCount: number;
  hasAllNoodleDirs: boolean;
  hasNoodleManifest: boolean;
  hasKnownNoodleWorkspace: boolean;
  looksLikeCodeProject: boolean;
  projectMarkerNames: string[];
  directManualNotesCount: number;
  looksLikeDirectManualSubfolder: boolean;
  rootMarkdownOrTextCount: number;
}

export interface CreateNoteInput {
  pillar: WritablePillar;
  title: string;
  category: Category;
  subfolder?: string;
  bodyText?: string;
  content?: TipTapDoc;
  aiMeta?: AiNoteMetadata;
}

export interface UpdateNoteInput {
  title?: string;
  category?: Category;
  subfolder?: string | null;
  content?: TipTapDoc;
}

// Active workspace handle kept strictly inside the storage module
let activeRootHandle: FileSystemDirectoryHandle | null = null;
// True when the user opened a `manual/` folder directly (notes live in root, not root/manual/)
let activeDirectManualRoot = false;
// Track writes made by the app to prevent re-indexing echo loops (Hard Rule 3)
const trackedOwnWrites = new Map<string, OwnWriteExpectation>();
// Cache parsed notes keyed by workspace path so unchanged size/lastModified files skip re-hashing
const cachedEntriesByPath = new Map<string, StoredNoteEntry>();
// Serial write queue (writes execute strictly one at a time)
let writeQueue: Promise<unknown> = Promise.resolve();
// Track whether current session restored its handle from IndexedDB
let restoredHandleFlag = false;
// In-memory asset store used only when no disk workspace is connected (demo / iframe preview mode)
const memoryAssets = new Map<string, {blob: Blob; sha256: string}>();
// Scanner single-flight & debounce state
const AUTO_SCAN_DEBOUNCE_MS = 1200;
const MANUAL_SCAN_DEBOUNCE_MS = 250;
let inFlightScanPromise: Promise<WorkspaceScanSummary> | null = null;
let lastScanCompletedAt = 0;
let lastScanSummary: WorkspaceScanSummary | null = null;
let lastScanProblems: ScanProblem[] = [];
let isChangeDiagRunning = false;
const DIAG_SYNC_SUBDIR = '_diag_sync_1000';
const DIAG_SYNC_ID_PREFIX = '00000000-0000-4000-9000-';

function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task, task);
  writeQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function isFileSystemAccessSupported(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return typeof (window as PickerWindow).showDirectoryPicker === 'function';
}

export function isInsideIframe(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export function getActiveFolderName(): string | null {
  return activeRootHandle ? activeRootHandle.name : null;
}

export function hasActiveWorkspace(): boolean {
  return activeRootHandle !== null;
}

export function wasRestoredFromIndexedDb(): boolean {
  return restoredHandleFlag;
}

export function getTrackedOwnWriteDigest(relativePath: string): string | undefined {
  return trackedOwnWrites.get(relativePath)?.contentHash;
}

export function getLastScanProblems(): ScanProblem[] {
  return lastScanProblems;
}

/**
 * Validates and sanitizes a single filename or path segment.
 * Rejects slashes, '..', '.', control characters, unsafe characters, reserved names, and excessive length.
 */
export function sanitizeName(raw: string): string {
  if (typeof raw !== 'string') {
    throw new StorageError('INVALID_NAME', 'Name must be a string.');
  }

  // Check control characters before trimming so hidden control chars are never silently accepted
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new StorageError(
      'INVALID_NAME',
      'Name contains invalid control characters.',
    );
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new StorageError('INVALID_NAME', 'Name cannot be empty.');
  }

  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new StorageError(
      'PATH_TRAVERSAL',
      'Name cannot contain directory slashes (/ or \\).',
    );
  }

  if (trimmed === '.' || trimmed === '..' || trimmed.includes('..')) {
    throw new StorageError(
      'PATH_TRAVERSAL',
      'Name cannot contain parent directory references (..).',
    );
  }

  if (/[<>:"|?*]/.test(trimmed)) {
    throw new StorageError(
      'INVALID_NAME',
      'Name contains disallowed filesystem characters (< > : " | ? *).',
    );
  }

  if (trimmed.endsWith('.') || trimmed.endsWith(' ')) {
    throw new StorageError(
      'INVALID_NAME',
      'Name cannot end with a dot or space.',
    );
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new StorageError(
      'INVALID_NAME',
      `Name exceeds maximum length of ${MAX_NAME_LENGTH} characters.`,
    );
  }

  const stem = trimmed.replace(/\.json$/i, '').toUpperCase();
  if (RESERVED_WINDOWS_NAMES.has(stem)) {
    throw new StorageError(
      'INVALID_NAME',
      `Name "${stem}" is a reserved system filename.`,
    );
  }

  return trimmed;
}

function assertValidPillar(pillar: string): asserts pillar is Pillar {
  if (pillar !== 'sources' && pillar !== 'manual' && pillar !== 'ai') {
    throw new StorageError(
      'PATH_TRAVERSAL',
      `Invalid pillar directory "${pillar}".`,
    );
  }
}

function assertWritablePillar(pillar: string): asserts pillar is WritablePillar {
  assertValidPillar(pillar);
  if (pillar === 'sources') {
    throw new StorageError(
      'SOURCES_IMMUTABLE',
      'Writes to sources/ are refused: sources are immutable.',
    );
  }
}

function buildSafeNoteFileName(title: string, id: string): string {
  const cleanSlug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  const shortId = id.slice(0, 8);
  const candidate = `${cleanSlug || 'note'}-${shortId}.json`;
  return sanitizeName(candidate);
}

function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function computeSha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

async function computeBytesSha256(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

function deriveExcerptAndWordCount(content: TipTapDoc): {
  excerpt: string;
  wordCount: number;
} {
  const {text} = extractPlainText(content);
  const normalized = text.replace(/\s+/g, ' ').trim();
  const wordCount = normalized ? normalized.split(/\s+/).length : 0;
  return {
    excerpt: (normalized || 'Empty note.').slice(0, 180),
    wordCount,
  };
}

function requireRootHandle(): FileSystemDirectoryHandle {
  if (!activeRootHandle) {
    throw new StorageError(
      'NO_WORKSPACE',
      'No workspace folder is currently connected.',
    );
  }
  return activeRootHandle;
}

async function resolvePillarDir(
  root: FileSystemDirectoryHandle,
  pillar: Pillar,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  assertValidPillar(pillar);
  if (pillar === 'manual' && activeDirectManualRoot) {
    return root;
  }
  return root.getDirectoryHandle(pillar, {create});
}

async function dirExistsInRoot(
  root: FileSystemDirectoryHandle,
  name: string,
): Promise<boolean> {
  try {
    await root.getDirectoryHandle(name, {create: false});
    return true;
  } catch {
    return false;
  }
}

async function removeDirIfEmpty(
  root: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  try {
    const dir = await root.getDirectoryHandle(name, {create: false});
    for await (const _entry of dir.entries()) {
      return;
    }
    await root.removeEntry(name);
  } catch {
    // Directory missing or non-empty
  }
}

async function resolveNoteHandle(
  root: FileSystemDirectoryHandle,
  pillar: Pillar,
  fileName: string,
): Promise<{
  dirHandle: FileSystemDirectoryHandle;
  safeFileName: string;
  leafFileName: string;
}> {
  if (typeof fileName !== 'string' || !fileName.trim()) {
    throw new StorageError('INVALID_NAME', 'Note filename cannot be empty.');
  }
  const normalized = fileName.replace(/\\/g, '/').trim();
  const segments = normalized.split('/').filter((s) => s.length > 0);
  if (segments.length === 0 || normalized.startsWith('/')) {
    throw new StorageError('PATH_TRAVERSAL', 'Invalid relative note path.');
  }

  const sanitizedSegments = segments.map((seg) => sanitizeName(seg));
  const leafFileName = sanitizedSegments[sanitizedSegments.length - 1];
  if (!leafFileName.toLowerCase().endsWith('.json')) {
    throw new StorageError(
      'INVALID_NAME',
      'Note files must use the .json extension.',
    );
  }

  let dirHandle = await resolvePillarDir(root, pillar, false);
  for (let i = 0; i < sanitizedSegments.length - 1; i += 1) {
    dirHandle = await dirHandle.getDirectoryHandle(sanitizedSegments[i], {
      create: false,
    });
  }

  return {
    dirHandle,
    safeFileName: sanitizedSegments.join('/'),
    leafFileName,
  };
}

/**
 * Atomic write: writes payload to a temporary file first, flushes/closes,
 * then moves/replaces the target file and cleans up the temp file.
 * Records the expected hash, size, and timestamp to suppress rescan loops.
 */
async function writeFileAtomic(
  dirHandle: FileSystemDirectoryHandle,
  relativeKey: string,
  targetFileName: string,
  payload: string,
  digest: string,
  noteId?: string,
): Promise<{size: number; lastModified: number}> {
  const safeTarget = sanitizeName(targetFileName);
  const tempName = sanitizeName(
    `.${safeTarget}.tmp-${generateUuid().slice(0, 8)}`,
  );

  trackedOwnWrites.set(relativeKey, {
    path: relativeKey,
    noteId,
    contentHash: digest,
    writtenAt: Date.now(),
    op: 'write',
  });

  let tempHandle: MovableFileHandle | null = null;
  try {
    tempHandle = (await dirHandle.getFileHandle(tempName, {
      create: true,
    })) as MovableFileHandle;
    const tempWritable = await tempHandle.createWritable();
    await tempWritable.write(payload);
    await tempWritable.close();

    // Verify temp file size before replacing target
    const writtenTemp = await tempHandle.getFile();
    if (writtenTemp.size === 0 && payload.length > 0) {
      throw new StorageError('IO_ERROR', 'Atomic temp file verification failed.');
    }

    let movedDirectly = false;
    if (typeof tempHandle.move === 'function') {
      try {
        await tempHandle.move(dirHandle, safeTarget);
        movedDirectly = true;
      } catch {
        // Fallback to target writable swap if FileSystemFileHandle.move is unsupported
        movedDirectly = false;
      }
    }

    if (!movedDirectly) {
      const targetHandle = await dirHandle.getFileHandle(safeTarget, {
        create: true,
      });
      const targetWritable = await targetHandle.createWritable();
      await targetWritable.write(payload);
      await targetWritable.close();
    }

    const finalHandle = await dirHandle.getFileHandle(safeTarget, {
      create: false,
    });
    const finalFile = await finalHandle.getFile();
    trackedOwnWrites.set(relativeKey, {
      path: relativeKey,
      noteId,
      contentHash: digest,
      writtenAt: Date.now(),
      size: finalFile.size,
      lastModified: finalFile.lastModified,
      op: 'write',
    });
    return {size: finalFile.size, lastModified: finalFile.lastModified};
  } finally {
    // Clean up temporary file if it still exists
    try {
      await dirHandle.removeEntry(tempName);
    } catch {
      // Already moved or never created
    }
  }
}

async function writeBinaryFileAtomic(
  dirHandle: FileSystemDirectoryHandle,
  relativeKey: string,
  targetFileName: string,
  payload: ArrayBuffer,
  digest: string,
): Promise<void> {
  const safeTarget = sanitizeName(targetFileName);
  const tempName = sanitizeName(
    `.${safeTarget}.tmp-${generateUuid().slice(0, 8)}`,
  );

  trackedOwnWrites.set(relativeKey, {
    path: relativeKey,
    contentHash: digest,
    writtenAt: Date.now(),
    op: 'write',
  });

  let tempHandle: MovableFileHandle | null = null;
  try {
    tempHandle = (await dirHandle.getFileHandle(tempName, {
      create: true,
    })) as MovableFileHandle;
    const tempWritable = await tempHandle.createWritable();
    await tempWritable.write(payload);
    await tempWritable.close();

    const writtenTemp = await tempHandle.getFile();
    if (writtenTemp.size !== payload.byteLength) {
      throw new StorageError(
        'IO_ERROR',
        'Atomic binary temp file verification failed.',
      );
    }

    let movedDirectly = false;
    if (typeof tempHandle.move === 'function') {
      try {
        await tempHandle.move(dirHandle, safeTarget);
        movedDirectly = true;
      } catch {
        movedDirectly = false;
      }
    }

    if (!movedDirectly) {
      const targetHandle = await dirHandle.getFileHandle(safeTarget, {
        create: true,
      });
      const targetWritable = await targetHandle.createWritable();
      await targetWritable.write(payload);
      await targetWritable.close();
    }
  } finally {
    try {
      await dirHandle.removeEntry(tempName);
    } catch {
      // Already moved or never created
    }
  }
}

function isValidCategory(value: unknown): value is Category {
  return typeof value === 'string' && sanitizeCategoryLabel(value).length > 0;
}

function parseNoteJson(rawText: string, expectedPillar: Pillar): NoteRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new StorageError('INVALID_NOTE', 'Note file is not valid JSON.');
  }

  try {
    const {note} = migrateNote(parsed, expectedPillar);
    return {
      ...note,
      pillar: expectedPillar,
    };
  } catch (err) {
    throw new StorageError(
      'INVALID_NOTE',
      (err as Error).message || 'Invalid note format.',
    );
  }
}

async function cleanupOrphanedDiagSyncData(
  root: FileSystemDirectoryHandle,
): Promise<void> {
  if (isChangeDiagRunning) {
    return;
  }
  for (const pillar of ['manual', 'ai'] as const) {
    try {
      const pDir = await resolvePillarDir(root, pillar, false);
      try {
        await pDir.removeEntry(DIAG_SYNC_SUBDIR, {recursive: true});
      } catch {
        // No leftover diag folder in this pillar
      }
      if (!(pillar === 'manual' && activeDirectManualRoot)) {
        await removeDirIfEmpty(root, pillar);
      }
    } catch {
      // Pillar directory doesn't exist
    }
  }
  try {
    const idx = await readNotesIndex();
    const staleIds = idx
      .filter((row) => row.id.startsWith(DIAG_SYNC_ID_PREFIX))
      .map((row) => row.id);
    if (staleIds.length > 0) {
      await applyBatchIndexChanges({upserts: [], deleteNoteIds: staleIds});
    }
  } catch {
    // Ignore index cleanup errors
  }
}

const DIRECT_MANUAL_SKIP_DIRS = new Set(['ai', 'assets', 'sources', '.noodle']);

async function scanNotesInDirectory(
  dirHandle: FileSystemDirectoryHandle,
  pillar: Pillar,
  prevByPath?: Map<string, NoteIndexRow>,
  prefix = '',
  problems: ScanProblem[] = [],
  counter = {seen: 0},
): Promise<StoredNoteEntry[]> {
  const entries: StoredNoteEntry[] = [];

  for await (const [name, handle] of dirHandle.entries()) {
    if (name.startsWith('.')) {
      continue;
    }
    if (!isChangeDiagRunning && handle.kind === 'directory' && name === DIAG_SYNC_SUBDIR) {
      continue;
    }
    if (
      activeDirectManualRoot &&
      pillar === 'manual' &&
      prefix === '' &&
      handle.kind === 'directory' &&
      DIRECT_MANUAL_SKIP_DIRS.has(name.toLowerCase())
    ) {
      continue;
    }

    const relInPillar = prefix ? `${prefix}/${name}` : name;
    const fullPath = `${pillar}/${relInPillar}`;

    if (handle.kind === 'directory') {
      const nested = await scanNotesInDirectory(
        handle as FileSystemDirectoryHandle,
        pillar,
        prevByPath,
        relInPillar,
        problems,
        counter,
      );
      entries.push(...nested);
      continue;
    }

    if (handle.kind !== 'file' || !name.toLowerCase().endsWith('.json')) {
      continue;
    }

    counter.seen += 1;
    if (counter.seen % 100 === 0) {
      await yieldToMain();
    }

    try {
      const file = await (handle as FileSystemFileHandle).getFile();
      const prev = prevByPath?.get(fullPath);
      const cached = cachedEntriesByPath.get(fullPath);

      if (
        prev &&
        cached &&
        prev.size === file.size &&
        prev.lastModified === file.lastModified
      ) {
        entries.push(cached);
        continue;
      }

      const text = await file.text();
      const parsed = parseNoteJson(text, pillar);
      const computedHash = await computeCanonicalContentHash(parsed.content);
      const note: NoteRecord = {
        ...parsed,
        contentHash: computedHash,
      };
      const {excerpt, wordCount} = deriveExcerptAndWordCount(note.content);
      const entry: StoredNoteEntry = {
        note,
        fileName: relInPillar,
        pillar,
        excerpt,
        wordCount,
        path: fullPath,
        size: file.size,
        lastModified: file.lastModified,
      };
      entries.push(entry);
    } catch (err) {
      problems.push({
        id: fullPath,
        path: fullPath,
        pillar,
        fileName: relInPillar,
        reason:
          (err as Error).message || 'Unreadable or malformed JSON note file.',
        detectedAt: new Date().toISOString(),
      });
    }
  }

  entries.sort((a, b) =>
    b.note.updatedAt.localeCompare(a.note.updatedAt),
  );
  return entries;
}

async function readNotesInDirectory(
  dirHandle: FileSystemDirectoryHandle,
  pillar: Pillar,
): Promise<StoredNoteEntry[]> {
  return scanNotesInDirectory(dirHandle, pillar);
}

export async function queryHandlePermission(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  const permHandle = handle as PermissionCapableHandle;
  if (typeof permHandle.queryPermission === 'function') {
    return permHandle.queryPermission({mode: 'readwrite'});
  }
  return 'granted';
}

export async function requestHandlePermission(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  const permHandle = handle as PermissionCapableHandle;
  if (typeof permHandle.requestPermission === 'function') {
    return permHandle.requestPermission({mode: 'readwrite'});
  }
  return 'granted';
}

export function summarizeWorkspaceFolderEntries(
  folderName: string,
  entryNames: string[],
  hasNoodleManifest: boolean,
  extra?: {
    directManualNotesCount?: number;
    rootMarkdownOrTextCount?: number;
  },
): FolderInspection {
  const existingNames = new Set(entryNames);
  const projectMarkerNames = entryNames
    .filter((name) => PROJECT_DEPENDENCY_MARKERS.has(name.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  const looksLikeCodeProject = projectMarkerNames.length > 0;
  const hasAllNoodleDirs = NOODLE_WORK_DIRS.every((dir) =>
    existingNames.has(dir),
  );
  const hasPillarDir =
    existingNames.has('manual') ||
    existingNames.has('ai') ||
    existingNames.has('sources');
  const hasKnownNoodleWorkspace =
    hasNoodleManifest || (hasPillarDir && !looksLikeCodeProject);
  const directManualNotesCount = extra?.directManualNotesCount ?? 0;
  const rootMarkdownOrTextCount = extra?.rootMarkdownOrTextCount ?? 0;
  const looksLikeDirectManualSubfolder =
    !hasNoodleManifest &&
    !hasPillarDir &&
    !looksLikeCodeProject &&
    ((folderName.toLowerCase() === 'manual' && entryNames.length > 0) ||
      directManualNotesCount > 0);

  return {
    folderName,
    isEmpty: entryNames.length === 0,
    entryCount: entryNames.length,
    hasAllNoodleDirs,
    hasNoodleManifest,
    hasKnownNoodleWorkspace,
    looksLikeCodeProject,
    projectMarkerNames,
    directManualNotesCount,
    looksLikeDirectManualSubfolder,
    rootMarkdownOrTextCount,
  };
}

async function isNoodleNoteJsonFile(
  fileHandle: FileSystemFileHandle,
): Promise<boolean> {
  try {
    const file = await fileHandle.getFile();
    if (file.size === 0 || file.size > 5 * 1024 * 1024) {
      return false;
    }
    const text = await file.text();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') {
      return false;
    }
    const content = parsed.content as {type?: unknown} | undefined;
    return (
      typeof parsed.id === 'string' &&
      typeof parsed.title === 'string' &&
      Boolean(content && typeof content === 'object' && content.type === 'doc')
    );
  } catch {
    return false;
  }
}

async function countDirectManualCandidates(
  handle: FileSystemDirectoryHandle,
): Promise<{directManualNotesCount: number; rootMarkdownOrTextCount: number}> {
  let directManualNotesCount = 0;
  let rootMarkdownOrTextCount = 0;
  let checkedJson = 0;
  const subdirHandles: FileSystemDirectoryHandle[] = [];

  for await (const [name, entryHandle] of handle.entries()) {
    if (name.startsWith('.')) {
      continue;
    }
    if (entryHandle.kind === 'directory') {
      if (!DIRECT_MANUAL_SKIP_DIRS.has(name.toLowerCase())) {
        subdirHandles.push(entryHandle as FileSystemDirectoryHandle);
      }
      continue;
    }
    if (entryHandle.kind !== 'file') {
      continue;
    }
    const lower = name.toLowerCase();
    if (lower.endsWith('.json') && checkedJson < 25) {
      checkedJson += 1;
      if (await isNoodleNoteJsonFile(entryHandle as FileSystemFileHandle)) {
        directManualNotesCount += 1;
      }
    } else if (
      lower.endsWith('.md') ||
      lower.endsWith('.markdown') ||
      lower.endsWith('.txt')
    ) {
      rootMarkdownOrTextCount += 1;
    }
  }

  // Also check 1-level subfolders if root didn't directly list .json files
  if (directManualNotesCount === 0 && subdirHandles.length > 0) {
    for (const sub of subdirHandles.slice(0, 12)) {
      try {
        for await (const [subName, subEntry] of sub.entries()) {
          if (subName.startsWith('.') || subEntry.kind !== 'file') {
            continue;
          }
          const lower = subName.toLowerCase();
          if (lower.endsWith('.json') && checkedJson < 30) {
            checkedJson += 1;
            if (await isNoodleNoteJsonFile(subEntry as FileSystemFileHandle)) {
              directManualNotesCount += 1;
            }
          } else if (
            lower.endsWith('.md') ||
            lower.endsWith('.markdown') ||
            lower.endsWith('.txt')
          ) {
            rootMarkdownOrTextCount += 1;
          }
        }
      } catch {
        // Ignore unreadable subdir during inspection
      }
    }
  }

  return {directManualNotesCount, rootMarkdownOrTextCount};
}

async function detectDirectManualRoot(
  root: FileSystemDirectoryHandle,
  preferredFlag?: boolean,
): Promise<boolean> {
  try {
    const [hasManualDir, hasAiDir, hasSourcesDir] = await Promise.all([
      dirExistsInRoot(root, 'manual'),
      dirExistsInRoot(root, 'ai'),
      dirExistsInRoot(root, 'sources'),
    ]);
    if (hasManualDir || hasAiDir || hasSourcesDir) {
      return false;
    }
    if (preferredFlag === true) {
      return true;
    }
    const {directManualNotesCount} = await countDirectManualCandidates(root);
    return directManualNotesCount > 0;
  } catch {
    return Boolean(preferredFlag);
  }
}

export async function inspectWorkspaceFolder(
  handle: FileSystemDirectoryHandle,
): Promise<FolderInspection> {
  const entryNames: string[] = [];

  try {
    for await (const [name] of handle.entries()) {
      entryNames.push(name);
    }
  } catch (err) {
    const domErr = err as {name?: string; message?: string};
    if (domErr?.name === 'NotAllowedError' || domErr?.name === 'SecurityError') {
      throw new StorageError(
        'PERMISSION_DENIED',
        `Permission to read "${handle.name}" was not granted. Please allow folder access and try again.`,
      );
    }
    if (domErr?.name === 'NotFoundError') {
      throw new StorageError(
        'NOT_FOUND',
        `Folder "${handle.name}" could not be found on disk.`,
      );
    }
    throw new StorageError(
      'IO_ERROR',
      domErr?.message || `Unable to read folder "${handle.name}".`,
    );
  }

  let hasNoodleManifest = false;
  if (entryNames.includes('.noodle')) {
    try {
      const noodleDir = await handle.getDirectoryHandle('.noodle');
      await noodleDir.getFileHandle('manifest.json');
      hasNoodleManifest = true;
    } catch {
      hasNoodleManifest = false;
    }
  }

  const base = summarizeWorkspaceFolderEntries(
    handle.name,
    entryNames,
    hasNoodleManifest,
  );
  if (
    !base.isEmpty &&
    !base.hasKnownNoodleWorkspace &&
    !base.looksLikeCodeProject
  ) {
    const extra = await countDirectManualCandidates(handle);
    return summarizeWorkspaceFolderEntries(
      handle.name,
      entryNames,
      hasNoodleManifest,
      extra,
    );
  }

  return base;
}

/**
 * Connects the workspace folder cleanly without creating empty folders upfront.
 * Subfolders (`manual/`, `ai/`, `assets/`) are created lazily only when used.
 * Never deletes or overwrites existing user files.
 */
export async function initializeWorkspaceFolders(
  handle: FileSystemDirectoryHandle,
  options?: {directManualRoot?: boolean},
): Promise<void> {
  await enqueueWrite(async () => {
    const directMode =
      options?.directManualRoot ?? (await detectDirectManualRoot(handle));
    activeRootHandle = handle;
    activeDirectManualRoot = directMode;
    try {
      await saveWorkspaceHandle(handle, directMode);
    } catch {
      // Allow live folder session even if browser IndexedDB persistence is restricted
    }
  });
}

function classifyPickerError(err: unknown): StorageError {
  const domErr = err as {name?: string; message?: string};
  const msg = domErr?.message ?? '';
  if (domErr?.name === 'AbortError') {
    return new StorageError('USER_CANCELLED', 'Folder selection cancelled.');
  }
  if (/user gesture|user activation/i.test(msg)) {
    return new StorageError(
      'USER_GESTURE_REQUIRED',
      'Click the button again to open the folder picker.',
    );
  }
  if (
    isInsideIframe() ||
    /cross.?origin|subframe|iframe|embedded/i.test(msg)
  ) {
    return new StorageError(
      'BLOCKED_IFRAME',
      'The folder picker is blocked inside an embedded frame.',
    );
  }
  if (domErr?.name === 'SecurityError' || domErr?.name === 'NotAllowedError') {
    return new StorageError(
      'PERMISSION_DENIED',
      'Your browser blocked direct folder write access for this site. Use "Open folder read-only instead" below, or open Noodle in Chrome or Edge for full disk saving.',
    );
  }
  return new StorageError(
    'IO_ERROR',
    msg || 'Unable to open directory picker.',
  );
}

async function openDirectoryPickerSafe(
  pickerWin: PickerWindow,
  startInHandle?: FileSystemDirectoryHandle,
): Promise<FileSystemDirectoryHandle> {
  const tryOpen = async (
    startIn?: FileSystemDirectoryHandle,
  ): Promise<FileSystemDirectoryHandle> => {
    return pickerWin.showDirectoryPicker!({
      mode: 'readwrite',
      ...(startIn ? {startIn: startIn as unknown as 'documents'} : {}),
    });
  };

  const startedAt = Date.now();
  try {
    return await tryOpen(startInHandle);
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const classified = classifyPickerError(err);
    if (classified.code === 'USER_CANCELLED') {
      if (isInsideIframe()) {
        throw new StorageError(
          'BLOCKED_IFRAME',
          'The folder picker is blocked inside an embedded frame. Open Noodle in its own tab.',
        );
      }
      if (elapsedMs < 350) {
        throw new StorageError(
          'IO_ERROR',
          'Your browser closed the folder picker immediately. Try opening Noodle in Chrome or Microsoft Edge, or use "Open folder read-only instead" below.',
        );
      }
      throw classified;
    }
    if (
      startInHandle &&
      classified.code !== 'BLOCKED_IFRAME' &&
      classified.code !== 'USER_GESTURE_REQUIRED' &&
      classified.code !== 'PERMISSION_DENIED'
    ) {
      try {
        return await tryOpen(undefined);
      } catch (bareErr) {
        throw classifyPickerError(bareErr);
      }
    }
    throw classified;
  }
}

export async function pickWorkspaceFolder(options?: {
  startInHandle?: FileSystemDirectoryHandle;
}): Promise<{
  handle: FileSystemDirectoryHandle;
  inspection: FolderInspection;
}> {
  if (!isFileSystemAccessSupported()) {
    throw new StorageError(
      'UNSUPPORTED',
      'Your browser has local folder writing disabled (Brave disables it by default under brave://flags/#file-system-access-api). Use Google Chrome or Microsoft Edge, or enable that flag in Brave.',
    );
  }

  const pickerWin = window as PickerWindow;
  const handle = await openDirectoryPickerSafe(
    pickerWin,
    options?.startInHandle,
  );

  const perm = await queryHandlePermission(handle);
  if (perm !== 'granted') {
    let requested: PermissionState = perm;
    try {
      requested = await requestHandlePermission(handle);
    } catch (permErr) {
      const domErr = permErr as {name?: string; message?: string};
      if (
        domErr?.name === 'SecurityError' ||
        /user gesture|user activation/i.test(domErr?.message ?? '')
      ) {
        throw new StorageError(
          'USER_GESTURE_REQUIRED',
          `Folder "${handle.name}" was selected, but your browser needs one more click to grant read/write access. Click "Reconnect workspace" above.`,
          handle,
        );
      }
      throw new StorageError(
        'PERMISSION_DENIED',
        domErr?.message ||
          `Could not obtain read/write permission for "${handle.name}".`,
      );
    }

    if (requested === 'prompt') {
      throw new StorageError(
        'USER_GESTURE_REQUIRED',
        `Folder "${handle.name}" was selected, but your browser still needs permission confirmation. Click "Reconnect workspace" above and allow access.`,
        handle,
      );
    }

    if (requested !== 'granted') {
      throw new StorageError(
        'PERMISSION_DENIED',
        'Read/write permission for this folder was not granted. Make sure you allow editing files when prompted, or pick a subfolder inside Documents (such as "Noodle Notes").',
      );
    }
  }

  restoredHandleFlag = false;
  const inspection = await inspectWorkspaceFolder(handle);
  return {handle, inspection};
}

export async function restoreSavedWorkspace(): Promise<{
  handle: FileSystemDirectoryHandle;
  folderName: string;
  permission: PermissionState;
  inspection?: FolderInspection;
  directManualRoot?: boolean;
} | null> {
  const row = await loadWorkspaceHandle();
  if (!row || !row.handle) {
    return null;
  }

  restoredHandleFlag = true;
  let permission: PermissionState = 'prompt';
  try {
    permission = await queryHandlePermission(row.handle);
  } catch {
    permission = 'prompt';
  }

  if (permission === 'granted') {
    try {
      const inspection = await inspectWorkspaceFolder(row.handle);
      activeRootHandle = row.handle;
      activeDirectManualRoot = await detectDirectManualRoot(
        row.handle,
        row.directManualRoot,
      );
      return {
        handle: row.handle,
        folderName: row.folderName || row.handle.name,
        permission,
        inspection,
        directManualRoot: activeDirectManualRoot,
      };
    } catch {
      return {
        handle: row.handle,
        folderName: row.folderName || row.handle.name,
        permission: 'prompt',
        directManualRoot: row.directManualRoot,
      };
    }
  }

  return {
    handle: row.handle,
    folderName: row.folderName || row.handle.name,
    permission,
    directManualRoot: row.directManualRoot,
  };
}

export async function reconnectSavedWorkspace(
  handle: FileSystemDirectoryHandle,
): Promise<{
  permission: PermissionState;
  elapsedMs: number;
  inspection?: FolderInspection;
}> {
  const startedAt = Date.now();
  let permission: PermissionState;
  try {
    permission = await requestHandlePermission(handle);
  } catch (err) {
    const domErr = err as {name?: string; message?: string};
    const msg = domErr?.message ?? '';
    if (
      isInsideIframe() ||
      /cross.?origin|subframe|iframe|embedded/i.test(msg)
    ) {
      throw new StorageError(
        'BLOCKED_IFRAME',
        'Folder access cannot be granted inside an embedded window. Open Noodle in a new tab to reconnect your folder.',
      );
    }
    if (domErr?.name === 'NotFoundError') {
      throw new StorageError(
        'NOT_FOUND',
        `Saved folder "${handle.name}" could not be found. Select it again or forget it.`,
      );
    }
    if (
      domErr?.name === 'SecurityError' ||
      domErr?.name === 'NotAllowedError'
    ) {
      return {
        permission: 'prompt',
        elapsedMs: Date.now() - startedAt,
      };
    }
    throw new StorageError(
      'IO_ERROR',
      msg || 'Could not request folder permission.',
    );
  }

  const elapsedMs = Date.now() - startedAt;

  if (permission !== 'granted') {
    if (isInsideIframe()) {
      throw new StorageError(
        'BLOCKED_IFRAME',
        'Folder access cannot be granted inside an embedded window. Open Noodle in a new tab to reconnect your folder.',
      );
    }
    return {permission, elapsedMs};
  }

  try {
    const inspection = await inspectWorkspaceFolder(handle);
    activeRootHandle = handle;
    activeDirectManualRoot = await detectDirectManualRoot(handle);
    return {permission, elapsedMs, inspection};
  } catch (err) {
    const domErr = err as {name?: string; message?: string};
    if (domErr?.name === 'NotFoundError') {
      throw new StorageError(
        'NOT_FOUND',
        `Saved folder "${handle.name}" could not be found on disk. Select it again or forget it.`,
      );
    }
    throw err;
  }
}

export async function forgetSavedWorkspace(): Promise<void> {
  activeRootHandle = null;
  activeDirectManualRoot = false;
  restoredHandleFlag = false;
  cachedEntriesByPath.clear();
  trackedOwnWrites.clear();
  lastScanProblems = [];
  lastScanSummary = null;
  await clearWorkspaceHandle();
}

export function setActiveWorkspaceHandle(
  handle: FileSystemDirectoryHandle,
  directManualRoot = false,
): void {
  activeRootHandle = handle;
  activeDirectManualRoot = directManualRoot;
}

function isPermissionDomError(err: unknown): boolean {
  const name = (err as {name?: string})?.name;
  return (
    name === 'NotAllowedError' ||
    name === 'SecurityError' ||
    (err instanceof StorageError && err.code === 'PERMISSION_DENIED')
  );
}

export async function listNotes(pillar?: Pillar): Promise<StoredNoteEntry[]> {
  const root = requireRootHandle();
  const pillarsToRead: Pillar[] = pillar ? [pillar] : PILLAR_DIRS;

  const problems: ScanProblem[] = [];
  const nested = await Promise.all(
    pillarsToRead.map(async (p) => {
      try {
        const dir = await resolvePillarDir(root, p, false);
        return await scanNotesInDirectory(dir, p, undefined, '', problems);
      } catch (err) {
        if (isPermissionDomError(err)) {
          throw new StorageError(
            'PERMISSION_DENIED',
            'Folder read permission was lost or denied. Please reconnect your workspace folder.',
          );
        }
        return [];
      }
    }),
  );

  const combined = nested.flat();
  combined.sort((a, b) => b.note.updatedAt.localeCompare(a.note.updatedAt));

  if (!pillar) {
    lastScanProblems = problems;
    for (const entry of combined) {
      cachedEntriesByPath.set(entry.path ?? `${entry.pillar}/${entry.fileName}`, entry);
    }
    await rebuildNotesIndex(combined, (entry) =>
      extractAssetPathsFromDoc(entry.note.content),
    );
  }

  return combined;
}

export async function scanWorkspaceChanges(
  reason: WorkspaceScanSummary['reason'] = 'manual',
  options?: {force?: boolean},
): Promise<WorkspaceScanSummary> {
  if (!activeRootHandle) {
    throw new StorageError(
      'NO_WORKSPACE',
      'No workspace folder is currently connected.',
    );
  }

  if (inFlightScanPromise) {
    return inFlightScanPromise;
  }

  const now = Date.now();
  const cooldown =
    reason === 'manual' ? MANUAL_SCAN_DEBOUNCE_MS : AUTO_SCAN_DEBOUNCE_MS;
  if (
    !options?.force &&
    reason !== 'diagnostics' &&
    lastScanSummary &&
    now - lastScanCompletedAt < cooldown
  ) {
    return lastScanSummary;
  }

  const scanPromise = (async (): Promise<WorkspaceScanSummary> => {
    const start = performance.now();
    const root = requireRootHandle();
    if (!activeDirectManualRoot && !(await dirExistsInRoot(root, 'manual'))) {
      if (await detectDirectManualRoot(root)) {
        activeDirectManualRoot = true;
      }
    }
    if (!isChangeDiagRunning && reason !== 'diagnostics') {
      await cleanupOrphanedDiagSyncData(root);
    }
    const previousIndex = await readNotesIndex();
    const prevByPath = new Map<string, NoteIndexRow>();
    for (const row of previousIndex) {
      prevByPath.set(row.path, row);
    }

    const problems: ScanProblem[] = [];
    const scannedNested = await Promise.all(
      PILLAR_DIRS.map(async (p) => {
        try {
          const dir = await resolvePillarDir(root, p, false);
          return await scanNotesInDirectory(dir, p, prevByPath, '', problems);
        } catch (err) {
          if (isPermissionDomError(err)) {
            throw new StorageError(
              'PERMISSION_DENIED',
              'Folder read permission was lost or denied. Please reconnect your workspace folder.',
            );
          }
          return [];
        }
      }),
    );

    const scannedEntries = scannedNested.flat();
    const reconciled = reconcileWorkspaceSnapshot({
      previousIndex,
      scannedEntries,
      ownWrites: trackedOwnWrites,
      problems,
    });

    // Update cache cleanly
    cachedEntriesByPath.clear();
    for (const entry of reconciled.entries) {
      cachedEntriesByPath.set(
        entry.path ?? `${entry.pillar}/${entry.fileName}`,
        entry,
      );
    }

    // Prune stale own-write markers older than 2 minutes
    const cutoff = Date.now() - 120_000;
    for (const [key, marker] of trackedOwnWrites.entries()) {
      if (marker.writtenAt < cutoff) {
        trackedOwnWrites.delete(key);
      }
    }

    // Batch all IndexedDB updates inside a single transaction
    if (previousIndex.length === 0 && reconciled.entries.length > 0) {
      await rebuildNotesIndex(reconciled.entries, (entry) =>
        extractAssetPathsFromDoc(entry.note.content),
      );
    } else {
      await applyBatchIndexChanges({
        upserts: reconciled.upserts.map((entry) => ({
          entry,
          assetPaths: extractAssetPathsFromDoc(entry.note.content),
        })),
        deleteNoteIds: reconciled.deletedNoteIds,
      });
    }

    lastScanProblems = problems;
    const summary: WorkspaceScanSummary = {
      reason,
      scannedFiles: scannedEntries.length,
      addedCount: reconciled.added.length,
      editedCount: reconciled.edited.length,
      deletedCount: reconciled.deletedNoteIds.length,
      movedCount: reconciled.moved.length,
      ignoredOwnWritesCount: reconciled.ignoredOwnWritesCount,
      problemCount: problems.length,
      durationMs: Math.round(performance.now() - start),
      addedNoteIds: reconciled.added.map((e) => e.note.id),
      editedNoteIds: reconciled.edited.map((e) => e.note.id),
      deletedNoteIds: reconciled.deletedNoteIds,
      movedNoteIds: reconciled.moved.map((m) => m.noteId),
      problems,
      entries: reconciled.entries,
    };

    lastScanSummary = summary;
    lastScanCompletedAt = Date.now();
    return summary;
  })();

  inFlightScanPromise = scanPromise;
  try {
    return await scanPromise;
  } finally {
    inFlightScanPromise = null;
  }
}

export async function readNote(
  pillar: Pillar,
  fileName: string,
): Promise<StoredNoteEntry> {
  const root = requireRootHandle();
  const {dirHandle, safeFileName, leafFileName} = await resolveNoteHandle(
    root,
    pillar,
    fileName,
  );

  try {
    const fileHandle = await dirHandle.getFileHandle(leafFileName, {
      create: false,
    });
    const file = await fileHandle.getFile();
    const text = await file.text();
    const parsed = parseNoteJson(text, pillar);
    const computedHash = await computeCanonicalContentHash(parsed.content);
    const note: NoteRecord = {
      ...parsed,
      contentHash: computedHash,
    };
    const {excerpt, wordCount} = deriveExcerptAndWordCount(note.content);
    return {
      note,
      fileName: safeFileName,
      pillar,
      excerpt,
      wordCount,
      path: `${pillar}/${safeFileName}`,
      size: file.size,
      lastModified: file.lastModified,
    };
  } catch (err) {
    if (err instanceof StorageError) {
      throw err;
    }
    throw new StorageError(
      'NOT_FOUND',
      `Could not read note "${safeFileName}" from ${pillar}/.`,
    );
  }
}

export async function createNote(
  input: CreateNoteInput,
): Promise<StoredNoteEntry> {
  assertWritablePillar(input.pillar);
  const cleanTitle = sanitizeName(input.title);
  if (!isValidCategory(input.category)) {
    throw new StorageError('INVALID_NAME', 'Invalid note category.');
  }
  const cleanCategory = sanitizeCategoryLabel(input.category);
  const cleanSubfolder = input.subfolder
    ? sanitizeCategoryLabel(input.subfolder)
    : undefined;

  return enqueueWrite(async () => {
    const root = requireRootHandle();
    const dirHandle = await resolvePillarDir(root, input.pillar, true);
    const id = generateUuid();
    const now = new Date().toISOString();
    const fileName = buildSafeNoteFileName(cleanTitle, id);

    const text = (input.bodyText ?? '').trim();
    const rawContent: TipTapDoc = input.content ?? {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: {id: generateUuid()},
          ...(text ? {content: [{type: 'text', text}]} : {}),
        },
      ],
    };
    const content = ensureBlockIds(rawContent);
    try {
      validateNoteAssetPaths(content);
    } catch (err) {
      throw new StorageError('INVALID_IMAGE_PATH', (err as Error).message);
    }

    const contentDigest = await computeCanonicalContentHash(content);
    const note: NoteRecord = {
      id,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      title: cleanTitle,
      category: cleanCategory,
      ...(cleanSubfolder ? {subfolder: cleanSubfolder} : {}),
      pillar: input.pillar,
      createdAt: now,
      updatedAt: now,
      contentHash: contentDigest,
      content,
      ...(input.pillar === 'ai' && input.aiMeta ? {aiMeta: input.aiMeta} : {}),
    };

    const fullPath = `${input.pillar}/${fileName}`;
    const serialized = JSON.stringify(note, null, 2);
    const stat = await writeFileAtomic(
      dirHandle,
      fullPath,
      fileName,
      serialized,
      contentDigest,
      note.id,
    );

    const {excerpt, wordCount} = deriveExcerptAndWordCount(note.content);
    const entry: StoredNoteEntry = {
      note,
      fileName,
      pillar: input.pillar,
      excerpt,
      wordCount,
      path: fullPath,
      size: stat.size,
      lastModified: stat.lastModified,
    };
    cachedEntriesByPath.set(fullPath, entry);
    await upsertSingleNoteIndex(entry, extractAssetPathsFromDoc(note.content));
    return entry;
  });
}

/**
 * Strictly writes validated AI-synthesized notes into `ai/` only.
 * Explicitly refuses any attempt to write into `manual/` or `sources/`.
 */
export async function saveAiSynthesizedNote(params: {
  targetPillar?: Pillar;
  title: string;
  category?: Category;
  content: TipTapDoc;
  aiMeta: AiNoteMetadata;
}): Promise<StoredNoteEntry> {
  const target = params.targetPillar ?? 'ai';
  if (target !== 'ai') {
    throw new StorageError(
      'SOURCES_IMMUTABLE',
      `Refused AI write to "${target}/": synthesized AI notes may ONLY be saved inside ai/, never manual/ or sources/.`,
    );
  }
  if (!params.aiMeta || params.aiMeta.isAiGenerated !== true) {
    throw new StorageError(
      'INVALID_NOTE',
      'AI synthesis notes require validated aiMeta provenance metadata.',
    );
  }
  return createNote({
    pillar: 'ai',
    title: params.title,
    category: params.category ?? 'Study',
    content: params.content,
    aiMeta: params.aiMeta,
  });
}

export async function updateNote(
  pillar: Pillar,
  fileName: string,
  patch: UpdateNoteInput,
): Promise<StoredNoteEntry> {
  assertWritablePillar(pillar);

  return enqueueWrite(async () => {
    const root = requireRootHandle();
    const {dirHandle, safeFileName, leafFileName} = await resolveNoteHandle(
      root,
      pillar,
      fileName,
    );
    const existing = await readNote(pillar, safeFileName);

    const nextTitle =
      patch.title !== undefined ? sanitizeName(patch.title) : existing.note.title;
    const rawNextCategory =
      patch.category !== undefined ? patch.category : existing.note.category;
    if (!isValidCategory(rawNextCategory)) {
      throw new StorageError('INVALID_NAME', 'Invalid note category.');
    }
    const nextCategory = sanitizeCategoryLabel(rawNextCategory);
    const nextSubfolder =
      patch.subfolder === undefined
        ? existing.note.subfolder
        : patch.subfolder
          ? sanitizeCategoryLabel(patch.subfolder) || undefined
          : undefined;

    const nextContent = ensureBlockIds(patch.content ?? existing.note.content);
    try {
      validateNoteAssetPaths(nextContent);
    } catch (err) {
      throw new StorageError('INVALID_IMAGE_PATH', (err as Error).message);
    }

    const contentDigest = await computeCanonicalContentHash(nextContent);

    const updatedNote: NoteRecord = {
      ...existing.note,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      title: nextTitle,
      category: nextCategory,
      ...(nextSubfolder ? {subfolder: nextSubfolder} : {}),
      pillar,
      updatedAt: new Date().toISOString(),
      contentHash: contentDigest,
      content: nextContent,
    };
    if (!nextSubfolder) {
      delete updatedNote.subfolder;
    }

    const fullPath = `${pillar}/${safeFileName}`;
    const serialized = JSON.stringify(updatedNote, null, 2);
    const stat = await writeFileAtomic(
      dirHandle,
      fullPath,
      leafFileName,
      serialized,
      contentDigest,
      updatedNote.id,
    );

    const {excerpt, wordCount} = deriveExcerptAndWordCount(updatedNote.content);
    const entry: StoredNoteEntry = {
      note: updatedNote,
      fileName: safeFileName,
      pillar,
      excerpt,
      wordCount,
      path: fullPath,
      size: stat.size,
      lastModified: stat.lastModified,
    };
    cachedEntriesByPath.set(fullPath, entry);
    await upsertSingleNoteIndex(
      entry,
      extractAssetPathsFromDoc(updatedNote.content),
    );
    return entry;
  });
}

export async function renameNote(
  pillar: Pillar,
  fileName: string,
  newTitle: string,
): Promise<StoredNoteEntry> {
  assertWritablePillar(pillar);
  const cleanTitle = sanitizeName(newTitle);

  return enqueueWrite(async () => {
    const root = requireRootHandle();
    const {dirHandle, safeFileName, leafFileName} = await resolveNoteHandle(
      root,
      pillar,
      fileName,
    );
    const existing = await readNote(pillar, safeFileName);
    const targetLeafName = buildSafeNoteFileName(cleanTitle, existing.note.id);
    const targetRelPath = safeFileName.includes('/')
      ? `${safeFileName.slice(0, safeFileName.lastIndexOf('/'))}/${targetLeafName}`
      : targetLeafName;
    const contentDigest = await computeCanonicalContentHash(existing.note.content);

    const renamedNote: NoteRecord = {
      ...existing.note,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      title: cleanTitle,
      updatedAt: new Date().toISOString(),
      contentHash: contentDigest,
    };

    const oldFullPath = `${pillar}/${safeFileName}`;
    const newFullPath = `${pillar}/${targetRelPath}`;
    const serialized = JSON.stringify(renamedNote, null, 2);
    const stat = await writeFileAtomic(
      dirHandle,
      newFullPath,
      targetLeafName,
      serialized,
      contentDigest,
      renamedNote.id,
    );

    if (targetLeafName !== leafFileName) {
      trackedOwnWrites.set(oldFullPath, {
        path: oldFullPath,
        noteId: renamedNote.id,
        contentHash: contentDigest,
        writtenAt: Date.now(),
        op: 'delete',
      });
      cachedEntriesByPath.delete(oldFullPath);
      await dirHandle.removeEntry(leafFileName);
    }

    const {excerpt, wordCount} = deriveExcerptAndWordCount(renamedNote.content);
    const entry: StoredNoteEntry = {
      note: renamedNote,
      fileName: targetRelPath,
      pillar,
      excerpt,
      wordCount,
      path: newFullPath,
      size: stat.size,
      lastModified: stat.lastModified,
    };
    cachedEntriesByPath.set(newFullPath, entry);
    await upsertSingleNoteIndex(
      entry,
      extractAssetPathsFromDoc(renamedNote.content),
    );
    return entry;
  });
}

export async function deleteNote(pillar: Pillar, fileName: string): Promise<void> {
  assertWritablePillar(pillar);

  return enqueueWrite(async () => {
    const root = requireRootHandle();
    const {dirHandle, safeFileName, leafFileName} = await resolveNoteHandle(
      root,
      pillar,
      fileName,
    );
    let noteId: string | null = null;
    let contentHash = '';
    try {
      const existing = await readNote(pillar, safeFileName);
      noteId = existing.note.id;
      contentHash = existing.note.contentHash;
    } catch {
      noteId = null;
    }
    const fullPath = `${pillar}/${safeFileName}`;
    trackedOwnWrites.set(fullPath, {
      path: fullPath,
      noteId: noteId ?? undefined,
      contentHash,
      writtenAt: Date.now(),
      op: 'delete',
    });
    cachedEntriesByPath.delete(fullPath);
    await dirHandle.removeEntry(leafFileName);
    if (noteId) {
      await deleteSingleNoteIndex(noteId);
    }
  });
}

export async function moveNote(
  fromPillar: Pillar,
  fileName: string,
  toPillar: Pillar,
): Promise<StoredNoteEntry> {
  assertWritablePillar(fromPillar);
  assertWritablePillar(toPillar);

  return enqueueWrite(async () => {
    const root = requireRootHandle();
    const {dirHandle: fromDir, safeFileName, leafFileName} =
      await resolveNoteHandle(root, fromPillar, fileName);

    if (fromPillar === toPillar) {
      return readNote(fromPillar, safeFileName);
    }

    const existing = await readNote(fromPillar, safeFileName);
    const toDir = await resolvePillarDir(root, toPillar, true);
    const contentDigest = await computeCanonicalContentHash(existing.note.content);

    const movedNote: NoteRecord = {
      ...existing.note,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      pillar: toPillar,
      updatedAt: new Date().toISOString(),
      contentHash: contentDigest,
    };

    const oldFullPath = `${fromPillar}/${safeFileName}`;
    const newFullPath = `${toPillar}/${leafFileName}`;
    const serialized = JSON.stringify(movedNote, null, 2);
    const stat = await writeFileAtomic(
      toDir,
      newFullPath,
      leafFileName,
      serialized,
      contentDigest,
      movedNote.id,
    );

    trackedOwnWrites.set(oldFullPath, {
      path: oldFullPath,
      noteId: movedNote.id,
      contentHash: contentDigest,
      writtenAt: Date.now(),
      op: 'delete',
    });
    cachedEntriesByPath.delete(oldFullPath);
    await fromDir.removeEntry(leafFileName);

    const {excerpt, wordCount} = deriveExcerptAndWordCount(movedNote.content);
    const entry: StoredNoteEntry = {
      note: movedNote,
      fileName: leafFileName,
      pillar: toPillar,
      excerpt,
      wordCount,
      path: newFullPath,
      size: stat.size,
      lastModified: stat.lastModified,
    };
    cachedEntriesByPath.set(newFullPath, entry);
    await upsertSingleNoteIndex(
      entry,
      extractAssetPathsFromDoc(movedNote.content),
    );
    return entry;
  });
}

export function parseWorkspaceRelativeNoteTarget(targetPath: string): {
  toPillar: WritablePillar;
  targetRelPath: string;
  leafFileName: string;
  subdirs: string[];
} {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new StorageError('INVALID_NAME', 'Target note path cannot be empty.');
  }

  const normalized = targetPath.replace(/\\/g, '/').trim();
  if (normalized.startsWith('/')) {
    throw new StorageError(
      'PATH_TRAVERSAL',
      'Target note path must be workspace-relative.',
    );
  }

  const segments = normalized.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) {
    throw new StorageError(
      'INVALID_NAME',
      'Target note path must include a folder and filename (e.g., manual/Study/note.json).',
    );
  }

  const rawPillar = segments[0];
  assertWritablePillar(rawPillar);

  const sanitizedSegments = segments.slice(1).map((seg) => sanitizeName(seg));
  const leafFileName = sanitizedSegments[sanitizedSegments.length - 1];
  if (!leafFileName.toLowerCase().endsWith('.json')) {
    throw new StorageError(
      'INVALID_NAME',
      'Note files must use the .json extension.',
    );
  }

  return {
    toPillar: rawPillar,
    targetRelPath: sanitizedSegments.join('/'),
    leafFileName,
    subdirs: sanitizedSegments.slice(0, -1),
  };
}

export async function moveNoteToFolder(
  entry: StoredNoteEntry,
  targetPath: string,
): Promise<StoredNoteEntry> {
  assertWritablePillar(entry.pillar);
  const {
    toPillar,
    targetRelPath,
    leafFileName: targetLeafName,
    subdirs,
  } = parseWorkspaceRelativeNoteTarget(targetPath);

  return enqueueWrite(async () => {
    const root = requireRootHandle();
    const {
      dirHandle: fromDir,
      safeFileName,
      leafFileName: sourceLeafName,
    } = await resolveNoteHandle(root, entry.pillar, entry.fileName);

    const oldFullPath = `${entry.pillar}/${safeFileName}`;
    const newFullPath = `${toPillar}/${targetRelPath}`;
    if (oldFullPath === newFullPath) {
      return readNote(entry.pillar, safeFileName);
    }

    const existing = await readNote(entry.pillar, safeFileName);
    let toDir = await resolvePillarDir(root, toPillar, true);
    for (const sub of subdirs) {
      toDir = await toDir.getDirectoryHandle(sub, {create: true});
    }

    const contentDigest = await computeCanonicalContentHash(existing.note.content);
    const movedNote: NoteRecord = {
      ...existing.note,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      pillar: toPillar,
      updatedAt: new Date().toISOString(),
      contentHash: contentDigest,
    };

    const serialized = JSON.stringify(movedNote, null, 2);
    const stat = await writeFileAtomic(
      toDir,
      newFullPath,
      targetLeafName,
      serialized,
      contentDigest,
      movedNote.id,
    );

    trackedOwnWrites.set(oldFullPath, {
      path: oldFullPath,
      noteId: movedNote.id,
      contentHash: contentDigest,
      writtenAt: Date.now(),
      op: 'delete',
    });
    cachedEntriesByPath.delete(oldFullPath);
    await fromDir.removeEntry(sourceLeafName);

    const {excerpt, wordCount} = deriveExcerptAndWordCount(movedNote.content);
    const updatedEntry: StoredNoteEntry = {
      note: movedNote,
      fileName: targetRelPath,
      pillar: toPillar,
      excerpt,
      wordCount,
      path: newFullPath,
      size: stat.size,
      lastModified: stat.lastModified,
    };
    cachedEntriesByPath.set(newFullPath, updatedEntry);
    await upsertSingleNoteIndex(
      updatedEntry,
      extractAssetPathsFromDoc(movedNote.content),
    );
    return updatedEntry;
  });
}

/**
 * Diagnostics Self-Checks for Milestone 2
 */
export async function runStorageDiagnostics(): Promise<DiagnosticCheckResult[]> {
  const results: DiagnosticCheckResult[] = [];

  // 1. Picker works / workspace connected
  {
    const start = performance.now();
    const supported = isFileSystemAccessSupported();
    const iframe = isInsideIframe();
    if (!supported) {
      results.push({
        id: 'picker-works',
        name: 'Workspace Picker Supported & Active',
        status: 'FAIL',
        details:
          'File System Access API (showDirectoryPicker) is unsupported in this browser.',
        durationMs: Math.round(performance.now() - start),
      });
    } else if (activeRootHandle) {
      results.push({
        id: 'picker-works',
        name: 'Workspace Picker Supported & Active',
        status: 'PASS',
        details: `Connected to folder "${activeRootHandle.name}" with readwrite access.`,
        durationMs: Math.round(performance.now() - start),
      });
    } else if (iframe) {
      results.push({
        id: 'picker-works',
        name: 'Workspace Picker Supported & Active',
        status: 'FAIL',
        details:
          'Running inside an embedded iframe where showDirectoryPicker may be blocked. Open in a new tab and select a workspace folder.',
        durationMs: Math.round(performance.now() - start),
      });
    } else {
      results.push({
        id: 'picker-works',
        name: 'Workspace Picker Supported & Active',
        status: 'FAIL',
        details:
          'API is available, but no workspace folder has been selected yet.',
        durationMs: Math.round(performance.now() - start),
      });
    }
  }

  // 2. Handle restored after reload
  {
    const start = performance.now();
    try {
      const saved = await loadWorkspaceHandle();
      if (saved && saved.handle) {
        const perm = await queryHandlePermission(saved.handle);
        results.push({
          id: 'handle-restored',
          name: 'Handle Persisted & Restored via IndexedDB',
          status: 'PASS',
          details: `IndexedDB holds handle "${saved.folderName}" (permission: ${perm}, restoredOnBoot: ${restoredHandleFlag}).`,
          durationMs: Math.round(performance.now() - start),
        });
      } else {
        results.push({
          id: 'handle-restored',
          name: 'Handle Persisted & Restored via IndexedDB',
          status: 'FAIL',
          details:
            'No directory handle stored in IndexedDB yet. Select a workspace folder first, then reload.',
          durationMs: Math.round(performance.now() - start),
        });
      }
    } catch (err) {
      results.push({
        id: 'handle-restored',
        name: 'Handle Persisted & Restored via IndexedDB',
        status: 'FAIL',
        details: `IndexedDB handle lookup failed: ${(err as Error).message}`,
        durationMs: Math.round(performance.now() - start),
      });
    }
  }

  // 3. Write to sources/ is refused
  {
    const start = performance.now();
    try {
      await createNote({
        pillar: 'sources' as unknown as WritablePillar,
        title: 'Illegal Source Write Test',
        category: 'Study',
        bodyText: 'Should be refused.',
      });
      results.push({
        id: 'sources-immutable',
        name: 'Write to sources/ Refused',
        status: 'FAIL',
        details: 'Storage module unexpectedly allowed a write to sources/.',
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      const isExpected =
        err instanceof StorageError && err.code === 'SOURCES_IMMUTABLE';
      results.push({
        id: 'sources-immutable',
        name: 'Write to sources/ Refused',
        status: isExpected ? 'PASS' : 'FAIL',
        details: isExpected
          ? `Refused cleanly (${err.code}: ${err.message}).`
          : `Unexpected error: ${(err as Error).message}`,
        durationMs: Math.round(performance.now() - start),
      });
    }
  }

  // 4. Name with '../' is rejected
  {
    const start = performance.now();
    const maliciousInputs = ['../secret.json', 'foo/../../bar', 'bad\x00name'];
    const rejectedAll = maliciousInputs.every((candidate) => {
      try {
        sanitizeName(candidate);
        return false;
      } catch (err) {
        return (
          err instanceof StorageError &&
          (err.code === 'PATH_TRAVERSAL' || err.code === 'INVALID_NAME')
        );
      }
    });

    results.push({
      id: 'traversal-rejected',
      name: "Path Traversal ('../') Rejected",
      status: rejectedAll ? 'PASS' : 'FAIL',
      details: rejectedAll
        ? 'Rejected "../secret.json", "foo/../../bar", and control-character filenames.'
        : 'One or more unsafe filenames passed sanitization.',
      durationMs: Math.round(performance.now() - start),
    });
  }

  // 5. 200 notes list in a reasonable time
  {
    const start = performance.now();
    if (!activeRootHandle) {
      results.push({
        id: 'bench-200-notes',
        name: '200 Notes List Performance',
        status: 'FAIL',
        details:
          'Connect a workspace folder first to benchmark listing 200 real JSON files on disk.',
        durationMs: Math.round(performance.now() - start),
      });
    } else {
      const benchDirName = '_diag_bench_200';
      let noodleDir: FileSystemDirectoryHandle | null = null;
      const noodleExistedBefore = await dirExistsInRoot(activeRootHandle, '.noodle');
      try {
        noodleDir = await activeRootHandle.getDirectoryHandle('.noodle', {
          create: true,
        });
        const benchDir = await noodleDir.getDirectoryHandle(benchDirName, {
          create: true,
        });

        const now = new Date().toISOString();
        const sampleContent: TipTapDoc = {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              attrs: {id: 'bench-blk-1'},
              content: [{type: 'text', text: 'Diagnostic benchmark note body.'}],
            },
          ],
        };

        // Seed 200 valid note files inside .noodle/_diag_bench_200
        for (let i = 0; i < 200; i += 1) {
          const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
          const fileName = `bench-note-${String(i).padStart(3, '0')}.json`;
          const payload = JSON.stringify({
            id,
            schemaVersion: 1,
            title: `Benchmark Note ${i + 1}`,
            category: 'Study',
            pillar: 'manual',
            createdAt: now,
            updatedAt: now,
            contentHash: `sha256:bench-${i}`,
            content: sampleContent,
          });
          const fh = await benchDir.getFileHandle(fileName, {create: true});
          const w = await fh.createWritable();
          await w.write(payload);
          await w.close();
        }

        const listStart = performance.now();
        const listed = await readNotesInDirectory(benchDir, 'manual');
        const listMs = Math.round(performance.now() - listStart);

        const passed = listed.length === 200 && listMs < 5000;
        results.push({
          id: 'bench-200-notes',
          name: '200 Notes List Performance',
          status: passed ? 'PASS' : 'FAIL',
          details: `Listed ${listed.length}/200 JSON note files in ${listMs} ms (threshold < 5000 ms).`,
          durationMs: listMs,
        });
      } catch (err) {
        results.push({
          id: 'bench-200-notes',
          name: '200 Notes List Performance',
          status: 'FAIL',
          details: `Benchmark failed: ${(err as Error).message}`,
          durationMs: Math.round(performance.now() - start),
        });
      } finally {
        if (noodleDir) {
          try {
            await noodleDir.removeEntry(benchDirName, {recursive: true});
          } catch {
            // Ignore cleanup failure
          }
        }
        if (!noodleExistedBefore && activeRootHandle) {
          await removeDirIfEmpty(activeRootHandle, '.noodle');
        }
      }
    }
  }

  return results;
}

// ---------- IMAGE ASSETS (Milestone 4) ----------

export interface ImportableImageFile {
  name: string;
  type: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

export interface ImportedAssetResult {
  assetPath: string;
  reused: boolean;
  sha256: string;
}

function inferImageExtension(name: string, mimeType: string): string {
  const lowerName = (name || '').toLowerCase().trim();
  const lowerMime = (mimeType || '').toLowerCase().trim();

  if (lowerName.endsWith('.svg') || lowerMime === 'image/svg+xml') {
    throw new StorageError(
      'INVALID_IMAGE_TYPE',
      'SVG images are disabled for security reasons. Allowed formats: PNG, JPG, JPEG, GIF, WebP.',
    );
  }

  let ext = '';
  const lastDot = lowerName.lastIndexOf('.');
  if (lastDot > 0 && lastDot < lowerName.length - 1) {
    ext = lowerName.slice(lastDot + 1);
  }

  if (!ext && lowerMime) {
    if (lowerMime === 'image/png') ext = 'png';
    else if (lowerMime === 'image/jpeg') ext = 'jpg';
    else if (lowerMime === 'image/gif') ext = 'gif';
    else if (lowerMime === 'image/webp') ext = 'webp';
  }

  const allowedExts: readonly string[] = ALLOWED_IMAGE_EXTENSIONS;
  const allowedMimes: readonly string[] = ALLOWED_IMAGE_MIME_TYPES;

  if (!allowedExts.includes(ext)) {
    throw new StorageError(
      'INVALID_IMAGE_TYPE',
      `Unsupported image format "${ext || lowerMime || 'unknown'}". Allowed: PNG, JPG, JPEG, GIF, WebP.`,
    );
  }

  if (lowerMime && !allowedMimes.includes(lowerMime)) {
    throw new StorageError(
      'INVALID_IMAGE_TYPE',
      `Unsupported image MIME type "${lowerMime}". Allowed: PNG, JPG, JPEG, GIF, WebP.`,
    );
  }

  return ext;
}

function mimeForExtension(ext: string): string {
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function buildSafeAssetStem(rawName: string): string {
  const base = rawName.replace(/\.[^.]+$/, '');
  const slug = base
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'image';
}

async function fileExistsInDir(
  dir: FileSystemDirectoryHandle,
  fileName: string,
): Promise<boolean> {
  try {
    await dir.getFileHandle(fileName, {create: false});
    return true;
  } catch {
    return false;
  }
}

export async function importImageAsset(
  file: ImportableImageFile,
): Promise<ImportedAssetResult> {
  const ext = inferImageExtension(file.name, file.type);

  if (!Number.isFinite(file.size) || file.size <= 0) {
    throw new StorageError('INVALID_IMAGE_TYPE', 'Image file is empty.');
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new StorageError(
      'FILE_TOO_LARGE',
      'Image exceeds the 10 MB size limit.',
    );
  }

  const buffer = await file.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new StorageError('INVALID_IMAGE_TYPE', 'Image file is empty.');
  }
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new StorageError(
      'FILE_TOO_LARGE',
      'Image exceeds the 10 MB size limit.',
    );
  }

  const sha256 = await computeBytesSha256(buffer);
  const shortHash = sha256.replace('sha256:', '').slice(0, 8);
  const stem = buildSafeAssetStem(file.name);

  return enqueueWrite(async () => {
    if (activeRootHandle) {
      const assetsDir = await activeRootHandle.getDirectoryHandle('assets', {
        create: true,
      });

      // 1. Check IndexedDB metadata cache for identical bytes
      const cachedMeta = await findAssetMetaBySha256(sha256);
      if (cachedMeta && isWorkspaceRelativeAssetPath(cachedMeta.assetPath)) {
        const cachedFileName = sanitizeName(
          cachedMeta.assetPath.slice('assets/'.length),
        );
        if (await fileExistsInDir(assetsDir, cachedFileName)) {
          return {
            assetPath: cachedMeta.assetPath,
            reused: true,
            sha256,
          };
        }
      }

      // 2. Scan assets/ on disk in case file already exists without cache entry
      for await (const [existingName, handle] of assetsDir.entries()) {
        if (handle.kind !== 'file' || existingName.startsWith('.')) {
          continue;
        }
        try {
          const existingFile = await (handle as FileSystemFileHandle).getFile();
          if (existingFile.size !== buffer.byteLength) {
            continue;
          }
          const existingBytes = await existingFile.arrayBuffer();
          const existingHash = await computeBytesSha256(existingBytes);
          const existingRel = `assets/${existingName}`;
          await upsertAssetMeta({
            assetPath: existingRel,
            sha256: existingHash,
            byteSize: existingFile.size,
            updatedAt: new Date().toISOString(),
          });
          if (existingHash === sha256) {
            return {
              assetPath: existingRel,
              reused: true,
              sha256,
            };
          }
        } catch {
          // Ignore unreadable unrelated entry
        }
      }

      // 3. Collision-safe unique filename with content-hash suffix
      let suffix = 0;
      let candidateName = sanitizeName(`${stem}-${shortHash}.${ext}`);
      while (await fileExistsInDir(assetsDir, candidateName)) {
        suffix += 1;
        candidateName = sanitizeName(`${stem}-${shortHash}-${suffix}.${ext}`);
      }

      const relPath = `assets/${candidateName}`;
      await writeBinaryFileAtomic(
        assetsDir,
        relPath,
        candidateName,
        buffer,
        sha256,
      );
      await upsertAssetMeta({
        assetPath: relPath,
        sha256,
        byteSize: buffer.byteLength,
        updatedAt: new Date().toISOString(),
      });

      return {
        assetPath: relPath,
        reused: false,
        sha256,
      };
    }

    // Fallback when no workspace folder is connected (demo / iframe preview mode)
    for (const [existingRel, entry] of memoryAssets.entries()) {
      if (entry.sha256 === sha256) {
        return {
          assetPath: existingRel,
          reused: true,
          sha256,
        };
      }
    }

    let suffix = 0;
    let candidateName = sanitizeName(`${stem}-${shortHash}.${ext}`);
    while (memoryAssets.has(`assets/${candidateName}`)) {
      suffix += 1;
      candidateName = sanitizeName(`${stem}-${shortHash}-${suffix}.${ext}`);
    }
    const relPath = `assets/${candidateName}`;
    memoryAssets.set(relPath, {
      blob: new Blob([buffer], {type: file.type || mimeForExtension(ext)}),
      sha256,
    });
    await upsertAssetMeta({
      assetPath: relPath,
      sha256,
      byteSize: buffer.byteLength,
      updatedAt: new Date().toISOString(),
    });

    return {
      assetPath: relPath,
      reused: false,
      sha256,
    };
  });
}

export async function readAssetObjectUrl(relativePath: string): Promise<string> {
  if (!isWorkspaceRelativeAssetPath(relativePath)) {
    throw new StorageError(
      'PATH_TRAVERSAL',
      `Invalid asset path "${relativePath}". Images must be inside assets/.`,
    );
  }

  const fileName = sanitizeName(relativePath.slice('assets/'.length));

  if (activeRootHandle) {
    try {
      const assetsDir = await activeRootHandle.getDirectoryHandle('assets', {
        create: false,
      });
      const fileHandle = await assetsDir.getFileHandle(fileName, {
        create: false,
      });
      const file = await fileHandle.getFile();
      return URL.createObjectURL(file);
    } catch {
      throw new StorageError(
        'NOT_FOUND',
        formatMissingImageMessage(relativePath),
      );
    }
  }

  const mem = memoryAssets.get(relativePath);
  if (!mem) {
    throw new StorageError(
      'NOT_FOUND',
      formatMissingImageMessage(relativePath),
    );
  }
  return URL.createObjectURL(mem.blob);
}

export async function syncNoteAssetsIndex(
  noteId: string,
  content: TipTapDoc,
): Promise<void> {
  await upsertNoteAssets(noteId, extractAssetPathsFromDoc(content));
}

export async function removeNoteFromAssetsIndex(noteId: string): Promise<void> {
  await removeNoteAssets(noteId);
}

export async function previewOrphanAssetsForNoteDelete(
  noteId: string,
  content: TipTapDoc,
): Promise<{orphanAssets: string[]; needsFirstConfirmation: boolean}> {
  const candidates = extractAssetPathsFromDoc(content).filter(
    isWorkspaceRelativeAssetPath,
  );
  const orphanAssets = await findOrphanAssetsForNote(noteId, candidates);
  const confirmedBefore = await hasConfirmedAssetCleanup();
  return {
    orphanAssets,
    needsFirstConfirmation: orphanAssets.length > 0 && !confirmedBefore,
  };
}

export async function deleteAssetsFromWorkspace(
  assetPaths: string[],
): Promise<string[]> {
  if (assetPaths.length === 0) {
    return [];
  }

  const validPaths = assetPaths.map((p) => {
    if (!isWorkspaceRelativeAssetPath(p)) {
      throw new StorageError(
        'PATH_TRAVERSAL',
        `Refused asset deletion outside assets/: "${p}".`,
      );
    }
    return sanitizeName(p.slice('assets/'.length));
  });

  return enqueueWrite(async () => {
    const deleted: string[] = [];
    if (activeRootHandle) {
      let assetsDir: FileSystemDirectoryHandle | null = null;
      try {
        assetsDir = await activeRootHandle.getDirectoryHandle('assets', {
          create: false,
        });
      } catch {
        assetsDir = null;
      }

      if (assetsDir) {
        for (let i = 0; i < validPaths.length; i += 1) {
          const fileName = validPaths[i];
          const relPath = assetPaths[i];
          try {
            await assetsDir.removeEntry(fileName);
            deleted.push(relPath);
          } catch {
            // File already missing
          }
          await removeAssetMeta(relPath);
        }
      }
    } else {
      for (const relPath of assetPaths) {
        if (memoryAssets.delete(relPath)) {
          deleted.push(relPath);
        }
        await removeAssetMeta(relPath);
      }
    }

    await markAssetCleanupConfirmed();
    return deleted;
  });
}

/**
 * Diagnostics Self-Checks for Milestone 4 (Images & Assets)
 */
export async function runImageDiagnostics(): Promise<DiagnosticCheckResult[]> {
  const results: DiagnosticCheckResult[] = [];
  const createdAssetsForCleanup: string[] = [];
  const assetsExistedBefore = activeRootHandle
    ? await dirExistsInRoot(activeRootHandle, 'assets')
    : true;

  const makeFakeImage = (
    name: string,
    bytes: number[],
    type = 'image/png',
  ): ImportableImageFile => {
    const arr = new Uint8Array(bytes);
    return {
      name,
      type,
      size: arr.byteLength,
      arrayBuffer: async () => arr.buffer.slice(0),
    };
  };

  try {
    // 1. Duplicate-name collision (two different files named image.png never overwrite)
    {
      const start = performance.now();
      try {
        const resA = await importImageAsset(
          makeFakeImage('image.png', [137, 80, 78, 71, 1, 2, 3, 10]),
        );
        createdAssetsForCleanup.push(resA.assetPath);
        const resB = await importImageAsset(
          makeFakeImage('image.png', [137, 80, 78, 71, 4, 5, 6, 20]),
        );
        createdAssetsForCleanup.push(resB.assetPath);

        const passed =
          resA.assetPath.startsWith('assets/') &&
          resB.assetPath.startsWith('assets/') &&
          resA.assetPath !== resB.assetPath;

        results.push({
          id: 'img-collision',
          name: 'Duplicate-Name Collision Handled',
          status: passed ? 'PASS' : 'FAIL',
          details: passed
            ? `Two distinct "image.png" files stored separately as "${resA.assetPath}" and "${resB.assetPath}".`
            : 'Duplicate filenames collided or produced invalid paths.',
          durationMs: Math.round(performance.now() - start),
        });
      } catch (err) {
        results.push({
          id: 'img-collision',
          name: 'Duplicate-Name Collision Handled',
          status: 'FAIL',
          details: `Failed: ${(err as Error).message}`,
          durationMs: Math.round(performance.now() - start),
        });
      }
    }

    // 2. Same-bytes dedupe (reuses existing file)
    {
      const start = performance.now();
      try {
        const sameBytes = [137, 80, 78, 71, 99, 88, 77, 66, 55];
        const first = await importImageAsset(
          makeFakeImage('diagram-copy-1.png', sameBytes),
        );
        createdAssetsForCleanup.push(first.assetPath);
        const second = await importImageAsset(
          makeFakeImage('diagram-copy-2.png', sameBytes),
        );

        const passed =
          first.assetPath === second.assetPath && second.reused === true;

        results.push({
          id: 'img-dedupe',
          name: 'Same-Bytes Image Deduplication',
          status: passed ? 'PASS' : 'FAIL',
          details: passed
            ? `Identical bytes reused existing "${first.assetPath}" (reused=${String(second.reused)}).`
            : `Expected reuse of "${first.assetPath}", got "${second.assetPath}" (reused=${String(second.reused)}).`,
          durationMs: Math.round(performance.now() - start),
        });
      } catch (err) {
        results.push({
          id: 'img-dedupe',
          name: 'Same-Bytes Image Deduplication',
          status: 'FAIL',
          details: `Failed: ${(err as Error).message}`,
          durationMs: Math.round(performance.now() - start),
        });
      }
    }

    // 3. Traversal, absolute paths, SVG & oversized files rejected
    {
      const start = performance.now();
      const badPaths = [
        '/Users/student/secret.png',
        'C:\\images\\pic.png',
        'assets/../notes/evil.png',
        'https://evil.example/img.png',
      ];
      const allBadPathsRejected = badPaths.every((badSrc) => {
        try {
          validateNoteAssetPaths({
            type: 'doc',
            content: [{type: 'image', attrs: {id: 'bad-1', src: badSrc}}],
          });
          return false;
        } catch {
          return true;
        }
      });

      let svgRejected = false;
      try {
        await importImageAsset(
          makeFakeImage('vector.svg', [60, 115, 118, 103, 62], 'image/svg+xml'),
        );
      } catch (err) {
        svgRejected =
          err instanceof StorageError && err.code === 'INVALID_IMAGE_TYPE';
      }

      let traversalReadRejected = false;
      try {
        await readAssetObjectUrl('assets/../manual/secret.json');
      } catch (err) {
        traversalReadRejected =
          err instanceof StorageError && err.code === 'PATH_TRAVERSAL';
      }

      const passed =
        allBadPathsRejected && svgRejected && traversalReadRejected;
      results.push({
        id: 'img-traversal-rejected',
        name: 'Image Traversal, Absolute Paths & SVG Rejected',
        status: passed ? 'PASS' : 'FAIL',
        details: passed
          ? 'Rejected absolute/URL/traversal image paths on save, blocked SVG uploads, and refused assets/../ reads.'
          : 'One or more unsafe image paths or SVG uploads were not rejected.',
        durationMs: Math.round(performance.now() - start),
      });
    }

    // 4. Orphan cleanup keeps shared images
    {
      const start = performance.now();
      const diagNoteA = '_diag_note_a';
      const diagNoteB = '_diag_note_b';
      const uniqueAsset = 'assets/_diag-unique-only.png';
      const sharedAsset = 'assets/_diag-shared.png';
      try {
        await upsertNoteAssets(diagNoteA, [uniqueAsset, sharedAsset]);
        await upsertNoteAssets(diagNoteB, [sharedAsset]);

        const orphans = await findOrphanAssetsForNote(diagNoteA, [
          uniqueAsset,
          sharedAsset,
        ]);
        const passed =
          orphans.length === 1 &&
          orphans[0] === uniqueAsset &&
          !orphans.includes(sharedAsset);

        results.push({
          id: 'img-orphan-cleanup',
          name: 'Orphan Cleanup Keeps Shared Images',
          status: passed ? 'PASS' : 'FAIL',
          details: passed
            ? `Deleting note A flags only unreferenced "${uniqueAsset}" and preserves shared "${sharedAsset}".`
            : `Unexpected orphan list: ${JSON.stringify(orphans)}`,
          durationMs: Math.round(performance.now() - start),
        });
      } catch (err) {
        results.push({
          id: 'img-orphan-cleanup',
          name: 'Orphan Cleanup Keeps Shared Images',
          status: 'FAIL',
          details: `Failed: ${(err as Error).message}`,
          durationMs: Math.round(performance.now() - start),
        });
      } finally {
        await removeNoteAssets(diagNoteA);
        await removeNoteAssets(diagNoteB);
      }
    }

    // 5. Missing file placeholder & no autosave triggered
    {
      const start = performance.now();
      const missingRel = 'assets/missing-diag-file-404.png';
      let threwNotFound = false;
      let placeholderText = '';
      try {
        await readAssetObjectUrl(missingRel);
      } catch (err) {
        threwNotFound =
          err instanceof StorageError && err.code === 'NOT_FOUND';
        placeholderText = (err as Error).message;
      }

      const expectedMsg = formatMissingImageMessage(missingRel);
      const autosaveTriggered = shouldScheduleAutosave({
        editable: true,
        isHydrating: false,
        docChanged: false,
        isUniqueIdInit: false,
        currentCanonical: 'same',
        lastSavedCanonical: 'same',
      });

      const passed =
        threwNotFound &&
        placeholderText === expectedMsg &&
        !autosaveTriggered;

      results.push({
        id: 'img-missing-placeholder',
        name: 'Missing Image Placeholder & No Autosave',
        status: passed ? 'PASS' : 'FAIL',
        details: passed
          ? `Missing asset resolved cleanly to "${expectedMsg}" without crashing or triggering autosave.`
          : 'Missing asset check did not produce expected placeholder behavior.',
        durationMs: Math.round(performance.now() - start),
      });
    }
  } finally {
    if (createdAssetsForCleanup.length > 0) {
      try {
        const uniqueCleanup = Array.from(new Set(createdAssetsForCleanup));
        // Clean up diagnostic assets without overwriting user's first-time cleanup prompt setting
        const priorConfirmed = await hasConfirmedAssetCleanup();
        await deleteAssetsFromWorkspace(uniqueCleanup);
        if (!priorConfirmed) {
          const {noodleDb} = await import('../db/noodleDb');
          await noodleDb.appSettings.delete('assetCleanupConfirmed');
        }
      } catch {
        // Ignore cleanup failure
      }
    }
    if (!assetsExistedBefore && activeRootHandle) {
      await removeDirIfEmpty(activeRootHandle, 'assets');
    }
  }

  return results;
}

/**
 * Diagnostics Self-Checks for Milestone 5 (Change Detection & Scanning)
 */
export async function runChangeDetectionDiagnostics(): Promise<
  DiagnosticCheckResult[]
> {
  const results: DiagnosticCheckResult[] = [];
  const totalCount = 1000;
  const diagSubdir = '_diag_sync_1000';
  const now = new Date().toISOString();

  const makeDiagNote = (idx: number, body = 'Sync test note'): NoteRecord => {
    const id = `00000000-0000-4000-9000-${String(idx).padStart(12, '0')}`;
    const doc: TipTapDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: {id: `diag-blk-${idx}`},
          content: [{type: 'text', text: `${body} #${idx}`}],
        },
      ],
    };
    return {
      id,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      title: `Sync Diag Note ${idx}`,
      category: 'Study',
      pillar: 'manual',
      createdAt: now,
      updatedAt: now,
      contentHash: `sha256:diag-init-${idx}`,
      content: doc,
    };
  };

  if (activeRootHandle) {
    isChangeDiagRunning = true;
    let manualRoot: FileSystemDirectoryHandle | null = null;
    let aiRoot: FileSystemDirectoryHandle | null = null;
    const manualExistedBefore = await dirExistsInRoot(activeRootHandle, 'manual');
    const aiExistedBefore = await dirExistsInRoot(activeRootHandle, 'ai');

    try {
      manualRoot = await resolvePillarDir(activeRootHandle, 'manual', true);
      aiRoot = await resolvePillarDir(activeRootHandle, 'ai', true);

      const manualBatchDir = await manualRoot.getDirectoryHandle(diagSubdir, {
        create: true,
      });

      const diagNotes: Array<{note: NoteRecord; fileName: string; raw: string}> =
        [];
      for (let i = 0; i < totalCount; i += 1) {
        const note = makeDiagNote(i);
        note.contentHash = await computeCanonicalContentHash(note.content);
        const fileName = `diag-sync-${String(i).padStart(4, '0')}.json`;
        diagNotes.push({
          note,
          fileName,
          raw: JSON.stringify(note),
        });
      }

      // 1. Seed 1,000 notes in manual/_diag_sync_1000 and index via scanner
      const moveStart = performance.now();
      for (let i = 0; i < totalCount; i += 50) {
        const chunk = diagNotes.slice(i, i + 50);
        await Promise.all(
          chunk.map(async (item) => {
            const fh = await manualBatchDir.getFileHandle(item.fileName, {
              create: true,
            });
            const w = await fh.createWritable();
            await w.write(item.raw);
            await w.close();
          }),
        );
        await yieldToMain();
      }

      await scanWorkspaceChanges('diagnostics', {force: true});

      // Move all 1,000 notes externally from manual/_diag_sync_1000 -> ai/_diag_sync_1000
      const aiBatchDir = await aiRoot.getDirectoryHandle(diagSubdir, {
        create: true,
      });
      for (let i = 0; i < totalCount; i += 50) {
        const chunk = diagNotes.slice(i, i + 50);
        await Promise.all(
          chunk.map(async (item) => {
            const fh = await aiBatchDir.getFileHandle(item.fileName, {
              create: true,
            });
            const w = await fh.createWritable();
            await w.write(item.raw);
            await w.close();
          }),
        );
        await yieldToMain();
      }
      await manualRoot.removeEntry(diagSubdir, {recursive: true});

      const moveScan = await scanWorkspaceChanges('diagnostics', {force: true});
      const indexAfterMove = await readNotesIndex();
      const indexById = new Map(indexAfterMove.map((row) => [row.id, row]));

      const allMovedIdsSurvive = diagNotes.every((item) => {
        const row = indexById.get(item.note.id);
        return (
          row !== undefined &&
          row.pillar === 'ai' &&
          row.path === `ai/${diagSubdir}/${item.fileName}`
        );
      });
      const moveMs = Math.round(performance.now() - moveStart);

      results.push({
        id: 'change-1000-move',
        name: '1,000-Note Folder Move Preserves Identities & Index',
        status:
          moveScan.movedCount === totalCount && allMovedIdsSurvive
            ? 'PASS'
            : 'FAIL',
        details:
          moveScan.movedCount === totalCount && allMovedIdsSurvive
            ? `Moved ${totalCount} notes from manual/ to ai/ on disk and updated Dexie in ${moveScan.durationMs}ms scan (total ${moveMs}ms); all ${totalCount} UUIDs preserved.`
            : `Detected ${moveScan.movedCount}/${totalCount} moves; allMovedIdsSurvive=${String(allMovedIdsSurvive)}.`,
        durationMs: moveMs,
      });

      // 2. Outside edit detected
      {
        const start = performance.now();
        const target = diagNotes[0];
        const editedNote: NoteRecord = {
          ...target.note,
          pillar: 'ai',
          content: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                attrs: {id: 'diag-blk-0'},
                content: [{type: 'text', text: 'Edited externally outside app'}],
              },
            ],
          },
        };
        const fh = await aiBatchDir.getFileHandle(target.fileName, {
          create: false,
        });
        const w = await fh.createWritable();
        await w.write(JSON.stringify(editedNote));
        await w.close();

        const editScan = await scanWorkspaceChanges('diagnostics', {
          force: true,
        });
        const detected = editScan.editedNoteIds.includes(target.note.id);

        results.push({
          id: 'change-outside-edit',
          name: 'External Edit Detected by Scanner',
          status: detected ? 'PASS' : 'FAIL',
          details: detected
            ? `External modification to ${target.fileName} detected (${editScan.editedCount} edited) without silent overwrite.`
            : 'Scanner did not detect the external edit.',
          durationMs: Math.round(performance.now() - start),
        });
      }

      // 3. Own writes do not trigger rescan loop
      {
        const start = performance.now();
        const target = diagNotes[1];
        await updateNote('ai', `${diagSubdir}/${target.fileName}`, {
          title: 'Updated By App',
        });
        const ownScan = await scanWorkspaceChanges('diagnostics', {force: true});
        const noFalseChanges =
          ownScan.addedCount === 0 &&
          ownScan.editedCount === 0 &&
          ownScan.deletedCount === 0 &&
          ownScan.movedCount === 0;

        results.push({
          id: 'change-own-write-ignored',
          name: 'Own Writes Do Not Trigger Rescan Loop',
          status: noFalseChanges ? 'PASS' : 'FAIL',
          details: noFalseChanges
            ? 'App write recorded expected hash/stat and subsequent scan reported 0 external changes.'
            : `Unexpected scan deltas after own write (edited=${ownScan.editedCount}, added=${ownScan.addedCount}).`,
          durationMs: Math.round(performance.now() - start),
        });
      }

      // 4. Malformed files tolerated in Problems
      {
        const start = performance.now();
        const badName = 'malformed-diag.json';
        const badHandle = await aiBatchDir.getFileHandle(badName, {
          create: true,
        });
        const w = await badHandle.createWritable();
        await w.write('{ broken json !!!');
        await w.close();

        const problemScan = await scanWorkspaceChanges('diagnostics', {
          force: true,
        });
        const foundProblem = problemScan.problems.some(
          (p) => p.path === `ai/${diagSubdir}/${badName}`,
        );

        results.push({
          id: 'change-malformed-tolerated',
          name: 'Malformed Files Tolerated in Problems Panel',
          status: foundProblem ? 'PASS' : 'FAIL',
          details: foundProblem
            ? `Scanner stayed stable and listed "ai/${diagSubdir}/${badName}" in Problems.`
            : 'Malformed JSON file was not surfaced in Problems.',
          durationMs: Math.round(performance.now() - start),
        });
      }
    } catch (err) {
      results.push({
        id: 'change-diag-error',
        name: 'Change Detection Diagnostics',
        status: 'FAIL',
        details: `Unexpected failure: ${(err as Error).message}`,
      });
    } finally {
      if (manualRoot) {
        try {
          await manualRoot.removeEntry(diagSubdir, {recursive: true});
        } catch {
          // Ignore if already moved
        }
      }
      if (aiRoot) {
        try {
          await aiRoot.removeEntry(diagSubdir, {recursive: true});
        } catch {
          // Ignore cleanup error
        }
      }
      if (!manualExistedBefore) {
        await removeDirIfEmpty(activeRootHandle, 'manual');
      }
      if (!aiExistedBefore) {
        await removeDirIfEmpty(activeRootHandle, 'ai');
      }
      isChangeDiagRunning = false;
      try {
        await cleanupOrphanedDiagSyncData(activeRootHandle);
        await scanWorkspaceChanges('diagnostics', {force: true});
      } catch {
        // Ignore post-cleanup scan error
      }
    }

    return results;
  }

  // Fallback when no disk folder is connected (e.g. iframe preview):
  // Run pure reconcileWorkspaceSnapshot + real Dexie batch transactions across 1,000 notes.
  const seededIds: string[] = [];
  const startAll = performance.now();
  try {
    const initialEntries: StoredNoteEntry[] = [];
    for (let i = 0; i < totalCount; i += 1) {
      const note = makeDiagNote(i);
      note.contentHash = `sha256:diag-static-${i}`;
      seededIds.push(note.id);
      const fileName = `diag-sync-${String(i).padStart(4, '0')}.json`;
      initialEntries.push({
        note,
        fileName,
        pillar: 'manual',
        excerpt: `Sync test note #${i}`,
        wordCount: 4,
        path: `manual/${diagSubdir}/${fileName}`,
        size: 320,
        lastModified: 1700000000000,
      });
    }

    await applyBatchIndexChanges({
      upserts: initialEntries.map((entry) => ({entry, assetPaths: []})),
      deleteNoteIds: [],
    });

    const previousIndex = await readNotesIndex();
    const diagPrev = previousIndex.filter((row) =>
      row.id.startsWith('00000000-0000-4000-9000-'),
    );

    // Move all 1,000 notes from manual/ to ai/
    const movedScanned: StoredNoteEntry[] = initialEntries.map((e) => ({
      ...e,
      pillar: 'ai',
      path: `ai/${diagSubdir}/${e.fileName}`,
      note: {...e.note, pillar: 'ai'},
    }));

    const moveReconciled = reconcileWorkspaceSnapshot({
      previousIndex: diagPrev,
      scannedEntries: movedScanned,
      ownWrites: new Map(),
    });

    await applyBatchIndexChanges({
      upserts: moveReconciled.upserts.map((entry) => ({
        entry,
        assetPaths: [],
      })),
      deleteNoteIds: moveReconciled.deletedNoteIds,
    });

    const indexAfterMove = await readNotesIndex();
    const byId = new Map(indexAfterMove.map((row) => [row.id, row]));
    const allSurvive = initialEntries.every((e) => {
      const row = byId.get(e.note.id);
      return row?.pillar === 'ai' && row.path === `ai/${diagSubdir}/${e.fileName}`;
    });

    results.push({
      id: 'change-1000-move',
      name: '1,000-Note Folder Move Preserves Identities & Index',
      status:
        moveReconciled.moved.length === totalCount && allSurvive
          ? 'PASS'
          : 'FAIL',
      details: `Moved ${moveReconciled.moved.length}/${totalCount} notes across folders via batched Dexie transaction (virtual FS; connect a workspace folder for physical disk I/O).`,
      durationMs: Math.round(performance.now() - startAll),
    });

    // Outside edit test
    {
      const start = performance.now();
      const postMovePrev = (await readNotesIndex()).filter((row) =>
        row.id.startsWith('00000000-0000-4000-9000-'),
      );
      const editedScanned = movedScanned.map((entry, idx) =>
        idx === 0
          ? {
              ...entry,
              lastModified: 1700000099999,
              note: {...entry.note, contentHash: 'sha256:external-edit-0'},
            }
          : entry,
      );
      const res = reconcileWorkspaceSnapshot({
        previousIndex: postMovePrev,
        scannedEntries: editedScanned,
        ownWrites: new Map(),
      });
      const detected =
        res.edited.length === 1 &&
        res.edited[0].note.id === initialEntries[0].note.id;
      results.push({
        id: 'change-outside-edit',
        name: 'External Edit Detected by Scanner',
        status: detected ? 'PASS' : 'FAIL',
        details: detected
          ? 'External contentHash change flagged edited note without overwriting.'
          : 'Failed to detect external edit.',
        durationMs: Math.round(performance.now() - start),
      });
    }

    // Own-write suppression test
    {
      const start = performance.now();
      const postMovePrev = (await readNotesIndex()).filter((row) =>
        row.id.startsWith('00000000-0000-4000-9000-'),
      );
      const target = movedScanned[1];
      const ownHash = 'sha256:app-own-write-1';
      const ownPath = target.path!;
      const ownWrites = new Map<string, OwnWriteExpectation>([
        [
          ownPath,
          {
            path: ownPath,
            noteId: target.note.id,
            contentHash: ownHash,
            writtenAt: Date.now(),
            op: 'write',
          },
        ],
      ]);
      const scannedAfterOwn = movedScanned.map((entry, idx) =>
        idx === 1
          ? {
              ...entry,
              lastModified: 1700000123456,
              note: {...entry.note, contentHash: ownHash},
            }
          : entry,
      );
      const res = reconcileWorkspaceSnapshot({
        previousIndex: postMovePrev,
        scannedEntries: scannedAfterOwn,
        ownWrites,
      });
      const suppressed =
        res.edited.length === 0 &&
        res.added.length === 0 &&
        res.deletedNoteIds.length === 0 &&
        res.ignoredOwnWritesCount === 1;

      results.push({
        id: 'change-own-write-ignored',
        name: 'Own Writes Do Not Trigger Rescan Loop',
        status: suppressed ? 'PASS' : 'FAIL',
        details: suppressed
          ? 'Expected app write hash matched and suppressed external edit / rescan loop.'
          : 'Own write was misclassified as an external change.',
        durationMs: Math.round(performance.now() - start),
      });
    }

    // Malformed file tolerated
    {
      const start = performance.now();
      const postMovePrev = (await readNotesIndex()).filter((row) =>
        row.id.startsWith('00000000-0000-4000-9000-'),
      );
      const badPath = `ai/${diagSubdir}/broken.json`;
      const problem: ScanProblem = {
        id: badPath,
        path: badPath,
        pillar: 'ai',
        fileName: `${diagSubdir}/broken.json`,
        reason: 'Note file is not valid JSON.',
        detectedAt: new Date().toISOString(),
      };
      const res = reconcileWorkspaceSnapshot({
        previousIndex: postMovePrev,
        scannedEntries: movedScanned,
        ownWrites: new Map(),
        problems: [problem],
      });
      const ok = res.entries.length === totalCount && res.deletedNoteIds.length === 0;
      results.push({
        id: 'change-malformed-tolerated',
        name: 'Malformed Files Tolerated in Problems Panel',
        status: ok ? 'PASS' : 'FAIL',
        details: ok
          ? 'Malformed file isolated into Problems without crashing or corrupting valid notes.'
          : 'Malformed file tolerance check failed.',
        durationMs: Math.round(performance.now() - start),
      });
    }
  } finally {
    if (seededIds.length > 0) {
      try {
        await applyBatchIndexChanges({upserts: [], deleteNoteIds: seededIds});
      } catch {
        // Ignore cleanup error
      }
    }
  }

  return results;
}

// ---------- READ-ONLY SOURCES DOCUMENT EXTRACTION (Milestone 6) ----------

async function walkSourcesFiles(
  dirHandle: FileSystemDirectoryHandle,
  prevByPath: Map<string, SourceDocumentEntry>,
  prefix = '',
  out: SourceDocumentEntry[] = [],
  problems: ScanProblem[] = [],
): Promise<SourceDocumentEntry[]> {
  for await (const [name, handle] of dirHandle.entries()) {
    if (name.startsWith('.')) {
      continue;
    }

    const relInPillar = prefix ? `${prefix}/${name}` : name;
    const fullPath = `sources/${relInPillar}`;

    if (handle.kind === 'directory') {
      await walkSourcesFiles(
        handle as FileSystemDirectoryHandle,
        prevByPath,
        relInPillar,
        out,
        problems,
      );
      continue;
    }

    if (handle.kind !== 'file') {
      continue;
    }

    const lower = name.toLowerCase();
    if (lower.endsWith('.json')) {
      // Handled by scanNotesInDirectory
      continue;
    }

    const isPdf = lower.endsWith('.pdf');
    const isTxt = lower.endsWith('.txt');
    const isMd = lower.endsWith('.md') || lower.endsWith('.markdown');
    const isPptx = lower.endsWith('.pptx') || lower.endsWith('.ppt');

    if (!isPdf && !isTxt && !isMd && !isPptx) {
      continue;
    }

    try {
      const file = await (handle as FileSystemFileHandle).getFile();
      const prev = prevByPath.get(fullPath);

      if (
        prev &&
        prev.size === file.size &&
        prev.lastModified === file.lastModified
      ) {
        out.push(prev);
        continue;
      }

      const title =
        name.replace(/\.(pdf|txt|md|markdown|pptx|ppt)$/i, '') || name;
      const docId = `source:${fullPath}`;

      if (isPptx) {
        const buffer = await file.arrayBuffer();
        const contentHash = await computeBytesSha256(buffer);
        out.push({
          id: docId,
          fileName: relInPillar,
          path: fullPath,
          pillar: 'sources',
          title,
          kind: 'unsupported-pptx',
          size: file.size,
          lastModified: file.lastModified,
          contentHash,
          chunks: [],
          unsupportedReason:
            'Slide formats (.pptx) are not supported yet for text extraction or search.',
          updatedAt: new Date(file.lastModified || Date.now()).toISOString(),
        });
        continue;
      }

      if (isPdf) {
        const buffer = await file.arrayBuffer();
        const contentHash = await computeBytesSha256(buffer);
        const pages = await extractPdfPagesInWorker(buffer);
        const chunks = chunkPdfPages(pages);
        out.push({
          id: docId,
          fileName: relInPillar,
          path: fullPath,
          pillar: 'sources',
          title,
          kind: 'pdf',
          size: file.size,
          lastModified: file.lastModified,
          contentHash,
          chunks,
          updatedAt: new Date(file.lastModified || Date.now()).toISOString(),
        });
        continue;
      }

      const text = await file.text();
      const contentHash = await computeSha256(text);
      const kind = isMd ? 'md' : 'txt';
      const chunks = chunkPlainTextSource(text, kind);
      out.push({
        id: docId,
        fileName: relInPillar,
        path: fullPath,
        pillar: 'sources',
        title,
        kind,
        size: file.size,
        lastModified: file.lastModified,
        contentHash,
        chunks,
        updatedAt: new Date(file.lastModified || Date.now()).toISOString(),
      });
    } catch (err) {
      problems.push({
        id: `source-extract:${fullPath}`,
        path: fullPath,
        pillar: 'sources',
        fileName: relInPillar,
        reason:
          (err as Error).message || 'Could not extract text from source file.',
        detectedAt: new Date().toISOString(),
      });
    }
  }

  return out;
}

/**
 * Scans `sources/` read-only for PDF, .txt, .md, and unsupported .pptx files.
 * Extracts text off the main thread for PDFs and persists extracted chunks in Dexie.
 */
export async function scanSourceDocumentsInWorkspace(): Promise<{
  documents: SourceDocumentEntry[];
  problems: ScanProblem[];
}> {
  if (!activeRootHandle) {
    return {documents: [], problems: []};
  }

  const prevStored = await getStoredSourceDocuments();
  const prevByPath = new Map<string, SourceDocumentEntry>();
  for (const row of prevStored) {
    prevByPath.set(row.path, row);
  }

  const problems: ScanProblem[] = [];
  let documents: SourceDocumentEntry[] = [];
  try {
    const sourcesDir = await resolvePillarDir(activeRootHandle, 'sources', false);
    documents = await walkSourcesFiles(sourcesDir, prevByPath, '', [], problems);
  } catch {
    documents = [];
  }

  documents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  await replaceStoredSourceDocuments(documents);
  return {documents, problems};
}

export async function computePdfBytesSha256(
  buffer: ArrayBuffer,
): Promise<string> {
  return computeBytesSha256(buffer);
}

/**
 * Strictly read-only access to raw file bytes inside `sources/`.
 * Never opens a writable stream or mutates any source file on disk.
 */
export async function readSourceFileBytes(
  relativePath: string,
  expectedContentHash?: string,
): Promise<ArrayBuffer> {
  if (typeof relativePath !== 'string' || !relativePath.startsWith('sources/')) {
    throw new StorageError(
      'PATH_TRAVERSAL',
      `Source reads are restricted strictly to sources/: "${relativePath}".`,
    );
  }

  const innerPath = relativePath.slice('sources/'.length).replace(/\\/g, '/');
  const segments = innerPath.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new StorageError('INVALID_NAME', 'Source path cannot be empty.');
  }
  const safeSegments = segments.map((seg) => sanitizeName(seg));

  if (activeRootHandle) {
    try {
      let dirHandle = await resolvePillarDir(activeRootHandle, 'sources', false);
      for (let i = 0; i < safeSegments.length - 1; i += 1) {
        dirHandle = await dirHandle.getDirectoryHandle(safeSegments[i], {
          create: false,
        });
      }
      const fileHandle = await dirHandle.getFileHandle(
        safeSegments[safeSegments.length - 1],
        {create: false},
      );
      const file = await fileHandle.getFile();
      return await file.arrayBuffer();
    } catch (err) {
      if (err instanceof StorageError) {
        throw err;
      }
      throw new StorageError(
        'NOT_FOUND',
        `Could not read source file "${relativePath}".`,
      );
    }
  }

  const demoBytes = await getDemoSourceBytesByPathOrHash(
    relativePath,
    expectedContentHash,
  );
  if (demoBytes) {
    return demoBytes;
  }

  throw new StorageError(
    'NOT_FOUND',
    `Source file "${relativePath}" is not available in demo storage.`,
  );
}

const DEMO_PDF_FILE_NAME = 'buzsaki-2015-sharp-wave-ripples.pdf';
const DEMO_PDF_PATH = `sources/${DEMO_PDF_FILE_NAME}`;

export async function loadDemoSourceDocuments(): Promise<SourceDocumentEntry[]> {
  let rows = await listDemoSourceFiles();
  if (rows.length === 0) {
    const sampleUint8 = buildSampleAcademicPdfBytes();
    const sampleBuffer = sampleUint8.buffer.slice(
      sampleUint8.byteOffset,
      sampleUint8.byteOffset + sampleUint8.byteLength,
    ) as ArrayBuffer;
    const contentHash = await computeBytesSha256(sampleBuffer);
    await saveDemoSourceFile({
      id: `source:${DEMO_PDF_PATH}`,
      path: DEMO_PDF_PATH,
      fileName: DEMO_PDF_FILE_NAME,
      title: 'Buzsaki (2015) — Sharp-Wave Ripples (Sample PDF)',
      size: sampleBuffer.byteLength,
      lastModified: Date.now(),
      contentHash,
      bytes: sampleBuffer,
      updatedAt: new Date().toISOString(),
    });
    rows = await listDemoSourceFiles();
  }

  const docs: SourceDocumentEntry[] = [];
  for (const row of rows) {
    let chunks: SourceDocumentEntry['chunks'] = [];
    try {
      const pages = await extractPdfPagesInWorker(row.bytes.slice(0));
      chunks = chunkPdfPages(pages);
    } catch {
      chunks = [];
    }
    docs.push({
      id: row.id,
      fileName: row.fileName,
      path: row.path,
      pillar: 'sources',
      title: row.title,
      kind: 'pdf',
      size: row.size,
      lastModified: row.lastModified,
      contentHash: row.contentHash,
      chunks,
      updatedAt: row.updatedAt,
    });
  }
  docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return docs;
}

export async function importDemoPdfSource(file: {
  name: string;
  size: number;
  lastModified?: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}): Promise<SourceDocumentEntry> {
  const safeFileName = sanitizeName(file.name);
  if (!safeFileName.toLowerCase().endsWith('.pdf')) {
    throw new StorageError('INVALID_NAME', 'Only .pdf files can be opened here.');
  }
  const bytes = await file.arrayBuffer();
  const contentHash = await computeBytesSha256(bytes);
  const path = `sources/${safeFileName}`;
  const title = safeFileName.replace(/\.pdf$/i, '') || safeFileName;
  const updatedAt = new Date(file.lastModified || Date.now()).toISOString();

  await saveDemoSourceFile({
    id: `source:${path}`,
    path,
    fileName: safeFileName,
    title,
    size: bytes.byteLength,
    lastModified: file.lastModified || Date.now(),
    contentHash,
    bytes,
    updatedAt,
  });

  let chunks: SourceDocumentEntry['chunks'] = [];
  try {
    const pages = await extractPdfPagesInWorker(bytes.slice(0));
    chunks = chunkPdfPages(pages);
  } catch {
    chunks = [];
  }

  return {
    id: `source:${path}`,
    fileName: safeFileName,
    path,
    pillar: 'sources',
    title,
    kind: 'pdf',
    size: bytes.byteLength,
    lastModified: file.lastModified || Date.now(),
    contentHash,
    chunks,
    updatedAt,
  };
}

export async function importReadOnlyFolderFromFiles(
  fileList: FileList | File[],
): Promise<{
  folderName: string;
  notes: StoredNoteEntry[];
  sources: SourceDocumentEntry[];
  problems: ScanProblem[];
}> {
  const files = Array.from(fileList);
  const firstRel = files[0]?.webkitRelativePath || '';
  const rootFolderName = firstRel.split('/').filter(Boolean)[0] || 'Local Folder';
  const notes: StoredNoteEntry[] = [];
  const sources: SourceDocumentEntry[] = [];
  const problems: ScanProblem[] = [];

  for (const file of files) {
    const rawRel = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
    const parts = rawRel.split('/').filter(Boolean);
    const insideParts =
      parts.length > 1 && parts[0] === rootFolderName ? parts.slice(1) : parts;
    if (insideParts.length === 0) {
      continue;
    }
    if (
      insideParts.some(
        (seg) =>
          seg.startsWith('.') ||
          PROJECT_DEPENDENCY_MARKERS.has(seg.toLowerCase()),
      )
    ) {
      continue;
    }

    const lowerName = file.name.toLowerCase();
    const topDir = insideParts[0]?.toLowerCase() ?? '';
    const relPath = insideParts.join('/');

    if (lowerName.endsWith('.json')) {
      const pillar: Pillar =
        topDir === 'ai'
          ? 'ai'
          : topDir === 'sources'
            ? 'sources'
            : 'manual';
      const fileNameInPillar =
        topDir === 'manual' || topDir === 'ai' || topDir === 'sources'
          ? insideParts.slice(1).join('/')
          : relPath;
      if (!fileNameInPillar) {
        continue;
      }
      try {
        const text = await file.text();
        const parsed = parseNoteJson(text, pillar);
        const computedHash = await computeCanonicalContentHash(parsed.content);
        const note: NoteRecord = {
          ...parsed,
          contentHash: computedHash,
        };
        const {excerpt, wordCount} = deriveExcerptAndWordCount(note.content);
        notes.push({
          note,
          fileName: fileNameInPillar,
          pillar,
          excerpt,
          wordCount,
          path: `${pillar}/${fileNameInPillar}`,
          size: file.size,
          lastModified: file.lastModified,
        });
      } catch (err) {
        problems.push({
          id: relPath,
          path: relPath,
          pillar,
          fileName: fileNameInPillar,
          reason: (err as Error).message || 'Invalid JSON note file.',
          detectedAt: new Date().toISOString(),
        });
      }
      continue;
    }

    const isPdf = lowerName.endsWith('.pdf');
    const isTxt = lowerName.endsWith('.txt');
    const isMd = lowerName.endsWith('.md') || lowerName.endsWith('.markdown');
    if (isPdf || isTxt || isMd) {
      const srcPath =
        topDir === 'sources' ? relPath : `sources/${relPath}`;
      const title = file.name.replace(/\.(pdf|txt|md|markdown)$/i, '') || file.name;
      const updatedAt = new Date(file.lastModified || Date.now()).toISOString();
      try {
        if (isPdf) {
          const buffer = await file.arrayBuffer();
          const contentHash = await computeBytesSha256(buffer);
          let chunks: SourceDocumentEntry['chunks'] = [];
          try {
            const pages = await extractPdfPagesInWorker(buffer.slice(0));
            chunks = chunkPdfPages(pages);
          } catch {
            chunks = [];
          }
          try {
            await saveDemoSourceFile({
              id: `source:${srcPath}`,
              path: srcPath,
              fileName: file.name,
              title,
              size: buffer.byteLength,
              lastModified: file.lastModified || Date.now(),
              contentHash,
              bytes: buffer,
              updatedAt,
            });
          } catch {
            // Continue in memory if browser storage quota or IndexedDB is restricted
          }
          sources.push({
            id: `source:${srcPath}`,
            fileName: file.name,
            path: srcPath,
            pillar: 'sources',
            title,
            kind: 'pdf',
            size: file.size,
            lastModified: file.lastModified,
            contentHash,
            chunks,
            updatedAt,
          });
        } else {
          const text = await file.text();
          const contentHash = await computeSha256(text);
          const kind = isMd ? 'md' : 'txt';
          const chunks = chunkPlainTextSource(text, kind);
          sources.push({
            id: `source:${srcPath}`,
            fileName: file.name,
            path: srcPath,
            pillar: 'sources',
            title,
            kind,
            size: file.size,
            lastModified: file.lastModified,
            contentHash,
            chunks,
            updatedAt,
          });
        }
      } catch (err) {
        problems.push({
          id: `source:${srcPath}`,
          path: srcPath,
          pillar: 'sources',
          fileName: file.name,
          reason: (err as Error).message || 'Could not read source file.',
          detectedAt: new Date().toISOString(),
        });
      }
    }
  }

  notes.sort((a, b) => b.note.updatedAt.localeCompare(a.note.updatedAt));
  sources.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {folderName: rootFolderName, notes, sources, problems};
}



