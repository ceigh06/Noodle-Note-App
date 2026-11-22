import {
  ArrowUpRight,
  Cpu,
  Download,
  Loader2,
  Mic,
  MicOff,
  Search,
  Settings,
  X,
} from 'lucide-react';
import {AVAILABLE_EMBEDDING_MODELS} from '../search/chunker';
import {formatHotkeyLabel} from '../voice/voiceConfig';
import {
  EmbeddingModelConfig,
  EmbeddingProgressState,
  Pillar,
  RoutePath,
  SearchResultItem,
  VoiceRuntimeState,
  VoiceSearchSettings,
  WhisperProgressState,
} from '../types/noodle';

interface LocalSearchPanelProps {
  query: string;
  onQueryChange: (value: string) => void;
  searching: boolean;
  searchMode: 'semantic' | 'word-match';
  results: SearchResultItem[];
  aiEnabled: boolean;
  embeddingConfig: EmbeddingModelConfig;
  progressState: EmbeddingProgressState;
  voiceSettings: VoiceSearchSettings;
  voiceRuntime: VoiceRuntimeState;
  whisperProgress: WhisperProgressState;
  onStartPushToTalk: () => void;
  onStopPushToTalk: () => void;
  onMasterKillSwitch: () => void;
  onOpenSettings: (route: RoutePath) => void;
  onDownloadModel: () => void;
  onCancelWork: () => void;
  onChangeModelId: (modelId: string) => void;
  onOpenResult: (result: SearchResultItem) => void;
}

const PILLAR_LABEL: Record<Pillar, string> = {
  sources: 'Sources',
  manual: 'Manual',
  ai: 'AI Output',
};

function formatMb(bytes: number): string {
  if (!bytes || bytes <= 0) {
    return '0 MB';
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function LocalSearchPanel({
  query,
  onQueryChange,
  searching,
  searchMode,
  results,
  aiEnabled,
  embeddingConfig,
  progressState,
  voiceSettings,
  voiceRuntime,
  whisperProgress,
  onStartPushToTalk,
  onStopPushToTalk,
  onMasterKillSwitch,
  onOpenSettings,
  onDownloadModel,
  onCancelWork,
  onChangeModelId,
  onOpenResult,
}: LocalSearchPanelProps) {
  const isBusy =
    progressState.status === 'downloading' ||
    progressState.status === 'loading' ||
    progressState.status === 'indexing';

  const isListening = voiceRuntime.phase === 'listening';
  const isTranscribing = voiceRuntime.phase === 'transcribing';

  const effectiveModeLabel = !aiEnabled
    ? 'Word-match search (Local AI paused)'
    : embeddingConfig.isDownloaded
      ? 'Semantic search (on-device)'
      : 'Word-match search (model not downloaded yet)';

  return (
    <section
      aria-label="Local Semantic and Word-Match Search"
      className="rounded-xl border border-[#232734] bg-[#13161E] p-4 space-y-3.5"
    >
      {/* Top row: search input + push-to-talk (if enabled) + model status & actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[#767D8F]" />
          <input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search concepts or keywords across sources/, manual/, and ai/..."
            aria-label="Search workspace blocks"
            className="h-10 w-full rounded-lg border border-[#262B38] bg-[#0D0F14] pr-9 pl-9 text-xs text-[#ECEBE6] placeholder-[#686F80] transition-colors focus:border-[#E0A83E]/60 focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => onQueryChange('')}
              aria-label="Clear local search"
              className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded p-1 text-[#7D8496] hover:text-[#ECEBE6]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          {voiceSettings.experimentalVoiceEnabled ? (
            <>
              <button
                type="button"
                onMouseDown={onStartPushToTalk}
                onMouseUp={onStopPushToTalk}
                onMouseLeave={() => {
                  if (isListening) {
                    onStopPushToTalk();
                  }
                }}
                onTouchStart={(e) => {
                  e.preventDefault();
                  onStartPushToTalk();
                }}
                onTouchEnd={(e) => {
                  e.preventDefault();
                  onStopPushToTalk();
                }}
                disabled={isTranscribing}
                title={`Hold to speak (${formatHotkeyLabel(voiceSettings.pushToTalkHotkey)} while tab focused)`}
                className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors select-none ${
                  isListening
                    ? 'border-rose-400 bg-rose-500/25 text-rose-100 animate-pulse'
                    : isTranscribing
                      ? 'border-[#E0A83E]/50 bg-[#E0A83E]/15 text-[#F4D084]'
                      : 'border-[#333A4C] bg-[#181C26] text-[#ECEBE6] hover:border-[#E0A83E]/55 hover:text-[#F6DFA8]'
                }`}
              >
                {isTranscribing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#E0A83E]" />
                ) : (
                  <Mic className="h-3.5 w-3.5 text-[#E0A83E]" />
                )}
                <span>
                  {isListening
                    ? 'Release to search'
                    : isTranscribing
                      ? 'Whisper…'
                      : `Hold to Talk (${formatHotkeyLabel(voiceSettings.pushToTalkHotkey)})`}
                </span>
              </button>

              {voiceRuntime.activeTrackCount > 0 && (
                <button
                  type="button"
                  onClick={onMasterKillSwitch}
                  title="Master Kill Switch: stop all microphone tracks immediately"
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-rose-500/60 bg-rose-600 px-2.5 text-xs font-semibold text-white hover:bg-rose-500"
                >
                  <MicOff className="h-3.5 w-3.5" />
                  <span>Kill Mic</span>
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={() => onOpenSettings('/settings')}
              title="Voice search is experimental and OFF by default. Configure in Settings."
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#272C3A] bg-[#161922] px-2.5 text-xs font-medium text-[#8E95A5] transition-colors hover:border-[#3A4154] hover:text-[#ECEBE6]"
            >
              <MicOff className="h-3.5 w-3.5 text-[#767D8F]" />
              <span>Voice Off</span>
            </button>
          )}

          <label className="sr-only" htmlFor="noodle-embedding-model-select">
            Local embedding model
          </label>
          <select
            id="noodle-embedding-model-select"
            value={embeddingConfig.modelId}
            disabled={isBusy}
            onChange={(e) => onChangeModelId(e.target.value)}
            className="h-9 rounded-lg border border-[#272C3A] bg-[#161922] px-2.5 text-xs text-[#C8CCD6] focus:border-[#E0A83E]/60 focus:outline-none disabled:opacity-50"
          >
            {AVAILABLE_EMBEDDING_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>

          {isBusy ? (
            <button
              type="button"
              onClick={onCancelWork}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-rose-500/45 bg-rose-500/12 px-3 text-xs font-semibold text-rose-200 transition-colors hover:bg-rose-500/20"
            >
              <X className="h-3.5 w-3.5" />
              <span>Cancel</span>
            </button>
          ) : !embeddingConfig.isDownloaded ? (
            <button
              type="button"
              onClick={onDownloadModel}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#E0A83E] px-3.5 text-xs font-semibold text-[#111216] transition-colors hover:bg-[#ECB955]"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Download Model</span>
            </button>
          ) : null}
        </div>
      </div>

      {/* Honest status line */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#888F9F]">
        <div className="flex flex-wrap items-center gap-2">
          <Cpu className="h-3.5 w-3.5 text-[#E0A83E]" />
          <span className="font-medium text-[#D5D4CD]">{effectiveModeLabel}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono text-[#7D8496]">
            {embeddingConfig.modelId}
          </span>
          {embeddingConfig.isDownloaded && (
            <>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums text-[#8E95A5]">
                Cached offline ({embeddingConfig.vectorSize || 384}d)
              </span>
            </>
          )}
        </div>

        <span>Nothing leaves this device</span>
      </div>

      {/* Experimental Voice Search status strip (only shown when experimental voice is ON) */}
      {voiceSettings.experimentalVoiceEnabled && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#242937] bg-[#0F1219] px-3 py-2 text-[11px] text-[#9CA1AE]">
          <div className="flex flex-wrap items-center gap-2">
            <Mic className="h-3.5 w-3.5 text-[#E0A83E]" />
            <span>
              Voice Search active (Whisper Worker ·{' '}
              <code className="font-mono text-[#C8CCD6]">
                {voiceSettings.whisperModelId}
              </code>
              ). Browser tab must be focused — global OS hotkeys and tray icons
              are not possible in a browser.
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            {voiceRuntime.wakeWordActive && (
              <span className="font-mono text-emerald-300">
                Wake word: &ldquo;{voiceSettings.wakeWordKeyword}&rdquo;
              </span>
            )}
            <button
              type="button"
              onClick={() => onOpenSettings('/settings')}
              className="inline-flex items-center gap-1 font-medium text-[#E0A83E] hover:underline"
            >
              <Settings className="h-3 w-3" />
              <span>Settings</span>
            </button>
          </div>
        </div>
      )}

      {voiceSettings.experimentalVoiceEnabled &&
        (whisperProgress.status === 'downloading' ||
          whisperProgress.status === 'loading' ||
          whisperProgress.status === 'transcribing') && (
          <div className="space-y-1.5 rounded-lg border border-[#262B38] bg-[#0E1015] p-3 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 font-medium text-[#F4D084]">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#E0A83E]" />
                <span>
                  {whisperProgress.message ||
                    'Running local Whisper worker...'}
                </span>
              </span>
              <span className="font-mono text-[11px] text-[#A4AAB7] tabular-nums">
                {whisperProgress.progress}%
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#1C202B]">
              <div
                className="h-full bg-[#E0A83E] transition-[width] duration-150"
                style={{
                  width: `${Math.max(4, Math.min(100, whisperProgress.progress))}%`,
                }}
              />
            </div>
          </div>
        )}

      {voiceRuntime.lastError && (
        <p className="text-xs text-rose-300">{voiceRuntime.lastError}</p>
      )}

      {/* Cancellable download / indexing progress bar */}
      {isBusy && (
        <div className="space-y-2 rounded-lg border border-[#262B38] bg-[#0E1015] p-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 font-medium text-[#F4D084]">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[#E0A83E]" />
              <span>
                {progressState.message ||
                  (progressState.status === 'downloading'
                    ? 'Downloading model weights...'
                    : progressState.status === 'indexing'
                      ? 'Indexing changed blocks...'
                      : 'Loading cached model...')}
              </span>
            </span>
            <span className="font-mono text-[11px] text-[#A4AAB7] tabular-nums">
              {progressState.status === 'indexing' && progressState.totalToIndex
                ? `${progressState.indexedCount ?? 0}/${progressState.totalToIndex} blocks`
                : progressState.totalBytes > 0
                  ? `${formatMb(progressState.loadedBytes)} / ${formatMb(progressState.totalBytes)} (${progressState.progress}%)`
                  : `${progressState.progress}%`}
            </span>
          </div>

          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#1C202B]">
            <div
              className="h-full bg-[#E0A83E] transition-[width] duration-150"
              style={{
                width: `${Math.max(4, Math.min(100, progressState.progress))}%`,
              }}
            />
          </div>

          {progressState.currentFile && (
            <p className="truncate font-mono text-[11px] text-[#767D8F]">
              {progressState.currentFile}
            </p>
          )}
        </div>
      )}

      {!isBusy &&
        (progressState.status === 'cancelled' ||
          progressState.status === 'error') &&
        progressState.message && (
          <p
            className={`text-xs ${
              progressState.status === 'error'
                ? 'text-rose-300'
                : 'text-[#C8B994]'
            }`}
          >
            {progressState.message}
          </p>
        )}

      {/* Search Results */}
      {query.trim() && (
        <div className="space-y-2 border-t border-[#1F2330] pt-3">
          <div className="flex items-center justify-between text-[11px] text-[#888F9F] tabular-nums">
            <span>
              {searching
                ? 'Searching blocks across all folders...'
                : `${results.length} matching ${results.length === 1 ? 'block' : 'blocks'} (${searchMode === 'semantic' ? 'semantic similarity' : 'word match'})`}
            </span>
            <span>Top-{results.length || 0}</span>
          </div>

          {!searching && results.length === 0 ? (
            <p className="py-2 text-xs text-[#7D8496]">
              No matching blocks found across <code className="font-mono">sources/</code>,{' '}
              <code className="font-mono">manual/</code>, or{' '}
              <code className="font-mono">ai/</code>.
            </p>
          ) : (
            <div className="divide-y divide-[#1D212D] rounded-lg border border-[#222634] bg-[#0F1117]">
              {results.map((item) => (
                <button
                  key={item.chunkId}
                  type="button"
                  onClick={() => onOpenResult(item)}
                  className="group flex w-full items-start justify-between gap-4 px-3.5 py-3 text-left text-xs transition-colors hover:bg-[#171A24] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]/60"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#8990A2]">
                      <span className="font-mono font-semibold text-[#E0A83E] tabular-nums">
                        {item.score.toFixed(2)} {item.scoreLabel}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{PILLAR_LABEL[item.pillar]}</span>
                      {item.headingPath.length > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="truncate">
                            {item.headingPath.join(' › ')}
                          </span>
                        </>
                      )}
                    </div>
                    <p className="font-serif text-sm font-semibold text-[#F2EEE4] group-hover:text-[#F6DFA8]">
                      {item.title}
                    </p>
                    <p className="line-clamp-2 leading-relaxed text-[#9CA1AE]">
                      {item.text}
                    </p>
                  </div>

                  <span className="mt-1 inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-[#888F9F] group-hover:text-[#E0A83E]">
                    <span>Open block</span>
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
