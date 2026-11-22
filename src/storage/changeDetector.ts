import type {NoteIndexRow} from '../db/noodleDb';
import {ScanProblem, StoredNoteEntry} from '../types/noodle';

export interface OwnWriteExpectation {
  path: string;
  noteId?: string;
  contentHash: string;
  writtenAt: number;
  size?: number;
  lastModified?: number;
  op: 'write' | 'delete';
}

export interface DetectedMove {
  noteId: string;
  fromPath: string;
  toPath: string;
  entry: StoredNoteEntry;
}

export interface ReconcileResult {
  entries: StoredNoteEntry[];
  added: StoredNoteEntry[];
  edited: StoredNoteEntry[];
  moved: DetectedMove[];
  deletedNoteIds: string[];
  ignoredOwnWritesCount: number;
  upserts: StoredNoteEntry[];
}

export function getEntryPath(entry: StoredNoteEntry): string {
  return entry.path ?? `${entry.pillar}/${entry.fileName}`;
}

function matchesOwnWrite(
  ownWrite: OwnWriteExpectation | undefined,
  contentHash: string,
  op: 'write' | 'delete',
  noteId?: string,
): boolean {
  if (!ownWrite || ownWrite.op !== op) {
    return false;
  }
  if (op === 'delete') {
    return !noteId || !ownWrite.noteId || ownWrite.noteId === noteId;
  }
  if (ownWrite.contentHash !== contentHash) {
    return false;
  }
  if (noteId && ownWrite.noteId && ownWrite.noteId !== noteId) {
    return false;
  }
  return true;
}

/**
 * Pure workspace reconciliation comparing scanned disk files against the
 * IndexedDB snapshot (`path`, `size`, `lastModified`, `contentHash`, `id`).
 * Recognizes moves by UUID first and falls back to `contentHash` matching.
 * Ignores writes recorded by Noodle itself so own writes never loop.
 */
export function reconcileWorkspaceSnapshot(params: {
  previousIndex: NoteIndexRow[];
  scannedEntries: StoredNoteEntry[];
  ownWrites: Map<string, OwnWriteExpectation>;
  problems?: ScanProblem[];
}): ReconcileResult {
  const {previousIndex, scannedEntries, ownWrites, problems = []} = params;

  const prevById = new Map<string, NoteIndexRow>();
  for (const row of previousIndex) {
    prevById.set(row.id, row);
  }

  const problemPaths = new Set(problems.map((p) => p.path));

  const matchedPrevIds = new Set<string>();
  const unmatchedScanned: StoredNoteEntry[] = [];
  const finalEntries: StoredNoteEntry[] = [];

  const added: StoredNoteEntry[] = [];
  const edited: StoredNoteEntry[] = [];
  const moved: DetectedMove[] = [];
  const upserts: StoredNoteEntry[] = [];
  let ignoredOwnWritesCount = 0;

  // Pass 1: Match scanned files to previous index by stable UUID (`note.id`)
  for (const rawEntry of scannedEntries) {
    const entryPath = getEntryPath(rawEntry);
    const entry: StoredNoteEntry = {
      ...rawEntry,
      path: entryPath,
    };

    const prev = prevById.get(entry.note.id);
    if (!prev) {
      unmatchedScanned.push(entry);
      continue;
    }

    matchedPrevIds.add(prev.id);
    finalEntries.push(entry);

    const own = ownWrites.get(entryPath);
    const isOwnWrite = matchesOwnWrite(
      own,
      entry.note.contentHash,
      'write',
      entry.note.id,
    );

    if (prev.path !== entryPath) {
      upserts.push(entry);
      if (isOwnWrite) {
        ignoredOwnWritesCount += 1;
      } else {
        moved.push({
          noteId: entry.note.id,
          fromPath: prev.path,
          toPath: entryPath,
          entry,
        });
      }
      continue;
    }

    const contentOrMetaChanged =
      prev.contentHash !== entry.note.contentHash ||
      prev.title !== entry.note.title ||
      prev.category !== entry.note.category;
    const statChanged =
      (entry.size ?? 0) !== prev.size ||
      (entry.lastModified ?? 0) !== prev.lastModified;

    if (contentOrMetaChanged || statChanged) {
      upserts.push(entry);
      if (isOwnWrite) {
        ignoredOwnWritesCount += 1;
      } else if (contentOrMetaChanged) {
        edited.push(entry);
      }
    }
  }

  // Pass 2: Fallback move detection by `contentHash` for unmatched scanned files
  const unmatchedPrevByHash = new Map<string, NoteIndexRow[]>();
  for (const row of previousIndex) {
    if (matchedPrevIds.has(row.id)) {
      continue;
    }
    if (row.contentHash) {
      const bucket = unmatchedPrevByHash.get(row.contentHash) ?? [];
      bucket.push(row);
      unmatchedPrevByHash.set(row.contentHash, bucket);
    }
  }

  for (const entry of unmatchedScanned) {
    const entryPath = getEntryPath(entry);
    const hashBucket = entry.note.contentHash
      ? unmatchedPrevByHash.get(entry.note.contentHash)
      : undefined;
    const prevByHash =
      hashBucket && hashBucket.length > 0 ? hashBucket.shift() : undefined;

    if (prevByHash && !matchedPrevIds.has(prevByHash.id)) {
      matchedPrevIds.add(prevByHash.id);
      const preservedEntry: StoredNoteEntry = {
        ...entry,
        path: entryPath,
        note: {
          ...entry.note,
          id: prevByHash.id,
        },
      };
      finalEntries.push(preservedEntry);
      upserts.push(preservedEntry);

      const own = ownWrites.get(entryPath);
      if (
        matchesOwnWrite(
          own,
          preservedEntry.note.contentHash,
          'write',
          preservedEntry.note.id,
        )
      ) {
        ignoredOwnWritesCount += 1;
      } else {
        moved.push({
          noteId: prevByHash.id,
          fromPath: prevByHash.path,
          toPath: entryPath,
          entry: preservedEntry,
        });
      }
    } else {
      finalEntries.push(entry);
      upserts.push(entry);

      const own = ownWrites.get(entryPath);
      if (
        matchesOwnWrite(
          own,
          entry.note.contentHash,
          'write',
          entry.note.id,
        )
      ) {
        ignoredOwnWritesCount += 1;
      } else {
        added.push(entry);
      }
    }
  }

  // Pass 3: Deleted files
  const deletedNoteIds: string[] = [];
  for (const row of previousIndex) {
    if (matchedPrevIds.has(row.id)) {
      continue;
    }
    if (problemPaths.has(row.path)) {
      // Unreadable / malformed file still exists on disk; surface in Problems without dropping identity prematurely
      continue;
    }
    const ownDel = ownWrites.get(row.path);
    if (matchesOwnWrite(ownDel, row.contentHash, 'delete', row.id)) {
      ignoredOwnWritesCount += 1;
    } else {
      deletedNoteIds.push(row.id);
    }
  }

  finalEntries.sort((a, b) => b.note.updatedAt.localeCompare(a.note.updatedAt));

  return {
    entries: finalEntries,
    added,
    edited,
    moved,
    deletedNoteIds,
    ignoredOwnWritesCount,
    upserts,
  };
}
