import {FormEvent, useEffect, useMemo, useState} from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  CheckCircle2,
  Circle,
  FileText,
  GitMerge,
  Search,
} from 'lucide-react';
import {noodleDb} from '../db/noodleDb';
import {searchWorkspaceBlocks} from '../search/localSearchService';
import {
  RoutePath,
  ScoreLabel,
  SearchResultItem,
  SourceDocumentEntry,
  StoredNoteEntry,
} from '../types/noodle';

interface StudyPageProps {
  notes: StoredNoteEntry[];
  sourceDocuments: SourceDocumentEntry[];
  aiEnabled: boolean;
  onNavigateToBlock: (
    noteId: string,
    blockId: string,
    kind: 'note' | 'source',
  ) => void;
  onNavigate: (route: RoutePath) => void;
}

interface MatchedItem {
  noteId: string;
  blockId: string;
  kind: 'note' | 'source';
  title: string;
  path: string;
  headingPath: string[];
  excerpt: string;
  score: number;
  percentMatch: number;
  scoreLabel: ScoreLabel;
  category?: string;
}

interface StudyChecklistItem {
  id: string;
  title: string;
  detail: string;
  linkLabel: string;
  onFollowLink: () => void;
}

const STUDY_STATE_KEY = 'studyModeChecklistV1';

export function StudyPage({
  notes,
  sourceDocuments,
  aiEnabled,
  onNavigateToBlock,
  onNavigate,
}: StudyPageProps) {
  const [taskPrompt, setTaskPrompt] = useState('');
  const [activePrompt, setActivePrompt] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchMode, setSearchMode] = useState<'semantic' | 'word-match'>(
    'word-match',
  );
  const [matchedSources, setMatchedSources] = useState<MatchedItem[]>([]);
  const [suggestedManualNotes, setSuggestedManualNotes] = useState<
    MatchedItem[]
  >([]);
  const [completedStepIds, setCompletedStepIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void noodleDb.appSettings.get(STUDY_STATE_KEY).then((row) => {
      if (!active || !row || typeof row.value !== 'string') {
        return;
      }
      try {
        const parsed = JSON.parse(row.value) as {
          taskPrompt?: string;
          completedStepIds?: string[];
        };
        if (typeof parsed.taskPrompt === 'string' && parsed.taskPrompt.trim()) {
          setTaskPrompt(parsed.taskPrompt);
        }
        if (Array.isArray(parsed.completedStepIds)) {
          setCompletedStepIds(
            parsed.completedStepIds.filter(
              (id): id is string => typeof id === 'string',
            ),
          );
        }
      } catch {
        // Ignore malformed saved UI state
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const persistStudyState = (nextPrompt: string, nextCompleted: string[]) => {
    void noodleDb.appSettings.put({
      key: STUDY_STATE_KEY,
      value: JSON.stringify({
        taskPrompt: nextPrompt,
        completedStepIds: nextCompleted,
      }),
    });
  };

  const runStudyMatch = async (queryText: string) => {
    const trimmed = queryText.trim();
    if (!trimmed) {
      setError('Enter a study goal or exam topic to match against your local workspace.');
      return;
    }

    setError(null);
    setSearching(true);
    setActivePrompt(trimmed);
    persistStudyState(trimmed, completedStepIds);

    try {
      const res = await searchWorkspaceBlocks({
        query: trimmed,
        notes,
        sources: sourceDocuments,
        aiEnabled,
        topK: 28,
      });
      setSearchMode(res.mode);

      const bestSources = new Map<string, MatchedItem>();
      const bestManual = new Map<string, MatchedItem>();

      const toMatchedItem = (item: SearchResultItem): MatchedItem => {
        const clamped = Math.max(0, Math.min(1, item.score));
        const matchedNote =
          item.kind === 'note'
            ? notes.find((n) => n.note.id === item.noteId)
            : undefined;
        return {
          noteId: item.noteId,
          blockId: item.blockId,
          kind: item.kind,
          title: item.title,
          path: item.path,
          headingPath: item.headingPath,
          excerpt: item.text,
          score: item.score,
          percentMatch: Math.round(clamped * 100),
          scoreLabel: item.scoreLabel,
          category: matchedNote?.note.category,
        };
      };

      for (const item of res.results) {
        if (item.pillar === 'sources') {
          const prev = bestSources.get(item.noteId);
          if (!prev || item.score > prev.score) {
            bestSources.set(item.noteId, toMatchedItem(item));
          }
        } else if (item.pillar === 'manual') {
          const prev = bestManual.get(item.noteId);
          if (!prev || item.score > prev.score) {
            bestManual.set(item.noteId, toMatchedItem(item));
          }
        }
      }

      setMatchedSources(
        Array.from(bestSources.values())
          .sort((a, b) => b.score - a.score)
          .slice(0, 6),
      );
      setSuggestedManualNotes(
        Array.from(bestManual.values())
          .sort((a, b) => b.score - a.score)
          .slice(0, 6),
      );
    } catch (err) {
      setError((err as Error).message || 'Local study matching failed.');
    } finally {
      setSearching(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void runStudyMatch(taskPrompt);
  };

  const toggleStep = (stepId: string) => {
    setCompletedStepIds((prev) => {
      const next = prev.includes(stepId)
        ? prev.filter((id) => id !== stepId)
        : [...prev, stepId];
      persistStudyState(activePrompt || taskPrompt, next);
      return next;
    });
  };

  const topSource = matchedSources[0];
  const topManual = suggestedManualNotes[0];
  const focusTopic = activePrompt || taskPrompt.trim() || 'your target topic';

  const checklistSteps: StudyChecklistItem[] = useMemo(
    () => [
      {
        id: 'step-1-sources',
        title: '1. Review matched source readings',
        detail: topSource
          ? `Start with "${topSource.title}" (${topSource.percentMatch}% ${topSource.scoreLabel}) and check key definitions.`
          : 'Open your PDFs or text readings in Sources for this topic.',
        linkLabel: topSource ? `Open ${topSource.title}` : 'Browse Sources',
        onFollowLink: () => {
          if (topSource) {
            onNavigateToBlock(
              topSource.noteId,
              topSource.blockId,
              topSource.kind,
            );
          } else {
            onNavigate('/workspace');
          }
        },
      },
      {
        id: 'step-2-manual',
        title: '2. Update your personal notes',
        detail: topManual
          ? `Review "${topManual.title}" (${topManual.percentMatch}% ${topManual.scoreLabel}) and add examples in your own words.`
          : 'Open or create a note in My Notes to summarize key ideas and examples.',
        linkLabel: topManual ? `Edit ${topManual.title}` : 'Open My Notes',
        onFollowLink: () => {
          if (topManual) {
            onNavigateToBlock(
              topManual.noteId,
              topManual.blockId,
              topManual.kind,
            );
          } else {
            onNavigate('/workspace');
          }
        },
      },
      {
        id: 'step-3-synthesize-guide',
        title: '3. Create a Study Guide or Cheat-Sheet',
        detail: `Add your matched notes in Study Creator to build a guide for "${focusTopic}" using your own examples.`,
        linkLabel: 'Open Study Creator',
        onFollowLink: () => onNavigate('/workspace/synthesizer'),
      },
      {
        id: 'step-4-active-recall',
        title: '4. Practice with Flashcards & a Practice Exam',
        detail:
          'Generate interactive Flashcards and a Practice Exam from your notes to test what you remember.',
        linkLabel: 'Make Flashcards & Exam',
        onFollowLink: () => onNavigate('/workspace/synthesizer'),
      },
      {
        id: 'step-5-backlinks',
        title: '5. Double-check source links & weak spots',
        detail:
          'Follow linked sources back to the original paragraphs and review anything you missed.',
        linkLabel: 'Review Notes',
        onFollowLink: () => onNavigate('/workspace'),
      },
    ],
    [focusTopic, onNavigate, onNavigateToBlock, topManual, topSource],
  );

  const completedCount = checklistSteps.filter((s) =>
    completedStepIds.includes(s.id),
  ).length;
  const completionPct = Math.round(
    (completedCount / checklistSteps.length) * 100,
  );

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 lg:px-8">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 pb-1">
        <div className="space-y-1">
          <h1 className="font-serif text-2xl font-semibold text-[#F5F1E8] sm:text-3xl">
            Study Mode
          </h1>
          <p className="max-w-prose text-xs text-[#9198A8] sm:text-sm">
            Find your most relevant readings and notes, then follow a 5-step
            study checklist.
          </p>
        </div>

        <button
          type="button"
          onClick={() => onNavigate('/workspace')}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#282D3B] bg-[#141720] px-3.5 text-xs font-medium text-[#C8CCD6] transition-colors hover:border-[#383F52] hover:text-[#ECEBE6]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Back to Workspace</span>
        </button>
      </div>

      {/* Task Prompt Box */}
      <form
        onSubmit={handleSubmit}
        className="space-y-3 rounded-xl border border-[#232734] bg-[#13161E] p-5"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <label
            htmlFor="study-task-prompt"
            className="text-xs font-medium text-[#D5D4CD]"
          >
            What are you preparing for?
          </label>
          <span className="text-[11px] text-[#7D8496]">
            {activePrompt
              ? `Runs on your device (${searchMode === 'semantic' ? 'semantic similarity' : 'word match'}) · nothing leaves this computer`
              : 'Runs on your device · nothing leaves this computer'}
          </span>
        </div>

        <div className="flex flex-col gap-2.5 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[#6E7587]" />
            <input
              id="study-task-prompt"
              type="text"
              value={taskPrompt}
              onChange={(e) => setTaskPrompt(e.target.value)}
              placeholder="Prepare for my Calculus midterm on derivatives"
              className="h-10 w-full rounded-lg border border-[#282D3B] bg-[#0D0F14] pr-3 pl-9 text-xs text-[#ECEBE6] placeholder-[#686F80] focus:border-[#E0A83E]/60 focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={searching}
            className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-[#E0A83E] px-4 text-xs font-semibold text-[#111216] transition-colors hover:bg-[#ECB955] disabled:opacity-50"
          >
            <Search className="h-3.5 w-3.5" />
            <span>{searching ? 'Matching locally...' : 'Match Study Materials'}</span>
          </button>
        </div>
      </form>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-[#5A2934] bg-[#1C1216] px-4 py-3 text-xs text-rose-200"
        >
          {error}
        </div>
      )}

      {/* Matched Source Materials & Suggested Manual Notes */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Matched Source Materials */}
        <section
          aria-label="Matched Source Materials"
          className="space-y-3 rounded-xl border border-[#232734] bg-[#13161E] p-5"
        >
          <div className="flex items-baseline justify-between gap-2 pb-1">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-[#E0A83E]" />
              <h2 className="font-serif text-base font-semibold text-[#F4F0E7]">
                Matched Source Materials
              </h2>
            </div>
            <span className="text-[11px] text-[#7D8496] tabular-nums">
              {matchedSources.length} found
            </span>
          </div>

          {!activePrompt ? (
            <p className="py-6 text-xs leading-relaxed text-[#7D8496]">
              Enter a topic above to find matching PDFs and readings from Sources.
            </p>
          ) : matchedSources.length === 0 ? (
            <p className="py-6 text-xs leading-relaxed text-[#7D8496]">
              No source files matched &ldquo;{activePrompt}&rdquo;.
            </p>
          ) : (
            <div className="space-y-1.5">
              {matchedSources.map((item) => (
                <button
                  key={`${item.noteId}-${item.blockId}`}
                  type="button"
                  onClick={() =>
                    onNavigateToBlock(item.noteId, item.blockId, item.kind)
                  }
                  className="group flex w-full items-start justify-between gap-3 rounded-lg bg-[#0F1117] px-3.5 py-3 text-left text-xs transition-colors hover:bg-[#171A24]"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="font-semibold text-[#E0A83E] tabular-nums">
                        {item.percentMatch}% match
                      </span>
                      <span aria-hidden="true" className="text-[#686F80]">
                        ·
                      </span>
                      <span className="text-[#888F9F]">{item.scoreLabel}</span>
                      {item.headingPath.length > 0 && (
                        <>
                          <span aria-hidden="true" className="text-[#686F80]">
                            ·
                          </span>
                          <span className="truncate text-[#888F9F]">
                            {item.headingPath.join(' › ')}
                          </span>
                        </>
                      )}
                    </div>
                    <p className="font-serif text-sm font-semibold text-[#F2EEE4] group-hover:text-[#F6DFA8]">
                      {item.title}
                    </p>
                    <p className="line-clamp-2 leading-relaxed text-[#9CA1AE]">
                      {item.excerpt}
                    </p>
                  </div>
                  <ArrowUpRight className="mt-1 h-3.5 w-3.5 shrink-0 text-[#7D8496] group-hover:text-[#E0A83E]" />
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Suggested Manual Notes */}
        <section
          aria-label="Suggested Manual Notes"
          className="space-y-3 rounded-xl border border-[#232734] bg-[#13161E] p-5"
        >
          <div className="flex items-baseline justify-between gap-2 pb-1">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-[#E0A83E]" />
              <h2 className="font-serif text-base font-semibold text-[#F4F0E7]">
                Suggested Manual Notes
              </h2>
            </div>
            <span className="text-[11px] text-[#7D8496] tabular-nums">
              {suggestedManualNotes.length} found
            </span>
          </div>

          {!activePrompt ? (
            <p className="py-6 text-xs leading-relaxed text-[#7D8496]">
              Matching personal notes will appear here with direct links.
            </p>
          ) : suggestedManualNotes.length === 0 ? (
            <p className="py-6 text-xs leading-relaxed text-[#7D8496]">
              No personal notes matched &ldquo;{activePrompt}&rdquo;. Try creating
              one in My Notes.
            </p>
          ) : (
            <div className="space-y-1.5">
              {suggestedManualNotes.map((item) => (
                <button
                  key={`${item.noteId}-${item.blockId}`}
                  type="button"
                  onClick={() =>
                    onNavigateToBlock(item.noteId, item.blockId, item.kind)
                  }
                  className="group flex w-full items-start justify-between gap-3 rounded-lg bg-[#0F1117] px-3.5 py-3 text-left text-xs transition-colors hover:bg-[#171A24]"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="font-semibold text-[#E0A83E] tabular-nums">
                        {item.percentMatch}% match
                      </span>
                      <span aria-hidden="true" className="text-[#686F80]">
                        ·
                      </span>
                      <span className="text-[#888F9F]">{item.scoreLabel}</span>
                      {item.category && (
                        <>
                          <span aria-hidden="true" className="text-[#686F80]">
                            ·
                          </span>
                          <span className="text-[#9CA1AE]">{item.category}</span>
                        </>
                      )}
                    </div>
                    <p className="font-serif text-sm font-semibold text-[#F2EEE4] group-hover:text-[#F6DFA8]">
                      {item.title}
                    </p>
                    <p className="line-clamp-2 leading-relaxed text-[#9CA1AE]">
                      {item.excerpt}
                    </p>
                  </div>
                  <ArrowUpRight className="mt-1 h-3.5 w-3.5 shrink-0 text-[#7D8496] group-hover:text-[#E0A83E]" />
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Interactive 5-Step Checklist */}
      <section
        aria-label="5-Step Study Checklist"
        className="space-y-4 rounded-xl border border-[#232734] bg-[#13161E] p-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 pb-1">
          <div className="space-y-0.5">
            <h2 className="font-serif text-lg font-semibold text-[#F5F1E8]">
              5-Step Study Checklist
            </h2>
            <p className="text-xs text-[#8E95A5]">
              Check off each step as you prepare.
            </p>
          </div>

          <div className="flex items-center gap-3 text-xs">
            <span className="font-semibold text-[#ECEBE6] tabular-nums">
              {completedCount}/5 completed ({completionPct}%)
            </span>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="h-1.5 w-full overflow-hidden rounded-sm bg-[#1C202B]">
          <div
            className="h-full bg-[#E0A83E] transition-[width] duration-200"
            style={{width: `${completionPct}%`}}
          />
        </div>

        <div className="space-y-1.5">
          {checklistSteps.map((step) => {
            const done = completedStepIds.includes(step.id);
            return (
              <div
                key={step.id}
                className="flex flex-wrap items-start justify-between gap-4 rounded-lg bg-[#0F1117] px-4 py-3.5 text-xs"
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={done}
                    aria-label={`Mark ${step.title} as ${done ? 'incomplete' : 'complete'}`}
                    onClick={() => toggleStep(step.id)}
                    className="mt-0.5 shrink-0 text-[#E0A83E] transition-colors hover:text-[#F4D084] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]/60"
                  >
                    {done ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                    ) : (
                      <Circle className="h-5 w-5 text-[#5D6475]" />
                    )}
                  </button>

                  <div className="min-w-0 space-y-1">
                    <p
                      className={`font-serif text-sm font-semibold ${
                        done ? 'text-[#888F9F] line-through' : 'text-[#F2EEE4]'
                      }`}
                    >
                      {step.title}
                    </p>
                    <p className="leading-relaxed text-[#9CA1AE]">
                      {step.detail}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={step.onFollowLink}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[#2A2F3F] bg-[#161923] px-3 text-xs font-medium text-[#E0A83E] transition-colors hover:border-[#E0A83E]/55 hover:bg-[#1C202C]"
                >
                  {step.id.includes('synthesize') ||
                  step.id.includes('active-recall') ? (
                    <GitMerge className="h-3.5 w-3.5" />
                  ) : (
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  )}
                  <span>{step.linkLabel}</span>
                </button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
