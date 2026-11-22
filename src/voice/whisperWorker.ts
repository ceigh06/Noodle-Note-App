import {
  AutomaticSpeechRecognitionPipeline,
  env,
  pipeline,
  ProgressInfo,
} from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;

interface WorkerScope {
  postMessage: (message: unknown) => void;
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<WhisperWorkerRequest>) => void,
  ) => void;
}

export type WhisperWorkerRequest =
  | {
      type: 'init-whisper';
      jobId: string;
      modelId: string;
    }
  | {
      type: 'transcribe-pcm';
      jobId: string;
      modelId: string;
      samples16k: Float32Array;
    };

const ctx = globalThis as unknown as WorkerScope;

let activeModelId: string | null = null;
let activeTranscriber: AutomaticSpeechRecognitionPipeline | null = null;
let activeLoadPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

async function getTranscriber(
  modelId: string,
  jobId: string,
): Promise<AutomaticSpeechRecognitionPipeline> {
  if (activeTranscriber && activeModelId === modelId) {
    return activeTranscriber;
  }
  if (activeLoadPromise && activeModelId === modelId) {
    return activeLoadPromise;
  }

  if (activeTranscriber) {
    try {
      await activeTranscriber.dispose();
    } catch {
      // ignore disposal error on previous model
    }
  }

  activeTranscriber = null;
  activeModelId = modelId;

  const fileBytes = new Map<string, {loaded: number; total: number}>();

  activeLoadPromise = (async () => {
    const transcriber = await pipeline('automatic-speech-recognition', modelId, {
      dtype: 'q8',
      progress_callback: (info: ProgressInfo) => {
        if (info.status === 'progress_total') {
          ctx.postMessage({
            type: 'whisper-progress',
            jobId,
            modelId,
            progress: info.progress,
            loadedBytes: info.loaded,
            totalBytes: info.total,
            status: 'downloading',
          });
          return;
        }

        if (info.status === 'initiate' || info.status === 'download') {
          ctx.postMessage({
            type: 'whisper-progress',
            jobId,
            modelId,
            progress: 0,
            loadedBytes: 0,
            totalBytes: 0,
            currentFile: info.file,
            status: 'downloading',
          });
          return;
        }

        if (info.status === 'progress') {
          fileBytes.set(info.file, {loaded: info.loaded, total: info.total});
          let loadedSum = 0;
          let totalSum = 0;
          for (const entry of fileBytes.values()) {
            loadedSum += entry.loaded;
            totalSum += entry.total;
          }
          const pct =
            totalSum > 0 ? Math.min(100, (loadedSum / totalSum) * 100) : info.progress;
          ctx.postMessage({
            type: 'whisper-progress',
            jobId,
            modelId,
            progress: pct,
            loadedBytes: loadedSum,
            totalBytes: totalSum,
            currentFile: info.file,
            status: 'downloading',
          });
          return;
        }

        if (info.status === 'done') {
          ctx.postMessage({
            type: 'whisper-progress',
            jobId,
            modelId,
            progress: 100,
            loadedBytes: 0,
            totalBytes: 0,
            currentFile: info.file,
            status: 'loading',
          });
        }
      },
    });
    activeTranscriber = transcriber;
    return transcriber;
  })();

  try {
    return await activeLoadPromise;
  } finally {
    activeLoadPromise = null;
  }
}

ctx.addEventListener('message', async (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'init-whisper') {
      const transcriber = await getTranscriber(msg.modelId, msg.jobId);
      // Warmup with 0.25s silence frame in RAM only (zero persistence)
      const silence = new Float32Array(4000);
      await transcriber(silence);
      silence.fill(0);

      ctx.postMessage({
        type: 'init-whisper-done',
        jobId: msg.jobId,
        modelId: msg.modelId,
      });
      return;
    }

    if (msg.type === 'transcribe-pcm') {
      const pcm = msg.samples16k;
      try {
        const transcriber = await getTranscriber(msg.modelId, msg.jobId);
        const result = await transcriber(pcm, {
          chunk_length_s: 30,
          stride_length_s: 5,
        });
        const rawText = Array.isArray(result)
          ? result.map((r) => r.text ?? '').join(' ')
          : (result?.text ?? '');

        const cleaned = rawText
          .replace(/\[BLANK_AUDIO\]/gi, '')
          .replace(/\(blank audio\)/gi, '')
          .replace(/\s+/g, ' ')
          .trim();

        ctx.postMessage({
          type: 'transcribe-pcm-done',
          jobId: msg.jobId,
          text: cleaned,
        });
      } finally {
        // Ephemeral invariant: zero out audio buffer in worker RAM immediately
        if (pcm && typeof pcm.fill === 'function') {
          pcm.fill(0);
        }
      }
    }
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      jobId: msg.jobId,
      error: (err as Error).message || 'Whisper Web Worker failed.',
    });
  }
});
