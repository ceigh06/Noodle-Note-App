import {ArrowUpRight, Link2, Lock, Sparkles, Unlink, X} from 'lucide-react';
import {
  BacklinkRecord,
  Pillar,
  SuggestedConnection,
} from '../types/noodle';

interface ConnectionsPanelProps {
  currentNoteId: string;
  backlinks: BacklinkRecord[];
  suggestions: SuggestedConnection[];
  mode: 'semantic' | 'word-match';
  loading?: boolean;
  onLinkSuggestion: (suggestion: SuggestedConnection) => void;
  onDismissSuggestion: (suggestion: SuggestedConnection) => void;
  onRemoveBacklink: (backlinkId: string) => void;
  onNavigateToBlock: (
    noteId: string,
    blockId: string,
    kind: 'note' | 'source',
  ) => void;
}

const PILLAR_LABEL: Record<Pillar, string> = {
  sources: 'Sources',
  manual: 'Manual Notes',
  ai: 'AI Outputs',
};

export function ConnectionsPanel({
  currentNoteId,
  backlinks,
  suggestions,
  mode,
  loading = false,
  onLinkSuggestion,
  onDismissSuggestion,
  onRemoveBacklink,
  onNavigateToBlock,
}: ConnectionsPanelProps) {
  return (
    <section
      aria-label="Connections and Backlinks"
      className="mt-8 space-y-6 border-t border-[#202430] pt-6"
    >
      {/* Explicit Backlinks */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-[#E0A83E]" />
            <h2 className="font-serif text-base font-semibold text-[#F4F0E7]">
              Backlinks
            </h2>
            <span className="text-xs text-[#7D8496] tabular-nums">
              · {backlinks.length} explicit {backlinks.length === 1 ? 'link' : 'links'}
            </span>
          </div>
          <span className="text-[11px] text-[#767D8F]">
            Linked to stable block IDs
          </span>
        </div>

        {backlinks.length === 0 ? (
          <p className="text-xs text-[#7D8496]">
            No explicit backlinks yet. Accept a suggested connection below to
            create one.
          </p>
        ) : (
          <div className="divide-y divide-[#1E222E] rounded-xl border border-[#232734] bg-[#13161E]">
            {backlinks.map((link) => {
              const isOutgoing = link.sourceNoteId === currentNoteId;
              const jumpNoteId = isOutgoing
                ? link.targetNoteId
                : link.sourceNoteId;
              const jumpBlockId = isOutgoing
                ? link.targetBlockId
                : link.sourceBlockId;
              const jumpKind = isOutgoing ? link.targetKind : 'note';
              const displayTitle = isOutgoing
                ? link.targetTitle
                : link.sourceTitle;

              return (
                <div
                  key={link.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs"
                >
                  <button
                    type="button"
                    onClick={() =>
                      onNavigateToBlock(jumpNoteId, jumpBlockId, jumpKind)
                    }
                    className="group min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]/60"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#888F9F]">
                      <span>{isOutgoing ? 'Links to' : 'Linked from'}</span>
                      <span aria-hidden="true">·</span>
                      <span>{PILLAR_LABEL[link.targetPillar]}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono text-[#767D8F]">
                        block {jumpBlockId.slice(0, 12)}
                      </span>
                    </div>
                    <p className="mt-1 inline-flex items-center gap-1 font-medium text-[#ECEBE6] group-hover:text-[#F4D084]">
                      <span className="truncate">{displayTitle}</span>
                      <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-[#888F9F] group-hover:text-[#E0A83E]" />
                    </p>
                  </button>

                  {link.readOnly ? (
                    <span
                      title="AI synthesis provenance backlink (read-only)"
                      className="inline-flex h-7 items-center gap-1 px-2 text-[11px] font-medium text-[#888F9F]"
                    >
                      <Lock className="h-3 w-3 text-violet-300" />
                      <span>Read-only provenance</span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onRemoveBacklink(link.id)}
                      title="Remove backlink"
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-[#272C3A] bg-[#171A23] px-2.5 text-[11px] text-[#9CA1AE] hover:border-rose-500/40 hover:text-rose-300"
                    >
                      <Unlink className="h-3 w-3" />
                      <span>Unlink</span>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Suggested Connections from Other Folders */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[#E0A83E]" />
            <h2 className="font-serif text-base font-semibold text-[#F4F0E7]">
              Suggested Connections
            </h2>
            <span className="text-xs text-[#7D8496]">
              ·{' '}
              {mode === 'semantic'
                ? 'On-device semantic similarity'
                : 'Word-match fallback (model not downloaded)'}
            </span>
          </div>
          <span className="text-[11px] text-[#767D8F]">
            From other folders · never auto-linked
          </span>
        </div>

        {loading ? (
          <p className="text-xs text-[#888F9F]">
            Checking other folders for related blocks...
          </p>
        ) : suggestions.length === 0 ? (
          <p className="text-xs text-[#7D8496]">
            No unlinked suggestions found in other folders yet.
          </p>
        ) : (
          <div className="space-y-2.5">
            {suggestions.map((item) => (
              <div
                key={item.suggestionKey}
                className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-[#232734] bg-[#13161E] p-4 text-xs"
              >
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#8990A2]">
                    <span className="font-mono font-semibold text-[#E0A83E] tabular-nums">
                      {item.score.toFixed(2)} {item.scoreLabel}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{PILLAR_LABEL[item.targetPillar]}</span>
                    {item.headingPath.length > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="truncate">
                          {item.headingPath.join(' › ')}
                        </span>
                      </>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      onNavigateToBlock(
                        item.targetNoteId,
                        item.targetBlockId,
                        item.targetKind,
                      )
                    }
                    className="inline-flex items-center gap-1 text-left font-serif text-sm font-semibold text-[#F2EEE4] hover:text-[#F4D084]"
                  >
                    <span>{item.targetTitle}</span>
                    <ArrowUpRight className="h-3.5 w-3.5 text-[#888F9F]" />
                  </button>

                  <p className="line-clamp-2 leading-relaxed text-[#9CA1AE]">
                    {item.targetExcerpt}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onLinkSuggestion(item)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#E0A83E] px-3 text-xs font-semibold text-[#111216] transition-colors hover:bg-[#ECB955]"
                  >
                    <Link2 className="h-3.5 w-3.5" />
                    <span>Link</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDismissSuggestion(item)}
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-[#282D3B] bg-[#171A23] px-2.5 text-xs font-medium text-[#9CA1AE] transition-colors hover:border-[#3A4154] hover:text-[#ECEBE6]"
                  >
                    <X className="h-3.5 w-3.5" />
                    <span>Dismiss</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
