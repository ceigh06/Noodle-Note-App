import {DragEvent, useEffect, useMemo, useState} from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  FolderGit2,
  FolderTree,
  GitCommit,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Undo2,
} from 'lucide-react';
import {
  BatchMoveRecord,
  getBatchMoveLogs,
  markBatchRolledBack,
} from '../db/noodleDb';
import {
  checkRollbackConflicts,
  executeBatchMoveAndLog,
  NoteOrganizationProposal,
  proposeNoteFolderOrganizing,
  RollbackConflictItem,
} from '../storage/organizeService';
import {moveNoteToFolder} from '../storage/workspaceStorage';
import {RoutePath, StoredNoteEntry} from '../types/noodle';

interface OrganizePageProps {
  notes: StoredNoteEntry[];
  onRefreshWorkspace: () => Promise<void>;
  onNavigate: (route: RoutePath) => void;
}

const DRAG_MIME = 'application/x-noodle-organize-note';

export function OrganizePage({
  notes,
  onRefreshWorkspace,
  onNavigate,
}: OrganizePageProps) {
  const [proposals, setProposals] = useState<NoteOrganizationProposal[]>([]);
  const [loading, setLoading] = useState(false);
  const [approvedNoteIds, setApprovedNoteIds] = useState<Set<string>>(new Set());
  const [targetFolderOverrides, setTargetFolderOverrides] = useState<
    Record<string, string>
  >({});
  const [draggedNoteId, setDraggedNoteId] = useState<string | null>(null);

  const [batchLogs, setBatchLogs] = useState<BatchMoveRecord[]>([]);
  const [executing, setExecuting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [conflictModalData, setConflictModalData] = useState<{
    batch: BatchMoveRecord;
    conflicts: RollbackConflictItem[];
  } | null>(null);

  const refreshBatchLogs = async () => {
    const logs = await getBatchMoveLogs();
    setBatchLogs(logs);
  };

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      try {
        const [props, logs] = await Promise.all([
          proposeNoteFolderOrganizing(notes),
          getBatchMoveLogs(),
        ]);
        if (!active) return;
        setProposals(props);
        setBatchLogs(logs);
      } catch (err) {
        if (active) setError((err as Error).message || 'Failed to generate organization proposals.');
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [notes]);

  const effectiveProposals = useMemo(() => {
    return proposals.map((p) => ({
      ...p,
      proposedFolder: targetFolderOverrides[p.noteId] || p.proposedFolder,
    }));
  }, [proposals, targetFolderOverrides]);

  const foldersList = useMemo(() => {
    const set = new Set<string>();
    set.add('manual/Study');
    set.add('manual/Calculus');
    set.add('manual/Physics');
    set.add('manual/ComputerScience');
    set.add('manual/Work');
    set.add('manual/General');
    for (const p of effectiveProposals) {
      set.add(p.proposedFolder);
    }
    return Array.from(set).sort();
  }, [effectiveProposals]);

  const handleDragStart = (e: DragEvent<HTMLDivElement>, noteId: string) => {
    setDraggedNoteId(noteId);
    e.dataTransfer.setData(DRAG_MIME, noteId);
  };

  const handleDropOnFolder = (folderName: string) => {
    if (!draggedNoteId) return;
    setTargetFolderOverrides((prev) => ({
      ...prev,
      [draggedNoteId]: folderName,
    }));
    setDraggedNoteId(null);
  };

  const handleToggleApprove = (noteId: string) => {
    setApprovedNoteIds((prev) => {
      const next = new Set(prev);
      if (next.has(noteId)) {
        next.delete(noteId);
      } else {
        next.add(noteId);
      }
      return next;
    });
  };

  const handleApproveAll = () => {
    if (approvedNoteIds.size === effectiveProposals.length) {
      setApprovedNoteIds(new Set());
    } else {
      setApprovedNoteIds(new Set(effectiveProposals.map((p) => p.noteId)));
    }
  };

  const handleExecuteApprovedMoves = async () => {
    const approvedList = effectiveProposals.filter((p) =>
      approvedNoteIds.has(p.noteId),
    );
    if (approvedList.length === 0) {
      setError('Select and approve at least one note move first.');
      return;
    }

    setExecuting(true);
    setError(null);
    try {
      const items = approvedList.map((p) => ({
        noteId: p.noteId,
        fromPath: p.currentPath,
        toPath: `${p.proposedFolder}/${p.currentPath.split('/').pop()}`,
      }));

      await executeBatchMoveAndLog({
        approvedItems: items,
        notes,
      });

      await onRefreshWorkspace();
      await refreshBatchLogs();
      setApprovedNoteIds(new Set());
      const remaining = proposals.filter((p) => !approvedNoteIds.has(p.noteId));
      setProposals(remaining);
      setSuccessMessage(
        `Successfully moved ${items.length} notes with safety audit log recorded.`,
      );
      setTimeout(() => setSuccessMessage(null), 4000);
    } catch (err) {
      setError((err as Error).message || 'Failed to execute batch move.');
    } finally {
      setExecuting(false);
    }
  };

  const handleTriggerRollback = async (batch: BatchMoveRecord) => {
    setError(null);
    try {
      const conflicts = await checkRollbackConflicts(batch, notes);
      if (conflicts.length > 0) {
        setConflictModalData({batch, conflicts});
        return;
      }
      await executeRollback(batch, false);
    } catch (err) {
      setError((err as Error).message || 'Rollback check failed.');
    }
  };

  const executeRollback = async (batch: BatchMoveRecord, forceOverwrite: boolean) => {
    setExecuting(true);
    setError(null);
    try {
      for (const item of batch.items) {
        const entry = notes.find((n) => n.note.id === item.noteId);
        if (!entry) continue;
        const currentPath = entry.path ?? `${entry.pillar}/${entry.fileName}`;
        // If file is at toPath, move back to fromPath
        if (currentPath === item.toPath || forceOverwrite) {
          await moveNoteToFolder(entry, item.fromPath);
        }
      }
      await markBatchRolledBack(batch.batchId);
      await onRefreshWorkspace();
      await refreshBatchLogs();
      setConflictModalData(null);
      setSuccessMessage(`Successfully rolled back batch ${batch.batchId.slice(0, 10)}. No user edits were silently overwritten.`);
      setTimeout(() => setSuccessMessage(null), 4000);
    } catch (err) {
      setError((err as Error).message || 'Rollback execution failed.');
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 lg:px-8">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#202430] pb-5">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-medium text-[#E0A83E]">
            <FolderTree className="h-3.5 w-3.5" />
            <span>AI Organization with Safety Net</span>
          </div>
          <h1 className="font-serif text-2xl font-semibold tracking-tight text-[#F5F1E8] sm:text-3xl">
            Workspace Organizer &amp; Rollback
          </h1>
          <p className="text-xs text-[#9198A8] sm:text-sm">
            Compare embeddings against course folders, stage moves in split-screen, review visual diffs, and rollback safely with conflict protection.
          </p>
        </div>

        <button
          type="button"
          onClick={() => onNavigate('/workspace')}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[#282D3B] bg-[#141720] px-3.5 py-2 text-xs font-medium text-[#C8CCD6] transition-colors hover:border-[#383F52] hover:text-[#ECEBE6]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Back to Workspace</span>
        </button>
      </div>

      {successMessage && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-200">
          <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-400" />
          <span>{successMessage}</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
          <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" />
          <span>{error}</span>
        </div>
      )}

      {/* Split-Screen Staging UI */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left Pane: Current Folder Tree / Unassigned Notes */}
        <section
          aria-label="Current Notes & Folders"
          className="flex flex-col rounded-xl border border-[#232734] bg-[#13161E] p-5 lg:col-span-5"
        >
          <div className="flex items-baseline justify-between border-b border-[#202430] pb-3">
            <div>
              <h2 className="font-serif text-base font-semibold text-[#F5F1E8]">
                Current Notes
              </h2>
              <p className="text-xs text-[#8E95A5]">
                {effectiveProposals.length} notes ready for AI organization
              </p>
            </div>
            <button
              type="button"
              onClick={handleApproveAll}
              className="text-xs font-medium text-[#E0A83E] hover:underline"
            >
              {approvedNoteIds.size === effectiveProposals.length
                ? 'Deselect All'
                : 'Select All'}
            </button>
          </div>

          <div className="mt-3 max-h-[500px] flex-1 space-y-2 overflow-y-auto pr-1">
            {loading ? (
              <p className="py-12 text-center text-xs text-[#7D8496]">
                Analyzing note embeddings and clustering folders...
              </p>
            ) : effectiveProposals.length === 0 ? (
              <p className="py-12 text-center text-xs text-[#7D8496]">
                All notes are organized. No new proposals.
              </p>
            ) : (
              effectiveProposals.map((item) => {
                const approved = approvedNoteIds.has(item.noteId);
                return (
                  <div
                    key={item.noteId}
                    draggable
                    onDragStart={(e) => handleDragStart(e, item.noteId)}
                    className={`cursor-grab space-y-1.5 rounded-lg border p-3 text-xs transition-colors active:cursor-grabbing ${
                      approved
                        ? 'border-[#E0A83E]/50 bg-[#E0A83E]/10'
                        : 'border-[#222634] bg-[#0F1117] hover:border-[#383F52]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-serif font-semibold text-[#F2EEE4]">
                          {item.title}
                        </p>
                        <p className="truncate text-[11px] font-mono text-[#8990A2]">
                          {item.currentPath}
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleToggleApprove(item.noteId)}
                        className={`inline-flex h-6 shrink-0 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors ${
                          approved
                            ? 'bg-emerald-500 text-[#111216]'
                            : 'border border-[#2F3546] bg-[#161922] text-[#C8CCD6] hover:text-white'
                        }`}
                      >
                        {approved ? <Check className="h-3 w-3" /> : null}
                        <span>{approved ? 'Approved' : 'Approve'}</span>
                      </button>
                    </div>

                    <p className="text-[11px] text-[#7D8496]">
                      {item.reason}
                    </p>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Right Pane: Proposed Folder Tree & Visual Diff */}
        <section
          aria-label="Proposed Organization & Visual Diff"
          className="flex flex-col justify-between space-y-4 rounded-xl border border-[#232734] bg-[#13161E] p-5 lg:col-span-7"
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#202430] pb-3">
              <div>
                <h2 className="font-serif text-base font-semibold text-[#F5F1E8]">
                  Proposed Tree &amp; Visual Diff
                </h2>
                <p className="text-xs text-[#8E95A5]">
                  Drag notes between folders or approve per item. Nothing moves until you click &ldquo;Execute Moves&rdquo;.
                </p>
              </div>

              <button
                type="button"
                disabled={executing || approvedNoteIds.size === 0}
                onClick={() => void handleExecuteApprovedMoves()}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#E0A83E] px-4 text-xs font-semibold text-[#111216] transition-colors hover:bg-[#ECB955] disabled:opacity-45"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>
                  {executing
                    ? 'Executing moves...'
                    : `Execute Approved (${approvedNoteIds.size})`}
                </span>
              </button>
            </div>

            {/* Folder Drop Zones */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {foldersList.map((folderName) => {
                const itemsInFolder = effectiveProposals.filter(
                  (p) => p.proposedFolder === folderName,
                );
                return (
                  <div
                    key={folderName}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                    }}
                    onDrop={() => handleDropOnFolder(folderName)}
                    className="flex flex-col space-y-2 rounded-xl border border-[#252A38] bg-[#0E1015] p-3.5 min-h-[150px]"
                  >
                    <div className="flex items-center justify-between border-b border-[#1E2330] pb-2">
                      <span className="font-mono text-xs font-semibold text-[#F4D084]">
                        📁 {folderName}
                      </span>
                      <span className="font-mono text-[10px] text-[#7D8496] tabular-nums">
                        {itemsInFolder.length} proposed
                      </span>
                    </div>

                    <div className="flex-1 space-y-1.5">
                      {itemsInFolder.length === 0 ? (
                        <p className="py-6 text-center text-[11px] text-[#656C7D]">
                          Drop notes here
                        </p>
                      ) : (
                        itemsInFolder.map((item) => {
                          const approved = approvedNoteIds.has(item.noteId);
                          return (
                            <div
                              key={item.noteId}
                              draggable
                              onDragStart={(e) => handleDragStart(e, item.noteId)}
                              className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                                approved
                                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                                  : 'border-[#232734] bg-[#141720] text-[#D8D6CE]'
                              }`}
                            >
                              <div className="min-w-0 flex-1">
                                <p className="truncate font-medium">{item.title}</p>
                                <div className="flex items-center gap-1 text-[10px] text-[#888F9F]">
                                  <span className="font-mono">{item.currentFolder}</span>
                                  <ArrowRight className="h-2.5 w-2.5" />
                                  <span className="font-mono font-semibold text-[#E0A83E]">
                                    {Math.round(item.confidenceScore * 100)}% match
                                  </span>
                                </div>
                              </div>

                              <button
                                type="button"
                                onClick={() => handleToggleApprove(item.noteId)}
                                className={`h-5 w-5 shrink-0 rounded border flex items-center justify-center text-[10px] ${
                                  approved
                                    ? 'border-emerald-400 bg-emerald-500 text-black'
                                    : 'border-[#383F52] bg-[#1C202B] text-[#9CA1AE]'
                                }`}
                              >
                                {approved ? '✓' : ''}
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>

      {/* Safety Net & Rollback Audit Log Section */}
      <section
        aria-label="Safety Net & Rollback Log"
        className="space-y-4 rounded-xl border border-[#232734] bg-[#13161E] p-5"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#202430] pb-3">
          <div>
            <h2 className="font-serif text-base font-semibold text-[#F5F1E8]">
              Safety Net &amp; Batch Rollback History
            </h2>
            <p className="text-xs text-[#8E95A5]">
              Every batch move is logged in IndexedDB by note UUID, content hash, and modification time before moving.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void refreshBatchLogs()}
            className="inline-flex items-center gap-1 text-xs text-[#8E95A5] hover:text-[#ECEBE6]"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            <span>Refresh log</span>
          </button>
        </div>

        <div className="space-y-3">
          {batchLogs.length === 0 ? (
            <p className="py-12 text-center text-xs text-[#7D8496]">
              No batch moves recorded in IndexedDB yet.
            </p>
          ) : (
            batchLogs.map((batch) => (
              <div
                key={batch.batchId}
                className={`space-y-2 rounded-xl border p-4 text-xs ${
                  batch.rolledBack
                    ? 'border-[#222634] bg-[#0E1015] opacity-60'
                    : 'border-[#2A3042] bg-[#0F1117]'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <FolderGit2 className="h-4 w-4 text-[#E0A83E]" />
                    <span className="font-mono font-semibold text-[#ECEBE6]">
                      Batch {batch.batchId}
                    </span>
                    <span className="text-[11px] text-[#7D8496] tabular-nums">
                      · {new Date(batch.timestamp).toLocaleString()} · {batch.items.length} items
                    </span>
                  </div>

                  {!batch.rolledBack && (
                    <button
                      type="button"
                      disabled={executing}
                      onClick={() => void handleTriggerRollback(batch)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 font-semibold text-rose-200 transition-colors hover:bg-rose-500/20 disabled:opacity-50"
                    >
                      <Undo2 className="h-3.5 w-3.5 text-rose-400" />
                      <span>Rollback Batch</span>
                    </button>
                  )}
                  {batch.rolledBack && (
                    <span className="font-semibold text-emerald-400">
                      Rolled Back
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-2 pt-2 sm:grid-cols-2 lg:grid-cols-3">
                  {batch.items.map((item) => (
                    <div
                      key={`${batch.batchId}-${item.noteId}`}
                      className="rounded-lg border border-[#222634] bg-[#141720] p-2.5 text-[11px]"
                    >
                      <p className="truncate font-medium text-[#EFECE3]">
                        UUID: {item.uuid.slice(0, 12)}...
                      </p>
                      <p className="truncate font-mono text-[#7D8496]">
                        {item.fromPath} <span className="text-[#E0A83E]">→</span> {item.toPath}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Conflict Resolution Modal */}
      {conflictModalData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs">
          <div className="w-full max-w-lg space-y-4 rounded-xl border border-amber-500/40 bg-[#141622] p-6 text-xs text-[#ECEBE6] shadow-2xl">
            <div className="flex items-center gap-2 text-amber-400">
              <AlertTriangle className="h-5 w-5 shrink-0" />
              <h2 className="font-serif text-lg font-semibold text-[#F5F1E8]">
                Rollback Conflict Detected
              </h2>
            </div>

            <p className="text-sm leading-relaxed text-[#D8D6CE]">
              One or more files in this batch were edited after being moved. Noodle will never silently overwrite your newer edits.
            </p>

            <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-[#232738] bg-[#0F1117] p-3">
              {conflictModalData.conflicts.map((c) => (
                <div key={c.noteId} className="space-y-0.5 border-b border-[#1E2330] pb-2 last:border-0">
                  <p className="font-mono text-amber-300">{c.toPath}</p>
                  <p className="text-[11px] text-[#A8B0C2]">{c.reason}</p>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConflictModalData(null)}
                className="rounded-lg border border-[#2E3446] bg-[#1A1D28] px-4 py-2 font-medium text-[#C8CCD6] hover:text-white"
              >
                Cancel Rollback
              </button>

              <button
                type="button"
                onClick={() => void executeRollback(conflictModalData.batch, true)}
                className="rounded-lg bg-amber-500 px-4 py-2 font-semibold text-[#111216] hover:bg-amber-400"
              >
                Restore Anyway (Overwrite Newer Edits)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
