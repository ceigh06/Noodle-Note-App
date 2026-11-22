import {useRef, useState} from 'react';
import {
  AlertTriangle,
  FileText,
  FolderOpen,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import {getSynthesisFormatLabel} from '../cloud/synthesisOutput';
import {LocalSearchPanel} from '../components/LocalSearchPanel';
import {
  CATEGORIES,
  CATEGORY_STYLE,
  Category,
  EmbeddingModelConfig,
  EmbeddingProgressState,
  Pillar,
  PillarFilter,
  RoutePath,
  ScanProblem,
  SearchResultItem,
  SourceDocumentEntry,
  StoredNoteEntry,
  VoiceRuntimeState,
  VoiceSearchSettings,
  WhisperProgressState,
  WorkspaceConnectionState,
} from '../types/noodle';

interface WorkspacePageProps {
  notes: StoredNoteEntry[];
  sourceDocuments: SourceDocumentEntry[];
  problems: ScanProblem[];
  scanning: boolean;
  activePillar: PillarFilter;
  activeCategory: Category | 'All';
  searchQuery: string;
  localSearchQuery: string;
  searching: boolean;
  searchMode: 'semantic' | 'word-match';
  searchResults: SearchResultItem[];
  aiEnabled: boolean;
  embeddingConfig: EmbeddingModelConfig;
  embeddingProgress: EmbeddingProgressState;
  voiceSettings: VoiceSearchSettings;
  voiceRuntime: VoiceRuntimeState;
  whisperProgress: WhisperProgressState;
  onStartPushToTalk: () => void;
  onStopPushToTalk: () => void;
  onMasterKillSwitch: () => void;
  onNavigate: (route: RoutePath) => void;
  connectionState: WorkspaceConnectionState;
  folderName: string | null;
  busy: boolean;
  onSelectCategory: (category: Category | 'All') => void;
  onSearchChange: (query: string) => void;
  onLocalSearchChange: (query: string) => void;
  onResetFilters: () => void;
  onOpenNote: (entry: StoredNoteEntry) => void;
  onOpenSourceDoc: (doc: SourceDocumentEntry) => void;
  onOpenSearchResult: (result: SearchResultItem) => void;
  onDownloadModel: () => void;
  onCancelModelWork: () => void;
  onChangeModelId: (modelId: string) => void;
  onOpenNewNote: () => void;
  onImportMarkdown: (file: File) => Promise<void>;
  onImportDemoPdf?: (file: File) => Promise<void>;
  onReconnect: () => void;
  onRescan: () => void;
  onSelectFolder: () => void;
}

const PILLAR_META: Record<
  PillarFilter,
  {title: string; description: string}
> = {
  all: {
    title: 'All Workspace Notes',
    description:
      'Combined view across immutable sources, manual writing, and AI study outputs.',
  },
  sources: {
    title: 'Sources',
    description:
      'Papers, PDFs, lecture transcripts, and reference texts. Strictly read-only to Noodle.',
  },
  manual: {
    title: 'Manual Notes',
    description:
      'Your own writing, seminar drafts, and problem sets. AI may read but never edit.',
  },
  ai: {
    title: 'AI Outputs',
    description:
      'Study guides, cross-note comparisons, and synthesized outlines generated in ai/.',
  },
};

const PILLAR_SHORT_LABEL: Record<Pillar, string> = {
  sources: 'Sources',
  manual: 'Manual',
  ai: 'AI Output',
};

export function WorkspacePage({
  notes,
  sourceDocuments,
  problems,
  scanning,
  activePillar,
  activeCategory,
  searchQuery,
  localSearchQuery,
  searching,
  searchMode,
  searchResults,
  aiEnabled,
  embeddingConfig,
  embeddingProgress,
  voiceSettings,
  voiceRuntime,
  whisperProgress,
  onStartPushToTalk,
  onStopPushToTalk,
  onMasterKillSwitch,
  onNavigate,
  connectionState,
  folderName,
  busy,
  onSelectCategory,
  onSearchChange,
  onLocalSearchChange,
  onResetFilters,
  onOpenNote,
  onOpenSourceDoc,
  onOpenSearchResult,
  onDownloadModel,
  onCancelModelWork,
  onChangeModelId,
  onOpenNewNote,
  onImportMarkdown,
  onImportDemoPdf,
  onReconnect,
  onRescan,
  onSelectFolder,
}: WorkspacePageProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const pillarInfo = PILLAR_META[activePillar];
  const showProblemsPanel = problemsOpen || problems.length > 0;

  const filteredNotes = notes.filter((entry) => {
    if (activePillar !== 'all' && entry.pillar !== activePillar) {
      return false;
    }
    if (activeCategory !== 'All' && entry.note.category !== activeCategory) {
      return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      if (!entry.note.title.toLowerCase().includes(q)) {
        return false;
      }
    }
    return true;
  });

  const filteredSources = sourceDocuments.filter((doc) => {
    if (activePillar !== 'all' && activePillar !== 'sources') {
      return false;
    }
    if (activeCategory !== 'All') {
      return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      if (!doc.title.toLowerCase().includes(q)) {
        return false;
      }
    }
    return true;
  });

  const unsupportedPptxCount = sourceDocuments.filter(
    (d) => d.kind === 'unsupported-pptx',
  ).length;
  const totalShownCount = filteredNotes.length + filteredSources.length;

  const hasActiveFilters =
    activeCategory !== 'All' || searchQuery.trim().length > 0;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 lg:px-8">
      {/* Hidden Markdown File Input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.markdown,.txt"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            void onImportMarkdown(file);
            e.target.value = '';
          }
        }}
      />
      {/* Hidden Demo PDF Input */}
      <input
        ref={pdfInputRef}
        type="file"
        accept=".pdf,application/pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && onImportDemoPdf) {
            void onImportDemoPdf(file);
            e.target.value = '';
          }
        }}
      />

      {/* Reconnect Banner on Reload */}
      {connectionState === 'restored-needs-permission' && folderName && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#E0A83E]/40 bg-[#E0A83E]/10 px-4 py-3 text-xs">
          <div className="space-y-0.5">
            <p className="font-semibold text-[#F6DFA8]">
              Reconnect workspace &ldquo;{folderName}&rdquo;
            </p>
            <p className="text-[#D8C9A3]">
              Browser reload requires a click to restore read/write permission
              to your local folder.
            </p>
          </div>
          <button
            type="button"
            onClick={onReconnect}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#E0A83E] px-3.5 text-xs font-semibold text-[#111216] transition-colors hover:bg-[#ECB955] disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>{busy ? 'Reconnecting...' : 'Reconnect workspace'}</span>
          </button>
        </div>
      )}

      {/* Subtle Demo Mode Notice if no real folder connected */}
      {connectionState !== 'connected' &&
        connectionState !== 'restored-needs-permission' && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#242835] bg-[#12141B] px-4 py-2.5 text-xs text-[#9CA1AE]">
            <span>
              Viewing in-memory demo notes. Select a local folder to persist
              notes to disk.
            </span>
            <button
              type="button"
              onClick={onSelectFolder}
              className="inline-flex items-center gap-1.5 font-medium text-[#E0A83E] hover:text-[#F0C264]"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              <span>Select Workspace Folder</span>
            </button>
          </div>
        )}

      {/* Mobile title search */}
      <div className="relative md:hidden">
        <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-[#6E7587]" />
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Filter notes by title..."
          aria-label="Filter notes by title"
          className="h-10 w-full rounded-lg border border-[#252936] bg-[#12141A] pr-8 pl-9 text-xs text-[#ECEBE6] placeholder-[#686F80] focus:border-[#E0A83E]/60 focus:outline-none"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            aria-label="Clear title filter"
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-[#7D8496] hover:text-[#ECEBE6]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Pillar Heading + Import .md */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#202430] pb-5">
        <div className="space-y-1">
          <h1 className="font-serif text-2xl font-semibold tracking-tight text-[#F5F1E8] sm:text-3xl">
            {pillarInfo.title}
          </h1>
          <p className="text-xs text-[#9198A8] sm:text-sm">
            {pillarInfo.description}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {connectionState === 'connected' && (
            <>
              <button
                type="button"
                onClick={onRescan}
                disabled={scanning}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#272C3A] bg-[#151822] px-3 text-xs font-medium text-[#C8CCD6] whitespace-nowrap transition-colors hover:border-[#3A4154] hover:text-[#F4F0E7] disabled:opacity-50"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${scanning ? 'animate-spin text-[#E0A83E]' : ''}`}
                />
                <span>{scanning ? 'Scanning...' : 'Rescan'}</span>
              </button>

              <button
                type="button"
                onClick={() => setProblemsOpen((prev) => !prev)}
                aria-expanded={showProblemsPanel}
                className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium whitespace-nowrap tabular-nums transition-colors ${
                  problems.length > 0
                    ? 'border-amber-500/45 bg-amber-500/12 text-amber-200 hover:bg-amber-500/20'
                    : 'border-[#272C3A] bg-[#151822] text-[#9CA1AE] hover:border-[#3A4154] hover:text-[#F4F0E7]'
                }`}
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                <span>Problems ({problems.length})</span>
              </button>
            </>
          )}

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#272C3A] bg-[#151822] px-3 text-xs font-medium text-[#C8CCD6] whitespace-nowrap transition-colors hover:border-[#3A4154] hover:text-[#F4F0E7]"
          >
            <Upload className="h-3.5 w-3.5" />
            <span>Import .md</span>
          </button>

          {connectionState !== 'connected' && onImportDemoPdf && (
            <button
              type="button"
              onClick={() => pdfInputRef.current?.click()}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#272C3A] bg-[#151822] px-3 text-xs font-medium text-[#C8CCD6] whitespace-nowrap transition-colors hover:border-[#3A4154] hover:text-[#F4F0E7]"
            >
              <FileText className="h-3.5 w-3.5 text-[#E0A83E]" />
              <span>Open Demo PDF</span>
            </button>
          )}

          <div className="text-xs text-[#888F9F] tabular-nums">
            Showing{' '}
            <span className="font-semibold text-[#ECEBE6]">
              {totalShownCount}
            </span>{' '}
            {totalShownCount === 1 ? 'item' : 'items'}
          </div>
        </div>
      </div>

      {/* On-Device Semantic & Word-Match Search */}
      <LocalSearchPanel
        query={localSearchQuery}
        onQueryChange={onLocalSearchChange}
        searching={searching}
        searchMode={searchMode}
        results={searchResults}
        aiEnabled={aiEnabled}
        embeddingConfig={embeddingConfig}
        progressState={embeddingProgress}
        voiceSettings={voiceSettings}
        voiceRuntime={voiceRuntime}
        whisperProgress={whisperProgress}
        onStartPushToTalk={onStartPushToTalk}
        onStopPushToTalk={onStopPushToTalk}
        onMasterKillSwitch={onMasterKillSwitch}
        onOpenSettings={onNavigate}
        onDownloadModel={onDownloadModel}
        onCancelWork={onCancelModelWork}
        onChangeModelId={onChangeModelId}
        onOpenResult={onOpenSearchResult}
      />

      {/* Plain format notice for Sources / .pptx */}
      {(activePillar === 'sources' || unsupportedPptxCount > 0) && (
        <div className="rounded-xl border border-[#232734] bg-[#12141B] px-4 py-2.5 text-xs text-[#9CA1AE]">
          {unsupportedPptxCount > 0 ? (
            <span>
              Found{' '}
              <span className="font-semibold text-amber-200 tabular-nums">
                {unsupportedPptxCount}
              </span>{' '}
              slide file{unsupportedPptxCount === 1 ? '' : 's'} in{' '}
              <code className="font-mono">sources/</code>. Slide formats (.pptx)
              are not supported yet — PDF, .txt, and .md files are indexed locally.
            </span>
          ) : (
            <span>
              Indexed source formats in <code className="font-mono">sources/</code>:
              PDF, <code className="font-mono">.txt</code>, and{' '}
              <code className="font-mono">.md</code>. Slide formats (.pptx) are not
              supported yet.
            </span>
          )}
        </div>
      )}

      {/* Problems Panel (tolerates unreadable or malformed files without crashing) */}
      {connectionState === 'connected' && showProblemsPanel && (
        <section
          aria-label="Workspace file problems"
          className={`rounded-xl border p-4 text-xs ${
            problems.length > 0
              ? 'border-amber-500/40 bg-amber-500/8'
              : 'border-[#232734] bg-[#13161E]'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <AlertTriangle
                className={`h-4 w-4 ${
                  problems.length > 0 ? 'text-amber-300' : 'text-[#888F9F]'
                }`}
              />
              <h2 className="font-serif text-sm font-semibold text-[#F4F0E7]">
                Problems
              </h2>
              <span className="text-[#9CA1AE] tabular-nums">
                · {problems.length}{' '}
                {problems.length === 1 ? 'file issue' : 'file issues'}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onRescan}
                disabled={scanning}
                className="rounded-md border border-[#2C3140] bg-[#151820] px-2.5 py-1 text-[11px] font-medium text-[#D8D7D0] hover:text-white disabled:opacity-50"
              >
                {scanning ? 'Scanning...' : 'Rescan'}
              </button>
              {problems.length === 0 && (
                <button
                  type="button"
                  onClick={() => setProblemsOpen(false)}
                  className="rounded-md border border-[#2C3140] bg-[#151820] px-2.5 py-1 text-[11px] text-[#9CA1AE] hover:text-white"
                >
                  Close
                </button>
              )}
            </div>
          </div>

          {problems.length === 0 ? (
            <p className="mt-2 text-[#888F9F]">
              No unreadable or malformed files found in <code className="font-mono">sources/</code>,{' '}
              <code className="font-mono">manual/</code>, or <code className="font-mono">ai/</code>.
            </p>
          ) : (
            <div className="mt-3 divide-y divide-[#2A261E] rounded-lg border border-amber-500/25 bg-[#12141A]">
              {problems.map((problem) => (
                <div
                  key={problem.id}
                  className="flex flex-wrap items-start justify-between gap-2 px-3.5 py-2.5"
                >
                  <div className="min-w-0 space-y-0.5">
                    <p className="truncate font-mono text-[11px] font-medium text-amber-200">
                      {problem.path}
                    </p>
                    <p className="text-[#B8BDC9]">{problem.reason}</p>
                  </div>
                  <span className="shrink-0 font-mono text-[11px] text-[#7D8496]">
                    {problem.pillar}/
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Interactive Category Filter Pills */}
      <div
        role="toolbar"
        aria-label="Filter by category"
        className="flex flex-wrap items-center gap-2"
      >
        <button
          type="button"
          onClick={() => onSelectCategory('All')}
          aria-pressed={activeCategory === 'All'}
          className={`h-8 rounded-full border px-3.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]/60 ${
            activeCategory === 'All'
              ? 'border-[#E0A83E]/55 bg-[#E0A83E]/15 text-[#F3CA77]'
              : 'border-[#262B38] bg-[#141720] text-[#9CA1AE] hover:border-[#363C4D] hover:text-[#ECEBE6]'
          }`}
        >
          All Categories
        </button>

        {CATEGORIES.map((category) => {
          const style = CATEGORY_STYLE[category];
          const isSelected = activeCategory === category;
          return (
            <button
              key={category}
              type="button"
              onClick={() => onSelectCategory(category)}
              aria-pressed={isSelected}
              className={`flex h-8 items-center gap-2 rounded-full border px-3.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]/60 ${
                isSelected
                  ? `${style.activeBg} ${style.activeBorder} ${style.text}`
                  : 'border-[#262B38] bg-[#141720] text-[#9CA1AE] hover:border-[#363C4D] hover:text-[#ECEBE6]'
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${style.dot}`} />
              <span>{category}</span>
            </button>
          );
        })}
      </div>

      {/* Note & Source Grid or Empty State */}
      {totalShownCount === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-[#232734] bg-[#12141B] px-6 py-16 text-center">
          <FileText className="h-8 w-8 text-[#596072]" />
          <h2 className="mt-3 font-serif text-lg font-semibold text-[#EFECE3]">
            No matching notes
          </h2>
          <p className="mt-1 max-w-md text-xs leading-relaxed text-[#888F9F]">
            {hasActiveFilters
              ? 'No notes match your current title filter or selected category.'
              : 'This pillar does not contain any notes yet.'}
          </p>
          <div className="mt-5 flex items-center gap-3">
            {hasActiveFilters && (
              <button
                type="button"
                onClick={onResetFilters}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#2C3140] bg-[#181B24] px-3.5 py-2 text-xs font-medium text-[#D8D7D0] transition-colors hover:border-[#3E4559] hover:text-white"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Reset filters</span>
              </button>
            )}
            <button
              type="button"
              onClick={onOpenNewNote}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#E0A83E] px-3.5 py-2 text-xs font-semibold text-[#111216] transition-colors hover:bg-[#ECB955]"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add New Note</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filteredNotes.map((entry) => {
            const {note} = entry;
            const catStyle = CATEGORY_STYLE[note.category];
            const isAiNote =
              entry.pillar === 'ai' || note.aiMeta?.isAiGenerated === true;
            const dateStr = new Date(note.updatedAt).toLocaleDateString(
              undefined,
              {month: 'short', day: 'numeric'},
            );

            return (
              <article
                key={`${entry.pillar}-${entry.fileName}-${note.id}`}
                className={`group flex flex-col justify-between rounded-xl border transition-colors duration-150 ${
                  isAiNote
                    ? 'border-violet-400/30 bg-[#151521] hover:border-violet-400/55 hover:bg-[#191928]'
                    : 'border-[#232734] bg-[#141720] hover:border-[#373D50] hover:bg-[#181C27]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onOpenNote(entry)}
                  className="flex h-full w-full flex-col justify-between rounded-xl p-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]/60"
                >
                  <div>
                    {/* Unboxed typographic metadata line */}
                    <div className="flex flex-wrap items-center gap-2 text-xs text-[#8990A2]">
                      {isAiNote ? (
                        <span className="inline-flex items-center gap-1.5 font-medium text-violet-300">
                          <Sparkles className="h-3.5 w-3.5 text-violet-300" />
                          <span>
                            AI Output
                            {note.aiMeta
                              ? ` · ${getSynthesisFormatLabel(note.aiMeta.format)}`
                              : ''}
                          </span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 font-medium text-[#D5D4CD]">
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${catStyle.dot}`}
                          />
                          {note.category}
                        </span>
                      )}
                      {!isAiNote && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{PILLAR_SHORT_LABEL[entry.pillar]}</span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">{dateStr}</span>
                    </div>

                    {/* Title */}
                    <h2 className="mt-2.5 font-serif text-[17px] leading-snug font-semibold text-[#F2EEE4] transition-colors group-hover:text-[#F8DDA0]">
                      {note.title}
                    </h2>

                    {/* Excerpt */}
                    <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-[#9CA1AE]">
                      {entry.excerpt}
                    </p>
                  </div>

                  {/* Quiet Footer */}
                  <div className="mt-5 flex items-center justify-between border-t border-[#1F2330] pt-3 text-[11px] text-[#767D8F]">
                    <span className="truncate font-mono tabular-nums">
                      {note.aiMeta
                        ? `${note.aiMeta.model} · ${note.aiMeta.sourcesUsed.length} sources`
                        : `${entry.wordCount} words`}
                    </span>
                    <span className="shrink-0 font-medium text-[#9CA1AE] transition-colors group-hover:text-[#E0A83E]">
                      Open editor →
                    </span>
                  </div>
                </button>
              </article>
            );
          })}

          {filteredSources.map((doc) => {
            const dateStr = new Date(doc.updatedAt).toLocaleDateString(
              undefined,
              {month: 'short', day: 'numeric'},
            );
            const formatLabel =
              doc.kind === 'pdf'
                ? 'PDF'
                : doc.kind === 'md'
                  ? 'Markdown'
                  : doc.kind === 'txt'
                    ? 'Text'
                    : 'PPTX (Unsupported)';
            const firstExcerpt =
              doc.kind === 'unsupported-pptx'
                ? doc.unsupportedReason ||
                  'Slide formats (.pptx) are not supported yet.'
                : doc.chunks[0]?.text || 'No text extracted from this file.';

            return (
              <article
                key={doc.id}
                className="group flex flex-col justify-between rounded-xl border border-[#232734] bg-[#141720] transition-colors duration-150 hover:border-[#373D50] hover:bg-[#181C27]"
              >
                <button
                  type="button"
                  onClick={() => onOpenSourceDoc(doc)}
                  className="flex h-full w-full flex-col justify-between rounded-xl p-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]/60"
                >
                  <div>
                    <div className="flex items-center gap-2 text-xs text-[#8990A2]">
                      <span className="font-medium text-[#D5D4CD]">
                        {formatLabel}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>Sources</span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">{dateStr}</span>
                    </div>

                    <h2 className="mt-2.5 font-serif text-[17px] leading-snug font-semibold text-[#F2EEE4] transition-colors group-hover:text-[#F8DDA0]">
                      {doc.title}
                    </h2>

                    <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-[#9CA1AE]">
                      {firstExcerpt}
                    </p>
                  </div>

                  <div className="mt-5 flex items-center justify-between border-t border-[#1F2330] pt-3 text-[11px] text-[#767D8F]">
                    <span className="tabular-nums">
                      {doc.kind === 'unsupported-pptx'
                        ? 'Not indexed'
                        : `${doc.chunks.length} blocks`}
                    </span>
                    <span className="font-medium text-[#9CA1AE] transition-colors group-hover:text-[#E0A83E]">
                      Read source →
                    </span>
                  </div>
                </button>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
