import type {BuiltInKeyword, PorcupineWorker} from '@picovoice/porcupine-web';
import {BuiltInWakeKeyword} from '../types/noodle';
import {
  ensureGetUserMediaTracked,
  registerAudioContext,
  registerMicrophoneTeardownHook,
} from './microphoneController';

export const PICOVOICE_LICENSING_SUMMARY =
  'Picovoice Porcupine requires your own personal AccessKey from Picovoice Console (console.picovoice.ai). Free accounts carry Picovoice evaluation/usage limits; commercial redistribution requires a commercial Picovoice license. AccessKeys are never bundled or stored permanently by Noodle.';

let activePorcupine: PorcupineWorker | null = null;
let unsubscribeKillHook: (() => void) | null = null;
let isRunning = false;

export function mapWakeKeywordToBuiltIn(
  keyword: BuiltInWakeKeyword,
  builtInEnum: typeof BuiltInKeyword,
): BuiltInKeyword {
  const entries = Object.values(builtInEnum) as string[];
  if (entries.includes(keyword)) {
    return keyword as BuiltInKeyword;
  }
  return builtInEnum.Porcupine;
}

export function isPorcupineWakeWordRunning(): boolean {
  return isRunning;
}

/**
 * Stops Porcupine wake word listener and tears down WebVoiceProcessor + its AudioContext.
 */
export async function stopPorcupineWakeWord(): Promise<void> {
  const hadActive = isRunning || activePorcupine !== null;
  isRunning = false;
  if (unsubscribeKillHook) {
    unsubscribeKillHook();
    unsubscribeKillHook = null;
  }

  if (!hadActive) {
    return;
  }

  try {
    const {WebVoiceProcessor} = await import('@picovoice/web-voice-processor');
    if (activePorcupine) {
      await WebVoiceProcessor.unsubscribe(activePorcupine);
    }
    await WebVoiceProcessor.reset();
    const wvpCtx = WebVoiceProcessor.audioContext;
    if (wvpCtx && wvpCtx.state !== 'closed') {
      await wvpCtx.close();
    }
  } catch {
    // Continue teardown
  }

  if (activePorcupine) {
    try {
      await activePorcupine.release();
    } catch {
      // Ignore release errors
    }
    try {
      activePorcupine.terminate();
    } catch {
      // Ignore terminate errors
    }
    activePorcupine = null;
  }
}

/**
 * Starts optional Picovoice Porcupine wake word detection in a worker.
 * Dynamically loads Picovoice SDK only when explicitly enabled with a valid user AccessKey.
 * Never hard-codes an AccessKey; throws if accessKey is blank.
 */
export async function startPorcupineWakeWord(params: {
  accessKey: string;
  keyword: BuiltInWakeKeyword;
  onDetected: (detectedLabel: string) => void;
  onError: (message: string) => void;
}): Promise<void> {
  const trimmedKey = params.accessKey.trim();
  if (!trimmedKey) {
    throw new Error(
      'Picovoice AccessKey is required to start optional wake word detection.',
    );
  }

  await stopPorcupineWakeWord();
  ensureGetUserMediaTracked();

  const [{BuiltInKeyword: BuiltInEnum, PorcupineWorker: WorkerCls}, {WebVoiceProcessor}] =
    await Promise.all([
      import('@picovoice/porcupine-web'),
      import('@picovoice/web-voice-processor'),
    ]);

  const builtInKeyword = mapWakeKeywordToBuiltIn(params.keyword, BuiltInEnum);

  const worker = await WorkerCls.create(
    trimmedKey,
    {builtin: builtInKeyword, sensitivity: 0.55},
    (detection) => {
      params.onDetected(detection.label || params.keyword);
    },
    {
      publicPath: '/porcupine_params.pv',
      customWritePath: 'noodle_porcupine_params_v1',
      version: 1,
    },
    {
      processErrorCallback: (error) => {
        params.onError(error?.message || String(error));
      },
    },
  );

  activePorcupine = worker;
  isRunning = true;

  unsubscribeKillHook = registerMicrophoneTeardownHook(async () => {
    await stopPorcupineWakeWord();
  });

  try {
    await WebVoiceProcessor.subscribe(worker);
    if (WebVoiceProcessor.audioContext) {
      registerAudioContext(WebVoiceProcessor.audioContext);
    }
  } catch (err) {
    await stopPorcupineWakeWord();
    throw err;
  }
}
