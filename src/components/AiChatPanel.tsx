import {useEffect, useMemo, useRef, useState} from 'react';
import {
  AlertCircle,
  Bookmark,
  Bot,
  Check,
  FolderDown,
  Lock,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  cancelChatPreview,
  ChatMessage,
  executeApprovedChatQuery,
  extractRelevantNoteExcerpts,
  formatChatAsAiNote,
  prepareChatPreview,
} from '../cloud/chatService';
import {
  getAllProviderStatuses,
  getUnlockedSessionKey,
  resolvePreferredProvider,
  saveProviderKeySessionOnly,
  subscribeKeyVaultChanges,
} from '../cloud/keyVault';
import {getProviderAdapter} from '../cloud/providerAdapter';
import {
  AiNoteMetadata,
  Category,
  CloudProviderId,
  CloudRetrievedExcerpt,
  CloudSynthesisRequestPreview,
  StoredNoteEntry,
  TipTapDoc,
} from '../types/noodle';
import {CloudPrivacyNoticeModal} from './CloudPrivacyNoticeModal';

interface AiChatPanelProps {
  isOpen: boolean;
  onClose: () => void;
  activeNote: StoredNoteEntry | null;
  onNavigateToBlock?: (
    noteId: string,
    blockId: string,
    kind: 'note' | 'source',
  ) => void;
  onSaveToAi?: (payload: {
    targetPillar: 'ai';
    title: string;
    category: Category;
    content: TipTapDoc;
    aiMeta: AiNoteMetadata;
  }) => Promise<StoredNoteEntry>;
  onOpenKeySetup?: () => void;
}

export function AiChatPanel({
  isOpen,
  onClose,
  activeNote,
  onNavigateToBlock,
  onSaveToAi,
  onOpenKeySetup,
}: AiChatPanelProps) {
  // Chat history is strictly in-memory per requirement
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);
  const [savingToAi, setSavingToAi] = useState(false);

  // Active provider & model
  const [provider, setProvider] = useState<CloudProviderId>('gemini');
  const [model, setModel] = useState('gemini-2.5-flash');
  const [hasSessionKey, setHasSessionKey] = useState(false);

  // Inline API key entry if not yet unlocked
  const [inlineKeyInput, setInlineKeyInput] = useState('');
  const [inlineKeySaving, setInlineKeySaving] = useState(false);
  const [inlineKeyError, setInlineKeyError] = useState<string | null>(null);
  const [showKeyForm, setShowKeyForm] = useState(false);

  // Mandatory Privacy Notice before ANY network call
  const [privacyPreview, setPrivacyPreview] =
    useState<CloudSynthesisRequestPreview | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Check key vault state
  const refreshKeyStatus = async () => {
    try {
      const preferred = await resolvePreferredProvider();
      setProvider(preferred.provider);
      setModel(preferred.model);
      const unlocked = getUnlockedSessionKey(preferred.provider);
      setHasSessionKey(Boolean(unlocked?.apiKey));
    } catch {
      // Default fallback
      const unlocked = getUnlockedSessionKey('gemini');
      setHasSessionKey(Boolean(unlocked?.apiKey));
    }
  };

  useEffect(() => {
    void refreshKeyStatus();
    const unsubscribe = subscribeKeyVaultChanges(() => {
      void refreshKeyStatus();
    });
    return unsubscribe;
  }, []);

  const activeNoteId = activeNote?.note.id ?? null;
  const latestPreviewRef = useRef<CloudSynthesisRequestPreview | null>(null);
  latestPreviewRef.current = privacyPreview;

  // Cancel unconfirmed privacy previews and clear transient banners when switching notes or closing
  useEffect(() => {
    if (latestPreviewRef.current) {
      cancelChatPreview(latestPreviewRef.current.requestId);
      setPrivacyPreview(null);
    }
    setChatError(null);
    setSaveSuccessMsg(null);
  }, [activeNoteId, isOpen]);

  // Scroll to bottom on new message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({behavior: 'smooth'});
  }, [messages, sending]);

  // Extract block count from active note for inspection
  const activeNoteBlockCount = useMemo(() => {
    if (!activeNote) return 0;
    try {
      const excerpts = extractRelevantNoteExcerpts(activeNote, '', 100);
      return excerpts.length;
    } catch {
      return 0;
    }
  }, [activeNote]);

  const handleSaveInlineKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanKey = inlineKeyInput.trim();
    if (!cleanKey) {
      setInlineKeyError('Please enter a valid API key.');
      return;
    }
    setInlineKeySaving(true);
    setInlineKeyError(null);
    try {
      await saveProviderKeySessionOnly({
        provider,
        apiKey: cleanKey,
        model,
      });
      setHasSessionKey(true);
      setInlineKeyInput('');
      setShowKeyForm(false);
    } catch (err) {
      setInlineKeyError((err as Error).message || 'Failed to save key.');
    } finally {
      setInlineKeySaving(false);
    }
  };

  const handleInitiateChatQuery = async (e: React.FormEvent) => {
    e.preventDefault();
    setChatError(null);
    setSaveSuccessMsg(null);

    const q = inputText.trim();
    if (!q) return;

    if (!activeNote) {
      setChatError(
        'Please select or open an active note in your workspace before chatting.',
      );
      return;
    }

    if (!hasSessionKey) {
      setShowKeyForm(true);
      setChatError(
        `API key required for ${getProviderAdapter(provider).label}. Enter your key below.`,
      );
      return;
    }

    try {
      // Step 1: Extract ONLY relevant excerpts from active note
      const excerpts = extractRelevantNoteExcerpts(activeNote, q, 5);
      if (excerpts.length === 0) {
        setChatError(
          'Active note contains no readable text blocks. Please add content to the note first.',
        );
        return;
      }

      // Step 2: Prepare single-use request preview for mandatory Privacy Notice
      const preview = prepareChatPreview({
        provider,
        model,
        question: q,
        excerpts,
      });

      // Step 3: Present Privacy Notice to user for explicit approval
      setPrivacyPreview(preview);
    } catch (err) {
      setChatError((err as Error).message || 'Could not prepare request.');
    }
  };

  const handleCancelPrivacyNotice = () => {
    if (privacyPreview) {
      cancelChatPreview(privacyPreview.requestId);
    }
    setPrivacyPreview(null);
  };

  const handleConfirmPrivacyNotice = async () => {
    if (!privacyPreview) return;

    const previewToExecute = privacyPreview;
    setPrivacyPreview(null);
    setSending(true);
    setChatError(null);

    // Append user message immediately
    const userMsg: ChatMessage = {
      id: `usr-${Date.now()}`,
      role: 'user',
      text: previewToExecute.question,
      timestamp: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInputText('');

    try {
      // Step 4: Execute query ONLY after confirmed user notice approval
      const result = await executeApprovedChatQuery({
        preview: previewToExecute,
        userApprovedNotice: true,
      });

      const assistantMsg: ChatMessage = {
        id: `asst-${Date.now()}`,
        role: 'assistant',
        text: result.answerText,
        citedBlockIds: result.citedBlockIds,
        citations: result.citations,
        timestamp: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }),
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      setChatError(
        (err as Error).message ||
          'Failed to receive a response from the cloud provider.',
      );
    } finally {
      setSending(false);
    }
  };

  const handleSaveToAi = async () => {
    if (!activeNote || messages.length === 0 || !onSaveToAi) return;

    setSavingToAi(true);
    setChatError(null);
    try {
      const payload = formatChatAsAiNote({
        activeNote,
        messages,
        provider,
        model,
      });

      const saved = await onSaveToAi(payload);
      setSaveSuccessMsg(
        `Conversation saved to ${saved.pillar}/${saved.fileName}!`,
      );
      setTimeout(() => setSaveSuccessMsg(null), 4000);
    } catch (err) {
      setChatError((err as Error).message || 'Failed to save to ai/.');
    } finally {
      setSavingToAi(false);
    }
  };

  const handleClearHistory = () => {
    setMessages([]);
    setChatError(null);
    setSaveSuccessMsg(null);
  };

  // Helper to render text with clickable [block: <id>] citation chips
  const renderMessageContent = (text: string, citedBlockIds?: string[]) => {
    const parts = text.split(/(\[block:\s*[^\]]+\])/gi);
    return (
      <div className="space-y-2 whitespace-pre-wrap leading-relaxed">
        <p>
          {parts.map((part, i) => {
            const match = /\[block:\s*([^\]]+)\]/i.exec(part);
            if (match) {
              const blockId = match[1].trim();
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() =>
                    activeNote &&
                    onNavigateToBlock?.(activeNote.note.id, blockId, 'note')
                  }
                  title={`Jump to block "${blockId}" in active note`}
                  className="mx-0.5 inline-flex items-center gap-1 rounded bg-[#232018] px-1.5 py-0.5 text-[11px] font-medium text-[#F3CA77] transition-colors hover:bg-[#322B1E] focus:outline-none focus:ring-1 focus:ring-[#E0A83E]"
                >
                  <Bookmark className="h-3 w-3 shrink-0" />
                  <span>{blockId}</span>
                </button>
              );
            }
            return part;
          })}
        </p>

        {citedBlockIds && citedBlockIds.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pt-1 text-[11px] text-[#8E95A5]">
            <span className="font-medium text-[#B2B8C6]">Cited Blocks:</span>
            {citedBlockIds.map((bid) => (
              <button
                key={bid}
                type="button"
                onClick={() =>
                  activeNote &&
                  onNavigateToBlock?.(activeNote.note.id, bid, 'note')
                }
                title={`Jump to block "${bid}" in active note`}
                className="inline-flex items-center gap-1 rounded bg-[#232018] px-1.5 py-0.5 text-[11px] text-[#F3CA77] transition-colors hover:bg-[#322B1E]"
              >
                <span>{bid}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <>
      <aside
        aria-label="AI Note Chat Panel"
        className="relative flex h-full w-80 md:w-96 flex-col border-l border-[#232733] bg-[#12141A] text-[#ECEBE6] shadow-xl shrink-0"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#232733] bg-[#151821] px-4 py-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[#E0A83E]" />
            <div>
              <h2 className="font-serif text-sm font-semibold text-[#F4F0E7]">
                Note Assistant
              </h2>
              <p className="text-[11px] text-[#8E95A5]">
                Answers based on this note
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {messages.length > 0 && (
              <button
                type="button"
                onClick={handleClearHistory}
                title="Clear chat history"
                className="rounded p-1.5 text-[#8E95A5] transition-colors hover:bg-[#202430] hover:text-[#ECEBE6]"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close AI Chat Panel"
              className="rounded p-1.5 text-[#8E95A5] transition-colors hover:bg-[#202430] hover:text-[#ECEBE6]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Active Note & Privacy Summary */}
        <div className="space-y-2 border-b border-[#232733] bg-[#0E1015] px-4 py-3 text-xs">
          {activeNote ? (
            <div className="min-w-0 space-y-0.5">
              <div className="flex items-center justify-between gap-2 text-[11px] text-[#8E95A5]">
                <span>
                  {activeNote.pillar === 'manual' ? 'My Notes' : activeNote.pillar === 'sources' ? 'Sources' : 'AI Notes'}
                </span>
                <span className="tabular-nums">{activeNoteBlockCount} sections</span>
              </div>
              <p className="truncate font-serif text-xs font-medium text-[#F4F1EA]">
                {activeNote.note.title}
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-amber-300">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span className="text-[11px]">
                Open a note to ask questions about it.
              </span>
            </div>
          )}

          <div className="flex items-center justify-between pt-0.5 text-[11px]">
            <span className="inline-flex items-center gap-1.5 text-[#8E95A5]">
              <Lock className="h-3 w-3 text-[#E0A83E]" />
              <span className={hasSessionKey ? 'font-medium text-emerald-400' : 'font-medium text-amber-400'}>
                {hasSessionKey ? 'Key Active' : 'Key Needed'}
              </span>
              <span>· Asks before every send</span>
            </span>

            {!hasSessionKey ? (
              <button
                type="button"
                onClick={() => setShowKeyForm((prev) => !prev)}
                className="text-[11px] font-medium text-[#E0A83E] hover:underline"
              >
                {showKeyForm ? 'Hide Key Input' : 'Enter API Key'}
              </button>
            ) : (
              <button
                type="button"
                onClick={onOpenKeySetup}
                className="text-[11px] text-[#8E95A5] hover:text-[#ECEBE6]"
              >
                Manage Key
              </button>
            )}
          </div>
        </div>

        {/* Inline Key Configuration Form (if key not unlocked) */}
        {showKeyForm && !hasSessionKey && (
          <div className="border-b border-[#232734] bg-[#161922] p-3 text-xs">
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-medium text-[#F2EEE4]">
                Enter {getProviderAdapter(provider).label} Key
              </span>
              <button
                type="button"
                onClick={() => setShowKeyForm(false)}
                className="text-[#8E95A5] hover:text-white"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="text-[11px] text-[#8E95A5] mb-2 leading-tight">
              Kept for this session only. Requests go straight from your browser.
            </p>
            <form onSubmit={handleSaveInlineKey} className="space-y-2">
              <input
                type="password"
                value={inlineKeyInput}
                onChange={(e) => {
                  setInlineKeyInput(e.target.value);
                  setInlineKeyError(null);
                }}
                placeholder="AIzaSy... or sk-..."
                className="h-8 w-full rounded border border-[#2B3040] bg-[#0E1015] px-2.5 font-mono text-xs text-[#ECEBE6] placeholder-[#656C7D] focus:border-[#E0A83E] focus:outline-none"
              />
              {inlineKeyError && (
                <p className="text-[11px] text-rose-400">{inlineKeyError}</p>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="submit"
                  disabled={inlineKeySaving}
                  className="rounded bg-[#E0A83E] px-2.5 py-1 text-[11px] font-semibold text-[#111216] hover:bg-[#ECB955] disabled:opacity-50"
                >
                  {inlineKeySaving ? 'Saving...' : 'Use for Session'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Message Thread Area */}
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center p-4 text-center text-[#6E7587]">
              <Bot className="mb-2 h-8 w-8 text-[#464C5E]" />
              <p className="text-xs font-medium text-[#9CA2B2]">
                Ask about this note
              </p>
              <p className="mt-1 max-w-[220px] text-[11px] text-[#6E7587]">
                Sends only relevant snippets after you approve.
              </p>
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col ${
                  msg.role === 'user' ? 'items-end' : 'items-start'
                }`}
              >
                <div className="mb-1 flex items-center gap-1.5 text-[10px] text-[#6E7587]">
                  <span>{msg.role === 'user' ? 'You' : 'Assistant'}</span>
                  <span>·</span>
                  <span>{msg.timestamp}</span>
                </div>

                <div
                  className={`max-w-[90%] rounded-xl px-3.5 py-2.5 text-xs ${
                    msg.role === 'user'
                      ? 'bg-[#E0A83E] font-medium text-[#111216]'
                      : 'bg-[#161922] text-[#ECEBE6]'
                  }`}
                >
                  {msg.role === 'user' ? (
                    <p className="whitespace-pre-wrap">{msg.text}</p>
                  ) : (
                    renderMessageContent(msg.text, msg.citedBlockIds)
                  )}
                </div>
              </div>
            ))
          )}

          {sending && (
            <div className="flex items-center gap-2 rounded-lg bg-[#161922] p-3 text-xs text-[#9CA2B2]">
              <RefreshCw className="h-3.5 w-3.5 animate-spin text-[#E0A83E]" />
              <span>Analyzing relevant note excerpts...</span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Feedback / Error banner */}
        {chatError && (
          <div className="mx-4 mb-2 flex items-start gap-2 rounded-lg bg-[#201318] p-2.5 text-xs text-rose-300">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
            <p className="flex-1">{chatError}</p>
          </div>
        )}

        {saveSuccessMsg && (
          <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg bg-[#11201A] p-2.5 text-xs text-emerald-300">
            <Check className="h-4 w-4 shrink-0 text-emerald-400" />
            <p className="flex-1">{saveSuccessMsg}</p>
          </div>
        )}

        {/* Save to AI Notes Action Bar */}
        {messages.length > 0 && onSaveToAi && (
          <div className="flex items-center justify-between border-t border-[#232734] bg-[#13151D] px-4 py-2 text-xs">
            <span className="text-[11px] text-[#7A8194]">Not saved yet</span>
            <button
              type="button"
              onClick={handleSaveToAi}
              disabled={savingToAi}
              className="inline-flex items-center gap-1.5 rounded bg-[#202532] px-2.5 py-1 text-[11px] font-medium text-[#E0A83E] hover:bg-[#282E3E] transition-colors disabled:opacity-50"
            >
              <FolderDown className="h-3.5 w-3.5" />
              <span>{savingToAi ? 'Saving...' : 'Save to AI Notes'}</span>
            </button>
          </div>
        )}

        {/* Input Bar */}
        <div className="border-t border-[#232733] bg-[#141720] p-3">
          <form onSubmit={handleInitiateChatQuery} className="flex gap-2">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              disabled={!activeNote || sending}
              placeholder={
                activeNote
                  ? 'Ask about this note (e.g. summarize key points)...'
                  : 'Open a note to start chatting...'
              }
              className="h-9 flex-1 rounded-lg border border-[#262B3A] bg-[#0E1015] px-3 text-xs text-[#ECEBE6] placeholder-[#5E6575] focus:border-[#E0A83E] focus:outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!inputText.trim() || !activeNote || sending}
              aria-label="Send question"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#E0A83E] text-[#111216] transition-colors hover:bg-[#ECB955] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </div>
      </aside>

      {/* Mandatory Privacy Notice Modal before sending excerpts to cloud */}
      <CloudPrivacyNoticeModal
        preview={privacyPreview}
        sending={sending}
        onCancel={handleCancelPrivacyNotice}
        onConfirmSend={handleConfirmPrivacyNotice}
      />
    </>
  );
}
