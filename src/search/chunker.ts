import {
  SourceDocumentChunk,
  SourceDocumentEntry,
  StoredNoteEntry,
  TipTapDoc,
  TipTapNode,
} from '../types/noodle';

/**
 * Verified from node_modules/@huggingface/transformers/types/pipelines/feature-extraction.d.ts
 * and Transformers.js feature-extraction default pipeline config.
 */
export const DEFAULT_EMBEDDING_MODEL_ID = 'onnx-community/all-MiniLM-L6-v2-ONNX';
export const ALTERNATE_EMBEDDING_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

export const AVAILABLE_EMBEDDING_MODELS: Array<{
  id: string;
  label: string;
  dimensions: number;
}> = [
  {
    id: DEFAULT_EMBEDDING_MODEL_ID,
    label: 'all-MiniLM-L6-v2 ONNX (Default)',
    dimensions: 384,
  },
  {
    id: ALTERNATE_EMBEDDING_MODEL_ID,
    label: 'Xenova all-MiniLM-L6-v2',
    dimensions: 384,
  },
];

export interface DocumentChunkSpec {
  id: string; // `${noteId}::${blockId}`
  noteId: string;
  blockId: string;
  headingPath: string[];
  text: string;
  embedText: string;
}

function collectInlineText(nodes: TipTapNode[] | undefined): string {
  if (!Array.isArray(nodes)) {
    return '';
  }
  let out = '';
  for (const child of nodes) {
    if (child.type === 'text') {
      out += child.text ?? '';
    } else if (child.type === 'hardBreak') {
      out += '\n';
    } else if (Array.isArray(child.content)) {
      out += collectInlineText(child.content);
    }
  }
  return out;
}

function formatEmbedText(
  noteTitle: string,
  headingPath: string[],
  blockText: string,
): string {
  const headerParts = [noteTitle.trim(), ...headingPath].filter(Boolean);
  if (headerParts.length === 0) {
    return blockText;
  }
  return `${headerParts.join(' > ')}: ${blockText}`;
}

/**
 * Hierarchical chunking by TipTap block:
 * tracks active heading sections (H1/H2/H3) and emits one chunk per
 * content block carrying its stable `blockId` (`node.attrs.id`).
 */
export function chunkTipTapDocument(
  noteId: string,
  noteTitle: string,
  doc: TipTapDoc,
): DocumentChunkSpec[] {
  const chunks: DocumentChunkSpec[] = [];
  const headingStack: Array<{level: number; text: string}> = [];
  const seenBlockIds = new Set<string>();
  let fallbackCounter = 0;

  function resolveBlockId(node: TipTapNode): string {
    const raw =
      node.attrs && typeof node.attrs.id === 'string' && node.attrs.id.trim()
        ? node.attrs.id.trim()
        : `blk-${++fallbackCounter}`;
    if (!seenBlockIds.has(raw)) {
      seenBlockIds.add(raw);
      return raw;
    }
    let suffix = 1;
    while (seenBlockIds.has(`${raw}-${suffix}`)) {
      suffix += 1;
    }
    const deduped = `${raw}-${suffix}`;
    seenBlockIds.add(deduped);
    return deduped;
  }

  function currentHeadingPath(): string[] {
    return headingStack.map((h) => h.text);
  }

  function walk(node: TipTapNode): void {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (node.type === 'heading') {
      const headingText = collectInlineText(node.content).trim();
      const level =
        node.attrs && typeof node.attrs.level === 'number'
          ? node.attrs.level
          : 1;
      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1].level >= level
      ) {
        headingStack.pop();
      }
      if (headingText) {
        headingStack.push({level, text: headingText});
        const blockId = resolveBlockId(node);
        const path = currentHeadingPath();
        chunks.push({
          id: `${noteId}::${blockId}`,
          noteId,
          blockId,
          headingPath: path,
          text: headingText,
          embedText: formatEmbedText(noteTitle, path.slice(0, -1), headingText),
        });
      }
      return;
    }

    if (node.type === 'paragraph' || node.type === 'codeBlock') {
      const blockText = collectInlineText(node.content).trim();
      if (blockText) {
        const blockId = resolveBlockId(node);
        const path = currentHeadingPath();
        chunks.push({
          id: `${noteId}::${blockId}`,
          noteId,
          blockId,
          headingPath: path,
          text: blockText,
          embedText: formatEmbedText(noteTitle, path, blockText),
        });
      }
      return;
    }

    if (
      node.type === 'blockquote' &&
      Array.isArray(node.content) &&
      node.content.every((c) => c.type === 'text' || c.type === 'hardBreak')
    ) {
      const blockText = collectInlineText(node.content).trim();
      if (blockText) {
        const blockId = resolveBlockId(node);
        const path = currentHeadingPath();
        chunks.push({
          id: `${noteId}::${blockId}`,
          noteId,
          blockId,
          headingPath: path,
          text: blockText,
          embedText: formatEmbedText(noteTitle, path, blockText),
        });
      }
      return;
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        walk(child);
      }
    }
  }

  if (doc && Array.isArray(doc.content)) {
    for (const child of doc.content) {
      walk(child);
    }
  }

  // Fallback if note only has a title and empty blocks
  if (chunks.length === 0 && noteTitle.trim()) {
    const firstBlockId =
      doc?.content?.[0]?.attrs && typeof doc.content[0].attrs.id === 'string'
        ? doc.content[0].attrs.id
        : 'title-block';
    chunks.push({
      id: `${noteId}::${firstBlockId}`,
      noteId,
      blockId: firstBlockId,
      headingPath: [],
      text: noteTitle.trim(),
      embedText: noteTitle.trim(),
    });
  }

  return chunks;
}

/**
 * Splits plain .txt or Markdown .md source files hierarchically into sections
 * and paragraph blocks with stable deterministic block IDs.
 */
export function chunkPlainTextSource(
  rawText: string,
  kind: 'txt' | 'md',
): SourceDocumentChunk[] {
  const normalized = rawText.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const chunks: SourceDocumentChunk[] = [];
  const headingStack: Array<{level: number; text: string}> = [];

  let paragraphLines: string[] = [];
  let blockIndex = 0;

  const flushParagraph = () => {
    const text = paragraphLines.join(' ').replace(/\s+/g, ' ').trim();
    paragraphLines = [];
    if (!text) {
      return;
    }
    blockIndex += 1;
    chunks.push({
      blockId: `src-p-${blockIndex}`,
      headingPath: headingStack.map((h) => h.text),
      text,
    });
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const headingMatch =
      kind === 'md' ? /^(#{1,3})\s+(.+)$/.exec(trimmed) : null;

    if (headingMatch) {
      flushParagraph();
      const level = headingMatch[1].length;
      const headingText = headingMatch[2].trim();
      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1].level >= level
      ) {
        headingStack.pop();
      }
      headingStack.push({level, text: headingText});
      blockIndex += 1;
      chunks.push({
        blockId: `src-h-${blockIndex}`,
        headingPath: headingStack.map((h) => h.text),
        text: headingText,
      });
      continue;
    }

    if (trimmed === '') {
      flushParagraph();
    } else {
      paragraphLines.push(trimmed);
    }
  }
  flushParagraph();

  return chunks;
}

/**
 * Splits extracted PDF page texts into clean paragraph chunks keyed by page & paragraph.
 */
export function chunkPdfPages(
  pages: Array<{pageNumber: number; text: string}>,
): SourceDocumentChunk[] {
  const chunks: SourceDocumentChunk[] = [];
  for (const page of pages) {
    const rawParas = page.text
      .replace(/\r\n?/g, '\n')
      .split(/\n{2,}/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    // If a PDF page has no blank-line breaks and is very long, split cleanly into ~600-char segments
    const segments: string[] = [];
    for (const para of rawParas) {
      if (para.length <= 650) {
        segments.push(para);
      } else {
        const sentences = para.split(/(?<=[.!?])\s+/);
        let acc = '';
        for (const s of sentences) {
          if (acc && acc.length + s.length + 1 > 600) {
            segments.push(acc.trim());
            acc = s;
          } else {
            acc = acc ? `${acc} ${s}` : s;
          }
        }
        if (acc.trim()) {
          segments.push(acc.trim());
        }
      }
    }

    segments.forEach((segment, idx) => {
      chunks.push({
        blockId: `page-${page.pageNumber}-p-${idx + 1}`,
        headingPath: [`Page ${page.pageNumber}`],
        pageNumber: page.pageNumber,
        text: segment,
      });
    });
  }
  return chunks;
}

export function chunkNoteEntry(entry: StoredNoteEntry): DocumentChunkSpec[] {
  return chunkTipTapDocument(entry.note.id, entry.note.title, entry.note.content);
}

export function chunkSourceEntry(doc: SourceDocumentEntry): DocumentChunkSpec[] {
  return doc.chunks.map((chunk) => ({
    id: `${doc.id}::${chunk.blockId}`,
    noteId: doc.id,
    blockId: chunk.blockId,
    headingPath: chunk.headingPath,
    text: chunk.text,
    embedText: formatEmbedText(doc.title, chunk.headingPath, chunk.text),
  }));
}

export function computeCosineSimilarity(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    const va = a[i];
    const vb = b[i];
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) {
    return 0;
  }
  return dot / denom;
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'he',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'that',
  'the',
  'to',
  'was',
  'were',
  'will',
  'with',
]);

export function tokenizeForWordMatch(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((tok) => tok.length >= 2 && !STOP_WORDS.has(tok));
}

/**
 * Honest lexical word-match fallback scorer (0..1) used before the embedding
 * model is downloaded or when Local AI is turned off.
 */
export function scoreWordMatch(
  query: string,
  text: string,
  title = '',
  headingPath: string[] = [],
): number {
  const qLower = query.trim().toLowerCase();
  if (!qLower) {
    return 0;
  }

  const qTokens = Array.from(new Set(tokenizeForWordMatch(qLower)));
  const combined = `${title} ${headingPath.join(' ')} ${text}`.toLowerCase();

  if (qTokens.length === 0) {
    return combined.includes(qLower) ? 0.5 : 0;
  }

  const docTokens = new Set(tokenizeForWordMatch(combined));
  let matched = 0;
  for (const tok of qTokens) {
    if (docTokens.has(tok)) {
      matched += 1;
    } else {
      for (const dt of docTokens) {
        if (dt.startsWith(tok) || tok.startsWith(dt)) {
          matched += 0.65;
          break;
        }
      }
    }
  }

  if (matched === 0) {
    return 0;
  }

  const coverage = Math.min(1, matched / qTokens.length);
  const exactPhraseBonus = combined.includes(qLower) ? 0.15 : 0;
  return Math.min(1, Number((coverage * 0.85 + exactPhraseBonus).toFixed(3)));
}
