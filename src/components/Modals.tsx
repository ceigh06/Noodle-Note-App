import {FormEvent, useEffect, useState} from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  Folder,
  FolderCheck,
  FolderPlus,
  KeyRound,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
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
  CATEGORY_COLOR_OPTIONS,
  getCategoryStyle,
  getSubfoldersForCategory,
  sanitizeCategoryLabel,
} from '../storage/categoryConfig';
import {
  Category,
  CategoryColorKey,
  CloudProviderId,
  KeyStorageMode,
  ProviderKeyStatus,
  UserCategoryConfig,
} from '../types/noodle';

interface NewNoteModalProps {
  open: boolean;
  isPersisted: boolean;
  categoryConfigs: UserCategoryConfig[];
  defaultCategory?: Category;
  defaultSubfolder?: string;
  initialTitle?: string;
  initialBody?: string;
  onClose: () => void;
  onCreate: (
    title: string,
    category: Category,
    body: string,
    subfolder?: string,
  ) => Promise<void> | void;
}

export function NewNoteModal({
  open,
  isPersisted,
  categoryConfigs,
  defaultCategory,
  defaultSubfolder,
  initialTitle = '',
  initialBody = '',
  onClose,
  onCreate,
}: NewNoteModalProps) {
  const fallbackCategory = categoryConfigs[0]?.name || 'Study';
  const resolvedDefaultCategory =
    defaultCategory &&
    defaultCategory !== 'All' &&
    categoryConfigs.some((c) => c.name === defaultCategory)
      ? defaultCategory
      : fallbackCategory;

  const [title, setTitle] = useState(initialTitle);
  const [category, setCategory] = useState<Category>(resolvedDefaultCategory);
  const [subfolder, setSubfolder] = useState<string>(defaultSubfolder || '');
  const [body, setBody] = useState(initialBody);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setTitle(initialTitle);
    setBody(initialBody);
    setCategory(resolvedDefaultCategory);
    const shouldPrefillSub =
      Boolean(defaultCategory) &&
      defaultCategory !== 'All' &&
      resolvedDefaultCategory === defaultCategory &&
      Boolean(defaultSubfolder) &&
      defaultSubfolder !== 'All';
    setSubfolder(shouldPrefillSub ? defaultSubfolder || '' : '');
    setError(null);
  }, [
    open,
    initialTitle,
    initialBody,
    defaultCategory,
    resolvedDefaultCategory,
    defaultSubfolder,
  ]);

  if (!open) {
    return null;
  }

  const knownSubfolders = getSubfoldersForCategory(categoryConfigs, category);

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
      const cleanSub = sanitizeCategoryLabel(subfolder);
      await onCreate(
        resolvedTitle,
        category,
        body.trim(),
        cleanSub || undefined,
      );
      setTitle('');
      setCategory(fallbackCategory);
      setSubfolder('');
      setBody('');
      onClose();
    } catch (err) {
      setError((err as Error).message || 'Could not create note.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
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
              New Note
            </h2>
            <p className="text-xs text-[#888F9F]">
              {isPersisted
                ? 'Saved locally inside your workspace folder'
                : 'Temporary demo note (not saved to a folder)'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[#8E95A5] transition-colors duration-150 hover:bg-[#212531] hover:text-[#ECEBE6]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-5">
          {error && (
            <div className="rounded-lg border border-[#6A2C39] bg-[#211318] px-3 py-2 text-xs text-rose-200">
              {error}
            </div>
          )}

          <div>
            <label
              htmlFor="note-title-input"
              className="mb-1.5 block text-xs font-medium text-[#B8BDC9]"
            >
              Note Title (optional)
            </label>
            <input
              id="note-title-input"
              type="text"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Leave blank to auto-title from first line..."
              className="h-10 w-full rounded-lg border border-[#282D3B] bg-[#0E1015] px-3 text-sm text-[#ECEBE6] placeholder-[#656C7D] focus:border-[#E0A83E] focus:outline-none"
            />
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium text-[#B8BDC9]">
              Category
            </span>
            <div className="flex flex-wrap gap-1.5">
              {categoryConfigs.map((cat) => {
                const style = getCategoryStyle(cat.name, categoryConfigs);
                const selected = category === cat.name;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => {
                      setCategory(cat.name);
                      setSubfolder('');
                    }}
                    className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors duration-150 ${
                      selected
                        ? `${style.activeBg} ${style.activeBorder} ${style.text}`
                        : 'border-[#262B38] bg-[#101218] text-[#9CA1AE] hover:border-[#363C4D] hover:text-[#ECEBE6]'
                    }`}
                  >
                    <span className={`h-2 w-2 rounded-[2px] ${style.dot}`} />
                    <span>{cat.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label
              htmlFor="note-subfolder-input"
              className="mb-1.5 block text-xs font-medium text-[#B8BDC9]"
            >
              Subfolder in {category} (optional)
            </label>
            {knownSubfolders.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setSubfolder('')}
                  className={`inline-flex h-8 items-center rounded-lg border px-2.5 text-xs font-medium transition-colors duration-150 ${
                    !subfolder
                      ? 'border-[#E0A83E] bg-[#232018] text-[#F3CA77]'
                      : 'border-[#262B38] bg-[#101218] text-[#8E95A5] hover:text-[#ECEBE6]'
                  }`}
                >
                  None
                </button>
                {knownSubfolders.map((sub) => (
                  <button
                    key={sub}
                    type="button"
                    onClick={() => setSubfolder(sub)}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors duration-150 ${
                      subfolder === sub
                        ? 'border-[#E0A83E] bg-[#232018] text-[#F3CA77]'
                        : 'border-[#262B38] bg-[#101218] text-[#9CA1AE] hover:border-[#363C4D] hover:text-[#ECEBE6]'
                    }`}
                  >
                    <Folder className="h-3 w-3" />
                    <span>{sub}</span>
                  </button>
                ))}
              </div>
            )}
            <input
              id="note-subfolder-input"
              type="text"
              value={subfolder}
              onChange={(e) => setSubfolder(e.target.value)}
              placeholder={`Optional subfolder inside ${category} (e.g. Lectures, Tasks)...`}
              className="h-9 w-full rounded-lg border border-[#282D3B] bg-[#0E1015] px-3 text-xs text-[#ECEBE6] placeholder-[#656C7D] focus:border-[#E0A83E] focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="note-body-input"
              className="mb-1.5 block text-xs font-medium text-[#B8BDC9]"
            >
              Starting Text (optional)
            </label>
            <textarea
              id="note-body-input"
              rows={3}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Start writing or leave blank to open the editor..."
              className="w-full rounded-lg border border-[#282D3B] bg-[#0E1015] p-3 text-sm leading-relaxed text-[#ECEBE6] placeholder-[#656C7D] focus:border-[#E0A83E] focus:outline-none"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 items-center rounded-lg border border-[#282D3B] px-4 text-xs font-medium text-[#B2B7C4] transition-colors duration-150 hover:bg-[#1E222D] hover:text-[#ECEBE6]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex h-9 items-center rounded-lg bg-[#E0A83E] px-4 text-xs font-semibold text-[#111216] transition-colors duration-150 hover:bg-[#ECB955] disabled:opacity-40"
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
          `${adapter.label} key saved & locked with your passphrase.`,
        );
      } else {
        await saveProviderKeySessionOnly({
          provider,
          apiKey: trimmedKey,
          model,
        });
        setSaveMessage(
          `${adapter.label} key kept for this tab only (clears when closed).`,
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
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
                Cloud AI Keys
              </h2>
              <p className="text-[11px] text-[#888F9F]">
                Connects directly from your browser · asks before sending anything
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[#8E95A5] transition-colors duration-150 hover:bg-[#212531] hover:text-[#ECEBE6]"
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
                  ? 'Locked'
                  : 'Not set';
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSwitchProvider(item.id)}
                  className={`rounded-lg border px-3 py-2.5 text-left transition-colors duration-150 ${
                    isSelected
                      ? 'border-[#E0A83E] bg-[#232018] text-[#F5F1E8]'
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
          <div className="space-y-2 rounded-lg bg-[#0E1015] p-3.5">
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
              <strong className="text-[#C8CCD6]">Browser compatibility:</strong>{' '}
              {adapter.browserCorsNote}
            </p>
          </div>

          {/* Honest OS Keychain Comparison */}
          <div className="flex items-start gap-2.5 rounded-lg border-l-2 border-[#E0A83E] bg-[#191610] p-3 text-[11px] text-amber-100">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#E0A83E]" />
            <div>
              <p className="font-semibold text-amber-200">
                Weaker than an OS keychain
              </p>
              <p className="mt-0.5 text-amber-100">
                {OS_KEYCHAIN_HONEST_WARNING} Your key is never logged, shown
                again, or saved in your notes.
              </p>
            </div>
          </div>

          {/* Existing Encrypted / Unlocked Key Controls */}
          {currentStatus &&
            (currentStatus.hasEncryptedKey || currentStatus.hasSessionKey) && (
              <div className="space-y-2.5 rounded-lg bg-[#0E1015] p-3.5">
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
                          ? 'Active for this session only'
                          : 'Unlocked for this session'
                        : 'Saved & locked on this device'}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {currentStatus.hasSessionKey &&
                      currentStatus.hasEncryptedKey && (
                        <button
                          type="button"
                          onClick={handleLock}
                          className="inline-flex h-8 items-center rounded-md border border-[#2C3140] bg-[#171A23] px-2.5 text-[11px] text-[#C8CCD6] hover:text-white"
                        >
                          Lock
                        </button>
                      )}
                    <button
                      type="button"
                      onClick={() => void handleForget()}
                      className="inline-flex h-8 items-center gap-1 rounded-md border border-[#6A2C39] bg-[#211318] px-2.5 text-[11px] text-rose-200 hover:bg-[#2E1A22]"
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
                      className="h-9 min-w-[180px] flex-1 rounded-lg border border-[#282D3B] bg-[#151820] px-3 text-xs text-[#ECEBE6] placeholder-[#656C7D] focus:border-[#E0A83E] focus:outline-none"
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
                    className="h-10 w-full rounded-lg border border-[#282D3B] bg-[#0E1015] pr-16 pl-3 font-mono text-xs text-[#ECEBE6] placeholder-[#656C7D] focus:border-[#E0A83E] focus:outline-none"
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
                  className="h-10 w-full rounded-lg border border-[#282D3B] bg-[#0E1015] px-2.5 text-xs text-[#ECEBE6] focus:border-[#E0A83E] focus:outline-none"
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
                    className={`h-10 rounded-lg border px-2 text-[11px] font-medium transition-colors duration-150 ${
                      storageMode === 'encrypted-indexeddb'
                        ? 'border-[#E0A83E] bg-[#232018] text-[#F5F1E8]'
                        : 'border-[#282D3B] bg-[#0E1015] text-[#9CA1AE]'
                    }`}
                  >
                    Lock with passphrase
                  </button>
                  <button
                    type="button"
                    onClick={() => setStorageMode('session-only')}
                    className={`h-10 rounded-lg border px-2 text-[11px] font-medium transition-colors duration-150 ${
                      storageMode === 'session-only'
                        ? 'border-[#E0A83E] bg-[#232018] text-[#F5F1E8]'
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
                  Passphrase (min 6 chars)
                </label>
                <input
                  id="byok-passphrase-input"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Create a passphrase to lock your key..."
                  className="h-10 w-full rounded-lg border border-[#282D3B] bg-[#0E1015] px-3 text-xs text-[#ECEBE6] placeholder-[#656C7D] focus:border-[#E0A83E] focus:outline-none"
                />
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-[#6A2C39] bg-[#211318] px-3 py-2 text-xs text-rose-200">
                {error}
              </div>
            )}

            {saveMessage && (
              <div className="flex items-start gap-2 rounded-lg border border-[#265442] bg-[#11201A] px-3 py-2 text-xs text-emerald-200">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                <span>{saveMessage}</span>
              </div>
            )}

            {testFeedback && (
              <div
                className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
                  testFeedback.ok
                    ? 'border-[#265442] bg-[#11201A] text-emerald-200'
                    : 'border-[#6A2C39] bg-[#211318] text-rose-200'
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
                className="inline-flex h-9 items-center rounded-lg border border-[#2C3140] bg-[#181B24] px-3.5 text-xs font-medium text-[#ECEBE6] transition-colors duration-150 hover:border-[#3E4559] disabled:opacity-50"
              >
                {testing ? 'Testing connection...' : 'Test connection'}
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="inline-flex h-9 items-center rounded-lg border border-[#282D3B] px-3.5 text-xs font-medium text-[#B2B7C4] hover:text-[#ECEBE6]"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex h-9 items-center rounded-lg bg-[#E0A83E] px-4 text-xs font-semibold text-[#111216] transition-colors duration-150 hover:bg-[#ECB955] disabled:opacity-40"
                >
                  {busy
                    ? 'Saving...'
                    : storageMode === 'encrypted-indexeddb'
                      ? 'Save & Lock Key'
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
  looksLikeCodeProject?: boolean;
  projectMarkerNames?: string[];
  looksLikeDirectManualSubfolder?: boolean;
  directManualNotesCount?: number;
  rootMarkdownOrTextCount?: number;
  onCancel: () => void;
  onChooseDifferent?: () => void;
  onConfirm: () => Promise<void> | void;
}

export function NonEmptyFolderModal({
  open,
  folderName,
  entryCount,
  looksLikeCodeProject = false,
  projectMarkerNames = [],
  looksLikeDirectManualSubfolder = false,
  directManualNotesCount = 0,
  rootMarkdownOrTextCount = 0,
  onCancel,
  onChooseDifferent,
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

  const titleText = looksLikeCodeProject
    ? 'Code or Dependency Folder Selected'
    : looksLikeDirectManualSubfolder
      ? `${folderName}/ Subfolder Selected`
      : 'Use This Folder?';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="non-empty-folder-title"
        className="w-full max-w-md rounded-xl border border-[#2A2F3E] bg-[#151820] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[#242834] px-5 py-4">
          <div className="flex items-center gap-2.5">
            {looksLikeCodeProject ? (
              <AlertTriangle className="h-4 w-4 text-amber-400" />
            ) : (
              <FolderCheck className="h-4 w-4 text-[#E0A83E]" />
            )}
            <h2
              id="non-empty-folder-title"
              className="font-serif text-lg font-semibold text-[#F4F0E7]"
            >
              {titleText}
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel folder setup"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[#8E95A5] transition-colors duration-150 hover:bg-[#212531] hover:text-[#ECEBE6]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5 text-xs leading-relaxed text-[#B8BDC9]">
          <p>
            <code className="rounded bg-[#0E1015] px-1.5 py-0.5 font-mono text-[#F4F0E7]">
              {folderName}
            </code>{' '}
            already has{' '}
            <span className="font-semibold text-[#ECEBE6] tabular-nums">
              {entryCount}
            </span>{' '}
            {entryCount === 1 ? 'item' : 'items'}.
          </p>

          {looksLikeDirectManualSubfolder && (
            <div className="rounded-lg border-l-2 border-[#E0A83E] bg-[#191610] p-3 text-amber-100">
              <p className="font-semibold text-amber-200">
                {directManualNotesCount > 0
                  ? `Found ${directManualNotesCount} Noodle ${directManualNotesCount === 1 ? 'note' : 'notes'} directly inside this folder`
                  : 'This looks like a manual/ notes subfolder'}
              </p>
              <p className="mt-1 text-amber-100">
                Usually you pick its parent folder (such as{' '}
                <code className="font-mono">Noodle Notes</code>) so{' '}
                <code className="font-mono">manual/</code>,{' '}
                <code className="font-mono">ai/</code>, and{' '}
                <code className="font-mono">sources/</code> stay side by side. Or
                open this folder directly to read and save your notes here.
              </p>
            </div>
          )}

          {!looksLikeDirectManualSubfolder && rootMarkdownOrTextCount > 0 && (
            <div className="rounded-lg border-l-2 border-[#4B648F] bg-[#131823] p-3 text-[#C9D6EC]">
              Found {rootMarkdownOrTextCount} Markdown or text{' '}
              {rootMarkdownOrTextCount === 1 ? 'file' : 'files'} here. Place
              reference readings inside <code className="font-mono">sources/</code>{' '}
              or import Markdown notes using <span className="font-semibold">Import .md</span>{' '}
              after connecting.
            </div>
          )}

          {looksLikeCodeProject && (
            <div className="rounded-lg border-l-2 border-[#E0A83E] bg-[#191610] p-3 text-amber-100">
              <p className="font-semibold text-amber-200">
                Looks like a software project folder
              </p>
              <p className="mt-1 text-amber-100">
                Found{' '}
                <code className="font-mono">
                  {projectMarkerNames.slice(0, 3).join(', ')}
                </code>
                . For a cleaner folder without dependency files, pick or create a
                dedicated notes folder (like{' '}
                <code className="font-mono">Noodle Notes</code>).
              </p>
            </div>
          )}

          {!looksLikeDirectManualSubfolder && (
            <p className="text-[#969DAB]">
              Noodle keeps your existing files untouched and only creates{' '}
              <code className="font-mono">manual/</code> when you save a note (
              <code className="font-mono">ai/</code> and{' '}
              <code className="font-mono">assets/</code> are added only if you use
              those features).
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex h-9 items-center rounded-lg border border-[#282D3B] px-4 text-xs font-medium text-[#B2B7C4] transition-colors duration-150 hover:bg-[#1E222D] hover:text-[#ECEBE6]"
            >
              Cancel
            </button>
            {(looksLikeCodeProject || looksLikeDirectManualSubfolder) &&
              onChooseDifferent && (
                <button
                  type="button"
                  onClick={onChooseDifferent}
                  className={
                    looksLikeCodeProject
                      ? 'inline-flex h-9 items-center rounded-lg bg-[#E0A83E] px-4 text-xs font-semibold text-[#111216] transition-colors duration-150 hover:bg-[#ECB955]'
                      : 'inline-flex h-9 items-center rounded-lg border border-[#323849] bg-[#1A1D27] px-4 text-xs font-medium text-[#ECEBE6] transition-colors duration-150 hover:bg-[#232734]'
                  }
                >
                  {looksLikeDirectManualSubfolder
                    ? 'Choose Parent Folder'
                    : 'Choose Different Folder'}
                </button>
              )}
            <button
              type="button"
              onClick={handleConfirm}
              disabled={initializing}
              className={
                looksLikeCodeProject
                  ? 'inline-flex h-9 items-center rounded-lg border border-[#323849] bg-[#1A1D27] px-4 text-xs font-medium text-[#ECEBE6] transition-colors duration-150 hover:bg-[#232734] disabled:opacity-40'
                  : 'inline-flex h-9 items-center rounded-lg bg-[#E0A83E] px-4 text-xs font-semibold text-[#111216] transition-colors duration-150 hover:bg-[#ECB955] disabled:opacity-40'
              }
            >
              {initializing
                ? 'Connecting...'
                : looksLikeCodeProject
                  ? 'Use Anyway'
                  : looksLikeDirectManualSubfolder
                    ? 'Open Notes Here'
                    : 'Continue'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface CategoryManagerModalProps {
  open: boolean;
  categoryConfigs: UserCategoryConfig[];
  onClose: () => void;
  onAddCategory: (name: string, color: CategoryColorKey) => Promise<string | null>;
  onRenameCategory: (categoryId: string, newName: string) => Promise<string | null>;
  onChangeCategoryColor: (categoryId: string, color: CategoryColorKey) => Promise<void>;
  onDeleteCategory: (categoryId: string) => Promise<string | null>;
  onAddSubfolder: (categoryId: string, subfolderName: string) => Promise<string | null>;
  onRenameSubfolder: (
    categoryId: string,
    oldName: string,
    newName: string,
  ) => Promise<string | null>;
  onDeleteSubfolder: (categoryId: string, subfolderName: string) => Promise<void>;
  onResetDefaults: () => Promise<void>;
}

export function CategoryManagerModal({
  open,
  categoryConfigs,
  onClose,
  onAddCategory,
  onRenameCategory,
  onChangeCategoryColor,
  onDeleteCategory,
  onAddSubfolder,
  onRenameSubfolder,
  onDeleteSubfolder,
  onResetDefaults,
}: CategoryManagerModalProps) {
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newCategoryColor, setNewCategoryColor] =
    useState<CategoryColorKey>('amber');
  const [editingCatId, setEditingCatId] = useState<string | null>(null);
  const [editingCatName, setEditingCatName] = useState('');
  const [newSubDrafts, setNewSubDrafts] = useState<Record<string, string>>({});
  const [editingSub, setEditingSub] = useState<{
    catId: string;
    oldName: string;
    value: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setError(null);
    setEditingCatId(null);
    setEditingSub(null);
  }, [open]);

  if (!open) {
    return null;
  }

  const handleCreateCategory = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const errMsg = await onAddCategory(newCategoryName, newCategoryColor);
      if (errMsg) {
        setError(errMsg);
      } else {
        setNewCategoryName('');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSaveCategoryRename = async (categoryId: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const errMsg = await onRenameCategory(categoryId, editingCatName);
      if (errMsg) {
        setError(errMsg);
      } else {
        setEditingCatId(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleCreateSubfolder = async (categoryId: string) => {
    const draft = newSubDrafts[categoryId] ?? '';
    if (!draft.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const errMsg = await onAddSubfolder(categoryId, draft);
      if (errMsg) {
        setError(errMsg);
      } else {
        setNewSubDrafts((prev) => ({...prev, [categoryId]: ''}));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSaveSubRename = async () => {
    if (!editingSub || busy) return;
    setBusy(true);
    setError(null);
    try {
      const errMsg = await onRenameSubfolder(
        editingSub.catId,
        editingSub.oldName,
        editingSub.value,
      );
      if (errMsg) {
        setError(errMsg);
      } else {
        setEditingSub(null);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="category-manager-title"
        className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[#2A2F3E] bg-[#151820] shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#242834] px-5 py-4">
          <div>
            <h2
              id="category-manager-title"
              className="font-serif text-lg font-semibold text-[#F4F0E7]"
            >
              Customize Categories &amp; Subfolders
            </h2>
            <p className="text-xs text-[#888F9F]">
              Name your top folders anything you like (Work, Study, Classes) and
              organize subfolders inside them.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close category manager"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[#8E95A5] transition-colors duration-150 hover:bg-[#212531] hover:text-[#ECEBE6]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-5 overflow-y-auto p-5 text-xs">
          {error && (
            <div className="rounded-lg border border-[#6A2C39] bg-[#211318] px-3 py-2 text-rose-200">
              {error}
            </div>
          )}

          {/* Add new top category */}
          <form
            onSubmit={(e) => void handleCreateCategory(e)}
            className="space-y-2.5 rounded-lg bg-[#0E1015] p-3.5"
          >
            <span className="block font-semibold text-[#ECEBE6]">
              Add Top-Level Category
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={newCategoryName}
                onChange={(e) => {
                  setNewCategoryName(e.target.value);
                  setError(null);
                }}
                placeholder="e.g. Personal, Biology, Startup..."
                className="h-9 min-w-[180px] flex-1 rounded-lg border border-[#282D3B] bg-[#151820] px-3 text-xs text-[#ECEBE6] placeholder-[#656C7D] focus:border-[#E0A83E] focus:outline-none"
              />
              <div className="flex h-9 items-center gap-1 rounded-lg border border-[#282D3B] bg-[#151820] px-2">
                {CATEGORY_COLOR_OPTIONS.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setNewCategoryColor(opt.key)}
                    title={opt.label}
                    aria-label={`Color ${opt.label}`}
                    className={`flex h-5 w-5 items-center justify-center rounded-full transition-transform duration-150 ${
                      newCategoryColor === opt.key
                        ? 'scale-110 ring-2 ring-[#ECEBE6]'
                        : 'opacity-70 hover:opacity-100'
                    }`}
                  >
                    <span className={`h-3 w-3 rounded-full ${opt.dot}`} />
                  </button>
                ))}
              </div>
              <button
                type="submit"
                disabled={busy || !newCategoryName.trim()}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#E0A83E] px-3.5 font-semibold text-[#111216] transition-colors duration-150 hover:bg-[#ECB955] disabled:opacity-40"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add Category</span>
              </button>
            </div>
          </form>

          {/* Existing categories + nested subfolders */}
          <div className="space-y-3">
            {categoryConfigs.map((cat) => {
              const style = getCategoryStyle(cat.name, categoryConfigs);
              const isEditingThis = editingCatId === cat.id;
              return (
                <div
                  key={cat.id}
                  className="space-y-3 rounded-lg bg-[#0E1015] p-3.5"
                >
                  {/* Top category header row */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`h-2.5 w-2.5 rounded-[2px] ${style.dot}`} />
                      {isEditingThis ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            autoFocus
                            value={editingCatName}
                            onChange={(e) => setEditingCatName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                void handleSaveCategoryRename(cat.id);
                              } else if (e.key === 'Escape') {
                                setEditingCatId(null);
                              }
                            }}
                            className="h-8 rounded-md border border-[#E0A83E] bg-[#151820] px-2.5 text-xs font-semibold text-[#ECEBE6] focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => void handleSaveCategoryRename(cat.id)}
                            disabled={busy}
                            className="inline-flex h-8 items-center gap-1 rounded-md bg-[#E0A83E] px-2.5 font-semibold text-[#111216] hover:bg-[#ECB955]"
                          >
                            <Check className="h-3.5 w-3.5" />
                            <span>Save</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingCatId(null)}
                            className="inline-flex h-8 items-center rounded-md border border-[#2C3140] px-2.5 text-[#9CA1AE] hover:text-white"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <span className="font-serif text-sm font-semibold text-[#F4F0E7]">
                          {cat.name}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5">
                      <div className="flex items-center gap-1 pr-1">
                        {CATEGORY_COLOR_OPTIONS.map((opt) => (
                          <button
                            key={opt.key}
                            type="button"
                            onClick={() => void onChangeCategoryColor(cat.id, opt.key)}
                            title={`Set ${cat.name} color to ${opt.label}`}
                            className={`flex h-4 w-4 items-center justify-center rounded-full ${
                              cat.color === opt.key
                                ? 'ring-1.5 ring-[#ECEBE6]'
                                : 'opacity-45 hover:opacity-100'
                            }`}
                          >
                            <span className={`h-2.5 w-2.5 rounded-full ${opt.dot}`} />
                          </button>
                        ))}
                      </div>

                      {!isEditingThis && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingCatId(cat.id);
                            setEditingCatName(cat.name);
                          }}
                          title={`Rename ${cat.name}`}
                          className="inline-flex h-7 items-center gap-1 rounded-md bg-[#161A24] px-2.5 text-[11px] text-[#B8BDC9] hover:bg-[#1E2331] hover:text-white"
                        >
                          <Pencil className="h-3 w-3" />
                          <span>Rename</span>
                        </button>
                      )}

                      {categoryConfigs.length > 1 && (
                        <button
                          type="button"
                          onClick={async () => {
                            setBusy(true);
                            setError(null);
                            try {
                              const errMsg = await onDeleteCategory(cat.id);
                              if (errMsg) setError(errMsg);
                            } finally {
                              setBusy(false);
                            }
                          }}
                          disabled={busy}
                          title={`Delete ${cat.name} (notes move to ${categoryConfigs.find((c) => c.id !== cat.id)?.name || 'first category'})`}
                          className="inline-flex h-7 items-center gap-1 rounded-md bg-[#211318] px-2 text-[11px] text-rose-200 hover:bg-[#2E1A22] disabled:opacity-40"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Subfolders section */}
                  <div className="space-y-2 pt-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {cat.subfolders.length === 0 ? (
                        <span className="text-[11px] text-[#6D7486]">
                          No subfolders yet
                        </span>
                      ) : (
                        cat.subfolders.map((sub) => {
                          const isEditingThisSub =
                            editingSub?.catId === cat.id &&
                            editingSub?.oldName === sub;
                          return isEditingThisSub ? (
                            <div
                              key={sub}
                              className="inline-flex h-7 items-center gap-1 rounded-md border border-[#E0A83E] bg-[#151820] px-2"
                            >
                              <input
                                type="text"
                                autoFocus
                                value={editingSub.value}
                                onChange={(e) =>
                                  setEditingSub({
                                    ...editingSub,
                                    value: e.target.value,
                                  })
                                }
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    void handleSaveSubRename();
                                  } else if (e.key === 'Escape') {
                                    setEditingSub(null);
                                  }
                                }}
                                className="w-28 bg-transparent text-[11px] text-[#ECEBE6] focus:outline-none"
                              />
                              <button
                                type="button"
                                onClick={() => void handleSaveSubRename()}
                                className="text-emerald-300 hover:text-emerald-200"
                                title="Save subfolder name"
                              >
                                <Check className="h-3 w-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingSub(null)}
                                className="text-[#8E95A5] hover:text-white"
                                title="Cancel"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                          ) : (
                            <div
                              key={sub}
                              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[#171B26] px-2.5 text-[11px] text-[#D5D4CD]"
                            >
                              <Folder className="h-3 w-3 text-[#E0A83E]" />
                              <span>{sub}</span>
                              <button
                                type="button"
                                onClick={() =>
                                  setEditingSub({
                                    catId: cat.id,
                                    oldName: sub,
                                    value: sub,
                                  })
                                }
                                title={`Rename subfolder ${sub}`}
                                className="ml-0.5 text-[#7D8496] hover:text-[#ECEBE6]"
                              >
                                <Pencil className="h-2.5 w-2.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => void onDeleteSubfolder(cat.id, sub)}
                                title={`Remove subfolder ${sub}`}
                                className="text-[#7D8496] hover:text-rose-300"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>

                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={newSubDrafts[cat.id] ?? ''}
                        onChange={(e) =>
                          setNewSubDrafts((prev) => ({
                            ...prev,
                            [cat.id]: e.target.value,
                          }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void handleCreateSubfolder(cat.id);
                          }
                        }}
                        placeholder={`Add subfolder under ${cat.name}...`}
                        className="h-8 flex-1 rounded-lg border border-[#262B38] bg-[#151820] px-2.5 text-[11px] text-[#ECEBE6] placeholder-[#656C7D] focus:border-[#E0A83E] focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => void handleCreateSubfolder(cat.id)}
                        disabled={busy || !(newSubDrafts[cat.id] ?? '').trim()}
                        className="inline-flex h-8 items-center gap-1 rounded-lg border border-[#2C3140] bg-[#171A23] px-2.5 text-[11px] font-medium text-[#ECEBE6] transition-colors duration-150 hover:border-[#E0A83E] hover:text-[#F3CA77] disabled:opacity-40"
                      >
                        <FolderPlus className="h-3.5 w-3.5" />
                        <span>Add Subfolder</span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[#242834] px-5 py-3.5 text-xs">
          <button
            type="button"
            onClick={() => void onResetDefaults()}
            disabled={busy}
            className="inline-flex h-9 items-center gap-1.5 text-[#8E95A5] hover:text-[#ECEBE6] disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Reset defaults</span>
          </button>

          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-lg bg-[#E0A83E] px-4 font-semibold text-[#111216] transition-colors duration-150 hover:bg-[#ECB955]"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

