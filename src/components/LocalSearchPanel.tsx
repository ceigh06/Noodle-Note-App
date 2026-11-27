import {useRef} from 'react';
import {
  ArrowUpRight,
  Cpu,
  Download,
  Loader2,
  Mic,
  MicOff,
  Search,
  Settings,
  Square,
  X,
} from 'lucide-react';
import {AVAILABLE_EMBEDDING_MODELS} from '../search/chunker';
import {formatHotkeyLabel, WHISPER_MODELS} from '../voice/voiceConfig';
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
  onActivateAndStartMic: () => void;
  onStartPushToTalk: () => void;
  onStopPushToTalk: () => void;
  onCancelVoiceCapture: () => void;
  onMasterKillSwitch: () => void;
  onOpenSettings: (route: RoutePath) => void;
  onDownloadModel: () => void;
  onCancelWork: () => void;
  onChangeModelId: (modelId: string) => void;
  onOpenResult: (result: SearchResultItem) => void;
}

const PILLAR_LABEL: Record<Pillar, string> = {
  sources: 'Sources',
  manual: 'My Notes',
  ai: 'AI Notes',
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
  onActivateAndStartMic,
  onStartPushToTalk,
  onStopPushToTalk,
  onCancelVoiceCapture,
  onMasterKillSwitch,
  onOpenSettings,
  onDownloadModel,
  onCancelWork,
  onChangeModelId,
  onOpenResult,
}: LocalSearchPanelProps) {
  const pressStartRef = useRef<number | null>(null);
  const isBusy =
    progressState.status === 'downloading' ||
    progressState.status === 'loading' ||
    progressState.status === 'indexing';

  const isListening = voiceRuntime.phase === 'listening';
  const isTranscribing = voiceRuntime.phase === 'transcribing';
  const micLevel = Math.max(0, Math.min(1, voiceRuntime.micLevel ?? 0));
  const micReady = Boolean(voiceRuntime.micReady);
  const activeWhisperModel =
    WHISPER_MODELS.find((m) => m.id === voiceSettings.whisperModelId) ??
    WHISPER_MODELS[0];

  const handleMicPressStart = () => {
    if (isTranscribing) {
      return;
    }
    if (isListening) {
      pressStartRef.current = -1;
      onStopPushToTalk();
      return;
    }
    pressStartRef.current = Date.now();
    onStartPushToTalk();
  };

  const handleMicPressEnd = () => {
    const started = pressStartRef.current;
    pressStartRef.current = null;
    if (started && started > 0 && Date.now() - started >= 450 && isListening) {
      onStopPushToTalk();
    }
  };

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
            placeholder="Search all notes and files..."
            aria-label="Search all notes and files"
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
                onMouseDown={handleMicPressStart}
                onMouseUp={handleMicPressEnd}
                onMouseLeave={() => {
                  if (
                    pressStartRef.current &&
                    pressStartRef.current > 0 &&
                    Date.now() - pressStartRef.current >= 450 &&
                    isListening
                  ) {
                    pressStartRef.current = null;
                    onStopPushToTalk();
                  }
                }}
                onTouchStart={(e) => {
                  e.preventDefault();
                  handleMicPressStart();
                }}
                onTouchEnd={(e) => {
                  e.preventDefault();
                  handleMicPressEnd();
                }}
                disabled={isTranscribing}
                title={`Click to start/stop, or hold to speak (${formatHotkeyLabel(voiceSettings.pushToTalkHotkey)})`}
                className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-semibold transition-colors select-none ${
                  isListening
                    ? 'border-rose-400 bg-rose-500/20 text-rose-100'
                    : isTranscribing
                      ? 'border-[#E0A83E]/50 bg-[#E0A83E]/15 text-[#F4D084]'
                      : 'border-[#333A4C] bg-[#181C26] text-[#ECEBE6] hover:border-[#E0A83E]/55 hover:text-[#F6DFA8]'
                }`}
              >
                {isTranscribing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#E0A83E]" />
                ) : isListening ? (
                  <Square className="h-3 w-3 fill-rose-300 text-rose-300" />
                ) : (
                  <Mic className="h-3.5 w-3.5 text-[#E0A83E]" />
                )}
                <span>
                  {isListening
                    ? micReady
                      ? 'Listening · Click to Search'
                      : 'Starting mic…'
                    : isTranscribing
                      ? 'Transcribing…'
                      : 'Speak to Search'}
                </span>
                {isListening && micReady && (
                  <span
                    aria-label="Live microphone input level"
                    className="inline-flex h-3.5 items-end gap-0.5"
                  >
                    {[0.12, 0.24, 0.4, 0.58, 0.78].map((threshold, idx) => {
                      const active = micLevel >= threshold;
                      const heights = ['h-1', 'h-1.5', 'h-2.5', 'h-3', 'h-3.5'];
                      return (
                        <span
                          key={threshold}
                          className={`w-0.5 rounded-full transition-colors ${heights[idx]} ${
                            active ? 'bg-rose-200' : 'bg-rose-300/30'
                          }`}
                        />
                      );
                    })}
                  </span>
                )}
              </button>

              {(isListening || isTranscribing) && (
                <button
                  type="button"
                  onClick={onCancelVoiceCapture}
                  title="Cancel voice capture"
                  className="inline-flex h-9 items-center gap-1 rounded-lg border border-[#2D3344] bg-[#161922] px-2.5 text-xs font-medium text-[#C8CCD6] hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                  <span>Cancel</span>
                </button>
              )}

              {(voiceRuntime.activeTrackCount > 0 || isListening) && (
                <button
                  type="button"
                  onClick={onMasterKillSwitch}
                  title="Stop all microphone streams immediately"
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-rose-500/60 bg-rose-600 px-2.5 text-xs font-semibold text-white hover:bg-rose-500"
                >
                  <MicOff className="h-3.5 w-3.5" />
                  <span>Stop Mic</span>
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={onActivateAndStartMic}
              title="Turn on on-device voice search and start speaking"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#2C3242] bg-[#161922] px-3 text-xs font-medium text-[#D5D4CD] transition-colors hover:border-[#E0A83E]/55 hover:text-[#F6DFA8]"
            >
              <Mic className="h-3.5 w-3.5 text-[#E0A83E]" />
              <span>Voice Search</span>
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
          {embeddingConfig.isDownloaded && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-[#8E95A5]">Saved offline</span>
            </>
          )}
        </div>

        <span>Nothing leaves this device</span>
      </div>

      {/* Voice Search status strip (only shown when experimental voice is ON) */}
      {voiceSettings.experimentalVoiceEnabled && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#0E1016] px-3 py-2 text-[11px] text-[#9CA1AE]">
          <div className="flex flex-wrap items-center gap-2">
            <Mic className="h-3.5 w-3.5 text-[#E0A83E]" />
            <span>
              Voice Search active (tap Speak to Search, or hold{' '}
              {formatHotkeyLabel(voiceSettings.pushToTalkHotkey)}) ·{' '}
              <span className="text-[#C8CCD6]">
                {activeWhisperModel.label.split(' (')[0]}
              </span>
            </span>
          </div>

          <div className="flex items-center gap-3">
            {voiceRuntime.wakeWordActive && (
              <span className="text-emerald-300">
                Wake word: &ldquo;{voiceSettings.wakeWordKeyword}&rdquo;
              </span>
            )}
            <button
              type="button"
              onClick={onMasterKillSwitch}
              className="font-medium text-[#9CA1AE] hover:text-rose-300"
            >
              Turn off
            </button>
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
          <div className="space-y-1.5 rounded-lg bg-[#0E1016] p-3 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 font-medium text-[#F4D084]">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#E0A83E]" />
                <span>
                  {whisperProgress.message ||
                    'Running local Whisper worker...'}
                </span>
              </span>
              <span className="text-[11px] text-[#A4AAB7] tabular-nums">
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
        <div className="space-y-2 rounded-lg bg-[#0E1016] p-3 text-xs">
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
            <span className="text-[11px] text-[#A4AAB7] tabular-nums">
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
        <div className="space-y-2 pt-2">
          <div className="flex items-center justify-between text-[11px] text-[#888F9F] tabular-nums">
            <span>
              {searching
                ? 'Searching across all notes and files...'
                : `${results.length} matching ${results.length === 1 ? 'section' : 'sections'} (${searchMode === 'semantic' ? 'semantic similarity' : 'word match'})`}
            </span>
            <span>Top {results.length || 0}</span>
          </div>

          {!searching && results.length === 0 ? (
            <p className="py-2 text-xs text-[#7D8496]">
              No matching notes or files found.
            </p>
          ) : (
            <div className="space-y-1 rounded-lg bg-[#0E1016] p-1.5">
              {results.map((item) => (
                <button
                  key={item.chunkId}
                  type="button"
                  onClick={() => onOpenResult(item)}
                  className="group flex w-full items-start justify-between gap-4 rounded-md px-3 py-2.5 text-left text-xs transition-colors duration-150 hover:bg-[#171A24] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#8990A2]">
                      <span className="font-semibold text-[#E0A83E] tabular-nums">
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
                    <span>Open</span>
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
