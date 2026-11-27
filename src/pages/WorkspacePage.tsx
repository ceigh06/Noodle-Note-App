import {useRef, useState} from 'react';
import {
  AlertTriangle,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import {getSynthesisFormatLabel} from '../cloud/synthesisOutput';
import {LocalSearchPanel} from '../components/LocalSearchPanel';
import {
  getCategoryStyle,
  getSubfoldersForCategory,
  sanitizeCategoryLabel,
} from '../storage/categoryConfig';
import {
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
  UserCategoryConfig,
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
  categoryConfigs: UserCategoryConfig[];
  activeCategory: Category | 'All';
  activeSubfolder: string;
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
  onActivateAndStartMic: () => void;
  onStartPushToTalk: () => void;
  onStopPushToTalk: () => void;
  onCancelVoiceCapture: () => void;
  onMasterKillSwitch: () => void;
  onNavigate: (route: RoutePath) => void;
  connectionState: WorkspaceConnectionState;
  folderName: string | null;
  workspaceError?: string | null;
  reconnectRequiresPicker?: boolean;
  busy: boolean;
  onSelectCategory: (category: Category | 'All') => void;
  onSelectSubfolder: (subfolder: string) => void;
  onOpenCategoryManager: () => void;
  onQuickAddSubfolder: (categoryName: string, subfolderName: string) => Promise<void> | void;
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
  onForgetWorkspace?: () => void;
  onRescan: () => void;
  onSelectFolder: () => void;
}

const PILLAR_META: Record<
  PillarFilter,
  {title: string; description: string}
> = {
  all: {
    title: 'All Notes & Files',
    description:
      'Your sources, personal notes, and AI study guides.',
  },
  sources: {
    title: 'Sources',
    description:
      'PDFs, transcripts, and reference readings.',
  },
  manual: {
    title: 'My Notes',
    description:
      'Your personal notes and drafts.',
  },
  ai: {
    title: 'AI Notes',
    description:
      'Study guides, flashcards, and practice exams.',
  },
};

const PILLAR_SHORT_LABEL: Record<Pillar, string> = {
  sources: 'Sources',
  manual: 'My Notes',
  ai: 'AI Notes',
};

export function WorkspacePage({
  notes,
  sourceDocuments,
  problems,
  scanning,
  activePillar,
  categoryConfigs,
  activeCategory,
  activeSubfolder,
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
  onActivateAndStartMic,
  onStartPushToTalk,
  onStopPushToTalk,
  onCancelVoiceCapture,
  onMasterKillSwitch,
  onNavigate,
  connectionState,
  folderName,
  workspaceError = null,
  reconnectRequiresPicker = false,
  busy,
  onSelectCategory,
  onSelectSubfolder,
  onOpenCategoryManager,
  onQuickAddSubfolder,
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
  onForgetWorkspace,
  onRescan,
  onSelectFolder,
}: WorkspacePageProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [addingInlineSubfolder, setAddingInlineSubfolder] = useState(false);
  const [inlineSubfolderName, setInlineSubfolderName] = useState('');
  const pillarInfo = PILLAR_META[activePillar];
  const showProblemsPanel = problemsOpen || problems.length > 0;

  const filteredNotes = notes.filter((entry) => {
    if (activePillar !== 'all' && entry.pillar !== activePillar) {
      return false;
    }
    if (
      activeCategory !== 'All' &&
      entry.note.category.toLowerCase() !== activeCategory.toLowerCase()
    ) {
      return false;
    }
    if (
      activeCategory !== 'All' &&
      activeSubfolder !== 'All' &&
      (entry.note.subfolder ?? '').toLowerCase() !== activeSubfolder.toLowerCase()
    ) {
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
  const activeCategorySubfolders =
    activeCategory === 'All'
      ? []
      : getSubfoldersForCategory(categoryConfigs, activeCategory);

  const hasActiveFilters =
    activeCategory !== 'All' ||
    activeSubfolder !== 'All' ||
    searchQuery.trim().length > 0;

  const handleSaveInlineSubfolder = async () => {
    if (activeCategory === 'All') return;
    const clean = sanitizeCategoryLabel(inlineSubfolderName);
    if (!clean) {
      setAddingInlineSubfolder(false);
      setInlineSubfolderName('');
      return;
    }
    await onQuickAddSubfolder(activeCategory, clean);
    onSelectSubfolder(clean);
    setAddingInlineSubfolder(false);
    setInlineSubfolderName('');
  };

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
        <div className="space-y-2 rounded-xl border border-[#4D3D20] bg-[#181510] px-4 py-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-0.5">
              <p className="font-semibold text-[#F6DFA8]">
                Reconnect workspace &ldquo;{folderName}&rdquo;
              </p>
              <p className="text-[#D8C9A3]">
                Click to restore access to your local folder after reloading.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onReconnect}
                disabled={busy}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#E0A83E] px-3.5 text-xs font-semibold text-[#111216] transition-colors duration-150 hover:bg-[#ECB955] disabled:opacity-50"
              >
                {reconnectRequiresPicker ? (
                  <FolderOpen className="h-3.5 w-3.5" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                <span>
                  {busy
                    ? 'Opening...'
                    : reconnectRequiresPicker
                      ? `Re-select ${folderName}`
                      : 'Reconnect workspace'}
                </span>
              </button>
              {onForgetWorkspace && (
                <button
                  type="button"
                  onClick={onForgetWorkspace}
                  className="inline-flex h-8 items-center rounded-lg border border-[#343949] bg-[#141720] px-3 text-xs text-[#B2B7C4] hover:text-[#ECEBE6]"
                >
                  Forget
                </button>
              )}
            </div>
          </div>
          {workspaceError && (
            <p className="text-xs text-rose-300">{workspaceError}</p>
          )}
        </div>
      )}

      {/* Connected Scan Error Notice */}
      {connectionState === 'connected' && workspaceError && (
        <div
          role="alert"
          className="rounded-xl border border-[#5A2934] bg-[#1C1216] px-4 py-2.5 text-xs text-rose-200"
        >
          {workspaceError}
        </div>
      )}

      {/* Subtle Demo / Read-Only Mode Notice if no writable folder connected */}
      {connectionState !== 'connected' &&
        connectionState !== 'restored-needs-permission' && (
          <div className="space-y-2 rounded-xl border border-[#242835] bg-[#12141B] px-4 py-2.5 text-xs text-[#9CA1AE]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>
                {folderName?.endsWith('(Read-Only)')
                  ? `Viewing ${folderName}. Edits stay in memory unless you connect with write access.`
                  : connectionState === 'blocked-iframe'
                    ? 'Folder access is blocked inside an embedded window. Open Noodle in its own tab to pick or reconnect a folder.'
                    : 'Using sample notes in memory. Pick a folder to save files on your computer.'}
              </span>
              <div className="flex items-center gap-3">
                {connectionState === 'blocked-iframe' && (
                  <a
                    href={typeof window !== 'undefined' ? window.location.href : '#/'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 font-medium text-[#E0A83E] hover:text-[#F0C264]"
                  >
                    <span>Open in a new tab</span>
                  </a>
                )}
                <button
                  type="button"
                  onClick={onSelectFolder}
                  className="inline-flex items-center gap-1.5 font-medium text-[#E0A83E] hover:text-[#F0C264]"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  <span>Select Workspace Folder</span>
                </button>
              </div>
            </div>
            {workspaceError && (
              <p className="text-xs text-rose-300">{workspaceError}</p>
            )}
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
      <div className="flex flex-wrap items-end justify-between gap-4 pb-2">
        <div className="space-y-1">
          <h1 className="font-serif text-2xl font-semibold text-[#F5F1E8] sm:text-3xl">
            {pillarInfo.title}
          </h1>
          <p className="max-w-prose text-xs text-[#9198A8] sm:text-sm">
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
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#272C3A] bg-[#151822] px-3 text-xs font-medium text-[#C8CCD6] whitespace-nowrap transition-colors duration-150 hover:border-[#3A4154] hover:text-[#F4F0E7] disabled:opacity-50"
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
                className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium whitespace-nowrap tabular-nums transition-colors duration-150 ${
                  problems.length > 0
                    ? 'border-amber-500 bg-[#1F1A14] text-amber-200 hover:bg-[#272017]'
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
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#272C3A] bg-[#151822] px-3 text-xs font-medium text-[#C8CCD6] whitespace-nowrap transition-colors duration-150 hover:border-[#3A4154] hover:text-[#F4F0E7]"
          >
            <Upload className="h-3.5 w-3.5" />
            <span>Import .md</span>
          </button>

          {connectionState !== 'connected' && onImportDemoPdf && (
            <button
              type="button"
              onClick={() => pdfInputRef.current?.click()}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#272C3A] bg-[#151822] px-3 text-xs font-medium text-[#C8CCD6] whitespace-nowrap transition-colors duration-150 hover:border-[#3A4154] hover:text-[#F4F0E7]"
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
        onActivateAndStartMic={onActivateAndStartMic}
        onStartPushToTalk={onStartPushToTalk}
        onStopPushToTalk={onStopPushToTalk}
        onCancelVoiceCapture={onCancelVoiceCapture}
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
              slide file{unsupportedPptxCount === 1 ? '' : 's'} in Sources.
              Slide formats (.pptx) are not supported yet — PDF, .txt, and .md
              files are searchable.
            </span>
          ) : (
            <span>
              Supported source files: PDF, <code className="font-mono">.txt</code>,
              and <code className="font-mono">.md</code>. Slide formats (.pptx)
              are not supported yet.
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
              No file problems found. All notes and sources are readable.
            </p>
          ) : (
            <div className="mt-3 space-y-1.5 rounded-lg bg-[#0F1117] p-2">
              {problems.map((problem) => (
                <div
                  key={problem.id}
                  className="flex flex-wrap items-start justify-between gap-2 rounded-md px-2.5 py-2 hover:bg-[#161923]"
                >
                  <div className="min-w-0 space-y-0.5">
                    <p className="truncate font-mono text-[11px] font-medium text-amber-200">
                      {problem.path}
                    </p>
                    <p className="text-[#B8BDC9]">{problem.reason}</p>
                  </div>
                  <span className="shrink-0 text-[11px] text-[#7D8496]">
                    {PILLAR_SHORT_LABEL[problem.pillar]}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Customizable Top-Level Category Tabs & Nested Subfolders */}
      <div className="space-y-3">
        <div
          role="toolbar"
          aria-label="Filter by category"
          className="flex flex-wrap items-center gap-1.5"
        >
          <button
            type="button"
            onClick={() => {
              onSelectCategory('All');
              onSelectSubfolder('All');
              setAddingInlineSubfolder(false);
              setInlineSubfolderName('');
            }}
            aria-pressed={activeCategory === 'All'}
            className={`h-9 rounded-lg border px-3.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E] ${
              activeCategory === 'All'
                ? 'border-[#E0A83E] bg-[#1D2230] text-[#F3CA77]'
                : 'border-[#252936] bg-[#141720] text-[#9CA1AE] hover:border-[#363C4D] hover:text-[#ECEBE6]'
            }`}
          >
            All Categories
          </button>

          {categoryConfigs.map((cat) => {
            const style = getCategoryStyle(cat.name, categoryConfigs);
            const isSelected =
              activeCategory !== 'All' &&
              activeCategory.toLowerCase() === cat.name.toLowerCase();
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => {
                  onSelectCategory(cat.name);
                  onSelectSubfolder('All');
                  setAddingInlineSubfolder(false);
                  setInlineSubfolderName('');
                }}
                aria-pressed={isSelected}
                className={`flex h-9 items-center gap-2 rounded-lg border px-3.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E] ${
                  isSelected
                    ? `${style.activeBg} ${style.activeBorder} ${style.text}`
                    : 'border-[#252936] bg-[#141720] text-[#9CA1AE] hover:border-[#363C4D] hover:text-[#ECEBE6]'
                }`}
              >
                <span className={`h-2 w-2 rounded-[2px] ${style.dot}`} />
                <span>{cat.name}</span>
                {cat.subfolders.length > 0 && (
                  <span className="text-[11px] opacity-75 tabular-nums">
                    {cat.subfolders.length}
                  </span>
                )}
              </button>
            );
          })}

          <button
            type="button"
            onClick={onOpenCategoryManager}
            title="Add, rename, recolor categories and subfolders"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#252936] bg-[#141720] px-3 text-xs font-medium text-[#B8BDC9] whitespace-nowrap shrink-0 transition-colors duration-150 hover:border-[#3A4154] hover:text-[#F3CA77]"
          >
            <SlidersHorizontal className="h-3.5 w-3.5 text-[#E0A83E]" />
            <span>Customize</span>
          </button>
        </div>

        {/* Subfolders row when a top-level category is selected */}
        {activeCategory !== 'All' && (
          <div
            key={activeCategory}
            role="toolbar"
            aria-label={`Subfolders in ${activeCategory}`}
            className="flex flex-wrap items-center gap-1.5 pl-1 text-xs"
          >
            <span className="mr-1 inline-flex items-center gap-1.5 text-xs font-medium text-[#7D8496]">
              <Folder className="h-3.5 w-3.5 text-[#E0A83E]" />
              <span>{activeCategory}</span>
            </span>

            <button
              type="button"
              onClick={() => onSelectSubfolder('All')}
              aria-pressed={activeSubfolder === 'All'}
              className={`h-8 rounded-lg border px-2.5 text-xs font-medium transition-colors duration-150 ${
                activeSubfolder === 'All'
                  ? 'border-[#E0A83E] bg-[#1D2230] text-[#F3CA77]'
                  : 'border-[#262B38] bg-[#141720] text-[#9CA1AE] hover:border-[#363C4D] hover:text-[#ECEBE6]'
              }`}
            >
              All
            </button>

            {activeCategorySubfolders.map((sub) => {
              const subSelected =
                activeSubfolder !== 'All' &&
                activeSubfolder.toLowerCase() === sub.toLowerCase();
              return (
                <button
                  key={sub}
                  type="button"
                  onClick={() => onSelectSubfolder(sub)}
                  aria-pressed={subSelected}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors duration-150 ${
                    subSelected
                      ? 'border-[#E0A83E] bg-[#1D2230] text-[#F3CA77]'
                      : 'border-[#262B38] bg-[#141720] text-[#9CA1AE] hover:border-[#363C4D] hover:text-[#ECEBE6]'
                  }`}
                >
                  <Folder className="h-3.5 w-3.5" />
                  <span>{sub}</span>
                </button>
              );
            })}

            {addingInlineSubfolder ? (
              <span className="inline-flex items-center gap-1.5">
                <input
                  type="text"
                  autoFocus
                  value={inlineSubfolderName}
                  onChange={(e) => setInlineSubfolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleSaveInlineSubfolder();
                    } else if (e.key === 'Escape') {
                      setAddingInlineSubfolder(false);
                      setInlineSubfolderName('');
                    }
                  }}
                  placeholder={`New subfolder in ${activeCategory}...`}
                  className="h-8 w-44 rounded-lg border border-[#E0A83E] bg-[#0D0F14] px-2.5 text-xs text-[#ECEBE6] placeholder-[#656C7D] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void handleSaveInlineSubfolder()}
                  className="h-8 rounded-lg bg-[#E0A83E] px-2.5 text-xs font-semibold text-[#111216] hover:bg-[#ECB955]"
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAddingInlineSubfolder(false);
                    setInlineSubfolderName('');
                  }}
                  className="h-8 rounded-lg border border-[#2C3140] px-2.5 text-xs text-[#9CA1AE] hover:text-white"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setAddingInlineSubfolder(true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#262B38] bg-[#141720] px-2.5 text-xs font-medium text-[#9CA1AE] transition-colors duration-150 hover:border-[#3A4154] hover:text-[#F3CA77]"
              >
                <FolderPlus className="h-3.5 w-3.5" />
                <span>Add Subfolder</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Note & Source Grid or Empty State */}
      {totalShownCount === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-[#232734] bg-[#12141B] px-6 py-16 text-center">
          <FileText className="h-8 w-8 text-[#596072]" />
          <h2 className="mt-3 font-serif text-lg font-semibold text-[#EFECE3]">
            No matching notes
          </h2>
          <p className="mt-1 max-w-md text-xs leading-relaxed text-[#888F9F]">
            {activeCategory !== 'All' && !searchQuery.trim()
              ? activeSubfolder !== 'All'
                ? `No notes in ${activeCategory} / ${activeSubfolder} yet.`
                : `No notes in ${activeCategory} yet.`
              : hasActiveFilters
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
            const catStyle = getCategoryStyle(note.category, categoryConfigs);
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
                    ? 'border-[#332E4D] bg-[#151521] hover:border-[#4B4470] hover:bg-[#191928]'
                    : 'border-[#232734] bg-[#141720] hover:border-[#373D50] hover:bg-[#181C27]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onOpenNote(entry)}
                  className="flex h-full w-full flex-col justify-between rounded-xl p-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]"
                >
                  <div>
                    {/* Unboxed typographic metadata line */}
                    <div className="flex flex-wrap items-center gap-2 text-xs text-[#8990A2]">
                      {isAiNote ? (
                        <span className="inline-flex items-center gap-1.5 font-medium text-violet-300">
                          <Sparkles className="h-3.5 w-3.5 text-violet-300" />
                          <span>
                            AI Note
                            {note.aiMeta
                              ? ` · ${getSynthesisFormatLabel(note.aiMeta.format)}`
                              : ''}
                          </span>
                        </span>
                      ) : (
                        <span className={`font-medium ${catStyle.text}`}>
                          {note.category}
                          {note.subfolder ? ` / ${note.subfolder}` : ''}
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
                  <div className="mt-5 flex items-center justify-between text-[11px] text-[#767D8F]">
                    <span className="truncate tabular-nums">
                      {note.aiMeta
                        ? `${note.aiMeta.sourcesUsed.length} sources`
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
                  className="flex h-full w-full flex-col justify-between rounded-xl p-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]"
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

                  <div className="mt-5 flex items-center justify-between text-[11px] text-[#767D8F]">
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
