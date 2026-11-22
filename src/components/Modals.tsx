import {FormEvent, useEffect, useState} from 'react';
import {
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  FolderCheck,
  KeyRound,
  Lock,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Unlock,
  X,
  XCircle,
} from 'lucide-react';
import {
  forgetProviderKey,
  getAllProviderStatuses,
  getUnlockedSessionKey,
  lockSessionProviderKey,
  OS_KEYCHAIN_HONEST_WARNING,
  resolvePreferredProvider,
  saveProviderKeyEncrypted,
  saveProviderKeySessionOnly,
  selectActiveProviderAndModel,
  unlockEncryptedProviderKey,
} from '../cloud/keyVault';
import {
  CLOUD_PROVIDER_LIST,
  getProviderAdapter,
} from '../cloud/providerAdapter';
import {
  CATEGORIES,
  CATEGORY_STYLE,
  Category,
  CloudProviderId,
  KeyStorageMode,
  ProviderKeyStatus,
} from '../types/noodle';

interface NewNoteModalProps {
  open: boolean;
  isPersisted: boolean;
  onClose: () => void;
  onCreate: (title: string, category: Category, body: string) => Promise<void> | void;
}

export function NewNoteModal({
  open,
  isPersisted,
  onClose,
  onCreate,
}: NewNoteModalProps) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<Category>('Study');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return null;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const firstLine = body.trim().split(/\r?\n/)[0]?.trim() ?? '';
      const resolvedTitle =
        title.trim() || (firstLine ? firstLine.slice(0, 80) : 'Untitled Note');
      await onCreate(resolvedTitle, category, body.trim());
      setTitle('');
      setCategory('Study');
      setBody('');
      onClose();
    } catch (err) {
      setError((err as Error).message || 'Could not create note.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-note-title"
        className="w-full max-w-lg rounded-xl border border-[#2A2F3E] bg-[#151820] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[#242834] px-5 py-4">
          <div>
            <h2
              id="new-note-title"
              className="font-serif text-lg font-semibold text-[#F4F0E7]"
            >
              New Manual Note
            </h2>
            <p className="text-xs text-[#888F9F]">
              {isPersisted
                ? 'Writes atomically as TipTap JSON inside your manual/ folder.'
                : 'Stored in memory for this demo session (manual/ pillar).'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="rounded-md p-1.5 text-[#8E95A5] hover:bg-[#212531] hover:text-[#ECEBE6]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-5">
          {error && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {error}
            </div>
          )}

          <div>
            <label
              htmlFor="note-title-input"
              className="mb-1.5 block text-xs font-medium text-[#B8BDC9]"
            >
              Note Title (optional — auto-titles from first line)
            </label>
            <input
              id="note-title-input"
              type="text"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Leave blank to auto-title from first line..."
              className="h-10 w-full rounded-lg border border-[#282D3B] bg-[#0E1015] px-3 text-sm text-[#ECEBE6] placeholder-[#656C7D] focus:border-[#E0A83E]/60 focus:outline-none"
            />
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium text-[#B8BDC9]">
              Category
            </span>
            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.map((cat) => {
                const style = CATEGORY_STYLE[cat];
                const selected = category === cat;
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setCategory(cat)}
                    className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                      selected
                        ? `${style.activeBg} ${style.activeBorder} ${style.text}`
                        : 'border-[#262B38] bg-[#101218] text-[#9CA1AE] hover:border-[#363C4D] hover:text-[#ECEBE6]'
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
                    <span>{cat}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label
              htmlFor="note-body-input"
              className="mb-1.5 block text-xs font-medium text-[#B8BDC9]"
            >
              Opening Text (optional)
            </label>
            <textarea
              id="note-body-input"
              rows={3}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Start writing or leave blank to compose in the pageless editor..."
              className="w-full rounded-lg border border-[#282D3B] bg-[#0E1015] p-3 text-sm leading-relaxed text-[#ECEBE6] placeholder-[#656C7D] focus:border-[#E0A83E]/60 focus:outline-none"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-[#282D3B] px-4 py-2 text-xs font-medium text-[#B2B7C4] transition-colors hover:bg-[#1E222D] hover:text-[#ECEBE6]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-[#E0A83E] px-4 py-2 text-xs font-semibold text-[#111216] transition-colors hover:bg-[#ECB955] disabled:opacity-40"
            >
              {submitting ? 'Creating...' : 'Create & Open Editor'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface KeySetupModalProps {
  open: boolean;
  onClose: () => void;
}

export function KeySetupModal({open, onClose}: KeySetupModalProps) {
  const [provider, setProvider] = useState<CloudProviderId>('gemini');
  const [model, setModel] = useState('gemini-2.5-flash');
  const [statuses, setStatuses] = useState<
    Record<CloudProviderId, ProviderKeyStatus> | null
  >(null);

  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [storageMode, setStorageMode] = useState<KeyStorageMode>(
    'encrypted-indexeddb',
  );
  const [passphrase, setPassphrase] = useState('');
  const [unlockPassphrase, setUnlockPassphrase] = useState('');

  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testFeedback, setTestFeedback] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatuses = async (targetProvider?: CloudProviderId) => {
    const next = await getAllProviderStatuses();
    setStatuses(next);
    const p = targetProvider ?? provider;
    setModel(next[p].model);
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    setError(null);
    setSaveMessage(null);
    setTestFeedback(null);
    setApiKeyInput('');
    setPassphrase('');
    setUnlockPassphrase('');
    setShowKey(false);
    void (async () => {
      const pref = await resolvePreferredProvider();
      setProvider(pref.provider);
      await refreshStatuses(pref.provider);
      setModel(pref.model);
    })();
  }, [open]);

  if (!open) {
    return null;
  }

  const adapter = getProviderAdapter(provider);
  const currentStatus = statuses?.[provider];
  const sessionKeyObj = getUnlockedSessionKey(provider);

  const handleSwitchProvider = (nextProvider: CloudProviderId) => {
    setProvider(nextProvider);
    const nextModel =
      statuses?.[nextProvider]?.model ||
      getProviderAdapter(nextProvider).defaultModel;
    setModel(nextModel);
    setApiKeyInput('');
    setPassphrase('');
    setUnlockPassphrase('');
    setShowKey(false);
    setError(null);
    setSaveMessage(null);
    setTestFeedback(null);
    void selectActiveProviderAndModel(nextProvider, nextModel);
  };

  const handleTestConnection = async () => {
    const candidateKey = apiKeyInput.trim() || sessionKeyObj?.apiKey || '';
    if (!candidateKey) {
      setTestFeedback({
        ok: false,
        message: 'Enter an API key or unlock your saved key before testing.',
      });
      return;
    }
    setTesting(true);
    setTestFeedback(null);
    setError(null);
    try {
      const res = await adapter.testConnection(candidateKey, model);
      setTestFeedback({ok: res.ok, message: res.message});
    } finally {
      setTesting(false);
    }
  };

  const handleSaveKey = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) {
      return;
    }
    setError(null);
    setSaveMessage(null);

    const trimmedKey = apiKeyInput.trim();
    if (!trimmedKey) {
      setError('Paste your API key before saving.');
      return;
    }

    setBusy(true);
    try {
      if (storageMode === 'encrypted-indexeddb') {
        await saveProviderKeyEncrypted({
          provider,
          apiKey: trimmedKey,
          passphrase,
          model,
        });
        setSaveMessage(
          `${adapter.label} key encrypted with PBKDF2 + AES-GCM in IndexedDB and unlocked for this session.`,
        );
      } else {
        await saveProviderKeySessionOnly({
          provider,
          apiKey: trimmedKey,
          model,
        });
        setSaveMessage(
          `${adapter.label} key kept in session memory only (cleared when this tab closes).`,
        );
      }
      setApiKeyInput('');
      setPassphrase('');
      setShowKey(false);
      await refreshStatuses(provider);
    } catch (err) {
      setError((err as Error).message || 'Could not save API key.');
    } finally {
      setBusy(false);
    }
  };

  const handleUnlock = async () => {
    setError(null);
    setSaveMessage(null);
    setBusy(true);
    try {
      await unlockEncryptedProviderKey(provider, unlockPassphrase);
      setUnlockPassphrase('');
      setSaveMessage(`${adapter.label} key unlocked for this session.`);
      await refreshStatuses(provider);
    } catch (err) {
      setError((err as Error).message || 'Could not unlock key.');
    } finally {
      setBusy(false);
    }
  };

  const handleLock = () => {
    lockSessionProviderKey(provider);
    setSaveMessage(
      `${adapter.label} key locked in session memory. Enter passphrase to unlock again.`,
    );
    void refreshStatuses(provider);
  };

  const handleForget = async () => {
    setError(null);
    setSaveMessage(null);
    await forgetProviderKey(provider);
    setApiKeyInput('');
    setPassphrase('');
    setUnlockPassphrase('');
    setSaveMessage(`Removed stored ${adapter.label} key.`);
    await refreshStatuses(provider);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="key-setup-title"
        className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-[#2A2F3E] bg-[#151820] shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#242834] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <KeyRound className="h-4 w-4 text-[#E0A83E]" />
            <div>
              <h2
                id="key-setup-title"
                className="font-serif text-lg font-semibold text-[#F4F0E7]"
              >
                Cloud Key Setup Wizard (BYOK)
              </h2>
              <p className="text-[11px] text-[#888F9F]">
                Direct browser calls only · no proxy server · sent only after
                privacy notice approval
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="rounded-md p-1.5 text-[#8E95A5] hover:bg-[#212531] hover:text-[#ECEBE6]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 space-y-4 overflow-y-auto p-5 text-xs leading-relaxed text-[#B8BDC9]">
          {/* Provider Tabs */}
          <div className="grid grid-cols-3 gap-2">
            {CLOUD_PROVIDER_LIST.map((item) => {
              const st = statuses?.[item.id];
              const isSelected = provider === item.id;
              const statusText = st?.hasSessionKey
                ? 'Unlocked'
                : st?.hasEncryptedKey
                  ? 'Encrypted'
                  : 'Not set';
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSwitchProvider(item.id)}
                  className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    isSelected
                      ? 'border-[#E0A83E]/60 bg-[#E0A83E]/12 text-[#F5F1E8]'
                      : 'border-[#252A38] bg-[#101218] text-[#9CA1AE] hover:border-[#373E52] hover:text-[#ECEBE6]'
                  }`}
                >
                  <div className="font-semibold">{item.label}</div>
                  <div
                    className={`mt-0.5 text-[11px] ${
                      st?.hasSessionKey
                        ? 'text-emerald-400'
                        : st?.hasEncryptedKey
                          ? 'text-[#E0A83E]'
                          : 'text-[#6D7486]'
                    }`}
                  >
                    {statusText}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Provider Details: Key Portal Link, Free Tier Note, Browser CORS Behavior */}
          <div className="space-y-2 rounded-lg border border-[#252A38] bg-[#101218] p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-[#ECEBE6]">
                {adapter.label}
              </span>
              <a
                href={adapter.keyPortalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-[#E0A83E] underline-offset-2 hover:underline"
              >
                <span>{adapter.keyPortalLabel}</span>
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>

            {adapter.freeTierNote && (
              <p className="font-medium text-emerald-300">
                Free tier: {adapter.freeTierNote}
              </p>
            )}

            <p className="text-[11px] text-[#969DAB]">
              <strong className="text-[#C8CCD6]">Browser CORS &amp; headers:</strong>{' '}
              {adapter.browserCorsNote}
            </p>
          </div>

          {/* Honest OS Keychain Comparison */}
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/35 bg-amber-500/8 p-3 text-[11px] text-amber-100/90">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <div>
              <p className="font-semibold text-amber-200">
                Weaker than an OS keychain
              </p>
              <p className="mt-0.5 text-amber-100/80">
                {OS_KEYCHAIN_HONEST_WARNING} Your key is never logged, displayed
                after saving, exported, or placed in URLs or workspace files.
              </p>
            </div>
          </div>

          {/* Existing Encrypted / Unlocked Key Controls */}
          {currentStatus &&
            (currentStatus.hasEncryptedKey || currentStatus.hasSessionKey) && (
              <div className="space-y-2.5 rounded-lg border border-[#272D3B] bg-[#11141C] p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {currentStatus.hasSessionKey ? (
                      <Unlock className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <Lock className="h-3.5 w-3.5 text-[#E0A83E]" />
                    )}
                    <span className="font-medium text-[#ECEBE6]">
                      {currentStatus.hasSessionKey
                        ? currentStatus.storageMode === 'session-only'
                          ? 'Active for this session only (memory)'
                          : 'Unlocked from encrypted IndexedDB'
                        : 'Locked in encrypted IndexedDB'}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {currentStatus.hasSessionKey &&
                      currentStatus.hasEncryptedKey && (
                        <button
                          type="button"
                          onClick={handleLock}
                          className="rounded border border-[#2C3140] bg-[#171A23] px-2.5 py-1 text-[11px] text-[#C8CCD6] hover:text-white"
                        >
                          Lock
                        </button>
                      )}
                    <button
                      type="button"
                      onClick={() => void handleForget()}
                      className="inline-flex items-center gap-1 rounded border border-rose-500/35 bg-rose-500/10 px-2.5 py-1 text-[11px] text-rose-200 hover:bg-rose-500/20"
                    >
                      <Trash2 className="h-3 w-3" />
                      <span>Forget key</span>
                    </button>
                  </div>
                </div>

                {currentStatus.hasEncryptedKey && !currentStatus.hasSessionKey && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <input
                      type="password"
                      value={unlockPassphrase}
                      onChange={(e) => setUnlockPassphrase(e.target.value)}
                      placeholder="Enter passphrase to unlock..."
                      aria-label="Unlock passphrase"
                      className="h-9 min-w-[180px] flex-1 rounded-lg border border-[#282D3B] bg-[#0E1015] px-3 text-xs text-[#ECEBE6] placeholder-[#656C7D] focus:border-[#E0A83E]/60 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void handleUnlock()}
                      disabled={busy || !unlockPassphrase}
                      className="h-9 rounded-lg bg-[#E0A83E] px-3.5 text-xs font-semibold text-[#111216] hover:bg-[#ECB955] disabled:opacity-40"
                    >
                      Unlock
                    </button>
                  </div>
                )}
              </div>
            )}

          {/* Save / Replace Key Form */}
          <form onSubmit={handleSaveKey} className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label
                  htmlFor="byok-api-key-input"
                  className="mb-1 block text-xs font-medium text-[#C8CCD6]"
                >
                  {currentStatus?.hasEncryptedKey || currentStatus?.hasSessionKey
                    ? `Replace ${adapter.label} API Key`
                    : `${adapter.label} API Key`}
                </label>
                <div className="relative">
                  <input
                    id="byok-api-key-input"
                    type={showKey ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    value={apiKeyInput}
                    onChange={(e) => {
                      setApiKeyInput(e.target.value);
                      setError(null);
                      setTestFeedback(null);
                    }}
                    placeholder={`Paste your ${adapter.label} key...`}
                    className="h-10 w-full rounded-lg border border-[#282D3B] bg-[#0E1015] pr-16 pl-3 font-mono text-xs text-[#ECEBE6] placeholder-[#656C7D] focus:border-[#E0A83E]/60 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((prev) => !prev)}
                    aria-label={showKey ? 'Hide API key' : 'Show API key'}
                    className="absolute top-1/2 right-2 inline-flex -translate-y-1/2 items-center gap-1 rounded px-2 py-1 text-[11px] text-[#9CA1AE] hover:bg-[#1C202B] hover:text-[#ECEBE6]"
                  >
                    {showKey ? (
                      <>
                        <EyeOff className="h-3.5 w-3.5" />
                        <span>Hide</span>
                      </>
                    ) : (
                      <>
                        <Eye className="h-3.5 w-3.5" />
                        <span>Show</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              <div>
                <label
                  htmlFor="byok-model-select"
                  className="mb-1 block text-xs font-medium text-[#C8CCD6]"
                >
                  Model
                </label>
                <select
                  id="byok-model-select"
                  value={model}
                  onChange={(e) => {
                    const nextModel = e.target.value;
                    setModel(nextModel);
                    void selectActiveProviderAndModel(provider, nextModel);
                  }}
                  className="h-10 w-full rounded-lg border border-[#282D3B] bg-[#0E1015] px-2.5 text-xs text-[#ECEBE6] focus:border-[#E0A83E]/60 focus:outline-none"
                >
                  {adapter.availableModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <span className="mb-1 block text-xs font-medium text-[#C8CCD6]">
                  Storage Option
                </span>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setStorageMode('encrypted-indexeddb')}
                    className={`h-10 rounded-lg border px-2 text-[11px] font-medium transition-colors ${
                      storageMode === 'encrypted-indexeddb'
                        ? 'border-[#E0A83E]/60 bg-[#E0A83E]/12 text-[#F5F1E8]'
                        : 'border-[#282D3B] bg-[#0E1015] text-[#9CA1AE]'
                    }`}
                  >
                    Encrypt (IndexedDB)
                  </button>
                  <button
                    type="button"
                    onClick={() => setStorageMode('session-only')}
                    className={`h-10 rounded-lg border px-2 text-[11px] font-medium transition-colors ${
                      storageMode === 'session-only'
                        ? 'border-[#E0A83E]/60 bg-[#E0A83E]/12 text-[#F5F1E8]'
                        : 'border-[#282D3B] bg-[#0E1015] text-[#9CA1AE]'
                    }`}
                  >
                    Keep for this session only
                  </button>
                </div>
              </div>
            </div>

            {storageMode === 'encrypted-indexeddb' && (
              <div>
                <label
                  htmlFor="byok-passphrase-input"
                  className="mb-1 block text-xs font-medium text-[#C8CCD6]"
                >
                  Encryption Passphrase (PBKDF2 + AES-GCM, min 6 chars)
                </label>
                <input
                  id="byok-passphrase-input"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Enter passphrase to encrypt key in IndexedDB..."
                  className="h-10 w-full rounded-lg border border-[#282D3B] bg-[#0E1015] px-3 text-xs text-[#ECEBE6] placeholder-[#656C7D] focus:border-[#E0A83E]/60 focus:outline-none"
                />
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                {error}
              </div>
            )}

            {saveMessage && (
              <div className="flex items-start gap-2 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                <span>{saveMessage}</span>
              </div>
            )}

            {testFeedback && (
              <div
                className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
                  testFeedback.ok
                    ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200'
                    : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                }`}
              >
                {testFeedback.ok ? (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                ) : (
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" />
                )}
                <span>{testFeedback.message}</span>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
              <button
                type="button"
                onClick={() => void handleTestConnection()}
                disabled={testing}
                className="rounded-lg border border-[#2C3140] bg-[#181B24] px-3.5 py-2 text-xs font-medium text-[#ECEBE6] transition-colors hover:border-[#3E4559] disabled:opacity-50"
              >
                {testing ? 'Testing connection...' : 'Test connection'}
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg border border-[#282D3B] px-3.5 py-2 text-xs font-medium text-[#B2B7C4] hover:text-[#ECEBE6]"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-lg bg-[#E0A83E] px-4 py-2 text-xs font-semibold text-[#111216] transition-colors hover:bg-[#ECB955] disabled:opacity-40"
                >
                  {busy
                    ? 'Saving...'
                    : storageMode === 'encrypted-indexeddb'
                      ? 'Encrypt & Save Key'
                      : 'Use for This Session'}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

interface NonEmptyFolderModalProps {
  open: boolean;
  folderName: string;
  entryCount: number;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
}

export function NonEmptyFolderModal({
  open,
  folderName,
  entryCount,
  onCancel,
  onConfirm,
}: NonEmptyFolderModalProps) {
  const [initializing, setInitializing] = useState(false);

  if (!open) {
    return null;
  }

  const handleConfirm = async () => {
    if (initializing) {
      return;
    }
    setInitializing(true);
    try {
      await onConfirm();
    } finally {
      setInitializing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="non-empty-folder-title"
        className="w-full max-w-md rounded-xl border border-[#2A2F3E] bg-[#151820] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[#242834] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <FolderCheck className="h-4 w-4 text-[#E0A83E]" />
            <h2
              id="non-empty-folder-title"
              className="font-serif text-lg font-semibold text-[#F4F0E7]"
            >
              Initialize Non-Empty Folder?
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel folder initialization"
            className="rounded-md p-1.5 text-[#8E95A5] hover:bg-[#212531] hover:text-[#ECEBE6]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5 text-xs leading-relaxed text-[#B8BDC9]">
          <p>
            The folder{' '}
            <code className="rounded bg-[#0E1015] px-1.5 py-0.5 font-mono text-[#F4F0E7]">
              {folderName}
            </code>{' '}
            already contains{' '}
            <span className="font-semibold text-[#ECEBE6] tabular-nums">
              {entryCount}
            </span>{' '}
            {entryCount === 1 ? 'item' : 'items'}.
          </p>
          <p className="text-[#969DAB]">
            Noodle will only create missing workspace subdirectories (
            <code className="font-mono">sources/</code>,{' '}
            <code className="font-mono">manual/</code>,{' '}
            <code className="font-mono">ai/</code>,{' '}
            <code className="font-mono">assets/</code>,{' '}
            <code className="font-mono">.noodle/</code>) and will never delete
            or overwrite your existing files.
          </p>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-[#282D3B] px-4 py-2 text-xs font-medium text-[#B2B7C4] transition-colors hover:bg-[#1E222D] hover:text-[#ECEBE6]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={initializing}
              className="rounded-lg bg-[#E0A83E] px-4 py-2 text-xs font-semibold text-[#111216] transition-colors hover:bg-[#ECB955] disabled:opacity-40"
            >
              {initializing ? 'Initializing...' : 'Continue & Initialize'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
