/**
 * Ephemeral in-memory microphone controller and Master Kill Switch.
 *
 * Security & privacy invariants:
 * - Zero audio blobs or buffers are ever written to IndexedDB, localStorage, sessionStorage, or disk.
 * - Zero audio bytes are ever sent over the network.
 * - Every MediaStream and MediaStreamTrack opened by Noodle (or Picovoice WebVoiceProcessor)
 *   is registered so the Master Kill Switch terminates all tracks immediately (`readyState === 'ended'`),
 *   closes AudioContexts, runs teardown hooks, and releases active microphone handles.
 */

export interface TrackLike {
  id?: string;
  kind?: string;
  readyState: string;
  stop: () => void;
}

export interface StreamLike {
  getTracks: () => TrackLike[];
  getAudioTracks?: () => TrackLike[];
}

function safeRemoveTrack(stream: StreamLike, track: TrackLike): void {
  const maybe = stream as {removeTrack?: (t: TrackLike) => void};
  if (typeof maybe.removeTrack === 'function') {
    try {
      maybe.removeTrack(track);
    } catch {
      // ignore removeTrack errors
    }
  }
}

export interface AudioContextLike {
  state?: string;
  close: () => Promise<void> | void;
}

type TrackChangeListener = (activeCount: number) => void;
type KillTeardownHook = () => Promise<void> | void;

const trackedStreams = new Set<StreamLike>();
const trackedTracks = new Set<TrackLike>();
const trackedAudioContexts = new Set<AudioContextLike>();
const teardownHooks = new Set<KillTeardownHook>();
const trackListeners = new Set<TrackChangeListener>();

let activeCaptureStopFn: ((discard: boolean) => Promise<Float32Array | null>) | null =
  null;
let ephemeralChunksInFlight: Float32Array[] = [];
let getUserMediaPatched = false;

function notifyTrackListeners(): void {
  const count = getActiveMicrophoneTrackCount();
  for (const listener of trackListeners) {
    listener(count);
  }
}

export function subscribeActiveMicrophoneTracks(
  listener: TrackChangeListener,
): () => void {
  trackListeners.add(listener);
  listener(getActiveMicrophoneTrackCount());
  return () => {
    trackListeners.delete(listener);
  };
}

export function registerMicrophoneStream(stream: StreamLike): void {
  trackedStreams.add(stream);
  const tracks = stream.getTracks();
  for (const track of tracks) {
    trackedTracks.add(track);
  }
  notifyTrackListeners();
}

export function registerAudioContext(ctx: AudioContextLike): void {
  trackedAudioContexts.add(ctx);
}

export function registerMicrophoneTeardownHook(hook: KillTeardownHook): () => void {
  teardownHooks.add(hook);
  return () => {
    teardownHooks.delete(hook);
  };
}

/**
 * Ensures any getUserMedia() call made inside this window (e.g. by Picovoice WebVoiceProcessor)
 * automatically registers its MediaStream and MediaStreamTracks with the Master Kill Switch.
 */
export function ensureGetUserMediaTracked(): void {
  if (
    getUserMediaPatched ||
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== 'function'
  ) {
    return;
  }

  const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
    navigator.mediaDevices,
  );

  try {
    navigator.mediaDevices.getUserMedia = async (
      constraints?: MediaStreamConstraints,
    ): Promise<MediaStream> => {
      const stream = await originalGetUserMedia(constraints);
      registerMicrophoneStream(stream);
      return stream;
    };
    getUserMediaPatched = true;
  } catch {
    // Some locked-down environments make mediaDevices.getUserMedia non-writable;
    // explicit registerMicrophoneStream calls still protect direct captures.
  }
}

export function getActiveMicrophoneTrackCount(): number {
  let liveCount = 0;
  for (const track of trackedTracks) {
    if (track.readyState !== 'ended') {
      liveCount += 1;
    }
  }
  return liveCount;
}

export function getTrackedStreamCount(): number {
  return trackedStreams.size;
}

export function getTrackedAudioContextCount(): number {
  return trackedAudioContexts.size;
}

/**
 * Pure linear-interpolation mono 16kHz resampler usable in both browser & Node tests.
 */
export function resampleTo16kMono(
  input: Float32Array,
  sourceSampleRate: number,
): Float32Array {
  const targetSampleRate = 16000;
  if (input.length === 0) {
    return new Float32Array(0);
  }
  if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0) {
    return new Float32Array(input);
  }
  if (sourceSampleRate === targetSampleRate) {
    return new Float32Array(input);
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const srcIndex = i * ratio;
    const left = Math.floor(srcIndex);
    const right = Math.min(input.length - 1, left + 1);
    const frac = srcIndex - left;
    output[i] = input[left] * (1 - frac) + input[right] * frac;
  }
  return output;
}

export function concatenateFloat32Chunks(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function zeroOutChunks(chunks: Float32Array[]): void {
  for (const chunk of chunks) {
    chunk.fill(0);
  }
  chunks.length = 0;
}

export async function queryMicrophonePermissionState(): Promise<
  'unknown' | 'prompt' | 'granted' | 'denied'
> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.permissions ||
    typeof navigator.permissions.query !== 'function'
  ) {
    return 'unknown';
  }
  try {
    const status = await navigator.permissions.query({
      name: 'microphone' as PermissionName,
    });
    if (
      status.state === 'prompt' ||
      status.state === 'granted' ||
      status.state === 'denied'
    ) {
      return status.state;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface EphemeralCaptureHandle {
  stopAndExtract16k: () => Promise<Float32Array>;
  discard: () => Promise<void>;
}

/**
 * Starts ephemeral push-to-talk capture into RAM only.
 * Releases microphone tracks immediately when stopped or discarded.
 */
export async function startEphemeralMicCapture(): Promise<EphemeralCaptureHandle> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== 'function'
  ) {
    throw new Error('Microphone capture is unavailable in this browser context.');
  }

  // Cancel any stale capture session cleanly first
  if (activeCaptureStopFn) {
    await activeCaptureStopFn(true);
    activeCaptureStopFn = null;
  }

  ensureGetUserMediaTracked();

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  registerMicrophoneStream(stream);

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as {webkitAudioContext: typeof AudioContext})
      .webkitAudioContext;
  const audioContext = new AudioCtx();
  registerAudioContext(audioContext);

  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const muteGain = audioContext.createGain();
  muteGain.gain.value = 0;

  const chunks: Float32Array[] = [];
  ephemeralChunksInFlight = chunks;
  let stopped = false;

  processor.onaudioprocess = (event) => {
    if (stopped) {
      return;
    }
    const channelData = event.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(channelData));
  };

  source.connect(processor);
  processor.connect(muteGain);
  muteGain.connect(audioContext.destination);

  const finalize = async (discard: boolean): Promise<Float32Array | null> => {
    if (stopped) {
      return null;
    }
    stopped = true;
    activeCaptureStopFn = null;

    try {
      processor.onaudioprocess = null;
      source.disconnect();
      processor.disconnect();
      muteGain.disconnect();
    } catch {
      // Ignore disconnect errors on torn-down nodes
    }

    for (const track of stream.getTracks()) {
      track.stop();
      safeRemoveTrack(stream, track);
    }
    trackedStreams.delete(stream);

    if (audioContext.state !== 'closed') {
      try {
        await audioContext.close();
      } catch {
        // Ignore close errors
      }
    }
    trackedAudioContexts.delete(audioContext);
    notifyTrackListeners();

    if (discard) {
      zeroOutChunks(chunks);
      return null;
    }

    const merged = concatenateFloat32Chunks(chunks);
    const sampleRate = audioContext.sampleRate || 16000;
    zeroOutChunks(chunks);
    const resampled = resampleTo16kMono(merged, sampleRate);
    merged.fill(0);
    return resampled;
  };

  activeCaptureStopFn = finalize;

  return {
    stopAndExtract16k: async () => {
      const out = await finalize(false);
      return out ?? new Float32Array(0);
    },
    discard: async () => {
      await finalize(true);
    },
  };
}

/**
 * Captures a single spoken utterance right after a wake word fires, stopping
 * automatically when speech ends (short silence gap) or when `maxDurationMs` elapses.
 */
export async function captureUtteranceAfterWakeWord(options?: {
  maxDurationMs?: number;
  silenceWindowMs?: number;
}): Promise<Float32Array> {
  const maxDurationMs = options?.maxDurationMs ?? 4500;
  const silenceWindowMs = options?.silenceWindowMs ?? 1200;

  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== 'function'
  ) {
    throw new Error('Microphone capture is unavailable in this browser context.');
  }

  ensureGetUserMediaTracked();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  registerMicrophoneStream(stream);

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as {webkitAudioContext: typeof AudioContext})
      .webkitAudioContext;
  const audioContext = new AudioCtx();
  registerAudioContext(audioContext);
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const muteGain = audioContext.createGain();
  muteGain.gain.value = 0;

  const chunks: Float32Array[] = [];
  ephemeralChunksInFlight = chunks;

  return new Promise<Float32Array>((resolve) => {
    let settled = false;
    let sawSpeech = false;
    let lastSpeechAt = Date.now();
    const startedAt = Date.now();

    const finish = async (discard: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearInterval(watcher);
      activeCaptureStopFn = null;

      try {
        processor.onaudioprocess = null;
        source.disconnect();
        processor.disconnect();
        muteGain.disconnect();
      } catch {
        // ignore
      }

      for (const track of stream.getTracks()) {
        track.stop();
      }
      trackedStreams.delete(stream);
      if (audioContext.state !== 'closed') {
        try {
          await audioContext.close();
        } catch {
          // ignore
        }
      }
      trackedAudioContexts.delete(audioContext);
      notifyTrackListeners();

      if (discard) {
        zeroOutChunks(chunks);
        resolve(new Float32Array(0));
        return;
      }

      const merged = concatenateFloat32Chunks(chunks);
      const sampleRate = audioContext.sampleRate || 16000;
      zeroOutChunks(chunks);
      const resampled = resampleTo16kMono(merged, sampleRate);
      merged.fill(0);
      resolve(resampled);
    };

    activeCaptureStopFn = async (discard) => {
      await finish(discard);
      return null;
    };

    processor.onaudioprocess = (event) => {
      if (settled) return;
      const input = event.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(input));
      let energy = 0;
      for (let i = 0; i < input.length; i += 1) {
        energy += input[i] * input[i];
      }
      const rms = Math.sqrt(energy / Math.max(1, input.length));
      if (rms > 0.015) {
        sawSpeech = true;
        lastSpeechAt = Date.now();
      }
    };

    source.connect(processor);
    processor.connect(muteGain);
    muteGain.connect(audioContext.destination);

    const watcher = window.setInterval(() => {
      const now = Date.now();
      if (now - startedAt >= maxDurationMs) {
        void finish(false);
        return;
      }
      if (sawSpeech && now - lastSpeechAt >= silenceWindowMs) {
        void finish(false);
      }
    }, 150);
  });
}

export interface KillSwitchReport {
  stoppedTrackCount: number;
  closedAudioContextCount: number;
  clearedStreamCount: number;
  remainingActiveTracks: number;
  permissionState: 'unknown' | 'prompt' | 'granted' | 'denied';
}

/**
 * MASTER MICROPHONE KILL SWITCH
 * Immediately stops every MediaStreamTrack across all active captures and engines,
 * closes AudioContexts, releases wake-word processors, wipes ephemeral RAM buffers,
 * and drops all stream/permission handles held by Noodle.
 */
export async function killAllMicrophoneAccess(): Promise<KillSwitchReport> {
  if (activeCaptureStopFn) {
    try {
      await activeCaptureStopFn(true);
    } catch {
      // Continue killing every remaining resource
    }
    activeCaptureStopFn = null;
  }

  zeroOutChunks(ephemeralChunksInFlight);

  for (const hook of Array.from(teardownHooks)) {
    try {
      await hook();
    } catch {
      // Keep tearing down remaining resources
    }
  }

  let stoppedTrackCount = 0;
  for (const stream of Array.from(trackedStreams)) {
    const tracks = stream.getTracks();
    for (const track of tracks) {
      trackedTracks.add(track);
    }
  }

  for (const track of Array.from(trackedTracks)) {
    try {
      track.stop();
      if (track.readyState !== 'ended') {
        // Note: synthetic test tracks may mutate readyState inside stop();
        // real browser MediaStreamTrack transitions to 'ended' immediately on stop().
      }
      stoppedTrackCount += 1;
    } catch {
      // ignore
    }
  }

  const clearedStreamCount = trackedStreams.size;
  for (const stream of Array.from(trackedStreams)) {
    for (const track of stream.getTracks()) {
      safeRemoveTrack(stream, track);
    }
  }
  trackedStreams.clear();

  let closedAudioContextCount = 0;
  for (const ctx of Array.from(trackedAudioContexts)) {
    try {
      if (ctx.state !== 'closed') {
        await ctx.close();
        closedAudioContextCount += 1;
      }
    } catch {
      // ignore
    }
  }
  trackedAudioContexts.clear();

  const remainingActiveTracks = getActiveMicrophoneTrackCount();
  trackedTracks.clear();
  notifyTrackListeners();

  const permissionState = await queryMicrophonePermissionState();

  return {
    stoppedTrackCount,
    closedAudioContextCount,
    clearedStreamCount,
    remainingActiveTracks,
    permissionState,
  };
}
