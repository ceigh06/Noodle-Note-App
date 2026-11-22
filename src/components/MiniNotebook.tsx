import {useMemo, useState} from 'react';
import {Check, NotebookPen, Trash2, X} from 'lucide-react';
import {CATEGORIES, Category} from '../types/noodle';

interface MiniNotebookProps {
  open: boolean;
  onClose: () => void;
  onSaveToManual: (title: string, category: Category, body: string) => void;
}

export function MiniNotebook({
  open,
  onClose,
  onSaveToManual,
}: MiniNotebookProps) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<Category>('Study');
  const [body, setBody] = useState('');
  const [savedNotice, setSavedNotice] = useState(false);

  const wordCount = useMemo(() => {
    const trimmed = body.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }, [body]);

  if (!open) {
    return null;
  }

  const handleSave = () => {
    if (!body.trim() && !title.trim()) {
      return;
    }
    const finalTitle =
      title.trim() || `Scratch Note · ${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
    onSaveToManual(finalTitle, category, body.trim());
    setTitle('');
    setBody('');
    setSavedNotice(true);
    window.setTimeout(() => setSavedNotice(false), 1800);
  };

  return (
    <section
      aria-label="Mini-Notebook"
      className="fixed right-5 bottom-5 z-30 flex w-[calc(100vw-2.5rem)] max-w-sm flex-col rounded-xl border border-[#2D3242] bg-[#161922] shadow-2xl shadow-black/60"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[#252A38] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <NotebookPen className="h-4 w-4 text-[#E0A83E]" />
          <h2 className="font-serif text-sm font-semibold text-[#F3EFE6]">
            Mini-Notebook
          </h2>
        </div>
        <div className="flex items-center gap-1">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as Category)}
            aria-label="Scratch note category"
            className="rounded border border-[#2A2F3D] bg-[#101218] px-2 py-1 text-[11px] text-[#C8CCD6] focus:border-[#E0A83E]/60 focus:outline-none"
          >
            {CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Mini-Notebook"
            className="rounded p-1.5 text-[#8E95A5] transition-colors hover:bg-[#222735] hover:text-[#ECEBE6]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Distraction-free body */}
      <div className="space-y-2 p-4">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Quick heading (optional)"
          className="w-full border-b border-[#232734] bg-transparent pb-1.5 font-serif text-sm text-[#F3EFE6] placeholder-[#656C7D] focus:border-[#E0A83E]/50 focus:outline-none"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          placeholder="Jot down a thought, citation, or question without leaving your current view..."
          className="w-full resize-none bg-transparent text-xs leading-relaxed text-[#D8D7D0] placeholder-[#656C7D] focus:outline-none"
        />
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-[#252A38] px-4 py-2.5">
        <span className="text-[11px] text-[#7D8496] tabular-nums">
          {wordCount} {wordCount === 1 ? 'word' : 'words'}
        </span>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setTitle('');
              setBody('');
            }}
            disabled={!title && !body}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[#8E95A5] transition-colors hover:text-[#ECEBE6] disabled:opacity-40"
          >
            <Trash2 className="h-3 w-3" />
            <span>Clear</span>
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!body.trim() && !title.trim()}
            className="flex items-center gap-1 rounded-md bg-[#E0A83E] px-2.5 py-1 text-[11px] font-semibold text-[#111216] transition-colors hover:bg-[#ECB955] disabled:opacity-40"
          >
            {savedNotice ? (
              <>
                <Check className="h-3 w-3" />
                <span>Saved</span>
              </>
            ) : (
              <span>Save to Manual</span>
            )}
          </button>
        </div>
      </div>
    </section>
  );
}
