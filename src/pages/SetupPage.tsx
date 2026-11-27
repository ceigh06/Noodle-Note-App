import {useRef} from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  ClipboardCheck,
  Cpu,
  ExternalLink,
  FolderOpen,
  Image as ImageIcon,
  PenLine,
  RefreshCw,
} from 'lucide-react';
import {isInsideIframe} from '../storage/workspaceStorage';
import {RoutePath, WorkspaceConnectionState} from '../types/noodle';

interface SetupPageProps {
  connectionState: WorkspaceConnectionState;
  folderName: string | null;
  errorMessage: string | null;
  busy: boolean;
  reconnectRequiresPicker?: boolean;
  onSelectFolder: () => void;
  onImportReadOnlyFolder?: (files: FileList) => void;
  onReconnect: () => void;
  onForgetWorkspace: () => void;
  onNavigate: (route: RoutePath) => void;
}

const FOLDER_LAYOUT = [
  {
    name: 'manual/',
    role: 'Your personal notes & drafts',
    rule: 'Created when you save a note',
    icon: PenLine,
  },
  {
    name: 'ai/',
    role: 'Generated study guides & summaries',
    rule: 'Created only when used',
    icon: Cpu,
  },
  {
    name: 'assets/',
    role: 'Images used in your notes',
    rule: 'Created only when used',
    icon: ImageIcon,
  },
  {
    name: 'sources/',
    role: 'Optional folder for PDFs, .txt & .md readings',
    rule: 'Read-only (optional)',
    icon: BookOpen,
  },
];

export function SetupPage({
  connectionState,
  folderName,
  errorMessage,
  busy,
  reconnectRequiresPicker = false,
  onSelectFolder,
  onImportReadOnlyFolder,
  onReconnect,
  onForgetWorkspace,
  onNavigate,
}: SetupPageProps) {
  const readOnlyDirInputRef = useRef<HTMLInputElement | null>(null);
  const needsReconnect = connectionState === 'restored-needs-permission';
  const isBlockedOrUnsupported =
    connectionState === 'blocked-iframe' || connectionState === 'unsupported';
  const insideIframe = isInsideIframe();
  const currentUrl =
    typeof window !== 'undefined' ? window.location.href : '#/';

  return (
    <div className="flex min-h-screen flex-col bg-[#0C0D10] text-[#ECEBE6]">
      {onImportReadOnlyFolder && (
        <input
          ref={readOnlyDirInputRef}
          type="file"
          multiple
          className="hidden"
          {...({webkitdirectory: '', directory: ''} as Record<string, string>)}
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length > 0) {
              onImportReadOnlyFolder(files);
              e.target.value = '';
            }
          }}
        />
      )}
      <header className="flex h-14 items-center justify-between border-b border-[#202430] bg-[#111318] px-6">
        <div className="flex items-baseline gap-2.5">
          <span className="font-serif text-xl font-semibold text-[#F4F0E7]">
            Noodle
          </span>
          <span className="text-xs text-[#7E8596]">Local Study Vault</span>
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
              <h1 className="font-serif text-3xl leading-tight font-semibold text-[#F5F1E8] text-balance sm:text-4xl">
                Choose a folder for your notes
              </h1>

              <p className="max-w-prose text-sm leading-relaxed text-[#A4AAB7]">
                Noodle saves your notes in a folder on your computer. Search
                runs on your device, and optional cloud AI only sees short
                snippets you approve.
              </p>

              {/* Restored handle awaiting permission click */}
              {needsReconnect && folderName && (
                <div className="space-y-3 rounded-xl border border-[#4D3D20] bg-[#181510] p-4 text-xs">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <p className="font-semibold text-[#F6DFA8]">
                        Previous workspace restored from browser storage
                      </p>
                      <p className="text-[#D8C9A3]">
                        {reconnectRequiresPicker ? (
                          <>
                            Your browser needs you to re-select{' '}
                            <code className="rounded bg-[#0C0D10] px-1.5 py-0.5 font-mono text-[#F8EBD0]">
                              {folderName}
                            </code>{' '}
                            to restore read/write access.
                          </>
                        ) : (
                          <>
                            Click below to grant read/write access back to{' '}
                            <code className="rounded bg-[#0C0D10] px-1.5 py-0.5 font-mono text-[#F8EBD0]">
                              {folderName}
                            </code>
                            .
                          </>
                        )}
                      </p>
                      {insideIframe && (
                        <p className="text-[#D8C9A3]">
                          Embedded windows often block folder access prompts. If
                          reconnecting fails, open Noodle in a new tab.
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={onReconnect}
                      disabled={busy}
                      className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#E0A83E] px-4 text-xs font-semibold text-[#111216] transition-colors hover:bg-[#ECB955] disabled:opacity-50"
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
                    {insideIframe && (
                      <a
                        href={currentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#685022] bg-[#241E12] px-3 text-xs font-semibold text-amber-100 transition-colors hover:bg-[#2F2718]"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        <span>Open in a new tab</span>
                      </a>
                    )}
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
                  className="space-y-2.5 rounded-xl border border-[#523F1B] bg-[#19150E] p-4 text-xs leading-relaxed text-amber-100"
                >
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                    <div className="space-y-1">
                      <p className="font-semibold text-amber-200">
                        {connectionState === 'blocked-iframe'
                          ? 'Folder Access Blocked in Embedded View'
                          : 'Desktop Browser Required for Folder Access'}
                      </p>
                      <p className="text-amber-100">
                        {connectionState === 'blocked-iframe'
                          ? 'Browsers block local folder prompts inside embedded windows. Open Noodle in its own tab to pick or reconnect a local folder.'
                          : 'This browser cannot write to local folders directly (Brave disables it by default unless you enable brave://flags/#file-system-access-api). Use Google Chrome or Microsoft Edge on desktop.'}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pl-7">
                    <a
                      href={currentUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#685022] bg-[#241E12] px-3 text-xs font-semibold text-amber-100 transition-colors hover:bg-[#2F2718]"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      <span>Open in a new tab</span>
                    </a>
                    {onImportReadOnlyFolder && (
                      <button
                        type="button"
                        onClick={() => readOnlyDirInputRef.current?.click()}
                        disabled={busy}
                        className="inline-flex h-9 items-center rounded-lg border border-[#343949] bg-[#141720] px-3 text-xs font-medium text-[#ECEBE6] hover:border-[#4B536A]"
                      >
                        Open folder read-only
                      </button>
                    )}
                    {folderName && (
                      <button
                        type="button"
                        onClick={onForgetWorkspace}
                        className="inline-flex h-9 items-center rounded-lg border border-[#343949] bg-[#141720] px-3 text-xs text-[#B2B7C4] hover:text-[#ECEBE6]"
                      >
                        Forget saved folder
                      </button>
                    )}
                  </div>
                </div>
              )}

              {errorMessage && !isBlockedOrUnsupported && (
                <div
                  role="alert"
                  className="space-y-2.5 rounded-xl border border-[#5A2934] bg-[#1C1216] px-4 py-3 text-xs leading-relaxed text-rose-200"
                >
                  <p>{errorMessage}</p>
                  {onImportReadOnlyFolder && (
                    <div className="flex flex-wrap items-center gap-2.5 pt-0.5">
                      <button
                        type="button"
                        onClick={() => readOnlyDirInputRef.current?.click()}
                        disabled={busy}
                        className="inline-flex h-8 items-center rounded-lg border border-[#5C3A44] bg-[#27181D] px-3 text-xs font-medium text-rose-100 hover:bg-[#331F26]"
                      >
                        Open folder read-only instead
                      </button>
                      <span className="text-[11px] text-rose-200/75">
                        Reads existing notes locally (browser shows an &ldquo;Upload&rdquo; prompt, nothing leaves your device)
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-3 pt-4">
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
                <button
                  type="button"
                  onClick={() => onNavigate('/workspace')}
                  className="text-xs text-[#9CA1AE] underline underline-offset-2 transition-colors hover:text-[#F4D084]"
                >
                  Or open the demo workspace
                </button>
              )}
            </div>
          </div>

          {/* Right Column: Expected Directory Layout */}
          <div className="flex flex-col justify-between rounded-2xl border border-[#242835] bg-[#111319] p-6 lg:col-span-5">
            <div>
              <h2 className="font-serif text-base font-semibold text-[#EFECE3]">
                Folder Structure
              </h2>
              <p className="mt-1 text-xs text-[#848B9B]">
                Noodle only creates the folders you use:
              </p>

              <ul className="mt-5 space-y-2.5">
                {FOLDER_LAYOUT.map((entry) => {
                  const Icon = entry.icon;
                  return (
                    <li
                      key={entry.name}
                      className="flex items-start gap-3 rounded-lg bg-[#161922] px-3.5 py-3"
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

            <div className="mt-6 pt-2 text-[11px] text-[#767D8F]">
              Tip: Pick a main folder such as{' '}
              <code className="font-mono text-[#9CA1AE]">Noodle Notes</code> in
              Documents, or select an existing{' '}
              <code className="font-mono text-[#9CA1AE]">manual/</code> folder
              directly.
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
