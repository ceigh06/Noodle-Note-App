import {
  Cpu,
  Folder,
  KeyRound,
  Menu,
  NotebookPen,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import {RoutePath, WorkspaceConnectionState} from '../types/noodle';

interface TopBarProps {
  folderName: string | null;
  connectionState: WorkspaceConnectionState;
  scanning?: boolean;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  aiEnabled: boolean;
  onToggleAi: () => void;
  miniNotebookOpen: boolean;
  onToggleMiniNotebook: () => void;
  onOpenKeySetup: () => void;
  onOpenNewNote: () => void;
  onOpenMobileSidebar: () => void;
  onReconnect: () => void;
  onRescan?: () => void;
  onNavigate: (route: RoutePath) => void;
}

export function TopBar({
  folderName,
  connectionState,
  scanning = false,
  searchQuery,
  onSearchChange,
  aiEnabled,
  onToggleAi,
  miniNotebookOpen,
  onToggleMiniNotebook,
  onOpenKeySetup,
  onOpenNewNote,
  onOpenMobileSidebar,
  onReconnect,
  onRescan,
  onNavigate,
}: TopBarProps) {
  const needsReconnect = connectionState === 'restored-needs-permission';
  const displayLabel =
    connectionState === 'connected' && folderName
      ? folderName
      : needsReconnect && folderName
        ? `Reconnect: ${folderName}`
        : 'Demo Workspace (In-Memory)';

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-[#232733] bg-[#12141A] px-4 lg:px-6">
      {/* Left: Mobile menu + Workspace Folder Indicator */}
      <div className="flex min-w-0 items-center gap-2.5">
        <button
          type="button"
          onClick={onOpenMobileSidebar}
          aria-label="Open navigation menu"
          className="rounded-md p-2 text-[#9CA1AE] hover:bg-[#1B1F29] hover:text-[#ECEBE6] lg:hidden"
        >
          <Menu className="h-4 w-4" />
        </button>

        {needsReconnect ? (
          <button
            type="button"
            onClick={onReconnect}
            title="Reconnect workspace folder"
            className="flex min-w-0 items-center gap-2 rounded-md border border-[#E0A83E]/50 bg-[#E0A83E]/12 px-2.5 py-1.5 text-xs text-[#F4D084] transition-colors hover:bg-[#E0A83E]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]/60"
          >
            <RefreshCw className="h-3.5 w-3.5 shrink-0 text-[#E0A83E]" />
            <span className="max-w-[160px] truncate font-mono text-[11px] sm:max-w-[240px]">
              {displayLabel}
            </span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onNavigate('/')}
            title="Workspace setup & folder selection"
            className="flex min-w-0 items-center gap-2 rounded-md border border-[#252936] bg-[#171A22] px-2.5 py-1.5 text-xs text-[#C8CCD6] transition-colors hover:border-[#363B4D] hover:text-[#F5F2EB] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]/60"
          >
            <Folder className="h-3.5 w-3.5 shrink-0 text-[#E0A83E]" />
            <span className="max-w-[160px] truncate font-mono text-[11px] sm:max-w-[240px]">
              {displayLabel}
            </span>
          </button>
        )}

        {connectionState === 'connected' && onRescan && (
          <button
            type="button"
            onClick={onRescan}
            disabled={scanning}
            title="Rescan workspace folder for changes"
            aria-label="Rescan workspace folder"
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[#252936] bg-[#171A22] px-2.5 text-xs font-medium whitespace-nowrap text-[#B8BDC9] transition-colors hover:border-[#363B4D] hover:text-[#ECEBE6] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]/60"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 text-[#E0A83E] ${scanning ? 'animate-spin' : ''}`}
            />
            <span className="hidden sm:inline">
              {scanning ? 'Scanning' : 'Rescan'}
            </span>
          </button>
        )}
      </div>

      {/* Center: Client-side title search */}
      <div className="relative hidden max-w-md flex-1 md:block">
        <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-[#6E7587]" />
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Filter notes by title..."
          aria-label="Filter notes by title"
          className="h-9 w-full rounded-lg border border-[#252936] bg-[#0E1015] pr-8 pl-9 text-xs text-[#ECEBE6] placeholder-[#686F80] transition-colors focus:border-[#E0A83E]/60 focus:outline-none"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            aria-label="Clear title filter"
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-[#7D8496] hover:text-[#ECEBE6]"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Right: AI toggle, Mini-Notebook launcher, Key setup, Add New Note */}
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onToggleAi}
          aria-pressed={aiEnabled}
          title={aiEnabled ? 'Local AI enabled' : 'Local AI paused'}
          className={`flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]/60 ${
            aiEnabled
              ? 'border-[#E0A83E]/40 bg-[#E0A83E]/12 text-[#F0C875]'
              : 'border-[#252936] bg-[#171A22] text-[#8E95A5] hover:text-[#ECEBE6]'
          }`}
        >
          <Cpu className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">
            AI {aiEnabled ? 'On' : 'Off'}
          </span>
        </button>

        <button
          type="button"
          onClick={onToggleMiniNotebook}
          aria-pressed={miniNotebookOpen}
          title="Toggle Mini-Notebook"
          className={`flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]/60 ${
            miniNotebookOpen
              ? 'border-[#E0A83E]/40 bg-[#E0A83E]/12 text-[#F0C875]'
              : 'border-[#252936] bg-[#171A22] text-[#B8BDC9] hover:border-[#353B4C] hover:text-[#ECEBE6]'
          }`}
        >
          <NotebookPen className="h-3.5 w-3.5" />
          <span className="hidden xl:inline">Mini-Notebook</span>
        </button>

        <button
          type="button"
          onClick={onOpenKeySetup}
          title="Configure BYOK API Key"
          className="flex h-9 items-center gap-1.5 rounded-lg border border-[#252936] bg-[#171A22] px-2.5 text-xs font-medium text-[#B8BDC9] whitespace-nowrap shrink-0 transition-colors hover:border-[#353B4C] hover:text-[#ECEBE6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]/60"
        >
          <KeyRound className="h-3.5 w-3.5 text-[#E0A83E]" />
          <span className="hidden xl:inline">API Key</span>
        </button>

        <button
          type="button"
          onClick={onOpenNewNote}
          className="flex h-9 items-center gap-1.5 rounded-lg bg-[#E0A83E] px-3.5 text-xs font-semibold text-[#111216] whitespace-nowrap shrink-0 transition-colors hover:bg-[#ECB955] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]"
        >
          <Plus className="h-3.5 w-3.5 stroke-[2.5]" />
          <span>Add New Note</span>
        </button>
      </div>
    </header>
  );
}
