import {
  BatchMoveRecord,
  getEmbeddingChunks,
  saveBatchMoveLog,
} from '../db/noodleDb';
import {computeCosineSimilarity} from '../search/chunker';
import {StoredNoteEntry} from '../types/noodle';
import {moveNoteToFolder} from './workspaceStorage';

export interface NoteOrganizationProposal {
  noteId: string;
  uuid: string;
  title: string;
  currentPath: string;
  currentFolder: string;
  proposedFolder: string;
  confidenceScore: number; // 0.0 to 1.0
  reason: string;
}

const COURSE_FOLDERS = [
  'manual/Calculus',
  'manual/Physics',
  'manual/ComputerScience',
  'manual/History',
  'manual/Literature',
  'manual/Study',
  'manual/Work',
  'manual/General',
];

/**
 * Proposes folder destinations for incoming or unassigned notes using embedding
 * similarity against existing notes in each folder, with fallback to category/keyword matching.
 */
export async function proposeNoteFolderOrganizing(
  notes: StoredNoteEntry[],
): Promise<NoteOrganizationProposal[]> {
  const embeddingChunks = await getEmbeddingChunks();
  const chunksByNoteId = new Map<string, Array<number[]>>();
  for (const ch of embeddingChunks) {
    if (Array.isArray(ch.vector) && ch.vector.length > 0) {
      let list = chunksByNoteId.get(ch.noteId);
      if (!list) {
        list = [];
        chunksByNoteId.set(ch.noteId, list);
      }
      list.push(ch.vector);
    }
  }

  // Compute average vector per folder (excluding incoming/root notes)
  const folderVectors = new Map<string, Array<number[]>>();
  for (const entry of notes) {
    const noteId = entry.note.id;
    const path = entry.path ?? `${entry.pillar}/${entry.fileName}`;
    const vectors = chunksByNoteId.get(noteId);
    if (!vectors || vectors.length === 0) {
      continue;
    }
    const parts = path.split('/');
    const folder = parts.length > 2 ? parts.slice(0, -1).join('/') : 'manual/General';
    let fv = folderVectors.get(folder);
    if (!fv) {
      fv = [];
      folderVectors.set(folder, fv);
    }
    fv.push(...vectors);
  }

  const proposals: NoteOrganizationProposal[] = [];

  for (const entry of notes) {
    const noteId = entry.note.id;
    const currentPath = entry.path ?? `${entry.pillar}/${entry.fileName}`;
    const parts = currentPath.split('/');
    const currentFolder = parts.length > 2 ? parts.slice(0, -1).join('/') : 'manual';

    // Consider notes in manual root or general as "incoming" or subject to organization
    const noteVectors = chunksByNoteId.get(noteId) || [];
    let bestFolder = 'manual/Study';
    let bestScore = 0.55;
    let reason = 'Matches default study folder';

    if (noteVectors.length > 0 && folderVectors.size > 0) {
      let maxSim = -1;
      let targetFolder = bestFolder;

      for (const [folder, fVecs] of folderVectors.entries()) {
        if (folder === currentFolder || fVecs.length === 0) {
          continue;
        }
        // Average similarity between note vectors and folder vectors
        let totalSim = 0;
        let count = 0;
        for (const nv of noteVectors) {
          for (const fv of fVecs) {
            totalSim += computeCosineSimilarity(nv, fv);
            count += 1;
          }
        }
        const avgSim = count > 0 ? totalSim / count : 0;
        if (avgSim > maxSim) {
          maxSim = avgSim;
          targetFolder = folder;
        }
      }

      if (maxSim > 0.3) {
        bestFolder = targetFolder;
        bestScore = Number(Math.min(0.98, Math.max(0.6, maxSim)).toFixed(2));
        reason = `Similar to notes in this folder (${Math.round(maxSim * 100)}% match)`;
      }
    } else {
      // Fallback category/subfolder mapping
      const cat = entry.note.category;
      const sub = entry.note.subfolder;
      if (sub) {
        bestFolder = `manual/${cat}/${sub}`;
        reason = `Matches "${cat} / ${sub}"`;
      } else if (cat === 'Study') {
        bestFolder = 'manual/Calculus';
        reason = `Matches "${cat}" category`;
      } else if (cat === 'Assignment') {
        bestFolder = 'manual/ComputerScience';
        reason = `Matches "${cat}" category`;
      } else if (cat === 'Work') {
        bestFolder = 'manual/Work';
        reason = `Matches "${cat}" category`;
      } else {
        bestFolder = `manual/${cat || 'General'}`;
        reason = `Matches "${cat || 'General'}" category`;
      }
      bestScore = 0.65;
    }

    if (currentFolder === 'manual' || currentFolder !== bestFolder) {
      proposals.push({
        noteId,
        uuid: noteId,
        title: entry.note.title,
        currentPath,
        currentFolder,
        proposedFolder: bestFolder,
        confidenceScore: bestScore,
        reason,
      });
    }
  }

  return proposals;
}

export interface ExecuteBatchMoveParams {
  approvedItems: Array<{noteId: string; fromPath: string; toPath: string}>;
  notes: StoredNoteEntry[];
  onMoveNote?: (entry: StoredNoteEntry, toPath: string) => Promise<void> | void;
}

export async function executeBatchMoveAndLog(
  params: ExecuteBatchMoveParams,
): Promise<BatchMoveRecord> {
  const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const items: BatchMoveRecord['items'] = [];

  for (const item of params.approvedItems) {
    const entry = params.notes.find((n) => n.note.id === item.noteId);
    if (!entry) {
      continue;
    }
    const contentHashBefore = entry.note.contentHash;
    const mtimeBefore = entry.lastModified ?? Date.now();

    if (params.onMoveNote) {
      await params.onMoveNote(entry, item.toPath);
    } else {
      await moveNoteToFolder(entry, item.toPath);
    }

    items.push({
      noteId: entry.note.id,
      uuid: entry.note.id,
      fromPath: item.fromPath,
      toPath: item.toPath,
      contentHashBefore,
      mtimeBefore,
    });
  }

  const record: BatchMoveRecord = {
    batchId,
    timestamp: new Date().toISOString(),
    items,
    rolledBack: false,
  };

  await saveBatchMoveLog(record);
  return record;
}

export interface RollbackConflictItem {
  noteId: string;
  fromPath: string;
  toPath: string;
  reason: string;
}

export async function checkRollbackConflicts(
  batch: BatchMoveRecord,
  currentNotes: StoredNoteEntry[],
): Promise<RollbackConflictItem[]> {
  const conflicts: RollbackConflictItem[] = [];

  for (const item of batch.items) {
    const currentEntry = currentNotes.find((n) => n.note.id === item.noteId);
    if (!currentEntry) {
      conflicts.push({
        noteId: item.noteId,
        fromPath: item.fromPath,
        toPath: item.toPath,
        reason: 'This file is no longer in your workspace.',
      });
      continue;
    }

    const currentHash = currentEntry.note.contentHash;
    const currentMtime = currentEntry.lastModified ?? 0;

    // Check if edited after the move
    if (currentHash !== item.contentHashBefore && currentMtime > item.mtimeBefore) {
      conflicts.push({
        noteId: item.noteId,
        fromPath: item.fromPath,
        toPath: item.toPath,
        reason: 'This note was edited after it was moved.',
      });
    }
  }

  return conflicts;
}
