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
  manual: 'Manual Notes',
  ai: 'AI Outputs',
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-privacy-notice-title"
        className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[#2D3344] bg-[#141720] shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-[#232734] px-5 py-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs font-medium text-[#E0A83E]">
              <ShieldAlert className="h-4 w-4" />
              <span>Privacy Notice · Confirm Before Sending</span>
            </div>
            <h2
              id="cloud-privacy-notice-title"
              className="font-serif text-lg font-semibold text-[#F5F1E8]"
            >
              Send retrieved excerpts to {preview.providerLabel}?
            </h2>
          </div>

          <button
            type="button"
            onClick={onCancel}
            disabled={sending}
            aria-label="Cancel cloud request"
            className="rounded-md p-1.5 text-[#8E95A5] hover:bg-[#212531] hover:text-[#ECEBE6] disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto p-5 text-xs">
          {/* Provider + Hard Rule Summary */}
          <div className="grid grid-cols-1 gap-3 rounded-lg border border-[#252A38] bg-[#0F1117] p-3.5 sm:grid-cols-2">
            <div>
              <p className="text-[11px] text-[#7D8496]">Provider &amp; Model</p>
              <p className="mt-0.5 font-medium text-[#ECEBE6]">
                {preview.providerLabel} ·{' '}
                <span className="font-mono text-[#E0A83E]">{preview.model}</span>
              </p>
              <p className="mt-0.5 font-mono text-[11px] text-[#7D8496]">
                Direct browser call to {preview.endpointHost}
                {preview.outputFormat
                  ? ` · ${getSynthesisFormatLabel(preview.outputFormat)}`
                  : ''}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-[#7D8496]">Payload Scope &amp; Sanitization</p>
              <p className="mt-0.5 font-medium text-[#ECEBE6] tabular-nums">
                {preview.excerpts.length} retrieved{' '}
                {preview.excerpts.length === 1 ? 'excerpt' : 'excerpts'} (
                {preview.totalChars} chars)
              </p>
              <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-[#A8B0C0]">
                <Lock className="h-3 w-3 text-[#E0A83E]" />
                <span>
                  Plain-text sanitized · capped at{' '}
                  {preview.maxExcerptChars ?? MAX_CLOUD_EXCERPT_CHARS} chars/excerpt
                </span>
              </p>
            </div>
          </div>

          {/* Question */}
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-[#8E95A5]">
              Question to send
            </p>
            <p className="rounded-lg border border-[#232734] bg-[#101218] px-3.5 py-2.5 text-[#F2EEE4]">
              {preview.question}
            </p>
          </div>

          {/* Exact Excerpts List */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-[#8E95A5]">
              <span className="font-medium">
                Exact excerpts &amp; source notes to transmit
              </span>
              <span className="tabular-nums">
                {preview.excerpts.length} items
              </span>
            </div>

            <div className="divide-y divide-[#1E222E] rounded-lg border border-[#232734] bg-[#0F1117]">
              {preview.excerpts.map((ex) => (
                <div key={ex.chunkId} className="space-y-1 px-3.5 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#8990A2]">
                    <span className="font-mono font-semibold text-[#E0A83E] tabular-nums">
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
                    <span className="ml-auto font-mono text-[10px] text-[#6B7284] tabular-nums">
                      block {ex.blockId.slice(0, 12)} · {ex.text.length}/
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
            Required before every cloud call. Your API key is sent in headers,
            never in URLs or prompts.
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={sending}
              className="rounded-lg border border-[#2C3140] bg-[#171A23] px-4 py-2 text-xs font-medium text-[#C8CCD6] transition-colors hover:border-[#3E4559] hover:text-white disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirmSend}
              disabled={sending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#E0A83E] px-4 py-2 text-xs font-semibold text-[#111216] transition-colors hover:bg-[#ECB955] disabled:opacity-50"
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
