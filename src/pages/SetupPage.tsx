import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  ClipboardCheck,
  Cpu,
  ExternalLink,
  FolderCog,
  FolderOpen,
  Image as ImageIcon,
  Lock,
  PenLine,
  RefreshCw,
} from 'lucide-react';
import {RoutePath, WorkspaceConnectionState} from '../types/noodle';

interface SetupPageProps {
  connectionState: WorkspaceConnectionState;
  folderName: string | null;
  errorMessage: string | null;
  busy: boolean;
  onSelectFolder: () => void;
  onReconnect: () => void;
  onForgetWorkspace: () => void;
  onNavigate: (route: RoutePath) => void;
}

const FOLDER_LAYOUT = [
  {
    name: 'sources/',
    role: 'Immutable reference files (PDFs, papers, transcripts)',
    rule: 'App never writes here',
    icon: BookOpen,
  },
  {
    name: 'manual/',
    role: 'Your personal TipTap JSON notes & seminar drafts',
    rule: 'AI read-only',
    icon: PenLine,
  },
  {
    name: 'ai/',
    role: 'Generated study guides & cross-note syntheses',
    rule: 'AI outputs only',
    icon: Cpu,
  },
  {
    name: 'assets/',
    role: 'Images referenced via workspace-relative paths',
    rule: 'Relative paths',
    icon: ImageIcon,
  },
  {
    name: '.noodle/',
    role: 'Local workspace manifest & schema metadata',
    rule: 'No API keys stored',
    icon: FolderCog,
  },
];

export function SetupPage({
  connectionState,
  folderName,
  errorMessage,
  busy,
  onSelectFolder,
  onReconnect,
  onForgetWorkspace,
  onNavigate,
}: SetupPageProps) {
  const needsReconnect = connectionState === 'restored-needs-permission';
  const isBlockedOrUnsupported =
    connectionState === 'blocked-iframe' || connectionState === 'unsupported';
  const currentUrl =
    typeof window !== 'undefined' ? window.location.href : '#/';

  return (
    <div className="flex min-h-screen flex-col bg-[#0C0D10] text-[#ECEBE6]">
      {/* Minimal Desktop Title Bar */}
      <header className="flex h-14 items-center justify-between border-b border-[#202430] bg-[#111318] px-6">
        <div className="flex items-baseline gap-2.5">
          <span className="font-serif text-xl font-semibold tracking-tight text-[#F4F0E7]">
            Noodle
          </span>
          <span className="text-xs text-[#7E8596]">Local-First Study Vault</span>
        </div>

        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => onNavigate('/diagnostics')}
            className="flex items-center gap-1.5 text-xs font-medium text-[#9CA1AE] transition-colors hover:text-[#ECEBE6]"
          >
            <ClipboardCheck className="h-3.5 w-3.5" />
            <span>Diagnostics</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('/workspace')}
            className="text-xs font-medium text-[#E0A83E] transition-colors hover:text-[#F0C264]"
          >
            {connectionState === 'connected'
              ? 'Return to Workspace'
              : 'Open Demo Workspace'}
          </button>
        </div>
      </header>

      {/* Main Setup Canvas */}
      <main className="mx-auto flex w-full max-w-5xl flex-1 items-center px-6 py-12">
        <div className="grid w-full grid-cols-1 items-stretch gap-8 lg:grid-cols-12">
          {/* Left Column: Primary Setup Action */}
          <div className="flex flex-col justify-between rounded-2xl border border-[#242835] bg-[#13151C] p-8 lg:col-span-7">
            <div className="space-y-5">
              <div className="flex items-center gap-2 text-xs font-medium text-[#E0A83E]">
                <Lock className="h-3.5 w-3.5" />
                <span>Files remain on your machine</span>
              </div>

              <h1 className="font-serif text-3xl leading-tight font-semibold tracking-tight text-[#F5F1E8] text-balance sm:text-4xl">
                Choose a folder to anchor your study vault.
              </h1>

              <p className="max-w-xl text-sm leading-relaxed text-[#A4AAB7]">
                Noodle stores every note as transparent JSON inside a directory
                you own. Local AI handles search and routing; optional cloud
                synthesis uses your own API key on retrieved excerpts only.
              </p>

              {/* Restored handle awaiting permission click */}
              {needsReconnect && folderName && (
                <div className="space-y-3 rounded-xl border border-[#E0A83E]/40 bg-[#E0A83E]/10 p-4 text-xs">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <p className="font-semibold text-[#F6DFA8]">
                        Previous workspace restored from browser storage
                      </p>
                      <p className="text-[#D8C9A3]">
                        Click below to grant read/write access back to{' '}
                        <code className="rounded bg-[#0C0D10]/60 px-1.5 py-0.5 font-mono text-[#F8EBD0]">
                          {folderName}
                        </code>
                        .
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={onReconnect}
                      disabled={busy}
                      className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#E0A83E] px-4 text-xs font-semibold text-[#111216] transition-colors hover:bg-[#ECB955] disabled:opacity-50"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      <span>
                        {busy ? 'Requesting access...' : 'Reconnect workspace'}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={onForgetWorkspace}
                      className="inline-flex h-9 items-center rounded-lg border border-[#343949] bg-[#141720] px-3 text-xs text-[#B2B7C4] hover:text-[#ECEBE6]"
                    >
                      Forget saved folder
                    </button>
                  </div>
                </div>
              )}

              {/* Blocked in iframe or unsupported browser */}
              {isBlockedOrUnsupported && (
                <div
                  role="alert"
                  className="space-y-2.5 rounded-xl border border-amber-500/35 bg-amber-500/10 p-4 text-xs leading-relaxed text-amber-100"
                >
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                    <div className="space-y-1">
                      <p className="font-semibold text-amber-200">
                        {connectionState === 'blocked-iframe'
                          ? 'Folder Picker Blocked Inside Embedded Frame'
                          : 'Chromium Desktop Required for Folder Access'}
                      </p>
                      <p className="text-amber-100/85">
                        {connectionState === 'blocked-iframe'
                          ? 'Browsers block the File System Access directory picker inside cross-origin iframes. Open Noodle in its own browser tab to select a local workspace folder.'
                          : 'This browser does not support showDirectoryPicker. Use Chrome, Edge, Arc, or Brave on desktop to bind a local folder.'}
                      </p>
                    </div>
                  </div>
                  <div className="pl-7">
                    <a
                      href={currentUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-md border border-amber-400/40 bg-amber-400/15 px-3 py-1.5 text-xs font-semibold text-amber-100 transition-colors hover:bg-amber-400/25"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      <span>Open in a new tab</span>
                    </a>
                  </div>
                </div>
              )}

              {errorMessage && !isBlockedOrUnsupported && (
                <div
                  role="alert"
                  className="rounded-xl border border-rose-500/35 bg-rose-500/10 px-4 py-3 text-xs text-rose-200"
                >
                  {errorMessage}
                </div>
              )}
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-[#212531] pt-6">
              <button
                type="button"
                onClick={onSelectFolder}
                disabled={busy}
                className="inline-flex h-11 items-center gap-2.5 rounded-lg bg-[#E0A83E] px-5 text-sm font-semibold text-[#111216] transition-colors hover:bg-[#ECB955] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E] disabled:opacity-50"
              >
                <FolderOpen className="h-4 w-4" />
                <span>
                  {busy ? 'Opening picker...' : 'Select Workspace Folder'}
                </span>
                <ArrowRight className="h-4 w-4" />
              </button>

              {connectionState === 'connected' && folderName ? (
                <span className="text-xs text-[#9CA1AE]">
                  Connected to{' '}
                  <code className="font-mono text-[#E0A83E]">{folderName}</code>
                </span>
              ) : (
                <span className="text-xs text-[#7D8496]">
                  Or open the in-memory demo from the top bar
                </span>
              )}
            </div>
          </div>

          {/* Right Column: Expected Directory Layout */}
          <div className="flex flex-col justify-between rounded-2xl border border-[#242835] bg-[#111319] p-6 lg:col-span-5">
            <div>
              <h2 className="font-serif text-base font-semibold text-[#EFECE3]">
                Workspace Directory Layout
              </h2>
              <p className="mt-1 text-xs text-[#848B9B]">
                Enforced structural boundaries inside your chosen folder:
              </p>

              <ul className="mt-5 divide-y divide-[#1E222E]">
                {FOLDER_LAYOUT.map((entry) => {
                  const Icon = entry.icon;
                  return (
                    <li
                      key={entry.name}
                      className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
                    >
                      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[#E0A83E]" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <code className="font-mono text-xs font-semibold text-[#ECEBE6]">
                            {entry.name}
                          </code>
                          <span className="text-[11px] text-[#7F8698]">
                            {entry.rule}
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-[#8D94A5]">
                          {entry.role}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="mt-6 border-t border-[#1E222E] pt-4 text-[11px] text-[#767D8F]">
              IndexedDB (Dexie) persists your directory handle and rebuildable
              note index locally across browser reloads.
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
