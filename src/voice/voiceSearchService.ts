import {WhisperProgressState} from '../types/noodle';
import {prepareAudioForWhisper} from './microphoneController';
import {cleanWhisperTranscript} from './transcriptCleaner';
import {DEFAULT_WHISPER_MODEL_ID} from './voiceConfig';
import type {WhisperWorkerRequest} from './whisperWorker';

interface WhisperWorkerResponse {
  type: string;
  jobId: string;
  modelId?: string;
  progress?: number;
  loadedBytes?: number;
  totalBytes?: number;
  currentFile?: string;
  status?: 'downloading' | 'loading';
  text?: string;
  error?: string;
}

type ProgressListener = (state: WhisperProgressState) => void;

const progressListeners = new Set<ProgressListener>();

let whisperWorkerInstance: Worker | null = null;
let loadedWhisperModelId: string | null = null;
let jobCounter = 0;
let activeGeneration = 0;

let currentProgress: WhisperProgressState = {
  status: 'idle',
  modelId: DEFAULT_WHISPER_MODEL_ID,
  progress: 0,
  loadedBytes: 0,
  totalBytes: 0,
};

const pendingJobs = new Map<
  string,
  {
    generation: number;
    resolve: (msg: WhisperWorkerResponse) => void;
    reject: (err: Error) => void;
  }
>();

function emitProgress(patch: Partial<WhisperProgressState>): void {
  currentProgress = {
    ...currentProgress,
    ...patch,
  };
  for (const listener of progressListeners) {
    listener(currentProgress);
  }
}

export function subscribeWhisperProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener);
  listener(currentProgress);
  return () => {
    progressListeners.delete(listener);
  };
}

export function getWhisperProgressSnapshot(): WhisperProgressState {
  return currentProgress;
}

export function terminateWhisperWorker(): void {
  if (whisperWorkerInstance) {
    whisperWorkerInstance.terminate();
    whisperWorkerInstance = null;
  }
  loadedWhisperModelId = null;
}

function getOrCreateWhisperWorker(): Worker {
  if (!whisperWorkerInstance) {
    whisperWorkerInstance = new Worker(
      new URL('./whisperWorker.ts', import.meta.url),
      {type: 'module'},
    );
    whisperWorkerInstance.onmessage = (
      event: MessageEvent<WhisperWorkerResponse>,
    ) => {
      const msg = event.data;
      if (msg.type === 'whisper-progress') {
        const pending = pendingJobs.get(msg.jobId);
        if (!pending || pending.generation !== activeGeneration) {
          return;
        }
        emitProgress({
          status: msg.status === 'loading' ? 'loading' : 'downloading',
          modelId: msg.modelId ?? currentProgress.modelId,
          progress: Math.round(msg.progress ?? 0),
          loadedBytes: msg.loadedBytes ?? 0,
          totalBytes: msg.totalBytes ?? 0,
          currentFile: msg.currentFile,
        });
        return;
      }

      const pending = pendingJobs.get(msg.jobId);
      if (!pending) {
        return;
      }
      pendingJobs.delete(msg.jobId);
      if (pending.generation !== activeGeneration) {
        pending.reject(new Error('Voice operation cancelled.'));
        return;
      }
      if (msg.type === 'error') {
        pending.reject(new Error(msg.error || 'Whisper transcription failed.'));
      } else {
        pending.resolve(msg);
      }
    };
    whisperWorkerInstance.onerror = (event) => {
      const err = new Error(event.message || 'Whisper Web Worker error.');
      for (const [, pending] of pendingJobs.entries()) {
        pending.reject(err);
      }
      pendingJobs.clear();
      terminateWhisperWorker();
    };
  }
  return whisperWorkerInstance;
}

function nextJobId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++jobCounter}`;
}

function runWhisperRequest(
  payload: WhisperWorkerRequest,
  transferables: Transferable[] = [],
): Promise<WhisperWorkerResponse> {
  if (typeof Worker === 'undefined') {
    return Promise.reject(
      new Error('Web Workers are unavailable in this environment.'),
    );
  }
  const generation = activeGeneration;
  const worker = getOrCreateWhisperWorker();
  return new Promise<WhisperWorkerResponse>((resolve, reject) => {
    pendingJobs.set(payload.jobId, {
      generation,
      resolve,
      reject,
    });
    worker.postMessage(payload, transferables);
  });
}

export function cancelWhisperWork(): void {
  activeGeneration += 1;
  for (const [, pending] of pendingJobs.entries()) {
    pending.reject(new Error('Voice transcription cancelled.'));
  }
  pendingJobs.clear();
  terminateWhisperWorker();
  emitProgress({
    status: 'idle',
    progress: 0,
    loadedBytes: 0,
    totalBytes: 0,
    currentFile: undefined,
    message: 'Cancelled local Whisper worker.',
  });
}

export function isWhisperWorkerLoadedFor(modelId: string): boolean {
  return loadedWhisperModelId === modelId && whisperWorkerInstance !== null;
}

export async function initializeWhisperModel(
  modelId: string,
  alreadyDownloaded = false,
): Promise<void> {
  emitProgress({
    status: alreadyDownloaded ? 'loading' : 'downloading',
    modelId,
    progress: 0,
    loadedBytes: 0,
    totalBytes: 0,
    message: alreadyDownloaded
      ? `Loading cached Whisper weights (${modelId})...`
      : `Downloading Whisper weights (${modelId}) to browser cache...`,
  });

  try {
    await runWhisperRequest({
      type: 'init-whisper',
      jobId: nextJobId('whisper-init'),
      modelId,
    });
    loadedWhisperModelId = modelId;
    emitProgress({
      status: 'ready',
      modelId,
      progress: 100,
      message: `Whisper ready locally (${modelId}).`,
    });
  } catch (err) {
    const msg = (err as Error).message || 'Failed to initialize Whisper model.';
    emitProgress({
      status: 'error',
      modelId,
      message: msg,
    });
    throw err;
  }
}

/**
 * Transcribes ephemeral 16kHz mono PCM Float32Array inside the Whisper Web Worker.
 * Zero audio is stored in IndexedDB/localStorage/files or sent over any network.
 */
export async function transcribeEphemeralAudio(params: {
  samples16k: Float32Array;
  modelId: string;
}): Promise<string> {
  const {samples16k, modelId} = params;
  if (!samples16k || samples16k.length < 1600) {
    if (samples16k) {
      samples16k.fill(0);
    }
    return '';
  }

  const prepared = prepareAudioForWhisper(samples16k);
  samples16k.fill(0);

  if (!prepared.hasSpeech || prepared.audio.length < 1600) {
    prepared.audio.fill(0);
    return '';
  }

  emitProgress({
    status:
      loadedWhisperModelId === modelId ? 'transcribing' : 'downloading',
    modelId,
    message:
      loadedWhisperModelId === modelId
        ? 'Transcribing speech locally in Web Worker...'
        : `Loading ${modelId} into Whisper Web Worker...`,
  });

  // Transfer conditioned buffer directly so worker owns ephemeral memory cleanly.
  const copy = prepared.audio;

  try {
    const res = await runWhisperRequest(
      {
        type: 'transcribe-pcm',
        jobId: nextJobId('whisper-asr'),
        modelId,
        samples16k: copy,
      },
      [copy.buffer],
    );
    loadedWhisperModelId = modelId;
    emitProgress({
      status: 'ready',
      modelId,
      progress: 100,
      message: 'Transcribed locally. Audio buffer discarded from RAM.',
    });
    return cleanWhisperTranscript(res.text ?? '');
  } catch (err) {
    const msg = (err as Error).message || 'Whisper transcription failed.';
    emitProgress({
      status: 'error',
      modelId,
      message: msg,
    });
    throw err;
  }
}
