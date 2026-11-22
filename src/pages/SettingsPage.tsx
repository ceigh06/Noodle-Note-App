import {useState} from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Cpu,
  Download,
  Eye,
  EyeOff,
  Keyboard,
  Loader2,
  Mic,
  MicOff,
  Radio,
  Settings,
  ShieldAlert,
  Sliders,
  X,
} from 'lucide-react';
import {PICOVOICE_LICENSING_SUMMARY} from '../voice/porcupineWakeWord';
import {
  formatHotkeyLabel,
  PORCUPINE_BUILTIN_KEYWORDS,
  PUSH_TO_TALK_HOTKEY_PRESETS,
  WHISPER_MODELS,
} from '../voice/voiceConfig';
import {KillSwitchReport} from '../voice/microphoneController';
import {
  BuiltInWakeKeyword,
  RoutePath,
  VoiceRuntimeState,
  VoiceSearchSettings,
  WhisperProgressState,
} from '../types/noodle';

interface SettingsPageProps {
  voiceSettings: VoiceSearchSettings;
  voiceRuntime: VoiceRuntimeState;
  whisperProgress: WhisperProgressState;
  porcupineAccessKey: string;
  onChangePorcupineAccessKey: (nextKey: string) => void;
  onUpdateVoiceSettings: (
    patch: Partial<VoiceSearchSettings>,
  ) => Promise<void>;
  onMasterKillSwitch: () => Promise<KillSwitchReport>;
  onDownloadWhisperModel: () => Promise<void>;
  onCancelWhisperWork: () => void;
  onNavigate: (route: RoutePath) => void;
}

export function SettingsPage({
  voiceSettings,
  voiceRuntime,
  whisperProgress,
  porcupineAccessKey,
  onChangePorcupineAccessKey,
  onUpdateVoiceSettings,
  onMasterKillSwitch,
  onDownloadWhisperModel,
  onCancelWhisperWork,
  onNavigate,
}: SettingsPageProps) {
  const [showKey, setShowKey] = useState(false);
  const [recordingHotkey, setRecordingHotkey] = useState(false);
  const [killReport, setKillReport] = useState<KillSwitchReport | null>(null);
  const [wakeError, setWakeError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const isWhisperBusy =
    whisperProgress.status === 'downloading' ||
    whisperProgress.status === 'loading' ||
    whisperProgress.status === 'transcribing';

  const handleToggleExperimentalVoice = async (enabled: boolean) => {
    setWakeError(null);
    setKillReport(null);
    if (!enabled) {
      const report = await onMasterKillSwitch();
      setKillReport(report);
      return;
    }
    await onUpdateVoiceSettings({experimentalVoiceEnabled: true});
  };

  const handleKillClick = async () => {
    setBusyAction('kill');
    setWakeError(null);
    try {
      const report = await onMasterKillSwitch();
      setKillReport(report);
    } finally {
      setBusyAction(null);
    }
  };

  const handleToggleWakeWord = async (enabled: boolean) => {
    setWakeError(null);
    if (enabled) {
      if (!voiceSettings.experimentalVoiceEnabled) {
        setWakeError('Enable Experimental Voice Search (Step 1) first.');
        return;
      }
      if (!porcupineAccessKey.trim()) {
        setWakeError(
          'Enter your own Picovoice AccessKey below before turning on wake word detection.',
        );
        return;
      }
    }
    await onUpdateVoiceSettings({wakeWordEnabled: enabled});
  };

  const handleRecordHotkeyKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setRecordingHotkey(false);
      return;
    }
    if (
      e.key === 'Alt' ||
      e.key === 'Control' ||
      e.key === 'Shift' ||
      e.key === 'Meta'
    ) {
      return;
    }

    const parts: string[] = [];
    if (e.ctrlKey) parts.push('Control');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');

    const keyPart =
      e.code === 'Space'
        ? 'Space'
        : e.code || (e.key.length === 1 ? `Key${e.key.toUpperCase()}` : e.key);
    parts.push(keyPart);

    const nextHotkey = parts.join('+');
    setRecordingHotkey(false);
    void onUpdateVoiceSettings({pushToTalkHotkey: nextHotkey});
  };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 lg:px-8">
      {/* Page Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#202430] pb-5">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-medium text-[#E0A83E]">
            <Settings className="h-3.5 w-3.5" />
            <span>Experimental Hardware &amp; Local Voice Controls</span>
          </div>
          <h1 className="font-serif text-2xl font-semibold tracking-tight text-[#F5F1E8] sm:text-3xl">
            Settings
          </h1>
          <p className="text-xs text-[#9198A8] sm:text-sm">
            Configure experimental local voice search, microphone kill switch,
            and optional wake word detection. Everything runs strictly in RAM
            with zero audio stored or sent off device.
          </p>
        </div>

        <button
          type="button"
          onClick={() => onNavigate('/workspace')}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[#282D3B] bg-[#141720] px-3.5 py-2 text-xs font-medium text-[#C8CCD6] transition-colors hover:border-[#383F52] hover:text-[#ECEBE6]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Back to Workspace</span>
        </button>
      </div>

      {/* Master Kill Switch Banner */}
      <section
        aria-label="Master Microphone Kill Switch"
        className="rounded-xl border border-rose-500/35 bg-[#161217] p-5 space-y-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5 max-w-2xl">
            <div className="flex items-center gap-2">
              <MicOff className="h-4 w-4 text-rose-400" />
              <h2 className="font-serif text-base font-semibold text-[#F6ECEE]">
                Master Microphone Kill Switch
              </h2>
              <span
                data-testid="active-mic-tracks-badge"
                className={`rounded border px-2 py-0.5 font-mono text-[11px] tabular-nums ${
                  voiceRuntime.activeTrackCount > 0
                    ? 'border-rose-400/50 bg-rose-500/20 text-rose-200'
                    : 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
                }`}
              >
                {voiceRuntime.activeTrackCount} active mic track
                {voiceRuntime.activeTrackCount === 1 ? '' : 's'}
              </span>
            </div>
            <p className="text-xs leading-relaxed text-[#C9BAC0]">
              Immediately calls <code className="font-mono">track.stop()</code>{' '}
              on every active microphone <code className="font-mono">MediaStreamTrack</code>,
              closes audio capture contexts, stops any Porcupine wake-word
              processor, wipes RAM buffers, and disables voice search so the
              browser microphone indicator turns off immediately.
            </p>
            <p className="font-mono text-[11px] text-[#9A8A90]">
              Browser mic permission handle state:{' '}
              <span className="text-[#E5D5DA]">
                {voiceRuntime.micPermissionState}
              </span>
            </p>
          </div>

          <button
            type="button"
            onClick={() => void handleKillClick()}
            disabled={busyAction === 'kill'}
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-rose-400/60 bg-rose-600 px-4 text-xs font-semibold text-white transition-colors hover:bg-rose-500 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
          >
            <MicOff className="h-4 w-4" />
            <span>
              {busyAction === 'kill'
                ? 'Stopping tracks...'
                : 'Kill All Microphone Tracks & Disable Voice'}
            </span>
          </button>
        </div>

        {killReport && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-3.5 py-2.5 text-xs text-emerald-200">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
            <span>
              Kill switch executed: stopped{' '}
              <strong className="font-mono">{killReport.stoppedTrackCount}</strong>{' '}
              track(s), closed{' '}
              <strong className="font-mono">{killReport.closedAudioContextCount}</strong>{' '}
              audio context(s), remaining active tracks:{' '}
              <strong className="font-mono">{killReport.remainingActiveTracks}</strong>.
              Voice search and wake word are now OFF.
            </span>
          </div>
        )}
      </section>

      {/* Step 1: Experimental Voice Search + Push-to-Talk + Local Whisper */}
      <section
        aria-label="Step 1 Voice Search Push-to-Talk and Whisper"
        className="rounded-xl border border-[#232734] bg-[#13161E] p-5 space-y-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#202430] pb-4">
          <div className="space-y-1 max-w-xl">
            <div className="flex items-center gap-2">
              <Mic className="h-4 w-4 text-[#E0A83E]" />
              <h2 className="font-serif text-base font-semibold text-[#F5F1E8]">
                Step 1 · Experimental Voice Search (OFF by default)
              </h2>
            </div>
            <p className="text-xs leading-relaxed text-[#9CA1AE]">
              Hold an in-app push-to-talk hotkey or mic button to capture
              audio in RAM, transcribe locally inside a{' '}
              <strong className="text-[#ECEBE6]">Whisper Web Worker</strong> via
              Transformers.js, and feed the transcript directly into on-device
              semantic search.
            </p>
          </div>

          <label className="relative inline-flex cursor-pointer items-center gap-2.5">
            <span className="text-xs font-medium text-[#C8CCD6]">
              {voiceSettings.experimentalVoiceEnabled ? 'Enabled' : 'OFF (Default)'}
            </span>
            <input
              type="checkbox"
              aria-label="Enable Experimental Voice Search"
              checked={voiceSettings.experimentalVoiceEnabled}
              onChange={(e) => void handleToggleExperimentalVoice(e.target.checked)}
              className="peer sr-only"
            />
            <div className="relative h-6 w-11 rounded-full bg-[#222736] after:absolute after:top-[2px] after:left-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all after:content-[''] peer-checked:bg-[#E0A83E] peer-checked:after:translate-x-full peer-focus:outline-none" />
          </label>
        </div>

        {/* Plain Browser Limitation Statement */}
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/35 bg-amber-500/8 px-3.5 py-3 text-xs text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div className="space-y-1">
            <p className="font-semibold text-amber-200">
              Browser limitation: no global hotkey or system tray
            </p>
            <p className="leading-relaxed text-amber-100/90">
              A global OS-wide hotkey and system tray icon are{' '}
              <strong>not possible in a web browser</strong>. Push-to-talk works
              only while this Noodle browser tab is focused, and microphone tracks
              are released immediately upon key release.
            </p>
          </div>
        </div>

        {/* Hotkey configuration + Local Whisper Model */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Push-to-talk hotkey */}
          <div className="space-y-3 rounded-lg border border-[#222634] bg-[#0E1015] p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#ECEBE6]">
              <Keyboard className="h-3.5 w-3.5 text-[#E0A83E]" />
              <span>In-App Push-to-Talk Hotkey</span>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="noodle-ptt-hotkey-select"
                className="block text-[11px] text-[#8E95A5]"
              >
                Choose preset or record custom chord (ignores typing in notes
                when using modifier combos):
              </label>
              <select
                id="noodle-ptt-hotkey-select"
                value={
                  PUSH_TO_TALK_HOTKEY_PRESETS.some(
                    (p) => p.value === voiceSettings.pushToTalkHotkey,
                  )
                    ? voiceSettings.pushToTalkHotkey
                    : 'custom'
                }
                onChange={(e) => {
                  if (e.target.value !== 'custom') {
                    void onUpdateVoiceSettings({
                      pushToTalkHotkey: e.target.value,
                    });
                  }
                }}
                className="h-9 w-full rounded-lg border border-[#272C3A] bg-[#161922] px-2.5 text-xs text-[#ECEBE6] focus:border-[#E0A83E]/60 focus:outline-none"
              >
                {PUSH_TO_TALK_HOTKEY_PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
                {!PUSH_TO_TALK_HOTKEY_PRESETS.some(
                  (p) => p.value === voiceSettings.pushToTalkHotkey,
                ) && (
                  <option value="custom">
                    Custom ({formatHotkeyLabel(voiceSettings.pushToTalkHotkey)})
                  </option>
                )}
              </select>

              <div className="flex items-center justify-between gap-2 pt-1">
                <span className="text-[11px] text-[#9CA1AE]">
                  Active:{' '}
                  <kbd className="rounded border border-[#303647] bg-[#171A24] px-2 py-0.5 font-mono text-[11px] text-[#F4D084]">
                    {formatHotkeyLabel(voiceSettings.pushToTalkHotkey)}
                  </kbd>
                </span>

                <button
                  type="button"
                  onClick={() => setRecordingHotkey(true)}
                  onKeyDown={
                    recordingHotkey ? handleRecordHotkeyKeyDown : undefined
                  }
                  onBlur={() => setRecordingHotkey(false)}
                  className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    recordingHotkey
                      ? 'border-[#E0A83E] bg-[#E0A83E]/20 text-[#F6DFA8]'
                      : 'border-[#2B3142] bg-[#151822] text-[#B8BDC9] hover:text-white'
                  }`}
                >
                  {recordingHotkey ? 'Press shortcut key…' : 'Record custom'}
                </button>
              </div>
            </div>
          </div>

          {/* Local Whisper model in Web Worker */}
          <div className="space-y-3 rounded-lg border border-[#222634] bg-[#0E1015] p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-[#ECEBE6]">
                <Cpu className="h-3.5 w-3.5 text-[#E0A83E]" />
                <span>Local Whisper Model (Web Worker)</span>
              </div>
              <span
                className={`font-mono text-[10px] ${
                  voiceSettings.whisperDownloaded
                    ? 'text-emerald-400'
                    : 'text-[#888F9F]'
                }`}
              >
                {voiceSettings.whisperDownloaded
                  ? 'Cached offline'
                  : 'Not cached yet'}
              </span>
            </div>

            <select
              aria-label="Whisper transcription model"
              value={voiceSettings.whisperModelId}
              disabled={isWhisperBusy}
              onChange={(e) =>
                void onUpdateVoiceSettings({
                  whisperModelId: e.target.value,
                  whisperDownloaded: false,
                })
              }
              className="h-9 w-full rounded-lg border border-[#272C3A] bg-[#161922] px-2.5 text-xs text-[#ECEBE6] focus:border-[#E0A83E]/60 focus:outline-none disabled:opacity-50"
            >
              {WHISPER_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} · {m.sizeHint}
                </option>
              ))}
            </select>

            <div className="flex flex-wrap items-center gap-2">
              {isWhisperBusy ? (
                <button
                  type="button"
                  onClick={onCancelWhisperWork}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-rose-500/45 bg-rose-500/12 px-3 text-xs font-semibold text-rose-200 hover:bg-rose-500/20"
                >
                  <X className="h-3.5 w-3.5" />
                  <span>Cancel</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void onDownloadWhisperModel()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#E0A83E] px-3 text-xs font-semibold text-[#111216] transition-colors hover:bg-[#ECB955]"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>
                    {voiceSettings.whisperDownloaded
                      ? 'Verify Whisper in Worker'
                      : 'Download & Test Whisper'}
                  </span>
                </button>
              )}

              <span className="text-[11px] text-[#7D8496]">
                Runs via <code className="font-mono">@huggingface/transformers</code>
              </span>
            </div>

            {(isWhisperBusy || whisperProgress.message) && (
              <div className="space-y-1.5 rounded border border-[#232734] bg-[#13161E] p-2.5 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-[#D8D7D0]">
                    {isWhisperBusy && (
                      <Loader2 className="h-3 w-3 animate-spin text-[#E0A83E]" />
                    )}
                    <span>{whisperProgress.message || whisperProgress.status}</span>
                  </span>
                  {isWhisperBusy && (
                    <span className="font-mono text-[#9CA1AE] tabular-nums">
                      {whisperProgress.progress}%
                    </span>
                  )}
                </div>
                {isWhisperBusy && (
                  <div className="h-1 w-full overflow-hidden rounded-full bg-[#1C202B]">
                    <div
                      className="h-full bg-[#E0A83E] transition-[width] duration-150"
                      style={{
                        width: `${Math.max(4, Math.min(100, whisperProgress.progress))}%`,
                      }}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Step 2 (Last, Optional): Picovoice Porcupine Wake Word */}
      <section
        aria-label="Step 2 Optional Wake Word with Picovoice Porcupine"
        className="rounded-xl border border-[#232734] bg-[#13161E] p-5 space-y-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#202430] pb-4">
          <div className="space-y-1 max-w-xl">
            <div className="flex items-center gap-2">
              <Radio className="h-4 w-4 text-[#E0A83E]" />
              <h2 className="font-serif text-base font-semibold text-[#F5F1E8]">
                Step 2 (Optional) · Wake Word via Picovoice Porcupine Web SDK
              </h2>
            </div>
            <p className="text-xs leading-relaxed text-[#9CA1AE]">
              Optionally listen locally for a wake word before capturing an
              utterance for Whisper transcription and semantic search. Off by
              default and requires Experimental Voice Search above to be ON.
            </p>
          </div>

          <label className="relative inline-flex cursor-pointer items-center gap-2.5">
            <span className="text-xs font-medium text-[#C8CCD6]">
              {voiceSettings.wakeWordEnabled ? 'Listening' : 'OFF (Default)'}
            </span>
            <input
              type="checkbox"
              aria-label="Enable Optional Porcupine Wake Word"
              checked={voiceSettings.wakeWordEnabled}
              disabled={!voiceSettings.experimentalVoiceEnabled}
              onChange={(e) => void handleToggleWakeWord(e.target.checked)}
              className="peer sr-only"
            />
            <div className="relative h-6 w-11 rounded-full bg-[#222736] after:absolute after:top-[2px] after:left-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all after:content-[''] peer-checked:bg-[#E0A83E] peer-checked:after:translate-x-full peer-disabled:opacity-40 peer-focus:outline-none" />
          </label>
        </div>

        {/* Licensing & Key Privacy Notice */}
        <div className="flex items-start gap-2.5 rounded-lg border border-[#2A3040] bg-[#0F1219] px-3.5 py-3 text-xs text-[#B8C0D0]">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#E0A83E]" />
          <div className="space-y-1">
            <p className="font-semibold text-[#F2EEE4]">
              Picovoice AccessKey &amp; Licensing Requirement
            </p>
            <p className="leading-relaxed">{PICOVOICE_LICENSING_SUMMARY}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* AccessKey input (session RAM only) */}
          <div className="space-y-2">
            <label
              htmlFor="noodle-picovoice-access-key"
              className="block text-xs font-medium text-[#C8CCD6]"
            >
              Your Picovoice AccessKey (held in session RAM only)
            </label>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  id="noodle-picovoice-access-key"
                  type={showKey ? 'text' : 'password'}
                  value={porcupineAccessKey}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setWakeError(null);
                    onChangePorcupineAccessKey(e.target.value);
                  }}
                  placeholder="Paste your Picovoice Console AccessKey..."
                  className="h-9 w-full rounded-lg border border-[#282D3B] bg-[#0E1015] pr-9 pl-3 font-mono text-xs text-[#ECEBE6] placeholder-[#656C7D] focus:border-[#E0A83E]/60 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((prev) => !prev)}
                  aria-label={showKey ? 'Hide AccessKey' : 'Show AccessKey'}
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-[#7D8496] hover:text-[#ECEBE6]"
                >
                  {showKey ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
              {porcupineAccessKey && (
                <button
                  type="button"
                  onClick={() => {
                    onChangePorcupineAccessKey('');
                    if (voiceSettings.wakeWordEnabled) {
                      void onUpdateVoiceSettings({wakeWordEnabled: false});
                    }
                  }}
                  className="h-9 rounded-lg border border-[#282D3B] bg-[#161922] px-3 text-xs text-[#B8BDC9] hover:text-white"
                >
                  Clear
                </button>
              )}
            </div>
            <p className="text-[11px] text-[#7D8496]">
              Never hard-coded or saved to IndexedDB, localStorage, or disk.
            </p>
          </div>

          {/* Built-in keyword selector */}
          <div className="space-y-2">
            <label
              htmlFor="noodle-porcupine-keyword"
              className="block text-xs font-medium text-[#C8CCD6]"
            >
              Built-In Wake Word
            </label>
            <select
              id="noodle-porcupine-keyword"
              value={voiceSettings.wakeWordKeyword}
              onChange={(e) =>
                void onUpdateVoiceSettings({
                  wakeWordKeyword: e.target.value as BuiltInWakeKeyword,
                })
              }
              className="h-9 w-full rounded-lg border border-[#272C3A] bg-[#0E1015] px-2.5 text-xs text-[#ECEBE6] focus:border-[#E0A83E]/60 focus:outline-none"
            >
              {PORCUPINE_BUILTIN_KEYWORDS.map((kw) => (
                <option key={kw} value={kw}>
                  &ldquo;{kw}&rdquo;
                </option>
              ))}
            </select>
            <p className="text-[11px] text-[#7D8496]">
              Status:{' '}
              <span className="text-[#C8CCD6]">
                {voiceRuntime.wakeWordStatusMessage ||
                  (voiceRuntime.wakeWordActive
                    ? `Listening for "${voiceSettings.wakeWordKeyword}"`
                    : 'Inactive')}
              </span>
            </p>
          </div>
        </div>

        {(wakeError || voiceRuntime.lastError) && (
          <p className="rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            {wakeError || voiceRuntime.lastError}
          </p>
        )}
      </section>

      {/* Shortcut to Trust Tuning & Diagnostics */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#202430] bg-[#111319] px-4 py-3 text-xs text-[#8E95A5]">
        <span>
          Verify microphone kill switch &amp; zero audio storage invariants in
          Diagnostics.
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onNavigate('/workspace/trust-tuning')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#272C3A] bg-[#161922] px-3 py-1.5 font-medium text-[#C8CCD6] hover:text-white"
          >
            <Sliders className="h-3.5 w-3.5 text-[#E0A83E]" />
            <span>Trust &amp; Tuning</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('/diagnostics')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#272C3A] bg-[#161922] px-3 py-1.5 font-medium text-[#E0A83E] hover:bg-[#1C202B]"
          >
            <span>Open Diagnostics →</span>
          </button>
        </div>
      </div>
    </div>
  );
}
