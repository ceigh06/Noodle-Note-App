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
 * Pure anti-aliased mono 16kHz resampler usable in both browser & Node tests.
 * Uses a Hann-windowed sinc low-pass filter when downsampling (>= 16 samples)
 * to eliminate high-frequency consonant aliasing, with linear interpolation fallback
 * for tiny buffers or upsampling.
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

  if (ratio > 1 && input.length >= 16) {
    const cutoff = 0.45 / ratio;
    const halfWidth = Math.min(32, Math.max(8, Math.ceil(6 * ratio)));

    for (let i = 0; i < outputLength; i += 1) {
      const center = i * ratio;
      const start = Math.max(0, Math.floor(center) - halfWidth);
      const end = Math.min(input.length - 1, Math.ceil(center) + halfWidth);
      let sum = 0;
      let weightSum = 0;

      for (let j = start; j <= end; j += 1) {
        const dx = j - center;
        const u = dx / halfWidth;
        const win = Math.abs(u) <= 1 ? 0.5 * (1 + Math.cos(Math.PI * u)) : 0;
        const x = 2 * cutoff * dx;
        const sinc =
          Math.abs(x) < 1e-6 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const w = win * sinc;
        sum += input[j] * w;
        weightSum += w;
      }

      output[i] =
        weightSum > 0
          ? sum / weightSum
          : input[Math.min(input.length - 1, Math.round(center))];
    }
    return output;
  }

  for (let i = 0; i < outputLength; i += 1) {
    const srcIndex = i * ratio;
    const left = Math.floor(srcIndex);
    const right = Math.min(input.length - 1, left + 1);
    const frac = srcIndex - left;
    output[i] = input[left] * (1 - frac) + input[right] * frac;
  }
  return output;
}

export interface PreparedWhisperAudio {
  audio: Float32Array;
  hasSpeech: boolean;
  peak: number;
  rms: number;
  activeDurationSec: number;
}

/**
 * Pure ephemeral RAM speech conditioning for 16kHz mono PCM before Whisper inference:
 * - Removes DC offset
 * - Detects speech activity vs silence / isolated click transients
 * - Trims excessive leading/trailing dead air while preserving 200-250ms phoneme padding
 * - Normalizes quiet microphone gain cleanly with soft limiting (no clipping)
 */
export function prepareAudioForWhisper(
  samples16k: Float32Array,
): PreparedWhisperAudio {
  const n = samples16k.length;
  if (n < 1600) {
    return {
      audio: new Float32Array(0),
      hasSpeech: false,
      peak: 0,
      rms: 0,
      activeDurationSec: 0,
    };
  }

  let mean = 0;
  for (let i = 0; i < n; i += 1) {
    mean += samples16k[i];
  }
  mean /= n;

  const centered = new Float32Array(n);
  let sumSq = 0;
  let globalPeak = 0;
  for (let i = 0; i < n; i += 1) {
    const v = samples16k[i] - mean;
    centered[i] = v;
    sumSq += v * v;
    const abs = Math.abs(v);
    if (abs > globalPeak) {
      globalPeak = abs;
    }
  }
  const globalRms = Math.sqrt(sumSq / n);

  const frameSize = 320; // 20ms at 16kHz
  const hopSize = 160; // 10ms hop
  const frameCount = Math.max(1, Math.floor((n - frameSize) / hopSize) + 1);
  const frameRms = new Float32Array(frameCount);
  const framePeaks = new Float32Array(frameCount);

  for (let f = 0; f < frameCount; f += 1) {
    const start = f * hopSize;
    const end = Math.min(n, start + frameSize);
    let e = 0;
    let p = 0;
    for (let i = start; i < end; i += 1) {
      const v = centered[i];
      e += v * v;
      const a = Math.abs(v);
      if (a > p) p = a;
    }
    frameRms[f] = Math.sqrt(e / Math.max(1, end - start));
    framePeaks[f] = p;
  }

  const sortedRms = Array.from(frameRms).sort((a, b) => a - b);
  const noiseFloor = sortedRms[Math.floor(sortedRms.length * 0.2)] ?? 0;
  const speechThresh = Math.max(0.0045, noiseFloor * 2.2);

  const rawActive = new Uint8Array(frameCount);
  for (let f = 0; f < frameCount; f += 1) {
    rawActive[f] = frameRms[f] >= speechThresh ? 1 : 0;
  }

  // Require neighboring active frame (bridges brief gaps and rejects isolated 10-20ms clicks)
  const sustained = new Uint8Array(frameCount);
  let activeFrames = 0;
  let maxSpeechRms = 0;
  let maxSpeechPeak = 0;
  let firstSpeechFrame = -1;
  let lastSpeechFrame = -1;

  for (let f = 0; f < frameCount; f += 1) {
    const hasNeighbor =
      (f > 0 && rawActive[f - 1] === 1) ||
      (f + 1 < frameCount && rawActive[f + 1] === 1);
    if (rawActive[f] === 1 && (hasNeighbor || frameCount <= 6)) {
      sustained[f] = 1;
      activeFrames += 1;
      if (frameRms[f] > maxSpeechRms) maxSpeechRms = frameRms[f];
      if (framePeaks[f] > maxSpeechPeak) maxSpeechPeak = framePeaks[f];
      if (firstSpeechFrame === -1) firstSpeechFrame = f;
      lastSpeechFrame = f;
    }
  }

  const activeDurationSec = (activeFrames * hopSize) / 16000;
  if (
    activeFrames < 10 ||
    activeDurationSec < 0.14 ||
    maxSpeechRms < 0.0045 ||
    maxSpeechPeak < 0.015
  ) {
    centered.fill(0);
    return {
      audio: new Float32Array(0),
      hasSpeech: false,
      peak: globalPeak,
      rms: globalRms,
      activeDurationSec,
    };
  }

  const prePadSamples = 3200; // 200ms onset pad
  const postPadSamples = 4000; // 250ms offset pad
  const trimStart = Math.max(0, firstSpeechFrame * hopSize - prePadSamples);
  const trimEnd = Math.min(
    n,
    lastSpeechFrame * hopSize + frameSize + postPadSamples,
  );

  const speechMags: number[] = [];
  for (let f = firstSpeechFrame; f <= lastSpeechFrame; f += 1) {
    if (sustained[f] === 1) {
      speechMags.push(framePeaks[f]);
    }
  }
  speechMags.sort((a, b) => a - b);
  const robustPeak =
    speechMags[Math.min(speechMags.length - 1, Math.floor(speechMags.length * 0.92))] ??
    maxSpeechPeak;

  let gain = 1;
  if (robustPeak > 1e-4 && robustPeak < 0.55) {
    gain = Math.min(10, 0.55 / robustPeak);
  } else if (robustPeak > 0.85) {
    gain = 0.75 / robustPeak;
  }

  const outLen = Math.max(0, trimEnd - trimStart);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    let v = centered[trimStart + i] * gain;
    const abs = Math.abs(v);
    if (abs > 0.85) {
      const sign = v < 0 ? -1 : 1;
      v = sign * (0.85 + 0.15 * Math.tanh((abs - 0.85) / 0.15));
    }
    out[i] = v;
  }

  centered.fill(0);
  return {
    audio: out,
    hasSpeech: true,
    peak: maxSpeechPeak,
    rms: maxSpeechRms,
    activeDurationSec,
  };
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
export async function startEphemeralMicCapture(options?: {
  onInputLevel?: (level: number) => void;
}): Promise<EphemeralCaptureHandle> {
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

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    const domErr = err as {name?: string; message?: string};
    if (
      domErr?.name === 'NotAllowedError' ||
      domErr?.name === 'PermissionDeniedError'
    ) {
      throw new Error(
        'Microphone access was blocked. Allow mic permission in your browser bar (or open Noodle in its own tab if embedded).',
      );
    }
    if (
      domErr?.name === 'NotFoundError' ||
      domErr?.name === 'DevicesNotFoundError'
    ) {
      throw new Error('No microphone was found on this device.');
    }
    if (
      domErr?.name === 'NotReadableError' ||
      domErr?.name === 'TrackStartError'
    ) {
      throw new Error('Your microphone is currently in use by another app.');
    }
    throw new Error(domErr?.message || 'Could not start microphone recording.');
  }
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
  const processor = audioContext.createScriptProcessor(2048, 1, 1);
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
    if (options?.onInputLevel) {
      let sumSq = 0;
      for (let i = 0; i < channelData.length; i += 1) {
        sumSq += channelData[i] * channelData[i];
      }
      const rms = Math.sqrt(sumSq / Math.max(1, channelData.length));
      options.onInputLevel(Math.min(1, Math.sqrt(rms) * 2.6));
    }
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
      echoCancellation: false,
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
  const processor = audioContext.createScriptProcessor(2048, 1, 1);
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
