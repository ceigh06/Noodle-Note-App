import {useEffect, useRef} from 'react';
import {AlertCircle, ArrowLeft, FileText, Lock} from 'lucide-react';
import {
  BacklinkRecord,
  SourceDocumentEntry,
  SuggestedConnection,
} from '../types/noodle';
import {ConnectionsPanel} from './ConnectionsPanel';

interface SourceDocumentViewProps {
  doc: SourceDocumentEntry;
  targetBlockId?: string | null;
  backlinks: BacklinkRecord[];
  suggestions: SuggestedConnection[];
  suggestionMode: 'semantic' | 'word-match';
  suggestionsLoading?: boolean;
  onBack: () => void;
  onLinkSuggestion: (suggestion: SuggestedConnection) => void;
  onDismissSuggestion: (suggestion: SuggestedConnection) => void;
  onRemoveBacklink: (backlinkId: string) => void;
  onNavigateToBlock: (
    noteId: string,
    blockId: string,
    kind: 'note' | 'source',
  ) => void;
}

export function SourceDocumentView({
  doc,
  targetBlockId = null,
  backlinks,
  suggestions,
  suggestionMode,
  suggestionsLoading = false,
  onBack,
  onLinkSuggestion,
  onDismissSuggestion,
  onRemoveBacklink,
  onNavigateToBlock,
}: SourceDocumentViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!targetBlockId || !containerRef.current) {
      return;
    }
    const selector = `[data-block-id="${CSS.escape(targetBlockId)}"]`;
    const targetEl = containerRef.current.querySelector(selector);
    if (!targetEl) {
      return;
    }
    targetEl.scrollIntoView({behavior: 'smooth', block: 'center'});
    targetEl.classList.add('noodle-target-block');
    const timer = window.setTimeout(() => {
      targetEl.classList.remove('noodle-target-block');
    }, 2400);
    return () => window.clearTimeout(timer);
  }, [doc.id, targetBlockId]);

  const kindLabel =
    doc.kind === 'pdf'
      ? 'PDF Document'
      : doc.kind === 'md'
        ? 'Markdown Reference'
        : doc.kind === 'txt'
          ? 'Text Reference'
          : 'Slide Deck (.pptx)';

  return (
    <div className="flex h-full flex-col bg-[#0C0D10]">
      <div className="sticky top-0 z-20 border-b border-[#232733] bg-[#12141A]/95 backdrop-blur-xs">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#282D3B] bg-[#171A23] px-2.5 text-xs font-medium text-[#C8CCD6] transition-colors hover:border-[#3A4154] hover:text-[#ECEBE6]"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Notes</span>
            </button>

            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs text-[#7D8496]">
                <Lock className="h-3 w-3 text-[#E0A83E]" />
                <span>Sources (immutable)</span>
                <span aria-hidden="true">·</span>
                <span>{kindLabel}</span>
                <span aria-hidden="true">·</span>
                <span className="truncate font-mono text-[11px]">{doc.path}</span>
              </div>
            </div>
          </div>

          <div className="text-xs text-[#888F9F] tabular-nums">
            {doc.chunks.length} extracted {doc.chunks.length === 1 ? 'block' : 'blocks'}
          </div>
        </div>
      </div>

      <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-3xl space-y-6">
          <div className="space-y-2 border-b border-[#1E222E] pb-5">
            <div className="flex items-center gap-2 text-xs text-[#8990A2]">
              <FileText className="h-3.5 w-3.5 text-[#E0A83E]" />
              <span>{kindLabel}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">
                {Math.max(1, Math.round(doc.size / 1024))} KB
              </span>
            </div>
            <h1 className="font-serif text-3xl leading-tight font-semibold tracking-tight text-[#F5F1E8]">
              {doc.title}
            </h1>
          </div>

          {doc.kind === 'unsupported-pptx' ? (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-5 text-xs leading-relaxed text-amber-100">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                <div className="space-y-1">
                  <p className="font-semibold text-amber-200">
                    Slide formats (.pptx) are not supported yet
                  </p>
                  <p className="text-amber-100/85">
                    Noodle currently extracts text and embeddings from PDF, .txt,
                    and .md files in <code className="font-mono">sources/</code>.
                    Export slide decks to PDF or Markdown to index and search
                    their contents locally.
                  </p>
                </div>
              </div>
            </div>
          ) : doc.chunks.length === 0 ? (
            <div className="rounded-xl border border-[#232734] bg-[#13161E] p-6 text-xs text-[#8E95A5]">
              No extractable text was found in this source document (scanned
              image-only PDFs require OCR before indexing).
            </div>
          ) : (
            <div className="space-y-4">
              {doc.chunks.map((chunk) => (
                <div
                  key={chunk.blockId}
                  data-block-id={chunk.blockId}
                  className="rounded-xl border border-[#1E222E] bg-[#13161E]/75 p-4 transition-colors"
                >
                  <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-[#7D8496]">
                    <span>
                      {chunk.headingPath.length > 0
                        ? chunk.headingPath.join(' › ')
                        : 'Section'}
                    </span>
                    <span className="font-mono tabular-nums">
                      {chunk.blockId}
                    </span>
                  </div>
                  <p className="text-[14.5px] leading-relaxed text-[#E4E2DB] whitespace-pre-wrap">
                    {chunk.text}
                  </p>
                </div>
              ))}
            </div>
          )}

          <ConnectionsPanel
            currentNoteId={doc.id}
            backlinks={backlinks}
            suggestions={suggestions}
            mode={suggestionMode}
            loading={suggestionsLoading}
            onLinkSuggestion={onLinkSuggestion}
            onDismissSuggestion={onDismissSuggestion}
            onRemoveBacklink={onRemoveBacklink}
            onNavigateToBlock={onNavigateToBlock}
          />
        </div>
      </div>
    </div>
  );
}
