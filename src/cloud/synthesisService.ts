import {addExplicitBacklink} from '../db/noodleDb';
import {createUuid} from '../editor/noteSchema';
import {chunkNoteEntry, chunkSourceEntry, scoreWordMatch} from '../search/chunker';
import {searchWorkspaceBlocks} from '../search/localSearchService';
import {
  AiNoteMetadata,
  BacklinkRecord,
  Category,
  CloudProviderId,
  CloudRetrievedExcerpt,
  CloudSynthesisRequestPreview,
  CloudSynthesisResponse,
  Pillar,
  ScoreLabel,
  SourceDocumentEntry,
  StoredNoteEntry,
  SynthesisOutputFormat,
  TipTapDoc,
  ValidatedSynthesisOutput,
} from '../types/noodle';
import {getUnlockedSessionKey} from './keyVault';
import {CloudProviderAdapter, getProviderAdapter} from './providerAdapter';
import {
  buildTipTapDocFromSynthesis,
  MAX_CLOUD_EXCERPT_CHARS,
  parseAndValidateSynthesisOutput,
  sanitizeAndCapExcerpt,
} from './synthesisOutput';
import {loadTrustSettings, recordTunableSectionScores} from './trustSettings';

/**
 * Tracks one-shot pending privacy notice request IDs so every single cloud
 * request requires a fresh explicit confirmation from the privacy notice modal.
 */
const pendingRequestIds = new Set<string>();

function nextRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface VaultBinItem {
  id: string;
  kind: 'note' | 'source';
  pillar: Pillar;
  title: string;
  path: string;
}

function sanitizeExcerptsList(
  excerpts: CloudRetrievedExcerpt[],
  maxExcerptChars = MAX_CLOUD_EXCERPT_CHARS,
): CloudRetrievedExcerpt[] {
  return excerpts
    .map((ex, idx) => {
      const sanitized = sanitizeAndCapExcerpt(ex.text, maxExcerptChars);
      return {
        ...ex,
        citationNumber: idx + 1,
        text: sanitized.text,
        wasTruncated: sanitized.wasTruncated || ex.wasTruncated,
        hadMarkupStripped:
          sanitized.hadMarkupStripped || ex.hadMarkupStripped,
      };
    })
    .filter((ex) => ex.text.length > 0);
}

export async function retrieveExcerptsForQuestion(params: {
  question: string;
  notes: StoredNoteEntry[];
  sources: SourceDocumentEntry[];
  aiEnabled: boolean;
  topK?: number;
}): Promise<{
  mode: 'semantic' | 'word-match';
  scoreLabel: ScoreLabel;
  excerpts: CloudRetrievedExcerpt[];
}> {
  const res = await searchWorkspaceBlocks({
    query: params.question,
    notes: params.notes,
    sources: params.sources,
    aiEnabled: params.aiEnabled,
    topK: params.topK ?? 6,
  });

  const rawExcerpts: CloudRetrievedExcerpt[] = res.results.map((item, idx) => ({
    citationNumber: idx + 1,
    chunkId: item.chunkId,
    noteId: item.noteId,
    blockId: item.blockId,
    kind: item.kind,
    pillar: item.pillar,
    sourceTitle: item.title,
    sourcePath: item.path,
    headingPath: item.headingPath,
    text: item.text,
    score: item.score,
    scoreLabel: item.scoreLabel,
  }));

  return {
    mode: res.mode,
    scoreLabel: res.mode === 'semantic' ? 'semantic similarity' : 'word match',
    excerpts: sanitizeExcerptsList(rawExcerpts, MAX_CLOUD_EXCERPT_CHARS),
  };
}

/**
 * Retrieves, sanitizes (plain text only), and caps excerpts strictly from the
 * documents placed inside The Synthesis Bin.
 */
export async function retrieveExcerptsFromVaultBin(params: {
  selectedItems: VaultBinItem[];
  question: string;
  notes: StoredNoteEntry[];
  sources: SourceDocumentEntry[];
  aiEnabled: boolean;
  maxExcerpts?: number;
}): Promise<{
  mode: 'semantic' | 'word-match';
  scoreLabel: ScoreLabel;
  excerpts: CloudRetrievedExcerpt[];
}> {
  const maxExcerpts = params.maxExcerpts ?? 8;
  const selectedIds = new Set(params.selectedItems.map((i) => i.id));
  if (selectedIds.size === 0) {
    return {mode: 'word-match', scoreLabel: 'word match', excerpts: []};
  }

  const scopedNotes = params.notes.filter((n) => selectedIds.has(n.note.id));
  const scopedSources = params.sources.filter((s) => selectedIds.has(s.id));

  const query = params.question.trim() || params.selectedItems.map((i) => i.title).join(' ');
  const searchOut = await searchWorkspaceBlocks({
    query,
    notes: scopedNotes,
    sources: scopedSources,
    aiEnabled: params.aiEnabled,
    topK: Math.max(maxExcerpts * 2, 12),
  });

  const collected: CloudRetrievedExcerpt[] = [];
  const seenChunkIds = new Set<string>();

  for (const item of searchOut.results) {
    if (!selectedIds.has(item.noteId) || seenChunkIds.has(item.chunkId)) {
      continue;
    }
    seenChunkIds.add(item.chunkId);
    collected.push({
      citationNumber: collected.length + 1,
      chunkId: item.chunkId,
      noteId: item.noteId,
      blockId: item.blockId,
      kind: item.kind,
      pillar: item.pillar,
      sourceTitle: item.title,
      sourcePath: item.path,
      headingPath: item.headingPath,
      text: item.text,
      score: item.score,
      scoreLabel: item.scoreLabel,
    });
    if (collected.length >= maxExcerpts) {
      break;
    }
  }

  // Ensure every item in the Synthesis Bin contributes at least 1 leading block
  // if semantic/word-match didn't already surface one for that item
  const representedDocIds = new Set(collected.map((c) => c.noteId));
  for (const binItem of params.selectedItems) {
    if (representedDocIds.has(binItem.id) || collected.length >= maxExcerpts + 2) {
      continue;
    }
    if (binItem.kind === 'note') {
      const noteEntry = scopedNotes.find((n) => n.note.id === binItem.id);
      if (!noteEntry) {
        continue;
      }
      const chunks = chunkNoteEntry(noteEntry);
      const best = chunks
        .map((ch) => ({
          ch,
          score: scoreWordMatch(query, ch.text, noteEntry.note.title, ch.headingPath),
        }))
        .sort((a, b) => b.score - a.score)[0];
      if (best) {
        collected.push({
          citationNumber: collected.length + 1,
          chunkId: best.ch.id,
          noteId: noteEntry.note.id,
          blockId: best.ch.blockId,
          kind: 'note',
          pillar: noteEntry.pillar,
          sourceTitle: noteEntry.note.title,
          sourcePath: noteEntry.path ?? `${noteEntry.pillar}/${noteEntry.fileName}`,
          headingPath: best.ch.headingPath,
          text: best.ch.text,
          score: best.score || 0.25,
          scoreLabel: 'word match',
        });
      }
    } else {
      const srcEntry = scopedSources.find((s) => s.id === binItem.id);
      if (!srcEntry || srcEntry.kind === 'unsupported-pptx') {
        continue;
      }
      const chunks = chunkSourceEntry(srcEntry);
      const best = chunks
        .map((ch) => ({
          ch,
          score: scoreWordMatch(query, ch.text, srcEntry.title, ch.headingPath),
        }))
        .sort((a, b) => b.score - a.score)[0];
      if (best) {
        collected.push({
          citationNumber: collected.length + 1,
          chunkId: best.ch.id,
          noteId: srcEntry.id,
          blockId: best.ch.blockId,
          kind: 'source',
          pillar: 'sources',
          sourceTitle: srcEntry.title,
          sourcePath: srcEntry.path,
          headingPath: best.ch.headingPath,
          text: best.ch.text,
          score: best.score || 0.25,
          scoreLabel: 'word match',
        });
      }
    }
  }

  return {
    mode: searchOut.mode,
    scoreLabel: searchOut.mode === 'semantic' ? 'semantic similarity' : 'word match',
    excerpts: sanitizeExcerptsList(collected, MAX_CLOUD_EXCERPT_CHARS),
  };
}

/**
 * Prepares the exact sanitized & capped payload that will be reviewed in the
 * mandatory Privacy Notice before dispatching any cloud request.
 */
export function prepareCloudSynthesisPreview(params: {
  provider: CloudProviderId;
  model: string;
  question: string;
  outputFormat?: SynthesisOutputFormat;
  excerpts: CloudRetrievedExcerpt[];
  maxExcerptChars?: number;
  webGroundingEnabled?: boolean;
  allowedDomains?: string[];
}): CloudSynthesisRequestPreview {
  const adapter = getProviderAdapter(params.provider);
  const trimmedQuestion = params.question.trim();
  if (!trimmedQuestion) {
    throw new Error('Enter a synthesis prompt or question before preparing cloud synthesis.');
  }

  const cap = params.maxExcerptChars ?? MAX_CLOUD_EXCERPT_CHARS;
  const sanitizedExcerpts = sanitizeExcerptsList(params.excerpts, cap);
  if (sanitizedExcerpts.length === 0) {
    throw new Error(
      'No non-empty retrieved excerpts are available. Add items to The Synthesis Bin before calling a cloud model.',
    );
  }

  const requestId = nextRequestId();
  pendingRequestIds.add(requestId);

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
    outputFormat: params.outputFormat,
    maxExcerptChars: cap,
    excerpts: sanitizedExcerpts,
    webGroundingEnabled: params.webGroundingEnabled,
    allowedDomains: params.allowedDomains,
    totalChars,
    createdAt: new Date().toISOString(),
  };
}

export function cancelCloudSynthesisPreview(requestId: string): void {
  pendingRequestIds.delete(requestId);
}

/**
 * Executes a cloud synthesis call ONLY after explicit per-call confirmation
 * from the Privacy Notice modal. Consumes the single-use `requestId`.
 */
export async function executeApprovedCloudSynthesis(params: {
  preview: CloudSynthesisRequestPreview;
  userApprovedNotice: boolean;
  apiKeyOverride?: string;
  adapterOverride?: CloudProviderAdapter;
  fetchImpl?: typeof fetch;
}): Promise<CloudSynthesisResponse> {
  if (!params.userApprovedNotice) {
    throw new Error(
      'Privacy notice approval is required before sending excerpts to a cloud provider.',
    );
  }
  if (!pendingRequestIds.has(params.preview.requestId)) {
    throw new Error(
      'This synthesis request was already sent or cancelled. Review the Privacy Notice again for a new call.',
    );
  }

  pendingRequestIds.delete(params.preview.requestId);

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

  return adapter.synthesizeFromExcerpts({
    apiKey: sessionKey,
    model: params.preview.model,
    question: params.preview.question,
    outputFormat: params.preview.outputFormat,
    excerpts: params.preview.excerpts,
    webGroundingEnabled: params.preview.webGroundingEnabled,
    allowedDomains: params.preview.allowedDomains,
    fetchImpl: params.fetchImpl,
  });
}

function resolveRealBlockReference(
  noteId: string,
  blockId: string,
  kind: 'note' | 'source',
  notes: StoredNoteEntry[],
  sources: SourceDocumentEntry[],
): boolean {
  if (kind === 'source') {
    const src = sources.find((s) => s.id === noteId);
    if (!src) {
      return false;
    }
    return src.chunks.some((c) => c.blockId === blockId);
  }
  const note = notes.find((n) => n.note.id === noteId);
  if (!note) {
    return false;
  }
  const chunks = chunkNoteEntry(note);
  if (chunks.some((c) => c.blockId === blockId)) {
    return true;
  }
  // Fallback recursive walk in case blockId is a parent node id
  const visit = (nodes: typeof note.note.content.content): boolean => {
    for (const node of nodes ?? []) {
      if (node.attrs?.id === blockId) {
        return true;
      }
      if (Array.isArray(node.content) && visit(node.content)) {
        return true;
      }
    }
    return false;
  };
  return visit(note.note.content.content);
}

/**
 * Validates provider output before saving, creates a TipTap JSON note strictly
 * in `ai/` (refusing `manual/` and `sources/`), and records read-only backlinks
 * anchored to real source block IDs.
 */
export async function validateAndPersistAiSynthesisResult(params: {
  response: CloudSynthesisResponse;
  excerpts: CloudRetrievedExcerpt[];
  notes: StoredNoteEntry[];
  sources: SourceDocumentEntry[];
  targetPillar?: Pillar;
  persistAiNote: (payload: {
    targetPillar: Pillar;
    title: string;
    category: Category;
    content: TipTapDoc;
    aiMeta: AiNoteMetadata;
  }) => Promise<StoredNoteEntry>;
}): Promise<{
  savedEntry: StoredNoteEntry;
  createdBacklinks: BacklinkRecord[];
  verifiedOutput: ValidatedSynthesisOutput;
}> {
  const targetPillar = params.targetPillar ?? 'ai';
  if (targetPillar !== 'ai') {
    throw new Error(
      `Refused save to "${targetPillar}/": synthesized AI notes may ONLY be saved in ai/, never manual/ or sources/.`,
    );
  }

  const format = params.response.outputFormat ?? 'study-guide';
  const structured =
    params.response.structuredOutput ??
    parseAndValidateSynthesisOutput(
      params.response.answerText,
      format,
      params.excerpts,
    );

  // Re-run validator over serialized structured JSON to guarantee strict invariants
  const verifiedOutput = parseAndValidateSynthesisOutput(
    JSON.stringify(structured),
    format,
    params.excerpts,
  );

  const trustState = await loadTrustSettings();
  for (const sec of verifiedOutput.sections) {
    const secSearch = await searchWorkspaceBlocks({
      query: sec.heading,
      notes: params.notes,
      sources: params.sources,
      aiEnabled: true,
      topK: 1,
    });
    const bestScore = secSearch.results[0]?.score ?? 0;
    const scoreLabel = secSearch.results[0]?.scoreLabel ?? 'word match';
    const isGap = bestScore < trustState.knowledgeGapThreshold;
    sec.bestSimilarityScore = bestScore;
    sec.scoreLabel = scoreLabel;
    sec.thresholdUsed = trustState.knowledgeGapThreshold;
    sec.knowledgeGap = isGap;
    if (isGap && !sec.body.includes('No supporting notes found')) {
      sec.body = `[No supporting notes found] ${sec.body}`;
    }
    await recordTunableSectionScores([
      {
        id: createUuid(),
        synthesisTitle: verifiedOutput.title,
        sectionHeading: sec.heading,
        query: sec.heading,
        bestScore,
        scoreLabel,
        recordedAt: params.response.createdAt,
      },
    ]);
  }

  const adapter = getProviderAdapter(params.response.provider);
  const {doc, aiMeta, primaryBlockId, blockIdByCitationNumber} =
    buildTipTapDocFromSynthesis({
      output: verifiedOutput,
      excerpts: params.excerpts,
      provider: params.response.provider,
      providerLabel: adapter.label,
      model: params.response.model,
      question: params.response.question,
      generatedAt: params.response.createdAt,
      webCitations: params.response.webCitations,
      webGroundingNotice: params.response.webGroundingNotice,
    });

  const savedEntry = await params.persistAiNote({
    targetPillar: 'ai',
    title: verifiedOutput.title,
    category: 'Study',
    content: doc,
    aiMeta,
  });

  if (savedEntry.pillar !== 'ai' || savedEntry.note.pillar !== 'ai') {
    throw new Error(
      `Invariant violation: saved note landed in "${savedEntry.pillar}/" instead of "ai/".`,
    );
  }

  // Create read-only provenance backlinks for each real source block ID used
  const createdBacklinks: BacklinkRecord[] = [];
  const seenTargets = new Set<string>();

  for (const ex of params.excerpts) {
    const dedupeKey = `${ex.noteId}::${ex.blockId}`;
    if (seenTargets.has(dedupeKey)) {
      continue;
    }
    const resolvesToRealBlock = resolveRealBlockReference(
      ex.noteId,
      ex.blockId,
      ex.kind,
      params.notes,
      params.sources,
    );
    if (!resolvesToRealBlock) {
      continue;
    }
    seenTargets.add(dedupeKey);

    const sourceBlockId =
      blockIdByCitationNumber.get(ex.citationNumber) ?? primaryBlockId;
    const record: BacklinkRecord = {
      id: `ai-prov::${savedEntry.note.id}::${sourceBlockId}->${ex.noteId}::${ex.blockId}`,
      sourceNoteId: savedEntry.note.id,
      sourceBlockId,
      sourceTitle: savedEntry.note.title,
      targetNoteId: ex.noteId,
      targetBlockId: ex.blockId,
      targetTitle: ex.sourceTitle,
      targetPillar: ex.pillar,
      targetKind: ex.kind,
      score: ex.score,
      scoreLabel: ex.scoreLabel,
      readOnly: true,
      createdAt: params.response.createdAt,
    };
    await addExplicitBacklink(record);
    createdBacklinks.push(record);
  }

  return {savedEntry, createdBacklinks, verifiedOutput};
}
