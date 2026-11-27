import {Lock, Send, ShieldAlert, X} from 'lucide-react';
import {
  getSynthesisFormatLabel,
  MAX_CLOUD_EXCERPT_CHARS,
} from '../cloud/synthesisOutput';
import {CloudSynthesisRequestPreview, Pillar} from '../types/noodle';

interface CloudPrivacyNoticeModalProps {
  preview: CloudSynthesisRequestPreview | null;
  sending?: boolean;
  onCancel: () => void;
  onConfirmSend: () => void;
}

const PILLAR_LABEL: Record<Pillar, string> = {
  sources: 'Sources',
  manual: 'My Notes',
  ai: 'AI Notes',
};

export function CloudPrivacyNoticeModal({
  preview,
  sending = false,
  onCancel,
  onConfirmSend,
}: CloudPrivacyNoticeModalProps) {
  if (!preview) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-privacy-notice-title"
        className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[#2D3344] bg-[#141720] shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-[#232734] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <ShieldAlert className="h-4 w-4 shrink-0 text-[#E0A83E]" />
            <h2
              id="cloud-privacy-notice-title"
              className="font-serif text-lg font-semibold text-[#F5F1E8]"
            >
              Privacy Notice: Send snippets to {preview.providerLabel}?
            </h2>
          </div>

          <button
            type="button"
            onClick={onCancel}
            disabled={sending}
            aria-label="Cancel cloud request"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[#8E95A5] transition-colors duration-150 hover:bg-[#212531] hover:text-[#ECEBE6] disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto p-5 text-xs">
          {/* Provider + Hard Rule Summary */}
          <div className="grid grid-cols-1 gap-3 rounded-lg bg-[#0E1015] p-3.5 sm:grid-cols-2">
            <div>
              <p className="text-[11px] text-[#7D8496]">Provider &amp; Model</p>
              <p className="mt-0.5 font-medium text-[#ECEBE6]">
                {preview.providerLabel} ·{' '}
                <span className="text-[#E0A83E]">{preview.model}</span>
              </p>
              <p className="mt-0.5 text-[11px] text-[#7D8496]">
                Direct browser call to {preview.endpointHost}
                {preview.outputFormat
                  ? ` · ${getSynthesisFormatLabel(preview.outputFormat)}`
                  : ''}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-[#7D8496]">What Will Be Sent</p>
              <p className="mt-0.5 font-medium text-[#ECEBE6] tabular-nums">
                {preview.excerpts.length}{' '}
                {preview.excerpts.length === 1 ? 'snippet' : 'snippets'} (
                {preview.totalChars} chars)
              </p>
              <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-[#A8B0C0] tabular-nums">
                <Lock className="h-3 w-3 text-[#E0A83E]" />
                <span>
                  Plain text only · max{' '}
                  {preview.maxExcerptChars ?? MAX_CLOUD_EXCERPT_CHARS} chars per
                  snippet
                </span>
              </p>
            </div>
          </div>

          {/* Question */}
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-[#8E95A5]">
              Question to send
            </p>
            <p className="rounded-lg bg-[#0E1015] px-3.5 py-2.5 text-[#F2EEE4]">
              {preview.question}
            </p>
          </div>

          {/* Exact Excerpts List */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-[#8E95A5]">
              <span className="font-medium">
                Snippets &amp; source notes to send
              </span>
              <span className="tabular-nums">
                {preview.excerpts.length}{' '}
                {preview.excerpts.length === 1 ? 'item' : 'items'}
              </span>
            </div>

            <div className="space-y-1.5">
              {preview.excerpts.map((ex) => (
                <div
                  key={ex.chunkId}
                  className="space-y-1 rounded-lg bg-[#0E1015] px-3.5 py-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#8990A2]">
                    <span className="font-semibold text-[#E0A83E] tabular-nums">
                      [{ex.citationNumber}]
                    </span>
                    <span className="font-medium text-[#EAE6DC]">
                      {ex.sourceTitle}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{PILLAR_LABEL[ex.pillar]}</span>
                    {ex.headingPath.length > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="truncate">
                          {ex.headingPath.join(' › ')}
                        </span>
                      </>
                    )}
                    <span className="ml-auto text-[11px] text-[#6B7284] tabular-nums">
                      {ex.text.length}/
                      {preview.maxExcerptChars ?? MAX_CLOUD_EXCERPT_CHARS} chars
                      {ex.hadMarkupStripped ? ' · sanitized' : ''}
                      {ex.wasTruncated ? ' · capped' : ''}
                    </span>
                  </div>
                  <p className="leading-relaxed text-[#C2C7D3] whitespace-pre-wrap">
                    {ex.text}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#232734] bg-[#11131A] px-5 py-3.5">
          <span className="text-[11px] text-[#888F9F]">
            Only these snippets are sent. Nothing else leaves your computer.
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={sending}
              className="inline-flex h-9 items-center rounded-lg border border-[#2C3140] bg-[#171A23] px-4 text-xs font-medium text-[#C8CCD6] transition-colors duration-150 hover:border-[#3E4559] hover:text-white disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirmSend}
              disabled={sending}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#E0A83E] px-4 text-xs font-semibold text-[#111216] transition-colors duration-150 hover:bg-[#ECB955] disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              <span>{sending ? 'Sending...' : 'Send'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
