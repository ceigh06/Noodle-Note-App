import {useEffect, useState} from 'react';
import {NodeViewWrapper, ReactNodeViewProps} from '@tiptap/react';
import {ImageOff} from 'lucide-react';
import {
  formatMissingImageMessage,
  isWorkspaceRelativeAssetPath,
} from '../editor/noteSchema';
import {readAssetObjectUrl} from '../storage/workspaceStorage';

export function WorkspaceImageNodeView({
  node,
  selected,
}: ReactNodeViewProps) {
  const src = typeof node.attrs.src === 'string' ? node.attrs.src.trim() : '';
  const alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : '';

  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;

    async function load() {
      setLoading(true);
      setMissing(false);
      setObjectUrl(null);

      if (!src || !isWorkspaceRelativeAssetPath(src)) {
        if (!cancelled) {
          setMissing(true);
          setLoading(false);
        }
        return;
      }

      try {
        const url = await readAssetObjectUrl(src);
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        createdUrl = url;
        setObjectUrl(url);
        setLoading(false);
      } catch {
        if (!cancelled) {
          setMissing(true);
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [src]);

  return (
    <NodeViewWrapper
      as="figure"
      data-drag-handle
      className={`my-4 overflow-hidden rounded-xl border transition-colors ${
        selected
          ? 'border-[#E0A83E]/70 ring-2 ring-[#E0A83E]/25'
          : 'border-[#252A38]'
      } bg-[#12141A]`}
    >
      {missing ? (
        <div
          role="status"
          className="flex items-center gap-3 px-4 py-5 text-xs text-[#C8CCD6]"
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#2D3344] bg-[#181C25] text-[#E0A83E]">
            <ImageOff className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium text-[#F4F0E7]">
              {formatMissingImageMessage(src || '(empty path)')}
            </p>
            <p className="text-[11px] text-[#888F9F]">
              File missing from <code className="font-mono">assets/</code>. Note
              left unchanged.
            </p>
          </div>
        </div>
      ) : loading || !objectUrl ? (
        <div className="flex h-36 items-center justify-center text-xs text-[#7D8496]">
          Loading image...
        </div>
      ) : (
        <div className="bg-[#0E1015]">
          <img
            src={objectUrl}
            alt={alt || src}
            onError={() => {
              setMissing(true);
              setObjectUrl(null);
            }}
            className="mx-auto max-h-[520px] w-auto max-w-full object-contain"
          />
          <figcaption className="flex items-center justify-between border-t border-[#1E222E] bg-[#12141A] px-3 py-1.5 font-mono text-[11px] text-[#7D8496]">
            <span className="truncate">{src}</span>
            {alt && alt !== src && (
              <span className="ml-3 truncate font-sans text-[#9AA1B1]">
                {alt}
              </span>
            )}
          </figcaption>
        </div>
      )}
    </NodeViewWrapper>
  );
}
