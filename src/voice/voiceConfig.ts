import {noodleDb} from '../db/noodleDb';
import {BuiltInWakeKeyword, VoiceSearchSettings} from '../types/noodle';

export const WHISPER_MODELS: Array<{
  id: string;
  label: string;
  sizeHint: string;
  description: string;
}> = [
  {
    id: 'onnx-community/whisper-tiny.en',
    label: 'Whisper Tiny English (onnx-community)',
    sizeHint: '~41 MB quantized (q8)',
    description: 'Fast English speech-to-text tuned for Transformers.js in Web Workers.',
  },
  {
    id: 'Xenova/whisper-tiny.en',
    label: 'Whisper Tiny English (Xenova)',
    sizeHint: '~41 MB quantized (q8)',
    description: 'Classic Xenova Whisper Tiny English ONNX weights cached in browser storage.',
  },
];

export const DEFAULT_WHISPER_MODEL_ID = WHISPER_MODELS[0].id;

export const PUSH_TO_TALK_HOTKEY_PRESETS: Array<{
  value: string;
  label: string;
}> = [
  {value: 'Alt+Space', label: 'Alt + Space'},
  {value: 'Control+Shift+Space', label: 'Ctrl + Shift + Space'},
  {value: 'Control+Shift+KeyV', label: 'Ctrl + Shift + V'},
  {value: 'Alt+KeyV', label: 'Alt + V'},
];

export const PORCUPINE_BUILTIN_KEYWORDS: BuiltInWakeKeyword[] = [
  'Porcupine',
  'Computer',
  'Jarvis',
  'Bumblebee',
  'Blueberry',
  'Grapefruit',
  'Grasshopper',
  'Picovoice',
  'Terminator',
  'Americano',
];

export function getDefaultVoiceSearchSettings(): VoiceSearchSettings {
  return {
    experimentalVoiceEnabled: false,
    whisperModelId: DEFAULT_WHISPER_MODEL_ID,
    whisperDownloaded: false,
    pushToTalkHotkey: 'Alt+Space',
    wakeWordEnabled: false,
    wakeWordKeyword: 'Porcupine',
  };
}

const SETTING_KEYS = {
  experimentalVoiceEnabled: 'voice.experimentalEnabled',
  whisperModelId: 'voice.whisperModelId',
  whisperDownloaded: 'voice.whisperDownloaded',
  pushToTalkHotkey: 'voice.pushToTalkHotkey',
  wakeWordEnabled: 'voice.wakeWordEnabled',
  wakeWordKeyword: 'voice.wakeWordKeyword',
} as const;

export async function loadVoiceSearchSettings(): Promise<VoiceSearchSettings> {
  const defaults = getDefaultVoiceSearchSettings();
  if (typeof indexedDB === 'undefined') {
    return defaults;
  }

  try {
    const rows = await noodleDb.appSettings
      .where('key')
      .anyOf(Object.values(SETTING_KEYS))
      .toArray();
    const map = new Map(rows.map((r) => [r.key, r.value]));

    const modelId =
      typeof map.get(SETTING_KEYS.whisperModelId) === 'string' &&
      WHISPER_MODELS.some((m) => m.id === map.get(SETTING_KEYS.whisperModelId))
        ? String(map.get(SETTING_KEYS.whisperModelId))
        : defaults.whisperModelId;

    const keywordCandidate = map.get(SETTING_KEYS.wakeWordKeyword);
    const wakeWordKeyword =
      typeof keywordCandidate === 'string' &&
      (PORCUPINE_BUILTIN_KEYWORDS as string[]).includes(keywordCandidate)
        ? (keywordCandidate as BuiltInWakeKeyword)
        : defaults.wakeWordKeyword;

    const experimentalVoiceEnabled =
      map.get(SETTING_KEYS.experimentalVoiceEnabled) === true;

    return {
      experimentalVoiceEnabled,
      whisperModelId: modelId,
      whisperDownloaded: map.get(SETTING_KEYS.whisperDownloaded) === true,
      pushToTalkHotkey:
        typeof map.get(SETTING_KEYS.pushToTalkHotkey) === 'string' &&
        String(map.get(SETTING_KEYS.pushToTalkHotkey)).trim().length > 0
          ? String(map.get(SETTING_KEYS.pushToTalkHotkey))
          : defaults.pushToTalkHotkey,
      wakeWordEnabled:
        experimentalVoiceEnabled &&
        map.get(SETTING_KEYS.wakeWordEnabled) === true,
      wakeWordKeyword,
    };
  } catch {
    return defaults;
  }
}

export async function saveVoiceSearchSettings(
  next: VoiceSearchSettings,
): Promise<VoiceSearchSettings> {
  const normalized: VoiceSearchSettings = {
    experimentalVoiceEnabled: Boolean(next.experimentalVoiceEnabled),
    whisperModelId: next.whisperModelId || DEFAULT_WHISPER_MODEL_ID,
    whisperDownloaded: Boolean(next.whisperDownloaded),
    pushToTalkHotkey: next.pushToTalkHotkey || 'Alt+Space',
    wakeWordEnabled:
      Boolean(next.experimentalVoiceEnabled) && Boolean(next.wakeWordEnabled),
    wakeWordKeyword: next.wakeWordKeyword || 'Porcupine',
  };

  if (typeof indexedDB !== 'undefined') {
    await noodleDb.transaction('rw', noodleDb.appSettings, async () => {
      await noodleDb.appSettings.bulkPut([
        {
          key: SETTING_KEYS.experimentalVoiceEnabled,
          value: normalized.experimentalVoiceEnabled,
        },
        {
          key: SETTING_KEYS.whisperModelId,
          value: normalized.whisperModelId,
        },
        {
          key: SETTING_KEYS.whisperDownloaded,
          value: normalized.whisperDownloaded,
        },
        {
          key: SETTING_KEYS.pushToTalkHotkey,
          value: normalized.pushToTalkHotkey,
        },
        {
          key: SETTING_KEYS.wakeWordEnabled,
          value: normalized.wakeWordEnabled,
        },
        {
          key: SETTING_KEYS.wakeWordKeyword,
          value: normalized.wakeWordKeyword,
        },
      ]);
    });
  }

  return normalized;
}

export interface HotkeyLikeEvent {
  code: string;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export function formatHotkeyLabel(hotkey: string): string {
  return hotkey
    .split('+')
    .map((part) => {
      if (part === 'Control') return 'Ctrl';
      if (part === 'Space') return 'Space';
      if (part.startsWith('Key')) return part.slice(3);
      return part;
    })
    .join(' + ');
}

export function isEditableElement(target: unknown): boolean {
  if (!target || typeof target !== 'object') {
    return false;
  }
  const el = target as {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => unknown;
  };
  const tag = (el.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  if (el.isContentEditable) {
    return true;
  }
  if (typeof el.closest === 'function') {
    return Boolean(el.closest('[contenteditable="true"], .ProseMirror'));
  }
  return false;
}

/**
 * Matches configured push-to-talk hotkey combinations such as 'Alt+Space',
 * 'Control+Shift+Space', 'Control+Shift+KeyV', or single non-typing keys.
 */
export function matchesPushToTalkHotkey(
  event: HotkeyLikeEvent,
  hotkey: string,
  target?: unknown,
): boolean {
  const parts = hotkey
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return false;
  }

  const requiresAlt = parts.includes('Alt');
  const requiresCtrl = parts.includes('Control') || parts.includes('Ctrl');
  const requiresShift = parts.includes('Shift');
  const requiresMeta = parts.includes('Meta');
  const mainKey = parts[parts.length - 1];

  // If the hotkey has no modifier key, never hijack typing inside inputs/editors.
  const hasModifier =
    requiresAlt || requiresCtrl || requiresShift || requiresMeta;
  if (!hasModifier && isEditableElement(target)) {
    return false;
  }

  if (
    event.altKey !== requiresAlt ||
    event.ctrlKey !== requiresCtrl ||
    event.shiftKey !== requiresShift ||
    event.metaKey !== requiresMeta
  ) {
    return false;
  }

  if (mainKey === 'Space') {
    return event.code === 'Space' || event.key === ' ';
  }
  if (mainKey.startsWith('Key')) {
    const letter = mainKey.slice(3).toLowerCase();
    return event.code === mainKey || event.key.toLowerCase() === letter;
  }
  return event.code === mainKey || event.key.toLowerCase() === mainKey.toLowerCase();
}
