import {createUuid, ensureBlockIds} from '../editor/noteSchema';
import {
  AiExamQuestion,
  AiFlashcardItem,
  AiNoteMetadata,
  AiSourceReference,
  AiSynthesisSection,
  CloudProviderId,
  CloudRetrievedExcerpt,
  SynthesisOutputFormat,
  TipTapDoc,
  TipTapNode,
  ValidatedSynthesisOutput,
} from '../types/noodle';

export const MAX_CLOUD_EXCERPT_CHARS = 800;

export const SYNTHESIS_FORMATS: Array<{
  id: SynthesisOutputFormat;
  label: string;
  shortLabel: string;
  description: string;
}> = [
  {
    id: 'study-guide',
    label: 'Study Guide',
    shortLabel: 'Study Guide',
    description:
      'Structured review guide preserving your own definitions, examples, and metaphors.',
  },
  {
    id: 'cheat-sheet',
    label: 'Summary Cheat-Sheet',
    shortLabel: 'Cheat-Sheet',
    description:
      'Dense, high-yield reference sheet of formulas, steps, and key distinctions.',
  },
  {
    id: 'flashcards',
    label: 'Flashcard Set',
    shortLabel: 'Flashcards',
    description:
      'Interactive active-recall deck (front/back + hints) plus saved TipTap note.',
  },
  {
    id: 'practice-exam',
    label: 'Practice Exam',
    shortLabel: 'Practice Exam',
    description:
      'Interactive multiple-choice practice test with explanations and answer key.',
  },
];

export function getSynthesisFormatLabel(format: SynthesisOutputFormat): string {
  return (
    SYNTHESIS_FORMATS.find((f) => f.id === format)?.label ?? 'Study Guide'
  );
}

/**
 * Strips scripts, styles, comments, HTML/XML tags, and markdown formatting/URLs
 * down to clean plain text, then caps at `maxChars` cleanly.
 */
export function sanitizeAndCapExcerpt(
  rawText: string,
  maxChars: number = MAX_CLOUD_EXCERPT_CHARS,
): {
  text: string;
  wasTruncated: boolean;
  hadMarkupStripped: boolean;
} {
  const input = String(rawText ?? '');
  let cleaned = input;
  let prev = '';
  let passes = 0;
  while (cleaned !== prev && passes < 12) {
    prev = cleaned;
    cleaned = cleaned
      // Remove script/style/iframe/noscript/object/embed/svg blocks including inner code
      .replace(
        /<(script|style|iframe|object|embed|svg|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi,
        ' ',
      )
      .replace(/<!--[\s\S]*?-->/g, ' ');
    passes += 1;
  }
  prev = '';
  passes = 0;
  while (cleaned !== prev && passes < 12) {
    prev = cleaned;
    cleaned = cleaned
      // Strip remaining HTML tags
      .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
      // Strip dangerous URI schemes
      .replace(/(?:javascript|vbscript|data):[^\s)'"]+/gi, '');
    passes += 1;
  }
  cleaned = cleaned
    // Convert markdown images/links to plain text labels
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove markdown heading/fence/blockquote syntax noise
    .replace(/```[a-zA-Z0-9_-]*\n?/g, ' ')
    .replace(/```/g, ' ')
    // Decode common safe HTML entities
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // Strip control characters except newlines/tabs, then normalize whitespace
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const hadMarkupStripped =
    cleaned !== input.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  if (cleaned.length <= maxChars) {
    return {
      text: cleaned,
      wasTruncated: false,
      hadMarkupStripped,
    };
  }

  const sliceLimit = Math.max(16, maxChars - 1);
  let cut = cleaned.slice(0, sliceLimit);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > sliceLimit * 0.6) {
    cut = cut.slice(0, lastSpace);
  }
  cleaned = `${cut.trimEnd()}…`;

  return {
    text: cleaned,
    wasTruncated: true,
    hadMarkupStripped,
  };
}

function hasUnsafeOutputMarkup(text: string): boolean {
  return (
    /<script\b/i.test(text) ||
    /<iframe\b/i.test(text) ||
    /javascript\s*:/i.test(text) ||
    /\bon(?:error|load|click|mouseover)\s*=/i.test(text)
  );
}

function extractJsonObjectCandidate(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error('Provider returned an empty response.');
  }

  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenceMatch && fenceMatch[1]) {
    return fenceMatch[1].trim();
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function normalizeCitationsArray(
  raw: unknown,
  validNumbers: Set<number>,
): number[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<number>();
  const out: number[] = [];
  for (const item of raw) {
    const num = typeof item === 'number' ? item : Number(item);
    if (Number.isInteger(num) && validNumbers.has(num) && !seen.has(num)) {
      seen.add(num);
      out.push(num);
    }
  }
  return out;
}

function extractInlineCitationNumbers(
  text: string,
  validNumbers: Set<number>,
): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const regex = /\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const num = Number(match[1]);
    if (validNumbers.has(num) && !seen.has(num)) {
      seen.add(num);
      out.push(num);
    }
  }
  return out;
}

/**
 * Strictly validates a provider response for the requested output format BEFORE
 * any TipTap JSON note or backlink is written. Rejects malformed JSON, missing
 * required fields, invalid exam indices, or script/XSS payloads without writing.
 */
export function parseAndValidateSynthesisOutput(
  rawResponseText: string,
  format: SynthesisOutputFormat,
  excerpts: CloudRetrievedExcerpt[],
): ValidatedSynthesisOutput {
  if (hasUnsafeOutputMarkup(rawResponseText)) {
    throw new Error(
      'Rejected provider output because it contained unsafe script or markup patterns. Nothing was saved.',
    );
  }

  const candidateJson = extractJsonObjectCandidate(rawResponseText);
  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(candidateJson);
  } catch {
    throw new Error(
      'Provider returned malformed JSON that did not match the required synthesis schema. Nothing was saved.',
    );
  }

  if (!parsedUnknown || typeof parsedUnknown !== 'object' || Array.isArray(parsedUnknown)) {
    throw new Error(
      'Provider output must be a JSON object. Nothing was saved.',
    );
  }

  const obj = parsedUnknown as Record<string, unknown>;
  const rawTitle = typeof obj.title === 'string' ? obj.title.trim() : '';
  if (!rawTitle || rawTitle.length > 160) {
    throw new Error(
      'Provider output is missing a valid title (1–160 characters). Nothing was saved.',
    );
  }

  const validNums = new Set(excerpts.map((e) => e.citationNumber));
  const summary =
    typeof obj.summary === 'string' ? obj.summary.trim().slice(0, 1200) : undefined;

  const preservedPhrases = Array.isArray(obj.preservedPhrases)
    ? obj.preservedPhrases
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        .map((p) => p.trim().slice(0, 200))
        .slice(0, 12)
    : [];

  const sections: AiSynthesisSection[] = [];
  if (Array.isArray(obj.sections)) {
    for (const rawSec of obj.sections) {
      if (!rawSec || typeof rawSec !== 'object') {
        throw new Error('Malformed section entry in provider response. Nothing was saved.');
      }
      const sec = rawSec as Record<string, unknown>;
      const heading = typeof sec.heading === 'string' ? sec.heading.trim() : '';
      const body = typeof sec.body === 'string' ? sec.body.trim() : '';
      if (!heading || !body) {
        throw new Error(
          'Provider section is missing a non-empty heading or body. Nothing was saved.',
        );
      }
      const combinedCites = new Set<number>([
        ...normalizeCitationsArray(sec.citations, validNums),
        ...extractInlineCitationNumbers(`${heading} ${body}`, validNums),
      ]);
      sections.push({
        heading: heading.slice(0, 180),
        body,
        citations: Array.from(combinedCites),
        preservedFromNotes: sec.preservedFromNotes === true,
      });
    }
  }

  let flashcards: AiFlashcardItem[] | undefined;
  if (format === 'flashcards') {
    if (!Array.isArray(obj.flashcards) || obj.flashcards.length === 0) {
      throw new Error(
        'Flashcard output must include a non-empty flashcards array. Nothing was saved.',
      );
    }
    flashcards = obj.flashcards.map((rawCard, idx) => {
      if (!rawCard || typeof rawCard !== 'object') {
        throw new Error(`Flashcard #${idx + 1} is malformed. Nothing was saved.`);
      }
      const c = rawCard as Record<string, unknown>;
      const front = typeof c.front === 'string' ? c.front.trim() : '';
      const back = typeof c.back === 'string' ? c.back.trim() : '';
      const hint = typeof c.hint === 'string' ? c.hint.trim() : undefined;
      if (!front || !back) {
        throw new Error(
          `Flashcard #${idx + 1} must have non-empty front and back text. Nothing was saved.`,
        );
      }
      const cites = new Set<number>([
        ...normalizeCitationsArray(c.citations, validNums),
        ...extractInlineCitationNumbers(`${front} ${back}`, validNums),
      ]);
      return {
        id: `fc-${idx + 1}`,
        front,
        back,
        ...(hint ? {hint} : {}),
        citations: Array.from(cites),
        preservedFromNotes: c.preservedFromNotes === true,
      };
    });
  }

  let examQuestions: AiExamQuestion[] | undefined;
  if (format === 'practice-exam') {
    if (!Array.isArray(obj.examQuestions) || obj.examQuestions.length === 0) {
      throw new Error(
        'Practice exam output must include a non-empty examQuestions array. Nothing was saved.',
      );
    }
    examQuestions = obj.examQuestions.map((rawQ, idx) => {
      if (!rawQ || typeof rawQ !== 'object') {
        throw new Error(`Exam question #${idx + 1} is malformed. Nothing was saved.`);
      }
      const q = rawQ as Record<string, unknown>;
      const prompt = typeof q.prompt === 'string' ? q.prompt.trim() : '';
      const explanation =
        typeof q.explanation === 'string' ? q.explanation.trim() : '';
      const options = Array.isArray(q.options)
        ? q.options
            .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
            .map((o) => o.trim())
        : [];
      const correctIndex =
        typeof q.correctIndex === 'number' && Number.isInteger(q.correctIndex)
          ? q.correctIndex
          : -1;

      if (
        !prompt ||
        !explanation ||
        options.length < 2 ||
        options.length > 6 ||
        correctIndex < 0 ||
        correctIndex >= options.length
      ) {
        throw new Error(
          `Exam question #${idx + 1} has invalid prompt, options, correctIndex, or explanation. Nothing was saved.`,
        );
      }
      const cites = new Set<number>([
        ...normalizeCitationsArray(q.citations, validNums),
        ...extractInlineCitationNumbers(`${prompt} ${explanation}`, validNums),
      ]);
      return {
        id: `eq-${idx + 1}`,
        prompt,
        options,
        correctIndex,
        explanation,
        citations: Array.from(cites),
        preservedFromNotes: q.preservedFromNotes === true,
      };
    });
  }

  if (
    (format === 'study-guide' || format === 'cheat-sheet') &&
    sections.length === 0
  ) {
    throw new Error(
      `${getSynthesisFormatLabel(format)} output must include at least one section. Nothing was saved.`,
    );
  }

  // Final safety scan on normalized text
  const allStrings = [
    rawTitle,
    summary ?? '',
    ...preservedPhrases,
    ...sections.flatMap((s) => [s.heading, s.body]),
    ...(flashcards ?? []).flatMap((f) => [f.front, f.back, f.hint ?? '']),
    ...(examQuestions ?? []).flatMap((eq) => [
      eq.prompt,
      eq.explanation,
      ...eq.options,
    ]),
  ].join('\n');

  if (hasUnsafeOutputMarkup(allStrings)) {
    throw new Error(
      'Rejected provider output containing unsafe script/HTML content. Nothing was saved.',
    );
  }

  return {
    format,
    title: rawTitle,
    summary,
    preservedPhrases,
    sections,
    flashcards,
    examQuestions,
  };
}

/**
 * Formats validated synthesis output into readable prose with `[N]` citations
 * for display inside SynthesizerPage when sections are shown.
 */
export function formatSynthesisAnswerText(
  output: ValidatedSynthesisOutput,
): string {
  const parts: string[] = [];
  if (output.summary) {
    parts.push(output.summary);
  }
  for (const sec of output.sections) {
    const marker = sec.preservedFromNotes ? ' [Preserved from your notes]' : '';
    const cites =
      sec.citations.length > 0
        ? ' ' + sec.citations.map((n) => `[${n}]`).join(' ')
        : '';
    parts.push(`${sec.heading}${marker}\n${sec.body}${cites}`);
  }
  if (output.flashcards && output.flashcards.length > 0) {
    parts.push(
      `Generated ${output.flashcards.length} interactive flashcards (view below or open saved AI note).`,
    );
  }
  if (output.examQuestions && output.examQuestions.length > 0) {
    parts.push(
      `Generated ${output.examQuestions.length} interactive practice exam questions (answer below or open saved AI note).`,
    );
  }
  return parts.join('\n\n').trim() || output.title;
}

/**
 * Converts a validated provider synthesis response into a TipTap JSON document
 * with stable block UUIDs, `preserved from your notes` markers, metadata summary,
 * and citation anchor block IDs for read-only backlinks.
 */
export function buildTipTapDocFromSynthesis(params: {
  output: ValidatedSynthesisOutput;
  excerpts: CloudRetrievedExcerpt[];
  provider: CloudProviderId;
  providerLabel: string;
  model: string;
  question: string;
  generatedAt: string;
}): {
  doc: TipTapDoc;
  aiMeta: AiNoteMetadata;
  primaryBlockId: string;
  blockIdByCitationNumber: Map<number, string>;
} {
  const {
    output,
    excerpts,
    provider,
    providerLabel,
    model,
    question,
    generatedAt,
  } = params;

  const nodes: TipTapNode[] = [];
  const blockIdByCitationNumber = new Map<number, string>();

  const titleBlockId = createUuid();
  nodes.push({
    type: 'heading',
    attrs: {id: titleBlockId, level: 1},
    content: [{type: 'text', text: output.title}],
  });

  const metaLine = `AI Synthesis (${getSynthesisFormatLabel(output.format)}) · ${providerLabel} (${model}) · ${new Date(generatedAt).toLocaleDateString()} · ${excerpts.length} source excerpts`;
  nodes.push({
    type: 'blockquote',
    attrs: {id: createUuid()},
    content: [
      {
        type: 'paragraph',
        attrs: {id: createUuid()},
        content: [{type: 'text', text: metaLine}],
      },
    ],
  });

  if (output.summary) {
    const sumId = createUuid();
    nodes.push({
      type: 'paragraph',
      attrs: {id: sumId},
      content: [{type: 'text', text: output.summary}],
    });
  }

  if (output.preservedPhrases.length > 0) {
    nodes.push({
      type: 'paragraph',
      attrs: {id: createUuid()},
      content: [
        {
          type: 'text',
          marks: [{type: 'bold'}],
          text: 'Preserved from your notes: ',
        },
        {
          type: 'text',
          marks: [{type: 'italic'}],
          text: output.preservedPhrases.map((p) => `"${p}"`).join(' · '),
        },
      ],
    });
  }

  const registerCitationBlock = (cites: number[], blockId: string) => {
    for (const num of cites) {
      if (!blockIdByCitationNumber.has(num)) {
        blockIdByCitationNumber.set(num, blockId);
      }
    }
  };

  for (const sec of output.sections) {
    const hId = createUuid();
    nodes.push({
      type: 'heading',
      attrs: {id: hId, level: 2},
      content: [
        {
          type: 'text',
          text: sec.preservedFromNotes
            ? `${sec.heading} [Preserved from your notes]`
            : sec.heading,
        },
      ],
    });

    const paragraphs = sec.body.split(/\n{2,}/).filter((p) => p.trim().length > 0);
    for (let i = 0; i < paragraphs.length; i += 1) {
      const pId = createUuid();
      const suffix =
        i === paragraphs.length - 1 && sec.citations.length > 0
          ? ` ${sec.citations.map((n) => `[${n}]`).join(' ')}`
          : '';
      nodes.push({
        type: 'paragraph',
        attrs: {id: pId},
        content: [{type: 'text', text: `${paragraphs[i].trim()}${suffix}`}],
      });
      registerCitationBlock(sec.citations, pId);
    }
  }

  if (output.flashcards && output.flashcards.length > 0) {
    nodes.push({
      type: 'heading',
      attrs: {id: createUuid(), level: 2},
      content: [{type: 'text', text: 'Flashcards'}],
    });

    for (let i = 0; i < output.flashcards.length; i += 1) {
      const card = output.flashcards[i];
      const qId = createUuid();
      const marker = card.preservedFromNotes
        ? ' [Preserved from your notes]'
        : '';
      const citeSuffix =
        card.citations.length > 0
          ? ` ${card.citations.map((n) => `[${n}]`).join(' ')}`
          : '';

      nodes.push({
        type: 'heading',
        attrs: {id: qId, level: 3},
        content: [{type: 'text', text: `Card ${i + 1}: ${card.front}${marker}`}],
      });
      const ansId = createUuid();
      nodes.push({
        type: 'paragraph',
        attrs: {id: ansId},
        content: [
          {
            type: 'text',
            text: `Answer: ${card.back}${card.hint ? ` (Hint: ${card.hint})` : ''}${citeSuffix}`,
          },
        ],
      });
      registerCitationBlock(card.citations, ansId);
    }
  }

  if (output.examQuestions && output.examQuestions.length > 0) {
    nodes.push({
      type: 'heading',
      attrs: {id: createUuid(), level: 2},
      content: [{type: 'text', text: 'Practice Exam & Answer Key'}],
    });

    for (let i = 0; i < output.examQuestions.length; i += 1) {
      const eq = output.examQuestions[i];
      const qId = createUuid();
      const marker = eq.preservedFromNotes
        ? ' [Preserved from your notes]'
        : '';
      nodes.push({
        type: 'heading',
        attrs: {id: qId, level: 3},
        content: [{type: 'text', text: `Question ${i + 1}: ${eq.prompt}${marker}`}],
      });
      nodes.push({
        type: 'orderedList',
        attrs: {id: createUuid()},
        content: eq.options.map((opt) => ({
          type: 'listItem',
          attrs: {id: createUuid()},
          content: [
            {
              type: 'paragraph',
              attrs: {id: createUuid()},
              content: [{type: 'text', text: opt}],
            },
          ],
        })),
      });
      const keyId = createUuid();
      const citeSuffix =
        eq.citations.length > 0
          ? ` ${eq.citations.map((n) => `[${n}]`).join(' ')}`
          : '';
      nodes.push({
        type: 'paragraph',
        attrs: {id: keyId},
        content: [
          {
            type: 'text',
            text: `Answer: ${eq.options[eq.correctIndex]} — ${eq.explanation}${citeSuffix}`,
          },
        ],
      });
      registerCitationBlock(eq.citations, keyId);
    }
  }

  if (excerpts.length > 0) {
    nodes.push({
      type: 'horizontalRule',
      attrs: {id: createUuid()},
    });
    nodes.push({
      type: 'heading',
      attrs: {id: createUuid(), level: 2},
      content: [{type: 'text', text: 'Sources Cited (Provenance)'}],
    });
    nodes.push({
      type: 'bulletList',
      attrs: {id: createUuid()},
      content: excerpts.map((ex) => ({
        type: 'listItem',
        attrs: {id: createUuid()},
        content: [
          {
            type: 'paragraph',
            attrs: {id: createUuid()},
            content: [
              {
                type: 'text',
                text: `[${ex.citationNumber}] ${ex.sourceTitle} (${ex.sourcePath} · block ${ex.blockId.slice(0, 12)})`,
              },
            ],
          },
        ],
      })),
    });
  }

  const ensuredDoc = ensureBlockIds({type: 'doc', content: nodes});
  const sourcesUsed: AiSourceReference[] = excerpts.map((ex) => ({
    citationNumber: ex.citationNumber,
    noteId: ex.noteId,
    blockId: ex.blockId,
    kind: ex.kind,
    pillar: ex.pillar,
    title: ex.sourceTitle,
    path: ex.sourcePath,
    excerpt: ex.text,
  }));

  const aiMeta: AiNoteMetadata = {
    isAiGenerated: true,
    format: output.format,
    model,
    provider,
    generatedAt,
    question,
    sourcesUsed,
    ...(output.preservedPhrases.length > 0
      ? {preservedPhrases: output.preservedPhrases}
      : {}),
    ...(output.flashcards ? {flashcards: output.flashcards} : {}),
    ...(output.examQuestions ? {examQuestions: output.examQuestions} : {}),
  };

  return {
    doc: ensuredDoc,
    aiMeta,
    primaryBlockId: titleBlockId,
    blockIdByCitationNumber,
  };
}
