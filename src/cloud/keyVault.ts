import {
  deleteEncryptedKeyRecord,
  getActiveProviderSetting,
  getEncryptedKeyRecord,
  listEncryptedKeyRecords,
  saveActiveProviderSetting,
  saveEncryptedKeyRecord,
} from '../db/noodleDb';
import {
  CloudProviderId,
  EncryptedKeyRecord,
  ProviderKeyStatus,
} from '../types/noodle';

export const KEY_VAULT_PBKDF2_ITERATIONS = 210_000;

export const OS_KEYCHAIN_HONEST_WARNING =
  'Saving a key in your browser (even locked with a passphrase or kept for this session only) is weaker than an OS keychain: scripts running in the page while unlocked can read it.';

const DEFAULT_MODEL_BY_PROVIDER: Record<CloudProviderId, string> = {
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-20250514',
};

/**
 * Strictly in-memory session key store.
 * Never written to localStorage, sessionStorage, URLs, logs, or workspace files.
 */
const sessionKeys = new Map<
  CloudProviderId,
  {apiKey: string; model: string; mode: 'encrypted-indexeddb' | 'session-only'}
>();

const statusListeners = new Set<() => void>();

function notifyVaultChange(): void {
  for (const listener of statusListeners) {
    listener();
  }
}

export function subscribeKeyVaultChanges(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

function getSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'WebCrypto (crypto.subtle) is unavailable. Requires HTTPS or localhost.',
    );
  }
  return subtle;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(base64, 'base64');
    const out = new Uint8Array(new ArrayBuffer(buf.length));
    out.set(buf);
    return out;
  }
  const binary = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Scrubs any known API key patterns or explicit secret strings from text
 * before logs, diagnostics, exports, or error UI states.
 */
export function redactSecretFromText(
  text: string,
  explicitSecret?: string,
): string {
  let out = String(text ?? '');
  if (explicitSecret && explicitSecret.trim().length >= 4) {
    const trimmed = explicitSecret.trim();
    out = out.split(trimmed).join('[REDACTED_KEY]');
  }
  out = out
    .replace(/sk-(?:proj-|ant-|svcacct-)?[A-Za-z0-9_-]{8,}/g, '[REDACTED_OPENAI_KEY]')
    .replace(/AIza[0-9A-Za-z_-]{12,}/g, '[REDACTED_GOOGLE_KEY]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1[REDACTED_KEY]')
    .replace(/([?&]key=)[^&\s]+/gi, '$1[REDACTED_KEY]');
  return out;
}

async function deriveAesGcmKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  const subtle = getSubtleCrypto();
  const encoder = new TextEncoder();
  const rawPassphrase = encoder.encode(passphrase);
  const keyMaterial = await subtle.importKey(
    'raw',
    rawPassphrase,
    {name: 'PBKDF2'},
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    {name: 'AES-GCM', length: 256},
    false,
    [usage],
  );
}

export async function encryptApiKeyWithPassphrase(params: {
  provider: CloudProviderId;
  apiKey: string;
  passphrase: string;
  model: string;
  iterations?: number;
}): Promise<EncryptedKeyRecord> {
  const cleanedKey = params.apiKey.trim();
  if (!cleanedKey) {
    throw new Error('API key cannot be empty.');
  }
  if (params.passphrase.length < 6) {
    throw new Error('Passphrase must be at least 6 characters long.');
  }

  const subtle = getSubtleCrypto();
  const salt = new Uint8Array(new ArrayBuffer(16));
  const iv = new Uint8Array(new ArrayBuffer(12));
  globalThis.crypto.getRandomValues(salt);
  globalThis.crypto.getRandomValues(iv);

  const iterations = params.iterations ?? KEY_VAULT_PBKDF2_ITERATIONS;
  const aesKey = await deriveAesGcmKey(
    params.passphrase,
    salt,
    iterations,
    'encrypt',
  );
  const plaintextBytes = new TextEncoder().encode(cleanedKey);
  const cipherBuffer = await subtle.encrypt(
    {name: 'AES-GCM', iv},
    aesKey,
    plaintextBytes,
  );

  return {
    provider: params.provider,
    saltBase64: bytesToBase64(salt),
    ivBase64: bytesToBase64(iv),
    ciphertextBase64: bytesToBase64(new Uint8Array(cipherBuffer)),
    iterations,
    model: params.model,
    updatedAt: new Date().toISOString(),
  };
}

export async function decryptApiKeyWithPassphrase(
  record: EncryptedKeyRecord,
  passphrase: string,
): Promise<string> {
  if (!passphrase) {
    throw new Error('Enter your vault passphrase to unlock this API key.');
  }
  const subtle = getSubtleCrypto();
  const salt = base64ToBytes(record.saltBase64);
  const iv = base64ToBytes(record.ivBase64);
  const ciphertext = base64ToBytes(record.ciphertextBase64);

  try {
    const aesKey = await deriveAesGcmKey(
      passphrase,
      salt,
      record.iterations,
      'decrypt',
    );
    const plainBuffer = await subtle.decrypt(
      {name: 'AES-GCM', iv},
      aesKey,
      ciphertext,
    );
    const decoded = new TextDecoder().decode(plainBuffer).trim();
    if (!decoded) {
      throw new Error('Decrypted key was empty.');
    }
    return decoded;
  } catch {
    throw new Error('Incorrect passphrase or corrupted encrypted key record.');
  }
}

export async function saveProviderKeyEncrypted(params: {
  provider: CloudProviderId;
  apiKey: string;
  passphrase: string;
  model: string;
}): Promise<void> {
  const record = await encryptApiKeyWithPassphrase(params);
  await saveEncryptedKeyRecord(record);
  await saveActiveProviderSetting(params.provider, params.model);
  sessionKeys.set(params.provider, {
    apiKey: params.apiKey.trim(),
    model: params.model,
    mode: 'encrypted-indexeddb',
  });
  notifyVaultChange();
}

export async function saveProviderKeySessionOnly(params: {
  provider: CloudProviderId;
  apiKey: string;
  model: string;
}): Promise<void> {
  const cleaned = params.apiKey.trim();
  if (!cleaned) {
    throw new Error('API key cannot be empty.');
  }
  // Remove any stale encrypted entry for this provider if switching to session-only
  await deleteEncryptedKeyRecord(params.provider);
  await saveActiveProviderSetting(params.provider, params.model);
  sessionKeys.set(params.provider, {
    apiKey: cleaned,
    model: params.model,
    mode: 'session-only',
  });
  notifyVaultChange();
}

export async function unlockEncryptedProviderKey(
  provider: CloudProviderId,
  passphrase: string,
): Promise<{apiKey: string; model: string}> {
  const record = await getEncryptedKeyRecord(provider);
  if (!record) {
    throw new Error(`No encrypted key saved for ${provider}.`);
  }
  const apiKey = await decryptApiKeyWithPassphrase(record, passphrase);
  sessionKeys.set(provider, {
    apiKey,
    model: record.model || DEFAULT_MODEL_BY_PROVIDER[provider],
    mode: 'encrypted-indexeddb',
  });
  await saveActiveProviderSetting(
    provider,
    record.model || DEFAULT_MODEL_BY_PROVIDER[provider],
  );
  notifyVaultChange();
  return {
    apiKey,
    model: record.model || DEFAULT_MODEL_BY_PROVIDER[provider],
  };
}

export function lockSessionProviderKey(provider: CloudProviderId): void {
  sessionKeys.delete(provider);
  notifyVaultChange();
}

export async function forgetProviderKey(
  provider: CloudProviderId,
): Promise<void> {
  sessionKeys.delete(provider);
  await deleteEncryptedKeyRecord(provider);
  notifyVaultChange();
}

export function getUnlockedSessionKey(provider: CloudProviderId): {
  apiKey: string;
  model: string;
  mode: 'encrypted-indexeddb' | 'session-only';
} | null {
  return sessionKeys.get(provider) ?? null;
}

export async function getAllProviderStatuses(): Promise<
  Record<CloudProviderId, ProviderKeyStatus>
> {
  const records = await listEncryptedKeyRecords();
  const byProvider = new Map<CloudProviderId, EncryptedKeyRecord>(
    records.map((r) => [r.provider, r]),
  );

  const providers: CloudProviderId[] = ['gemini', 'openai', 'anthropic'];
  const result = {} as Record<CloudProviderId, ProviderKeyStatus>;

  for (const p of providers) {
    const sess = sessionKeys.get(p);
    const enc = byProvider.get(p);
    result[p] = {
      provider: p,
      model: sess?.model || enc?.model || DEFAULT_MODEL_BY_PROVIDER[p],
      hasSessionKey: Boolean(sess),
      hasEncryptedKey: Boolean(enc),
      storageMode: sess
        ? sess.mode
        : enc
          ? 'encrypted-indexeddb'
          : 'none',
      updatedAt: enc?.updatedAt,
    };
  }

  return result;
}

export async function resolvePreferredProvider(): Promise<{
  provider: CloudProviderId;
  model: string;
}> {
  const saved = await getActiveProviderSetting();
  if (saved) {
    return {
      provider: saved.provider,
      model: saved.model || DEFAULT_MODEL_BY_PROVIDER[saved.provider],
    };
  }
  const statuses = await getAllProviderStatuses();
  for (const p of ['gemini', 'openai', 'anthropic'] as CloudProviderId[]) {
    if (statuses[p].hasSessionKey || statuses[p].hasEncryptedKey) {
      return {provider: p, model: statuses[p].model};
    }
  }
  return {provider: 'gemini', model: DEFAULT_MODEL_BY_PROVIDER.gemini};
}

export async function selectActiveProviderAndModel(
  provider: CloudProviderId,
  model: string,
): Promise<void> {
  const sess = sessionKeys.get(provider);
  if (sess) {
    sessionKeys.set(provider, {...sess, model});
  }
  await saveActiveProviderSetting(provider, model);
  notifyVaultChange();
}
