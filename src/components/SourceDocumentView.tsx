import {useEffect, useRef, useState} from 'react';
import {AlertCircle, ArrowLeft, BookOpen, FileText, Lock} from 'lucide-react';
import {
  BacklinkRecord,
  SourceDocumentEntry,
  SuggestedConnection,
} from '../types/noodle';
import {ConnectionsPanel} from './ConnectionsPanel';
import {PdfSourceViewer} from './PdfSourceViewer';

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
  const [pdfViewMode, setPdfViewMode] = useState<'pdf' | 'extracted'>('pdf');

  useEffect(() => {
    setPdfViewMode('pdf');
  }, [doc.id]);

  useEffect(() => {
    if (
      !targetBlockId ||
      !containerRef.current ||
      (doc.kind === 'pdf' && pdfViewMode === 'pdf')
    ) {
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
  }, [doc.id, doc.kind, pdfViewMode, targetBlockId]);

  const kindLabel =
    doc.kind === 'pdf'
      ? 'PDF Document'
      : doc.kind === 'md'
        ? 'Markdown Reference'
        : doc.kind === 'txt'
          ? 'Text Reference'
          : 'Slide Deck (.pptx)';

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#0C0D10]">
      <div className="sticky top-0 z-20 shrink-0 border-b border-[#232733] bg-[#12141A]/95 backdrop-blur-xs">
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
                <span>Sources (read-only)</span>
                <span aria-hidden="true">·</span>
                <span>{kindLabel}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {doc.kind === 'pdf' && (
              <div
                role="tablist"
                aria-label="PDF view mode"
                className="inline-flex rounded-lg border border-[#272C3A] bg-[#151822] p-0.5 text-[11px]"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={pdfViewMode === 'pdf'}
                  onClick={() => setPdfViewMode('pdf')}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors ${
                    pdfViewMode === 'pdf'
                      ? 'bg-[#E0A83E] text-[#111216]'
                      : 'text-[#9CA1AE] hover:text-[#ECEBE6]'
                  }`}
                >
                  <BookOpen className="h-3 w-3" />
                  <span>PDF Viewer</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={pdfViewMode === 'extracted'}
                  onClick={() => setPdfViewMode('extracted')}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors ${
                    pdfViewMode === 'extracted'
                      ? 'bg-[#E0A83E] text-[#111216]'
                      : 'text-[#9CA1AE] hover:text-[#ECEBE6]'
                  }`}
                >
                  <FileText className="h-3 w-3" />
                  <span>Text &amp; Links</span>
                </button>
              </div>
            )}

            <div className="text-xs text-[#888F9F] tabular-nums">
              {doc.chunks.length}{' '}
              {doc.chunks.length === 1 ? 'section' : 'sections'}
            </div>
          </div>
        </div>
      </div>

      {doc.kind === 'pdf' && pdfViewMode === 'pdf' ? (
        <PdfSourceViewer doc={doc} targetBlockId={targetBlockId} />
      ) : (
        <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-8 sm:px-8">
          <div className="mx-auto max-w-3xl space-y-6">
            <div className="space-y-2 pb-3">
              <div className="flex items-center gap-2 text-xs text-[#8990A2]">
                <FileText className="h-3.5 w-3.5 text-[#E0A83E]" />
                <span>{kindLabel}</span>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">
                  {Math.max(1, Math.round(doc.size / 1024))} KB
                </span>
              </div>
              <h1 className="font-serif text-3xl leading-tight font-semibold text-[#F5F1E8]">
                {doc.title}
              </h1>
            </div>

            {doc.kind === 'unsupported-pptx' ? (
              <div className="rounded-xl border border-[#523F1B] bg-[#19150E] p-5 text-xs leading-relaxed text-amber-100">
                <div className="flex items-start gap-2.5">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                  <div className="space-y-1">
                    <p className="font-semibold text-amber-200">
                      Slide formats (.pptx) are not supported yet
                    </p>
                    <p className="text-amber-100/85">
                      Noodle currently reads PDF, .txt, and .md files in Sources.
                      Export slide decks to PDF or Markdown to search their
                      contents.
                    </p>
                  </div>
                </div>
              </div>
            ) : doc.chunks.length === 0 ? (
              <div className="rounded-xl border border-[#232734] bg-[#13161E] p-6 text-xs text-[#8E95A5]">
                No readable text found in this file (scanned image-only PDFs
                need OCR first).
              </div>
            ) : (
              <div className="space-y-3">
                {doc.chunks.map((chunk) => (
                  <div
                    key={chunk.blockId}
                    data-block-id={chunk.blockId}
                    className="rounded-xl bg-[#13161E] p-4 transition-colors"
                  >
                    {chunk.headingPath.length > 0 && (
                      <div className="mb-1.5 text-[11px] font-medium text-[#7D8496]">
                        {chunk.headingPath.join(' › ')}
                      </div>
                    )}
                    <p className="max-w-prose text-[14.5px] leading-relaxed whitespace-pre-wrap text-[#E4E2DB]">
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
      )}
    </div>
  );
}

