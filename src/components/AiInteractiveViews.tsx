import {useState} from 'react';
import {
  ArrowUpRight,
  BookmarkCheck,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  HelpCircle,
  Layers,
  RotateCcw,
  Sparkles,
  XCircle,
} from 'lucide-react';
import {getProviderAdapter} from '../cloud/providerAdapter';
import {getSynthesisFormatLabel} from '../cloud/synthesisOutput';
import {
  AiExamQuestion,
  AiFlashcardItem,
  AiNoteMetadata,
  AiSourceReference,
} from '../types/noodle';

function CitationLinkChip({
  citationNumber,
  sources,
  onNavigateToBlock,
}: {
  citationNumber: number;
  sources: AiSourceReference[];
  onNavigateToBlock?: (
    noteId: string,
    blockId: string,
    kind: 'note' | 'source',
  ) => void;
}) {
  const target = sources.find((s) => s.citationNumber === citationNumber);
  if (!target || !onNavigateToBlock) {
    return (
      <span className="font-mono text-[11px] font-semibold text-[#E0A83E] tabular-nums">
        [{citationNumber}]
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() =>
        onNavigateToBlock(target.noteId, target.blockId, target.kind)
      }
      title={`Open "${target.title}" block ${target.blockId.slice(0, 12)}`}
      className="inline-flex items-center gap-0.5 rounded border border-[#E0A83E]/40 bg-[#E0A83E]/12 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-[#F4D084] tabular-nums transition-colors hover:bg-[#E0A83E]/25"
    >
      <span>[{citationNumber}]</span>
      <ArrowUpRight className="h-3 w-3" />
    </button>
  );
}

export function PreservedFromNotesMarker() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-300">
      <BookmarkCheck className="h-3.5 w-3.5 text-emerald-400" />
      <span>Preserved from your notes</span>
    </span>
  );
}

export function AiProvenanceBanner({
  aiMeta,
  onNavigateToBlock,
}: {
  aiMeta: AiNoteMetadata;
  onNavigateToBlock?: (
    noteId: string,
    blockId: string,
    kind: 'note' | 'source',
  ) => void;
}) {
  const providerLabel = getProviderAdapter(aiMeta.provider).label;
  const formatLabel = getSynthesisFormatLabel(aiMeta.format);
  const dateLabel = new Date(aiMeta.generatedAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <section
      aria-label="AI Generated Output Metadata"
      className="space-y-3 rounded-xl border border-violet-400/35 bg-[#161523] p-4 text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-violet-400/20 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Sparkles className="h-4 w-4 text-violet-300" />
          <span className="font-semibold text-violet-200">
            AI Output · {formatLabel}
          </span>
          <span aria-hidden="true" className="text-[#6F7689]">
            ·
          </span>
          <span className="font-mono text-[11px] text-[#C8CCD6]">
            {providerLabel} ({aiMeta.model})
          </span>
          <span aria-hidden="true" className="text-[#6F7689]">
            ·
          </span>
          <span className="text-[11px] text-[#9CA1AE] tabular-nums">
            {dateLabel}
          </span>
        </div>

        {aiMeta.preservedPhrases && aiMeta.preservedPhrases.length > 0 && (
          <PreservedFromNotesMarker />
        )}
      </div>

      {aiMeta.preservedPhrases && aiMeta.preservedPhrases.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium text-[#A8B0C2]">
            Retained phrasing, examples &amp; structural metaphors
          </p>
          <p className="text-xs leading-relaxed text-[#E5E2D9]">
            {aiMeta.preservedPhrases.map((p) => `“${p}”`).join(' · ')}
          </p>
        </div>
      )}

      {aiMeta.sourcesUsed.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-[#A8B0C2] tabular-nums">
            Sources used ({aiMeta.sourcesUsed.length} retrieved excerpts · read-only block links)
          </p>
          <div className="flex flex-wrap gap-2">
            {aiMeta.sourcesUsed.map((src) => (
              <button
                key={`${src.citationNumber}-${src.blockId}`}
                type="button"
                disabled={!onNavigateToBlock}
                onClick={() =>
                  onNavigateToBlock?.(src.noteId, src.blockId, src.kind)
                }
                className="inline-flex items-center gap-1.5 rounded-md border border-[#2C3142] bg-[#11131C] px-2.5 py-1 text-[11px] text-[#D7D9E2] transition-colors hover:border-[#E0A83E]/55 hover:text-[#F6DFA8] disabled:cursor-default"
              >
                <span className="font-mono font-semibold text-[#E0A83E] tabular-nums">
                  [{src.citationNumber}]
                </span>
                <span className="max-w-[200px] truncate">{src.title}</span>
                {onNavigateToBlock && (
                  <ArrowUpRight className="h-3 w-3 text-[#888F9F]" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function FlashcardDeckView({
  flashcards,
  sources,
  onNavigateToBlock,
}: {
  flashcards: AiFlashcardItem[];
  sources: AiSourceReference[];
  onNavigateToBlock?: (
    noteId: string,
    blockId: string,
    kind: 'note' | 'source',
  ) => void;
}) {
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [masteredIds, setMasteredIds] = useState<Set<string>>(() => new Set());

  if (flashcards.length === 0) {
    return null;
  }

  const safeIndex = Math.min(index, flashcards.length - 1);
  const card = flashcards[safeIndex];
  const isMastered = masteredIds.has(card.id);

  const goTo = (next: number) => {
    const bounded = (next + flashcards.length) % flashcards.length;
    setIndex(bounded);
    setFlipped(false);
    setShowHint(false);
  };

  const toggleMastered = () => {
    setMasteredIds((prev) => {
      const next = new Set(prev);
      if (next.has(card.id)) {
        next.delete(card.id);
      } else {
        next.add(card.id);
      }
      return next;
    });
  };

  return (
    <section
      aria-label="Interactive Flashcard Deck"
      className="space-y-4 rounded-xl border border-[#282D3B] bg-[#13161E] p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-[#E0A83E]" />
          <h3 className="font-serif text-base font-semibold text-[#F5F1E8]">
            Interactive Flashcard Deck
          </h3>
          <span className="font-mono text-[11px] text-[#8E95A5] tabular-nums">
            · Card {safeIndex + 1} of {flashcards.length}
          </span>
        </div>

        <span className="font-mono text-[11px] text-emerald-300 tabular-nums">
          Mastered {masteredIds.size}/{flashcards.length}
        </span>
      </div>

      {/* Card Surface */}
      <div className="space-y-4 rounded-xl border border-[#2B3040] bg-[#0F1117] p-6">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <span className="font-medium text-[#8E95A5]">
            {flipped ? 'Answer (Back)' : 'Prompt (Front)'}
          </span>
          <div className="flex flex-wrap items-center gap-3">
            {card.preservedFromNotes && <PreservedFromNotesMarker />}
            {card.citations.length > 0 && (
              <div className="flex items-center gap-1">
                {card.citations.map((num) => (
                  <CitationLinkChip
                    key={num}
                    citationNumber={num}
                    sources={sources}
                    onNavigateToBlock={onNavigateToBlock}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setFlipped((prev) => !prev)}
          className="flex min-h-[140px] w-full flex-col items-center justify-center rounded-lg border border-[#232734] bg-[#141720] px-6 py-6 text-center transition-colors hover:border-[#E0A83E]/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]/60"
        >
          <p className="max-w-2xl font-serif text-lg leading-relaxed text-[#F5F1E8]">
            {flipped ? card.back : card.front}
          </p>
          <span className="mt-4 text-[11px] text-[#7D8496]">
            {flipped ? 'Click to see prompt' : 'Click to reveal answer'}
          </span>
        </button>

        {!flipped && card.hint && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            {showHint ? (
              <p className="text-[#C8CCD6]">
                <span className="font-medium text-[#E0A83E]">Hint:</span>{' '}
                {card.hint}
              </p>
            ) : (
              <button
                type="button"
                onClick={() => setShowHint(true)}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-[#9CA1AE] hover:text-[#E0A83E]"
              >
                <HelpCircle className="h-3.5 w-3.5" />
                <span>Show hint</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Deck Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => goTo(safeIndex - 1)}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-[#282D3B] bg-[#161922] px-3 text-xs font-medium text-[#C8CCD6] hover:border-[#3A4154] hover:text-white"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            <span>Previous</span>
          </button>
          <button
            type="button"
            onClick={() => setFlipped((prev) => !prev)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#E0A83E] px-3.5 text-xs font-semibold text-[#111216] hover:bg-[#ECB955]"
          >
            <span>{flipped ? 'Show Front' : 'Flip Card'}</span>
          </button>
          <button
            type="button"
            onClick={() => goTo(safeIndex + 1)}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-[#282D3B] bg-[#161922] px-3 text-xs font-medium text-[#C8CCD6] hover:border-[#3A4154] hover:text-white"
          >
            <span>Next</span>
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>

        <button
          type="button"
          onClick={toggleMastered}
          className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors ${
            isMastered
              ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
              : 'border-[#282D3B] bg-[#161922] text-[#9CA1AE] hover:border-emerald-500/40 hover:text-emerald-200'
          }`}
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          <span>{isMastered ? 'Marked Known' : 'Mark Known'}</span>
        </button>
      </div>
    </section>
  );
}

export function PracticeExamView({
  questions,
  sources,
  onNavigateToBlock,
}: {
  questions: AiExamQuestion[];
  sources: AiSourceReference[];
  onNavigateToBlock?: (
    noteId: string,
    blockId: string,
    kind: 'note' | 'source',
  ) => void;
}) {
  const [selectedAnswers, setSelectedAnswers] = useState<
    Record<string, number>
  >({});
  const [submitted, setSubmitted] = useState(false);

  if (questions.length === 0) {
    return null;
  }

  const answeredCount = questions.filter(
    (q) => selectedAnswers[q.id] !== undefined,
  ).length;
  const correctCount = questions.filter(
    (q) => selectedAnswers[q.id] === q.correctIndex,
  ).length;

  const handleReset = () => {
    setSelectedAnswers({});
    setSubmitted(false);
  };

  return (
    <section
      aria-label="Interactive Practice Exam"
      className="space-y-4 rounded-xl border border-[#282D3B] bg-[#13161E] p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#202430] pb-3 text-xs">
        <div className="space-y-0.5">
          <h3 className="font-serif text-base font-semibold text-[#F5F1E8]">
            Interactive Practice Exam
          </h3>
          <p className="text-[11px] text-[#8E95A5] tabular-nums">
            {questions.length} questions · {answeredCount}/{questions.length}{' '}
            answered
            {submitted ? ` · Score: ${correctCount}/${questions.length}` : ''}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {submitted && (
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#282D3B] bg-[#161922] px-3 text-xs font-medium text-[#C8CCD6] hover:border-[#3A4154]"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Retake</span>
            </button>
          )}
          <button
            type="button"
            disabled={submitted || answeredCount === 0}
            onClick={() => setSubmitted(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#E0A83E] px-3.5 text-xs font-semibold text-[#111216] hover:bg-[#ECB955] disabled:opacity-45"
          >
            <span>Check Answers</span>
          </button>
        </div>
      </div>

      <div className="space-y-4">
        {questions.map((q, qIdx) => {
          const picked = selectedAnswers[q.id];
          const isCorrect = submitted && picked === q.correctIndex;
          const isWrong =
            submitted && picked !== undefined && picked !== q.correctIndex;

          return (
            <div
              key={q.id}
              className="space-y-3 rounded-xl border border-[#232734] bg-[#0F1117] p-4 text-xs"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="font-serif text-sm font-semibold text-[#F2EEE4]">
                  <span className="mr-2 font-mono text-xs text-[#E0A83E] tabular-nums">
                    Q{qIdx + 1}.
                  </span>
                  {q.prompt}
                </p>

                <div className="flex flex-wrap items-center gap-2">
                  {q.preservedFromNotes && <PreservedFromNotesMarker />}
                  {q.citations.map((num) => (
                    <CitationLinkChip
                      key={num}
                      citationNumber={num}
                      sources={sources}
                      onNavigateToBlock={onNavigateToBlock}
                    />
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                {q.options.map((opt, optIdx) => {
                  const isSelected = picked === optIdx;
                  const showCorrect = submitted && optIdx === q.correctIndex;
                  const showWrong =
                    submitted && isSelected && optIdx !== q.correctIndex;

                  return (
                    <button
                      key={`${q.id}-opt-${optIdx}`}
                      type="button"
                      disabled={submitted}
                      onClick={() =>
                        setSelectedAnswers((prev) => ({
                          ...prev,
                          [q.id]: optIdx,
                        }))
                      }
                      className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-left transition-colors ${
                        showCorrect
                          ? 'border-emerald-500/55 bg-emerald-500/12 text-emerald-200'
                          : showWrong
                            ? 'border-rose-500/55 bg-rose-500/12 text-rose-200'
                            : isSelected
                              ? 'border-[#E0A83E]/65 bg-[#E0A83E]/12 text-[#F6DFA8]'
                              : 'border-[#232734] bg-[#141720] text-[#D2D5DF] hover:border-[#383F52]'
                      }`}
                    >
                      <span>
                        <span className="mr-2 font-mono text-[11px] text-[#8E95A5]">
                          {String.fromCharCode(65 + optIdx)}.
                        </span>
                        {opt}
                      </span>
                      {showCorrect && (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                      )}
                      {showWrong && (
                        <XCircle className="h-4 w-4 shrink-0 text-rose-400" />
                      )}
                    </button>
                  );
                })}
              </div>

              {submitted && (
                <div
                  className={`rounded-lg border px-3.5 py-2.5 text-xs ${
                    isCorrect
                      ? 'border-emerald-500/35 bg-emerald-500/8 text-emerald-200'
                      : isWrong
                        ? 'border-rose-500/35 bg-rose-500/8 text-rose-200'
                        : 'border-[#282D3B] bg-[#141720] text-[#C8CCD6]'
                  }`}
                >
                  <span className="font-semibold">
                    {isCorrect
                      ? 'Correct: '
                      : isWrong
                        ? 'Incorrect: '
                        : 'Answer: '}
                  </span>
                  <span>{q.explanation}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
