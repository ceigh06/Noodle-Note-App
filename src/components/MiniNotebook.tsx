import {useEffect, useMemo, useState} from 'react';
import {Check, NotebookPen, Trash2, X} from 'lucide-react';
import {Category, UserCategoryConfig} from '../types/noodle';
import {getSubfoldersForCategory} from '../storage/categoryConfig';

interface MiniNotebookProps {
  open: boolean;
  categoryConfigs: UserCategoryConfig[];
  onClose: () => void;
  onSaveToManual: (
    title: string,
    category: Category,
    body: string,
    subfolder?: string,
  ) => void;
}

export function MiniNotebook({
  open,
  categoryConfigs,
  onClose,
  onSaveToManual,
}: MiniNotebookProps) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<Category>(
    categoryConfigs[0]?.name || 'Study',
  );
  const [subfolder, setSubfolder] = useState('');
  const [body, setBody] = useState('');
  const [savedNotice, setSavedNotice] = useState(false);

  useEffect(() => {
    if (
      categoryConfigs.length > 0 &&
      !categoryConfigs.some((c) => c.name === category)
    ) {
      setCategory(categoryConfigs[0].name);
      setSubfolder('');
    }
  }, [category, categoryConfigs]);

  const availableSubfolders = useMemo(
    () => getSubfoldersForCategory(categoryConfigs, category),
    [categoryConfigs, category],
  );

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
      title.trim() ||
      `Scratch Note · ${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
    onSaveToManual(
      finalTitle,
      category,
      body.trim(),
      subfolder.trim() || undefined,
    );
    setTitle('');
    setBody('');
    setSavedNotice(true);
    window.setTimeout(() => setSavedNotice(false), 1800);
  };

  return (
    <section
      aria-label="Mini-Notebook"
      className="fixed right-5 bottom-5 z-30 flex w-[calc(100vw-2.5rem)] max-w-sm flex-col rounded-xl border border-[#2D3242] bg-[#161922] shadow-2xl"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2">
        <div className="flex shrink-0 items-center gap-2">
          <NotebookPen className="h-4 w-4 text-[#E0A83E]" />
          <h2 className="font-serif text-sm font-semibold text-[#F3EFE6]">
            Mini-Notebook
          </h2>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setSubfolder('');
            }}
            aria-label="Scratch note category"
            className="h-8 max-w-[100px] truncate rounded-md border border-[#2A2F3D] bg-[#0E1015] px-2 text-xs text-[#C8CCD6] focus:border-[#E0A83E] focus:outline-none"
          >
            {categoryConfigs.map((cat) => (
              <option key={cat.id} value={cat.name}>
                {cat.name}
              </option>
            ))}
          </select>
          {availableSubfolders.length > 0 && (
            <select
              value={subfolder}
              onChange={(e) => setSubfolder(e.target.value)}
              aria-label="Scratch note subfolder"
              className="h-8 max-w-[100px] truncate rounded-md border border-[#2A2F3D] bg-[#0E1015] px-2 text-xs text-[#C8CCD6] focus:border-[#E0A83E] focus:outline-none"
            >
              <option value="">No subfolder</option>
              {availableSubfolders.map((sub) => (
                <option key={sub} value={sub}>
                  {sub}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Mini-Notebook"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[#8E95A5] transition-colors duration-150 hover:bg-[#222735] hover:text-[#ECEBE6]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Distraction-free body */}
      <div className="space-y-2.5 px-4 py-2">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Quick heading (optional)"
          className="w-full rounded-md bg-[#0E1015] px-2.5 py-1.5 font-serif text-sm text-[#F3EFE6] placeholder-[#656C7D] focus:outline-none focus:ring-1 focus:ring-[#E0A83E]"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          placeholder="Jot down a thought, citation, or question without leaving your current view..."
          className="w-full resize-none rounded-md bg-[#0E1015] p-2.5 text-xs leading-relaxed text-[#D8D7D0] placeholder-[#656C7D] focus:outline-none focus:ring-1 focus:ring-[#E0A83E]"
        />
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-4 pt-1 pb-3">
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
            className="inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-xs text-[#8E95A5] transition-colors duration-150 hover:bg-[#1E222E] hover:text-[#ECEBE6] disabled:opacity-40"
          >
            <Trash2 className="h-3 w-3" />
            <span>Clear</span>
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!body.trim() && !title.trim()}
            className="inline-flex h-8 items-center gap-1 rounded-md bg-[#E0A83E] px-3 text-xs font-semibold text-[#111216] transition-colors duration-150 hover:bg-[#ECB955] disabled:opacity-40"
          >
            {savedNotice ? (
              <>
                <Check className="h-3 w-3" />
                <span>Saved</span>
              </>
            ) : (
              <span>Save to My Notes</span>
            )}
          </button>
        </div>
      </div>
    </section>
  );
}
