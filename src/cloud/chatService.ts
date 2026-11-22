import {createUuid} from '../editor/noteSchema';
import {chunkTipTapDocument, scoreWordMatch} from '../search/chunker';
import {
  AiNoteMetadata,
  Category,
  CloudProviderId,
  CloudRetrievedExcerpt,
  CloudSynthesisCitation,
  CloudSynthesisRequestPreview,
  Pillar,
  StoredNoteEntry,
  TipTapDoc,
  TipTapNode,
} from '../types/noodle';
import {getUnlockedSessionKey} from './keyVault';
import {CloudProviderAdapter, getProviderAdapter} from './providerAdapter';
import {MAX_CLOUD_EXCERPT_CHARS, sanitizeAndCapExcerpt} from './synthesisOutput';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  citedBlockIds?: string[];
  citations?: CloudSynthesisCitation[];
  timestamp: string;
}

/**
 * Tracks one-shot pending privacy notice request IDs for chat requests.
 * Every single request requires an explicit confirmation from the privacy notice modal.
 */
const pendingChatRequestIds = new Set<string>();

function nextRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `chat-req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Extracts ONLY the relevant excerpts from the active note for a given question.
 * Ranks note blocks by relevance and caps output size to prevent data exfiltration.
 */
export function extractRelevantNoteExcerpts(
  note: StoredNoteEntry,
  question: string,
  maxExcerpts = 5,
  maxExcerptChars = MAX_CLOUD_EXCERPT_CHARS,
): CloudRetrievedExcerpt[] {
  const chunks = chunkTipTapDocument(
    note.note.id,
    note.note.title,
    note.note.content,
  );

  if (chunks.length === 0) {
    return [];
  }

  const query = question.trim();
  const scored = chunks.map((ch) => ({
    chunk: ch,
    score: scoreWordMatch(query, ch.text, note.note.title, ch.headingPath),
  }));

  // Prefer chunks that have matching query terms; fall back to leading chunks for general prompts
  const positive = scored.filter((s) => s.score > 0);
  const selected = (positive.length > 0 ? positive : scored)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxExcerpts);

  return selected.map((item, idx) => {
    const sanitized = sanitizeAndCapExcerpt(item.chunk.text, maxExcerptChars);
    return {
      citationNumber: idx + 1,
      chunkId: `${note.note.id}::${item.chunk.blockId}`,
      noteId: note.note.id,
      blockId: item.chunk.blockId,
      kind: 'note' as const,
      pillar: note.pillar,
      sourceTitle: note.note.title,
      sourcePath: note.path ?? `${note.pillar}/${note.fileName}`,
      headingPath: item.chunk.headingPath,
      text: sanitized.text,
      wasTruncated: sanitized.wasTruncated,
      hadMarkupStripped: sanitized.hadMarkupStripped,
      score: item.score > 0 ? item.score : 0.2,
      scoreLabel: 'word match' as const,
    };
  });
}

/**
 * Prepares the sanitized excerpt payload for user review in the mandatory Privacy Notice.
 */
export function prepareChatPreview(params: {
  provider: CloudProviderId;
  model?: string;
  question: string;
  excerpts: CloudRetrievedExcerpt[];
  maxExcerptChars?: number;
}): CloudSynthesisRequestPreview {
  const adapter = getProviderAdapter(params.provider);
  const trimmedQuestion = params.question.trim();
  if (!trimmedQuestion) {
    throw new Error('Enter a question about the active note before sending.');
  }

  if (params.excerpts.length === 0) {
    throw new Error(
      'No text blocks could be extracted from the active note. Add content to the note first.',
    );
  }

  const cap = params.maxExcerptChars ?? MAX_CLOUD_EXCERPT_CHARS;
  const sanitizedExcerpts = params.excerpts.map((ex, idx) => {
    const sanitized = sanitizeAndCapExcerpt(ex.text, cap);
    return {
      ...ex,
      citationNumber: idx + 1,
      text: sanitized.text,
      wasTruncated: sanitized.wasTruncated,
      hadMarkupStripped: sanitized.hadMarkupStripped,
    };
  });

  const requestId = nextRequestId();
  pendingChatRequestIds.add(requestId);

  const totalChars = sanitizedExcerpts.reduce(
    (sum, ex) => sum + ex.text.length + ex.sourceTitle.length,
    trimmedQuestion.length,
  );

  return {
    requestId,
    provider: params.provider,
    providerLabel: adapter.label,
    endpointHost: adapter.endpointHost,
    model: params.model || adapter.defaultModel,
    question: trimmedQuestion,
    maxExcerptChars: cap,
    excerpts: sanitizedExcerpts,
    totalChars,
    createdAt: new Date().toISOString(),
  };
}

export function cancelChatPreview(requestId: string): void {
  pendingChatRequestIds.delete(requestId);
}

/**
 * Extracts cited block IDs from assistant responses.
 * Detects explicit `[block: <id>]` as well as numeric `[1]`, `[2]` citations.
 */
export function parseCitedBlockIds(
  answerText: string,
  excerpts: CloudRetrievedExcerpt[],
): {
  citedBlockIds: string[];
  citations: CloudSynthesisCitation[];
} {
  const byNum = new Map<number, CloudRetrievedExcerpt>(
    excerpts.map((e) => [e.citationNumber, e]),
  );
  const byBlockId = new Map<string, CloudRetrievedExcerpt>(
    excerpts.map((e) => [e.blockId, e]),
  );

  const citedBlockIds = new Set<string>();
  const citations: CloudSynthesisCitation[] = [];

  const addCitation = (ex: CloudRetrievedExcerpt) => {
    if (!citations.some((c) => c.blockId === ex.blockId)) {
      citations.push({
        citationNumber: ex.citationNumber,
        noteId: ex.noteId,
        blockId: ex.blockId,
        kind: ex.kind,
        pillar: ex.pillar,
        sourceTitle: ex.sourceTitle,
        headingPath: ex.headingPath,
        excerpt: ex.text,
      });
    }
  };

  // Match [block: <id>] or [block:<id>]
  const blockRegex = /\[block:\s*([^\]]+)\]/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(answerText)) !== null) {
    const rawId = match[1].trim();
    if (rawId) {
      citedBlockIds.add(rawId);
      const ex = byBlockId.get(rawId);
      if (ex) {
        addCitation(ex);
      }
    }
  }

  // Also support numeric [1], [2] citations mapped to excerpt block IDs
  const numRegex = /\[(\d+)\]/g;
  while ((match = numRegex.exec(answerText)) !== null) {
    const num = Number(match[1]);
    const ex = byNum.get(num);
    if (ex) {
      citedBlockIds.add(ex.blockId);
      addCitation(ex);
    }
  }

  return {
    citedBlockIds: Array.from(citedBlockIds),
    citations,
  };
}

/**
 * Executes a cloud chat query ONLY after explicit per-call user confirmation
 * from the Privacy Notice modal. Consumes the single-use `requestId`.
 * Sends ONLY the sanitized relevant excerpts, never the whole note or unretrieved text.
 */
export async function executeApprovedChatQuery(params: {
  preview: CloudSynthesisRequestPreview;
  userApprovedNotice: boolean;
  apiKeyOverride?: string;
  adapterOverride?: CloudProviderAdapter;
  fetchImpl?: typeof fetch;
}): Promise<{
  answerText: string;
  citedBlockIds: string[];
  citations: CloudSynthesisCitation[];
}> {
  if (!params.userApprovedNotice) {
    throw new Error(
      'Privacy notice approval is required before sending excerpts to a cloud provider.',
    );
  }

  if (!pendingChatRequestIds.has(params.preview.requestId)) {
    throw new Error(
      'This chat request was already sent or cancelled. Review the Privacy Notice again for a new call.',
    );
  }

  pendingChatRequestIds.delete(params.preview.requestId);

  const sessionKey =
    params.apiKeyOverride?.trim() ||
    getUnlockedSessionKey(params.preview.provider)?.apiKey ||
    '';

  if (!sessionKey) {
    throw new Error(
      `No unlocked API key for ${params.preview.providerLabel}. Open API Key setup to enter or unlock your key.`,
    );
  }

  const adapter =
    params.adapterOverride ?? getProviderAdapter(params.preview.provider);

  // Instruct model to strictly cite block IDs like [block: <blockId>]
  const sampleBlockId = params.preview.excerpts[0]?.blockId || 'blk-1';
  const chatQuestionWithCitationDirective =
    `${params.preview.question}\n\n` +
    `Instruction: Answer based strictly on the relevant excerpts above from the active note. ` +
    `For every key claim or fact, cite the excerpt block ID using the format [block: <blockId>] (for example: [block: ${sampleBlockId}]). ` +
    `If the excerpts do not contain the answer, state that plainly.`;

  const response = await adapter.synthesizeFromExcerpts({
    apiKey: sessionKey,
    model: params.preview.model,
    question: chatQuestionWithCitationDirective,
    excerpts: params.preview.excerpts,
    fetchImpl: params.fetchImpl,
  });

  const parsed = parseCitedBlockIds(
    response.answerText,
    params.preview.excerpts,
  );

  return {
    answerText: response.answerText,
    citedBlockIds: parsed.citedBlockIds,
    citations: parsed.citations.length > 0 ? parsed.citations : response.citations,
  };
}

/**
 * Builds a structured TipTap document representing the conversation history
 * for saving into the `ai/` pillar.
 */
export function buildConversationTipTapDoc(
  activeNoteTitle: string,
  messages: ChatMessage[],
): TipTapDoc {
  const content: TipTapNode[] = [
    {
      type: 'heading',
      attrs: {level: 1, id: createUuid()},
      content: [{type: 'text', text: `AI Chat: ${activeNoteTitle}`}],
    },
    {
      type: 'paragraph',
      attrs: {id: createUuid()},
      content: [
        {
          type: 'text',
          text: `Saved AI conversation discussing active note "${activeNoteTitle}" on ${new Date().toLocaleString()}.`,
        },
      ],
    },
  ];

  for (const msg of messages) {
    if (msg.role === 'user') {
      content.push({
        type: 'heading',
        attrs: {level: 3, id: createUuid()},
        content: [{type: 'text', text: `User Question: ${msg.text}`}],
      });
    } else {
      content.push({
        type: 'paragraph',
        attrs: {id: createUuid()},
        content: [{type: 'text', text: msg.text}],
      });

      if (msg.citedBlockIds && msg.citedBlockIds.length > 0) {
        content.push({
          type: 'paragraph',
          attrs: {id: createUuid()},
          content: [
            {
              type: 'text',
              marks: [{type: 'italic'}],
              text: `Cited Blocks: ${msg.citedBlockIds.map((id) => `[block: ${id}]`).join(', ')}`,
            },
          ],
        });
      }
    }
  }

  return {
    type: 'doc',
    content,
  };
}

/**
 * Formats a chat conversation for persistence into the `ai/` pillar.
 */
export function formatChatAsAiNote(params: {
  activeNote: StoredNoteEntry;
  messages: ChatMessage[];
  provider: CloudProviderId;
  model: string;
}): {
  targetPillar: 'ai';
  title: string;
  category: Category;
  content: TipTapDoc;
  aiMeta: AiNoteMetadata;
} {
  const doc = buildConversationTipTapDoc(
    params.activeNote.note.title,
    params.messages,
  );

  const allCitations: CloudSynthesisCitation[] = [];
  const seenBlockIds = new Set<string>();

  for (const m of params.messages) {
    if (m.citations) {
      for (const c of m.citations) {
        if (!seenBlockIds.has(c.blockId)) {
          seenBlockIds.add(c.blockId);
          allCitations.push(c);
        }
      }
    }
  }

  const sourcesUsed = allCitations.map((c, i) => ({
    citationNumber: i + 1,
    noteId: c.noteId,
    blockId: c.blockId,
    kind: c.kind,
    pillar: c.pillar,
    title: c.sourceTitle,
    path: params.activeNote.path ?? `${params.activeNote.pillar}/${params.activeNote.fileName}`,
    excerpt: c.excerpt,
  }));

  const aiMeta: AiNoteMetadata = {
    isAiGenerated: true,
    format: 'study-guide',
    model: params.model,
    provider: params.provider,
    generatedAt: new Date().toISOString(),
    question: `AI Chat Session on ${params.activeNote.note.title}`,
    sourcesUsed,
  };

  const title = `AI Chat: ${params.activeNote.note.title} (${new Date().toLocaleDateString()})`;

  return {
    targetPillar: 'ai',
    title,
    category: params.activeNote.note.category,
    content: doc,
    aiMeta,
  };
}
