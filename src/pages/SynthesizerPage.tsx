import {DragEvent, FormEvent, Fragment, useEffect, useMemo, useState} from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  GripVertical,
  KeyRound,
  Lock,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  getAllProviderStatuses,
  getUnlockedSessionKey,
  resolvePreferredProvider,
  selectActiveProviderAndModel,
  subscribeKeyVaultChanges,
} from '../cloud/keyVault';
import {
  CLOUD_PROVIDER_LIST,
  getProviderAdapter,
} from '../cloud/providerAdapter';
import {
  getSynthesisFormatLabel,
  MAX_CLOUD_EXCERPT_CHARS,
  SYNTHESIS_FORMATS,
} from '../cloud/synthesisOutput';
import {
  cancelCloudSynthesisPreview,
  executeApprovedCloudSynthesis,
  prepareCloudSynthesisPreview,
  retrieveExcerptsFromVaultBin,
  validateAndPersistAiSynthesisResult,
  VaultBinItem,
} from '../cloud/synthesisService';
import {
  getEffectiveAllowedDomains,
  loadTrustSettings,
} from '../cloud/trustSettings';
import {FlashcardDeckView, PracticeExamView, PreservedFromNotesMarker} from '../components/AiInteractiveViews';
import {CloudPrivacyNoticeModal} from '../components/CloudPrivacyNoticeModal';
import {isAllowedLinkUrl} from '../editor/noteSchema';
import {
  AiNoteMetadata,
  BacklinkRecord,
  Category,
  CloudProviderId,
  CloudRetrievedExcerpt,
  CloudSynthesisRequestPreview,
  CloudSynthesisResponse,
  Pillar,
  PillarFilter,
  ProviderKeyStatus,
  RoutePath,
  ScoreLabel,
  SourceDocumentEntry,
  StoredNoteEntry,
  SynthesisOutputFormat,
  TipTapDoc,
} from '../types/noodle';

interface SynthesizerPageProps {
  notes: StoredNoteEntry[];
  sourceDocuments: SourceDocumentEntry[];
  aiEnabled: boolean;
  onOpenKeySetup: () => void;
  onNavigateToBlock: (
    noteId: string,
    blockId: string,
    kind: 'note' | 'source',
  ) => void;
  onSaveAiNote: (payload: {
    targetPillar: Pillar;
    title: string;
    category: Category;
    content: TipTapDoc;
    aiMeta: AiNoteMetadata;
  }) => Promise<StoredNoteEntry>;
  onNavigate: (route: RoutePath) => void;
}

const PILLAR_LABEL: Record<Pillar, string> = {
  sources: 'Sources',
  manual: 'My Notes',
  ai: 'AI Notes',
};

const DRAG_MIME = 'application/x-noodle-vault-item';

function renderTextWithClickableCitations(
  text: string,
  excerpts: CloudRetrievedExcerpt[],
  onNavigateToBlock: (
    noteId: string,
    blockId: string,
    kind: 'note' | 'source',
  ) => void,
) {
  const byNumber = new Map<number, CloudRetrievedExcerpt>(
    excerpts.map((e) => [e.citationNumber, e]),
  );
  const parts = text.split(/(\[\d+\])/g);

  return parts.map((part, idx) => {
    const match = /^\[(\d+)\]$/.exec(part);
    if (!match) {
      return <Fragment key={idx}>{part}</Fragment>;
    }
    const num = Number(match[1]);
    const target = byNumber.get(num);
    if (!target) {
      return <Fragment key={idx}>{part}</Fragment>;
    }
    return (
      <button
        key={idx}
        type="button"
        title={`Open block in "${target.sourceTitle}"`}
        onClick={() =>
          onNavigateToBlock(target.noteId, target.blockId, target.kind)
        }
        className="mx-0.5 inline-flex items-center rounded bg-[#232018] px-1.5 py-0.5 text-[11px] font-semibold text-[#F4D084] tabular-nums transition-colors hover:bg-[#322B1E]"
      >
        [{num}]
      </button>
    );
  });
}

export function SynthesizerPage({
  notes,
  sourceDocuments,
  aiEnabled,
  onOpenKeySetup,
  onNavigateToBlock,
  onSaveAiNote,
  onNavigate,
}: SynthesizerPageProps) {
  const [vaultQuery, setVaultQuery] = useState('');
  const [vaultPillarFilter, setVaultPillarFilter] =
    useState<PillarFilter>('all');
  const [binItems, setBinItems] = useState<VaultBinItem[]>([]);
  const [dragOverBin, setDragOverBin] = useState(false);

  const [question, setQuestion] = useState('');
  const [outputFormat, setOutputFormat] =
    useState<SynthesisOutputFormat>('study-guide');
  const [provider, setProvider] = useState<CloudProviderId>('gemini');
  const [model, setModel] = useState('gemini-2.5-flash');
  const [statuses, setStatuses] = useState<Record<
    CloudProviderId,
    ProviderKeyStatus
  > | null>(null);

  const [retrieving, setRetrieving] = useState(false);
  const [retrievalLabel, setRetrievalLabel] = useState<ScoreLabel>('word match');
  const [retrievedExcerpts, setRetrievedExcerpts] = useState<
    CloudRetrievedExcerpt[]
  >([]);

  const [pendingPreview, setPendingPreview] =
    useState<CloudSynthesisRequestPreview | null>(null);
  const [sending, setSending] = useState(false);
  const [response, setResponse] = useState<CloudSynthesisResponse | null>(null);
  const [savedAiEntry, setSavedAiEntry] = useState<StoredNoteEntry | null>(
    null,
  );
  const [savedBacklinks, setSavedBacklinks] = useState<BacklinkRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const sync = async () => {
      const [pref, all] = await Promise.all([
        resolvePreferredProvider(),
        getAllProviderStatuses(),
      ]);
      if (!active) {
        return;
      }
      setProvider(pref.provider);
      setModel(pref.model);
      setStatuses(all);
    };
    void sync();
    const unsub = subscribeKeyVaultChanges(() => {
      void sync();
    });
    return () => {
      active = false;
      unsub();
    };
  }, []);

  const vaultCatalog: Array<
    VaultBinItem & {subtitle: string; wordOrChunkLabel: string; disabled?: boolean}
  > = useMemo(() => {
    const noteItems = notes.map((entry) => ({
      id: entry.note.id,
      kind: 'note' as const,
      pillar: entry.pillar,
      title: entry.note.title,
      path: entry.path ?? `${entry.pillar}/${entry.fileName}`,
      subtitle: entry.note.category,
      wordOrChunkLabel: `${entry.wordCount} words`,
    }));

    const sourceItems = sourceDocuments.map((doc) => ({
      id: doc.id,
      kind: 'source' as const,
      pillar: 'sources' as const,
      title: doc.title,
      path: doc.path,
      subtitle:
        doc.kind === 'pdf'
          ? 'PDF'
          : doc.kind === 'md'
            ? 'Markdown'
            : doc.kind === 'txt'
              ? 'Text'
              : 'PPTX',
      wordOrChunkLabel:
        doc.kind === 'unsupported-pptx'
          ? 'Unsupported'
          : `${doc.chunks.length} blocks`,
      disabled: doc.kind === 'unsupported-pptx' || doc.chunks.length === 0,
    }));

    return [...noteItems, ...sourceItems];
  }, [notes, sourceDocuments]);

  const filteredVault = useMemo(() => {
    const q = vaultQuery.trim().toLowerCase();
    return vaultCatalog.filter((item) => {
      if (vaultPillarFilter !== 'all' && item.pillar !== vaultPillarFilter) {
        return false;
      }
      if (!q) {
        return true;
      }
      return (
        item.title.toLowerCase().includes(q) ||
        item.path.toLowerCase().includes(q) ||
        item.subtitle.toLowerCase().includes(q)
      );
    });
  }, [vaultCatalog, vaultPillarFilter, vaultQuery]);

  const binIdSet = useMemo(
    () => new Set(binItems.map((b) => b.id)),
    [binItems],
  );

  const addItemToBin = (item: VaultBinItem) => {
    setError(null);
    setBinItems((prev) => {
      if (prev.some((existing) => existing.id === item.id)) {
        return prev;
      }
      return [...prev, item];
    });
  };

  const removeItemFromBin = (id: string) => {
    setBinItems((prev) => prev.filter((item) => item.id !== id));
  };

  const handleDragStartVaultItem = (
    e: DragEvent<HTMLDivElement>,
    item: VaultBinItem,
  ) => {
    const serialized = JSON.stringify(item);
    e.dataTransfer.setData(DRAG_MIME, serialized);
    e.dataTransfer.setData('text/plain', serialized);
    e.dataTransfer.effectAllowed = 'copy';
  };

  const handleDropOnBin = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOverBin(false);
    const raw =
      e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData('text/plain');
    if (!raw) {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as VaultBinItem;
      if (
        parsed &&
        typeof parsed.id === 'string' &&
        typeof parsed.title === 'string' &&
        (parsed.kind === 'note' || parsed.kind === 'source')
      ) {
        addItemToBin(parsed);
      }
    } catch {
      // Ignore unrecognized external drop text
    }
  };

  const currentStatus = statuses?.[provider];
  const hasUnlockedKey = Boolean(getUnlockedSessionKey(provider));
  const adapter = getProviderAdapter(provider);

  const openNoticeForExcerpts = async (
    promptText: string,
    excerpts: CloudRetrievedExcerpt[],
  ) => {
    if (!getUnlockedSessionKey(provider)) {
      setError(
        currentStatus?.hasEncryptedKey
          ? `Your ${adapter.label} key is locked. Open AI Key settings to unlock it with your passphrase.`
          : `No active API key for ${adapter.label}. Open AI Key settings to add one (Gemini offers a free tier).`,
      );
      return;
    }

    const trustState = await loadTrustSettings();
    const allowedDomains = getEffectiveAllowedDomains(trustState.userAllowedDomains);

    const preview = prepareCloudSynthesisPreview({
      provider,
      model,
      question: promptText,
      outputFormat,
      excerpts,
      maxExcerptChars: MAX_CLOUD_EXCERPT_CHARS,
      webGroundingEnabled: trustState.webGroundingEnabled,
      allowedDomains,
    });
    setPendingPreview(preview);
  };

  const handlePrepareSynthesis = async (e: FormEvent) => {
    e.preventDefault();
    if (binItems.length === 0) {
      setError(
        'Add at least one note or source from My Vault into The Synthesis Bin first.',
      );
      return;
    }

    const effectivePrompt =
      question.trim() ||
      `Create a ${getSynthesisFormatLabel(outputFormat)} synthesizing ${binItems
        .map((i) => i.title)
        .slice(0, 3)
        .join(', ')}`;

    setError(null);
    setResponse(null);
    setSavedAiEntry(null);
    setSavedBacklinks([]);
    setRetrieving(true);

    try {
      const retrieved = await retrieveExcerptsFromVaultBin({
        selectedItems: binItems,
        question: effectivePrompt,
        notes,
        sources: sourceDocuments,
        aiEnabled,
        maxExcerpts: 8,
      });
      setRetrievalLabel(retrieved.scoreLabel);
      setRetrievedExcerpts(retrieved.excerpts);

      if (retrieved.excerpts.length === 0) {
        setError(
          'No extractable text blocks were found inside The Synthesis Bin items. Nothing was sent to any cloud provider.',
        );
        return;
      }

      await openNoticeForExcerpts(effectivePrompt, retrieved.excerpts);
    } catch (err) {
      setError((err as Error).message || 'Local excerpt extraction failed.');
    } finally {
      setRetrieving(false);
    }
  };

  const handleConfirmSend = async () => {
    if (!pendingPreview || sending) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      const out = await executeApprovedCloudSynthesis({
        preview: pendingPreview,
        userApprovedNotice: true,
      });

      // Validate provider output and persist TipTap JSON strictly into ai/ with read-only backlinks
      const persisted = await validateAndPersistAiSynthesisResult({
        response: out,
        excerpts: pendingPreview.excerpts,
        notes,
        sources: sourceDocuments,
        targetPillar: 'ai',
        persistAiNote: onSaveAiNote,
      });

      setResponse({
        ...out,
        structuredOutput: persisted.verifiedOutput,
      });
      setSavedAiEntry(persisted.savedEntry);
      setSavedBacklinks(persisted.createdBacklinks);
      setPendingPreview(null);
    } catch (err) {
      setError(
        (err as Error).message ||
          'Could not generate study material or the response was invalid.',
      );
      setPendingPreview(null);
    } finally {
      setSending(false);
    }
  };

  const handleCancelNotice = () => {
    if (pendingPreview) {
      cancelCloudSynthesisPreview(pendingPreview.requestId);
    }
    setPendingPreview(null);
  };

  const structured = response?.structuredOutput;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 lg:px-8">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 pb-1">
        <div className="space-y-1">
          <h1 className="font-serif text-2xl font-semibold text-[#F5F1E8] sm:text-3xl">
            Synthesizer
          </h1>
          <p className="max-w-prose text-xs text-[#9198A8] sm:text-sm">
            Pick notes from My Vault, preview what gets sent, and save study
            guides, flashcards, or exams to AI Notes.
          </p>
        </div>

        <button
          type="button"
          onClick={() => onNavigate('/workspace')}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#282D3B] bg-[#141720] px-3.5 text-xs font-medium text-[#C8CCD6] transition-colors hover:border-[#383F52] hover:text-[#ECEBE6]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Back to Workspace</span>
        </button>
      </div>

      {/* Provider & Key Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#232734] bg-[#13161E] px-4 py-3 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="synth-provider-select" className="text-[#8E95A5]">
            Provider
          </label>
          <select
            id="synth-provider-select"
            value={provider}
            onChange={(e) => {
              const nextP = e.target.value as CloudProviderId;
              const nextM =
                statuses?.[nextP]?.model || getProviderAdapter(nextP).defaultModel;
              setProvider(nextP);
              setModel(nextM);
              setError(null);
              void selectActiveProviderAndModel(nextP, nextM);
            }}
            className="h-8 rounded-md border border-[#282D3B] bg-[#0E1015] px-2.5 text-xs text-[#ECEBE6] focus:border-[#E0A83E]/60 focus:outline-none"
          >
            {CLOUD_PROVIDER_LIST.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>

          <span className="text-xs text-[#7D8496]">
            {model}
          </span>

              <span
                className={`text-[11px] font-medium ${
                  hasUnlockedKey
                    ? 'text-emerald-400'
                    : currentStatus?.hasEncryptedKey
                      ? 'text-[#E0A83E]'
                      : 'text-[#888F9F]'
                }`}
              >
                ·{' '}
                {hasUnlockedKey
                  ? 'Key ready'
                  : currentStatus?.hasEncryptedKey
                    ? 'Key locked'
                    : 'No key yet'}
              </span>
            </div>

            <button
              type="button"
              onClick={onOpenKeySetup}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#2C3140] bg-[#171A23] px-3 text-xs font-medium text-[#ECEBE6] transition-colors hover:border-[#E0A83E]/50"
            >
              <KeyRound className="h-3.5 w-3.5 text-[#E0A83E]" />
              <span>
                {hasUnlockedKey
                  ? 'Manage Key'
                  : currentStatus?.hasEncryptedKey
                    ? 'Unlock Key'
                    : 'Add AI Key'}
              </span>
            </button>
          </div>

          {/* Two-Pane Synthesizer Workspace: Left = My Vault, Right = The Synthesis Bin */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-stretch">
            {/* LEFT PANE: My Vault */}
            <section
              aria-label="My Vault"
              className="flex flex-col rounded-xl border border-[#232734] bg-[#13161E] p-4 lg:col-span-5"
            >
              <div className="space-y-3 pb-2">
                <div className="flex items-baseline justify-between gap-2">
                  <h2 className="font-serif text-lg font-semibold text-[#F5F1E8]">
                    My Vault
                  </h2>
                  <span className="text-[11px] text-[#7D8496] tabular-nums">
                    {filteredVault.length} items · drag or click to add
                  </span>
                </div>

                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-[#6E7587]" />
                  <input
                    type="search"
                    value={vaultQuery}
                    onChange={(e) => setVaultQuery(e.target.value)}
                    placeholder="Search notes & files..."
                    aria-label="Search My Vault"
                    className="h-9 w-full rounded-lg border border-[#282D3B] bg-[#0D0F14] pr-3 pl-9 text-xs text-[#ECEBE6] placeholder-[#686F80] focus:border-[#E0A83E]/60 focus:outline-none"
                  />
                </div>

                <div
                  role="tablist"
                  aria-label="Filter My Vault by folder"
                  className="flex flex-wrap items-center gap-1 rounded-lg bg-[#0E1015] p-1 text-[11px]"
                >
                  {(
                    [
                      {id: 'all', label: 'All'},
                      {id: 'sources', label: 'Sources'},
                      {id: 'manual', label: 'My Notes'},
                      {id: 'ai', label: 'AI Notes'},
                    ] as Array<{id: PillarFilter; label: string}>
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={vaultPillarFilter === tab.id}
                      onClick={() => setVaultPillarFilter(tab.id)}
                      className={`flex-1 rounded-md px-2.5 py-1.5 font-medium whitespace-nowrap transition-colors ${
                        vaultPillarFilter === tab.id
                          ? 'bg-[#222736] text-[#F6DFA8]'
                          : 'text-[#8E95A5] hover:text-[#ECEBE6]'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
          </div>

          <div className="mt-3 max-h-[430px] flex-1 space-y-1.5 overflow-y-auto pr-1">
            {filteredVault.length === 0 ? (
              <p className="py-10 text-center text-xs text-[#7D8496]">
                No notes or sources match &ldquo;{vaultQuery}&rdquo;.
              </p>
            ) : (
              filteredVault.map((item) => {
                const inBin = binIdSet.has(item.id);
                return (
                  <div
                    key={`${item.kind}-${item.id}`}
                    draggable={!item.disabled}
                    onDragStart={(e) => {
                      if (!item.disabled) {
                        handleDragStartVaultItem(e, {
                          id: item.id,
                          kind: item.kind,
                          pillar: item.pillar,
                          title: item.title,
                          path: item.path,
                        });
                      }
                    }}
                    className={`flex items-center justify-between gap-2.5 rounded-lg px-3 py-2.5 text-xs transition-colors ${
                      item.disabled
                        ? 'bg-[#0F1117] opacity-50'
                        : inBin
                          ? 'border-l-2 border-[#E0A83E] bg-[#1B1914]'
                          : 'bg-[#0F1117] hover:bg-[#171A23]'
                    }`}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <span
                        title={
                          item.disabled
                            ? 'Unsupported file format'
                            : 'Drag into The Synthesis Bin'
                        }
                        className="shrink-0 cursor-grab text-[#6E7587] active:cursor-grabbing"
                      >
                        <GripVertical className="h-4 w-4" />
                      </span>

                      <button
                        type="button"
                        disabled={item.disabled}
                        onClick={() =>
                          addItemToBin({
                            id: item.id,
                            kind: item.kind,
                            pillar: item.pillar,
                            title: item.title,
                            path: item.path,
                          })
                        }
                        className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]/60"
                      >
                        <p className="truncate font-medium text-[#EFECE3]">
                          {item.title}
                        </p>
                        <p className="truncate text-[11px] text-[#7E8596]">
                          {PILLAR_LABEL[item.pillar]} · {item.subtitle} ·{' '}
                          {item.wordOrChunkLabel}
                        </p>
                      </button>
                    </div>

                    <button
                      type="button"
                      disabled={item.disabled || inBin}
                      onClick={() =>
                        addItemToBin({
                          id: item.id,
                          kind: item.kind,
                          pillar: item.pillar,
                          title: item.title,
                          path: item.path,
                        })
                      }
                      aria-label={
                        inBin ? `${item.title} added` : `Add ${item.title} to bin`
                      }
                      className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium transition-colors ${
                        inBin
                          ? 'bg-[#121D19] text-emerald-300'
                          : 'bg-[#181C27] text-[#C8CCD6] hover:bg-[#212636] hover:text-[#F6DFA8]'
                      } disabled:cursor-default`}
                    >
                      {inBin ? (
                        <>
                          <Check className="h-3 w-3" />
                          <span>Added</span>
                        </>
                      ) : (
                        <>
                          <Plus className="h-3 w-3" />
                          <span>Add</span>
                        </>
                      )}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* RIGHT PANE: The Synthesis Bin */}
        <section
          aria-label="The Synthesis Bin"
          className="flex flex-col justify-between space-y-4 rounded-xl border border-[#232734] bg-[#13161E] p-5 lg:col-span-7"
        >
          <form onSubmit={handlePrepareSynthesis} className="space-y-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="space-y-0.5">
                <h2 className="font-serif text-lg font-semibold text-[#F5F1E8]">
                  The Synthesis Bin
                </h2>
                <p className="text-[11px] text-[#8E95A5]">
                  Drop or click items to add them. Only short snippets leave your device after you approve.
                </p>
              </div>
              {binItems.length > 0 && (
                <button
                  type="button"
                  onClick={() => setBinItems([])}
                  className="inline-flex items-center gap-1 text-[11px] text-[#8E95A5] hover:text-rose-300"
                >
                  <Trash2 className="h-3 w-3" />
                  <span>Clear bin</span>
                </button>
              )}
            </div>

            {/* Dashed Drop Zone with Removable Chips */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                if (!dragOverBin) {
                  setDragOverBin(true);
                }
              }}
              onDragLeave={() => setDragOverBin(false)}
              onDrop={handleDropOnBin}
              className={`min-h-[124px] rounded-xl border border-dashed p-4 transition-colors ${
                dragOverBin
                  ? 'border-[#E0A83E] bg-[#1C1A15]'
                  : 'border-[#2E3446] bg-[#0E1015]'
              }`}
            >
              {binItems.length === 0 ? (
                <div className="flex min-h-[88px] flex-col items-center justify-center text-center text-xs text-[#7D8496]">
                  <p className="font-medium text-[#B8BDC9]">
                    Drop vault items here
                  </p>
                  <p className="mt-1 text-[11px]">
                    Or click any item in My Vault to stage it for synthesis.
                  </p>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {binItems.map((item) => (
                    <span
                      key={`chip-${item.id}`}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-[#161923] px-2.5 py-1.5 text-xs text-[#EFECE3]"
                    >
                      <span className="text-[11px] font-medium text-[#E0A83E]">
                        {PILLAR_LABEL[item.pillar]}
                      </span>
                      <span className="max-w-[180px] truncate font-medium">
                        {item.title}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeItemFromBin(item.id)}
                        aria-label={`Remove ${item.title} from bin`}
                        className="rounded p-0.5 text-[#8E95A5] hover:bg-[#232838] hover:text-rose-300"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Output Format Selector */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-[#C8CCD6]">Output format</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {SYNTHESIS_FORMATS.map((fmt) => {
                  const selected = outputFormat === fmt.id;
                  return (
                    <button
                      key={fmt.id}
                      type="button"
                      onClick={() => setOutputFormat(fmt.id)}
                      className={`h-9 rounded-lg border px-3 text-left text-xs transition-colors ${
                        selected
                          ? 'border-[#E0A83E] bg-[#1D2230] font-semibold text-[#F6DFA8]'
                          : 'border-[#252A38] bg-[#0E1015] text-[#B4B9C6] hover:border-[#3A4154] hover:text-[#ECEBE6]'
                      }`}
                    >
                      {fmt.shortLabel}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-[#888F9F]">
                {
                  SYNTHESIS_FORMATS.find((f) => f.id === outputFormat)
                    ?.description
                }
              </p>
            </div>

            {/* Synthesis Prompt Input */}
            <div className="space-y-1.5">
              <label
                htmlFor="synth-question-input"
                className="block text-xs font-medium text-[#C8CCD6]"
              >
                What should this focus on? (keeps your own examples &amp; wording)
              </label>
              <textarea
                id="synth-question-input"
                rows={2}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="e.g., Focus on chain rule vs product rule traps and keep my staircase analogy"
                className="w-full rounded-lg border border-[#282D3B] bg-[#0D0F14] px-3 py-2 text-xs text-[#ECEBE6] placeholder-[#686F80] focus:border-[#E0A83E]/60 focus:outline-none"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <p className="flex items-center gap-1.5 text-[11px] text-[#7D8496]">
                <Lock className="h-3 w-3 text-[#E0A83E]" />
                <span>
                  Plain-text snippets max {MAX_CLOUD_EXCERPT_CHARS} chars · saves to AI Notes
                </span>
              </p>

              <button
                type="submit"
                disabled={retrieving || sending || binItems.length === 0}
                className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-[#E0A83E] px-4 text-xs font-semibold text-[#111216] transition-colors hover:bg-[#ECB955] disabled:opacity-45"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>
                  {retrieving
                    ? 'Finding snippets...'
                    : 'Create & Preview'}
                </span>
              </button>
            </div>
          </form>
        </section>
      </div>

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#5A2934] bg-[#1C1216] px-4 py-3 text-xs text-rose-200"
        >
          <span>{error}</span>
          {!hasUnlockedKey && (
            <button
              type="button"
              onClick={onOpenKeySetup}
              className="h-8 shrink-0 rounded-md border border-[#5A2934] bg-[#151820] px-3 font-medium text-rose-100 hover:bg-[#1E222E]"
            >
              Open API Key Setup
            </button>
          )}
        </div>
      )}

      {/* Saved Output & Interactive Views */}
      {response && structured && (
        <section
          aria-label="Synthesized Output"
          className="space-y-5 rounded-xl border border-[#343054] bg-[#141622] p-5"
        >
          <div className="flex flex-wrap items-start justify-between gap-3 pb-1">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Sparkles className="h-4 w-4 text-violet-300" />
                <span className="font-semibold text-violet-200">
                  {getSynthesisFormatLabel(structured.format)}
                </span>
                <span aria-hidden="true" className="text-[#6E7587]">
                  ·
                </span>
                <span className="text-xs text-[#A8B0C2]">
                  {getProviderAdapter(response.provider).label} ({response.model})
                </span>
                {structured.preservedPhrases.length > 0 && (
                  <>
                    <span aria-hidden="true" className="text-[#6E7587]">
                      ·
                    </span>
                    <PreservedFromNotesMarker />
                  </>
                )}
              </div>

              <h2 className="font-serif text-xl font-semibold text-[#F5F1E8]">
                {structured.title}
              </h2>

              {savedAiEntry && (
                <p className="text-xs text-emerald-300 tabular-nums">
                  Saved in AI Notes with {savedBacklinks.length} source{' '}
                  {savedBacklinks.length === 1 ? 'link' : 'links'}.
                </p>
              )}
            </div>

            {savedAiEntry && (
              <button
                type="button"
                onClick={() => {
                  const firstBlock =
                    savedAiEntry.note.content.content?.[0]?.attrs?.id;
                  onNavigateToBlock(
                    savedAiEntry.note.id,
                    typeof firstBlock === 'string'
                      ? firstBlock
                      : savedAiEntry.note.id,
                    'note',
                  );
                }}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[#E0A83E] px-3.5 text-xs font-semibold text-[#111216] transition-colors hover:bg-[#ECB955]"
              >
                <span>Open Saved Note</span>
                <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {structured.summary && (
            <p className="max-w-prose text-sm leading-relaxed text-[#E4E1D7]">
              {renderTextWithClickableCitations(
                structured.summary,
                retrievedExcerpts,
                onNavigateToBlock,
              )}
            </p>
          )}

          {structured.preservedPhrases.length > 0 && (
            <div className="rounded-lg bg-[#11201A] px-3.5 py-2.5 text-xs">
              <div className="mb-1">
                <PreservedFromNotesMarker />
              </div>
              <p className="text-[#D4ECE0]">
                {structured.preservedPhrases.map((p) => `“${p}”`).join(' · ')}
              </p>
            </div>
          )}

          {/* Interactive Flashcard Deck */}
          {structured.flashcards && structured.flashcards.length > 0 && (
            <FlashcardDeckView
              flashcards={structured.flashcards}
              sources={
                savedAiEntry?.note.aiMeta?.sourcesUsed ??
                retrievedExcerpts.map((ex) => ({
                  citationNumber: ex.citationNumber,
                  noteId: ex.noteId,
                  blockId: ex.blockId,
                  kind: ex.kind,
                  pillar: ex.pillar,
                  title: ex.sourceTitle,
                  path: ex.sourcePath,
                  excerpt: ex.text,
                }))
              }
              onNavigateToBlock={onNavigateToBlock}
            />
          )}

          {/* Interactive Practice Exam */}
          {structured.examQuestions && structured.examQuestions.length > 0 && (
            <PracticeExamView
              questions={structured.examQuestions}
              sources={
                savedAiEntry?.note.aiMeta?.sourcesUsed ??
                retrievedExcerpts.map((ex) => ({
                  citationNumber: ex.citationNumber,
                  noteId: ex.noteId,
                  blockId: ex.blockId,
                  kind: ex.kind,
                  pillar: ex.pillar,
                  title: ex.sourceTitle,
                  path: ex.sourcePath,
                  excerpt: ex.text,
                }))
              }
              onNavigateToBlock={onNavigateToBlock}
            />
          )}

          {/* Web Grounding Citations */}
          {response.webCitations && response.webCitations.length > 0 && (
            <div className="space-y-3 rounded-xl bg-[#101924] p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-serif text-sm font-semibold text-sky-200 tabular-nums">
                  Web Grounding Citations ({response.webCitations.length})
                </h3>
                {response.droppedWebCitationsCount !== undefined &&
                  response.droppedWebCitationsCount > 0 && (
                    <span className="text-[11px] text-sky-300 tabular-nums">
                      ({response.droppedWebCitationsCount} non-whitelisted citations dropped)
                    </span>
                  )}
              </div>
              {response.webGroundingNotice && (
                <p className="text-xs text-sky-300">{response.webGroundingNotice}</p>
              )}
              <div className="space-y-2">
                {response.webCitations.map((wc) => (
                  <div
                    key={wc.id}
                    className="flex items-start justify-between gap-2 rounded-lg bg-[#0E1016] p-3 text-xs"
                  >
                    <div className="space-y-1">
                      {isAllowedLinkUrl(wc.url) ? (
                        <a
                          href={wc.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-medium text-sky-300 hover:underline"
                        >
                          <span>{wc.title || wc.domain}</span>
                          <ArrowUpRight className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="inline-flex items-center gap-1 font-medium text-sky-300">
                          {wc.title || wc.domain}
                        </span>
                      )}
                      <p className="text-[11px] text-[#7E8596]">
                        {wc.domain}
                      </p>
                      {wc.claim && <p className="text-[#D0D4E0]">{wc.claim}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Sections (Study Guide / Cheat-Sheet / Overview) */}
          {structured.sections.length > 0 && (
            <div className="space-y-3">
              {structured.sections.map((sec, idx) => (
                <div
                  key={`${sec.heading}-${idx}`}
                  className={`space-y-2 rounded-xl p-4 ${
                    sec.knowledgeGap
                      ? 'border-l-2 border-[#E0A83E] bg-[#191610]'
                      : 'bg-[#0F1117]'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-serif text-base font-semibold text-[#F4F0E7]">
                      {sec.heading}
                    </h3>
                    <div className="flex items-center gap-2">
                      {sec.knowledgeGap && (
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-200">
                          <span>No supporting notes found</span>
                          {sec.bestSimilarityScore !== undefined && (
                            <span className="text-[11px] text-amber-300 tabular-nums">
                              ({sec.bestSimilarityScore.toFixed(2)})
                            </span>
                          )}
                        </span>
                      )}
                      {sec.preservedFromNotes && <PreservedFromNotesMarker />}
                    </div>
                  </div>
                  <div className="max-w-prose text-[13.5px] leading-relaxed whitespace-pre-wrap text-[#D8D6CE]">
                    {renderTextWithClickableCitations(
                      sec.body,
                      retrievedExcerpts,
                      onNavigateToBlock,
                    )}
                    {sec.citations.length > 0 &&
                      !sec.citations.every((n) =>
                        sec.body.includes(`[${n}]`),
                      ) && (
                        <span className="ml-1 inline-flex items-center gap-1">
                          {sec.citations.map((n) =>
                            renderTextWithClickableCitations(
                              `[${n}]`,
                              retrievedExcerpts,
                              onNavigateToBlock,
                            ),
                          )}
                        </span>
                      )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Sanitized Locally Retrieved Excerpts Preview */}
      {retrievedExcerpts.length > 0 && (
        <section
          aria-label="Sanitized Retrieved Excerpts"
          className="space-y-3 rounded-xl border border-[#232734] bg-[#13161E] p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="space-y-0.5">
              <h2 className="font-serif text-base font-semibold text-[#F4F0E7]">
                Snippets Ready for Review
              </h2>
              <p className="text-[11px] text-[#888F9F] tabular-nums">
                {retrievedExcerpts.length} matching snippets ({retrievalLabel}),
                plain text only, max {MAX_CLOUD_EXCERPT_CHARS} chars each.
              </p>
            </div>

            <button
              type="button"
              onClick={() =>
                openNoticeForExcerpts(
                  question.trim() ||
                    `Create a ${getSynthesisFormatLabel(outputFormat)} synthesizing ${binItems
                      .map((i) => i.title)
                      .slice(0, 3)
                      .join(', ')}`,
                  retrievedExcerpts,
                )
              }
              disabled={sending}
              className="h-8 rounded-lg bg-[#232018] px-3 text-xs font-semibold text-[#F4D084] transition-colors hover:bg-[#322B1E] disabled:opacity-50"
            >
              Review &amp; Send
            </button>
          </div>

          <div className="space-y-1.5">
            {retrievedExcerpts.map((ex) => (
              <button
                key={ex.chunkId}
                type="button"
                onClick={() =>
                  onNavigateToBlock(ex.noteId, ex.blockId, ex.kind)
                }
                className="group flex w-full items-start justify-between gap-4 rounded-lg bg-[#0F1117] px-3.5 py-3 text-left text-xs transition-colors hover:bg-[#171A24]"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#8990A2]">
                    <span className="font-semibold text-[#E0A83E] tabular-nums">
                      [{ex.citationNumber}] {ex.score.toFixed(2)} {ex.scoreLabel}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{PILLAR_LABEL[ex.pillar]}</span>
                    <span aria-hidden="true">·</span>
                    <span className="text-[11px] text-[#767D8F] tabular-nums">
                      {ex.text.length}/{MAX_CLOUD_EXCERPT_CHARS} chars
                      {ex.hadMarkupStripped ? ' · sanitized' : ''}
                      {ex.wasTruncated ? ' · capped' : ''}
                    </span>
                  </div>
                  <p className="font-serif text-sm font-semibold text-[#F2EEE4] group-hover:text-[#F6DFA8]">
                    {ex.sourceTitle}
                  </p>
                  <p className="line-clamp-3 leading-relaxed text-[#9CA1AE]">
                    {ex.text}
                  </p>
                </div>
                <ArrowUpRight className="mt-1 h-3.5 w-3.5 shrink-0 text-[#7D8496] group-hover:text-[#E0A83E]" />
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Mandatory Privacy Notice Before EVERY Cloud Call */}
      <CloudPrivacyNoticeModal
        preview={pendingPreview}
        sending={sending}
        onCancel={handleCancelNotice}
        onConfirmSend={() => void handleConfirmSend()}
      />
    </div>
  );
}
