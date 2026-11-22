import {
  CloudProviderId,
  CloudRetrievedExcerpt,
  CloudSynthesisCitation,
  CloudSynthesisRequestPreview,
  ExtractedSyllabusTopic,
  GapAnalysisReport,
  SearchResultItem,
  SourceDocumentEntry,
  StoredNoteEntry,
  SyllabusTopicCoverageResult,
} from '../types/noodle';
import {getUnlockedSessionKey} from './keyVault';
import {CloudProviderAdapter, getProviderAdapter} from './providerAdapter';
import {MAX_CLOUD_EXCERPT_CHARS, sanitizeAndCapExcerpt} from './synthesisOutput';
import {DEFAULT_KNOWLEDGE_GAP_THRESHOLD} from './trustSettings';
import {searchWorkspaceBlocks} from '../search/localSearchService';

export const MAX_SYLLABUS_CHARS = 16_000;

/**
 * Tracks one-shot pending privacy notice request IDs for syllabus analysis calls.
 * Every request strictly requires user confirmation before sending syllabus content.
 */
const pendingSyllabusRequestIds = new Set<string>();

function nextRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `syl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Prepares the single-use preview for the mandatory Privacy Notice modal
 * before sending syllabus text to a cloud model.
 */
export function prepareSyllabusPreview(params: {
  provider: CloudProviderId;
  model?: string;
  syllabusText: string;
}): CloudSynthesisRequestPreview {
  const adapter = getProviderAdapter(params.provider);
  const trimmed = params.syllabusText.trim();
  if (!trimmed) {
    throw new Error('Please paste or upload syllabus text before running gap analysis.');
  }

  const cappedText = trimmed.slice(0, MAX_SYLLABUS_CHARS);
  const sanitized = sanitizeAndCapExcerpt(cappedText, MAX_SYLLABUS_CHARS);

  const excerpt: CloudRetrievedExcerpt = {
    citationNumber: 1,
    chunkId: 'syllabus::input',
    noteId: 'syllabus-input',
    blockId: 'syl-blk-1',
    kind: 'source',
    pillar: 'sources',
    sourceTitle: 'Syllabus / Curriculum Input',
    sourcePath: 'sources/syllabus-input.txt',
    headingPath: ['Syllabus'],
    text: sanitized.text,
    wasTruncated: sanitized.wasTruncated || cappedText.length < trimmed.length,
    hadMarkupStripped: sanitized.hadMarkupStripped,
    score: 1.0,
    scoreLabel: 'word match',
  };

  const requestId = nextRequestId();
  pendingSyllabusRequestIds.add(requestId);

  const totalChars = excerpt.text.length + 80;

  return {
    requestId,
    provider: params.provider,
    providerLabel: adapter.label,
    endpointHost: adapter.endpointHost,
    model: params.model || adapter.defaultModel,
    question: 'Extract course topics and entities from syllabus for gap analysis',
    maxExcerptChars: MAX_SYLLABUS_CHARS,
    excerpts: [excerpt],
    totalChars,
    createdAt: new Date().toISOString(),
  };
}

export function cancelSyllabusPreview(requestId: string): void {
  pendingSyllabusRequestIds.delete(requestId);
}

/**
 * Parses structured topics from model response.
 * Handles pure JSON as well as markdown-fenced json.
 */
export function parseSyllabusTopicsResponse(rawText: string): {
  courseTitle: string;
  topics: ExtractedSyllabusTopic[];
} {
  let cleaned = rawText.trim();
  // Strip markdown code fences if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Attempt relaxed regex JSON extraction if surrounded by chat prose
    const match = /\{[\s\S]*"topics"[\s\S]*\}/i.exec(cleaned);
    if (match) {
      parsed = JSON.parse(match[0]);
    } else {
      throw new Error(
        'Cloud provider did not return valid JSON for syllabus topics. Please try again.',
      );
    }
  }

  const data = parsed as {
    courseTitle?: string;
    topics?: Array<{
      id?: string;
      name?: string;
      description?: string;
      entities?: string[];
    }>;
  };

  const courseTitle =
    typeof data.courseTitle === 'string' && data.courseTitle.trim()
      ? data.courseTitle.trim()
      : 'Course Syllabus';

  if (!Array.isArray(data.topics) || data.topics.length === 0) {
    throw new Error(
      'No topics could be extracted from this syllabus text. Provide a more detailed syllabus or outline.',
    );
  }

  const topics: ExtractedSyllabusTopic[] = data.topics.map((t, idx) => ({
    id: typeof t.id === 'string' && t.id.trim() ? t.id.trim() : `topic-${idx + 1}`,
    name: typeof t.name === 'string' && t.name.trim() ? t.name.trim() : `Topic ${idx + 1}`,
    description: typeof t.description === 'string' ? t.description.trim() : '',
    entities: Array.isArray(t.entities)
      ? t.entities.map((e) => String(e).trim()).filter(Boolean)
      : [],
  }));

  return {courseTitle, topics};
}

/**
 * Dispatches syllabus extraction ONLY after explicit Privacy Notice approval.
 */
export async function executeApprovedSyllabusExtraction(params: {
  preview: CloudSynthesisRequestPreview;
  userApprovedNotice: boolean;
  apiKeyOverride?: string;
  adapterOverride?: CloudProviderAdapter;
  fetchImpl?: typeof fetch;
}): Promise<{
  courseTitle: string;
  topics: ExtractedSyllabusTopic[];
}> {
  if (!params.userApprovedNotice) {
    throw new Error(
      'Privacy notice approval is required before sending syllabus text to a cloud provider.',
    );
  }

  if (!pendingSyllabusRequestIds.has(params.preview.requestId)) {
    throw new Error(
      'This syllabus extraction request was already sent or cancelled. Review the Privacy Notice again for a new call.',
    );
  }

  pendingSyllabusRequestIds.delete(params.preview.requestId);

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

  const extractionDirective =
    'You are an academic curriculum analyst. Analyze the following course syllabus and extract key topics/modules and domain entities.\n' +
    'Return ONLY valid JSON matching this schema (no prose outside JSON):\n' +
    '{\n' +
    '  "courseTitle": "Full Course Title",\n' +
    '  "topics": [\n' +
    '    {\n' +
    '      "id": "t-1",\n' +
    '      "name": "Topic Name",\n' +
    '      "description": "Short 1-2 sentence concept description",\n' +
    '      "entities": ["entity 1", "key term 2", "concept 3"]\n' +
    '    }\n' +
    '  ]\n' +
    '}';

  const res = await adapter.synthesizeFromExcerpts({
    apiKey: sessionKey,
    model: params.preview.model,
    question: extractionDirective,
    excerpts: params.preview.excerpts,
    fetchImpl: params.fetchImpl,
  });

  return parseSyllabusTopicsResponse(res.answerText);
}

/**
 * Maps each extracted syllabus topic against the local vector index or word match search.
 * Computes coverage (zero, weak, covered) and links each topic to best note matches.
 */
export async function mapTopicsAgainstLocalIndex(params: {
  topics: ExtractedSyllabusTopic[];
  notes: StoredNoteEntry[];
  sources: SourceDocumentEntry[];
  aiEnabled: boolean;
  threshold?: number;
}): Promise<SyllabusTopicCoverageResult[]> {
  const threshold = params.threshold ?? DEFAULT_KNOWLEDGE_GAP_THRESHOLD;
  const results: SyllabusTopicCoverageResult[] = [];

  for (const topic of params.topics) {
    const entityTerms = topic.entities.slice(0, 5).join(' ');
    const query = `${topic.name} ${entityTerms}`.trim();

    const searchOut = await searchWorkspaceBlocks({
      query,
      notes: params.notes,
      sources: params.sources,
      aiEnabled: params.aiEnabled,
      topK: 3,
    });

    const best = searchOut.results[0];
    const bestScore = best ? best.score : 0;
    const scoreLabel = best ? best.scoreLabel : (searchOut.mode === 'semantic' ? 'semantic similarity' : 'word match');

    let coverage: 'zero' | 'weak' | 'covered';
    let knowledgeGap: boolean;

    if (!best || bestScore <= 0.01) {
      coverage = 'zero';
      knowledgeGap = true;
    } else if (bestScore < threshold) {
      coverage = 'weak';
      knowledgeGap = true;
    } else {
      coverage = 'covered';
      knowledgeGap = false;
    }

    results.push({
      topic,
      coverage,
      bestScore: Math.round(bestScore * 100) / 100,
      scoreLabel,
      knowledgeGap,
      bestMatches: searchOut.results,
    });
  }

  return results;
}

/**
 * Generates an aggregated Gap Analysis Report from topic coverage results.
 */
export function buildGapAnalysisReport(params: {
  courseTitle: string;
  syllabusSnippet: string;
  threshold: number;
  topics: SyllabusTopicCoverageResult[];
}): GapAnalysisReport {
  let zeroCoverageCount = 0;
  let weakCoverageCount = 0;
  let coveredCount = 0;

  for (const t of params.topics) {
    if (t.coverage === 'zero') {
      zeroCoverageCount += 1;
    } else if (t.coverage === 'weak') {
      weakCoverageCount += 1;
    } else {
      coveredCount += 1;
    }
  }

  return {
    id: `gap-${Date.now()}`,
    courseTitle: params.courseTitle,
    analyzedAt: new Date().toISOString(),
    syllabusSnippet: params.syllabusSnippet.slice(0, 300),
    thresholdUsed: params.threshold,
    totalTopics: params.topics.length,
    zeroCoverageCount,
    weakCoverageCount,
    coveredCount,
    topics: params.topics,
  };
}
