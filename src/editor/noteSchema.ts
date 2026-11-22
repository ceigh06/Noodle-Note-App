import {
  CATEGORIES,
  Category,
  NoteRecord,
  Pillar,
  TipTapDoc,
  TipTapNode,
} from '../types/noodle';

export const CURRENT_SCHEMA_VERSION = 2;

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

export const ALLOWED_IMAGE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
] as const;

export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export const BLOCK_NODE_TYPES: string[] = [
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'horizontalRule',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'image',
];

const BLOCK_TYPE_SET = new Set(BLOCK_NODE_TYPES);

export function createUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Recursively sorts object keys lexicographically so JSON serialization is
 * deterministic across key reorderings. Array element order is preserved.
 */
export function canonicalizeJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    const v = obj[key];
    if (v !== undefined) {
      sorted[key] = canonicalizeJson(v);
    }
  }
  return sorted;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

export async function computeCanonicalContentHash(
  content: TipTapDoc,
): Promise<string> {
  const canonical = canonicalStringify(content);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

/**
 * Assigns a UUID `attrs.id` only to block-level nodes that do not already have one.
 * Existing IDs are never overwritten.
 */
export function ensureBlockIds(doc: TipTapDoc): TipTapDoc {
  function visitNode(node: TipTapNode): TipTapNode {
    const isBlock = BLOCK_TYPE_SET.has(node.type);
    let nextAttrs = node.attrs ? {...node.attrs} : undefined;

    if (isBlock) {
      const existingId =
        nextAttrs && typeof nextAttrs.id === 'string' && nextAttrs.id.trim()
          ? nextAttrs.id
          : null;
      if (!existingId) {
        nextAttrs = {
          ...(nextAttrs ?? {}),
          id: createUuid(),
        };
      }
    }

    const nextContent = Array.isArray(node.content)
      ? node.content.map(visitNode)
      : undefined;

    return {
      ...node,
      ...(nextAttrs !== undefined ? {attrs: nextAttrs} : {}),
      ...(nextContent !== undefined ? {content: nextContent} : {}),
    };
  }

  return {
    type: 'doc',
    content: Array.isArray(doc.content) ? doc.content.map(visitNode) : [],
  };
}

function normalizeDoc(rawContent: unknown): TipTapDoc {
  if (
    rawContent &&
    typeof rawContent === 'object' &&
    (rawContent as TipTapDoc).type === 'doc' &&
    Array.isArray((rawContent as TipTapDoc).content)
  ) {
    return rawContent as TipTapDoc;
  }

  if (typeof rawContent === 'string') {
    const lines = rawContent.split(/\r?\n/).filter((l) => l.length > 0);
    return {
      type: 'doc',
      content:
        lines.length > 0
          ? lines.map((line) => ({
              type: 'paragraph',
              attrs: {id: createUuid()},
              content: [{type: 'text', text: line}],
            }))
          : [{type: 'paragraph', attrs: {id: createUuid()}}],
    };
  }

  return {
    type: 'doc',
    content: [{type: 'paragraph', attrs: {id: createUuid()}}],
  };
}

function isValidPillar(value: unknown): value is Pillar {
  return value === 'sources' || value === 'manual' || value === 'ai';
}

function isValidCategory(value: unknown): value is Category {
  return typeof value === 'string' && CATEGORIES.includes(value as Category);
}

/**
 * Ordered note migration pipeline:
 *  - v0 -> v1: normalize root fields (schemaVersion, id, title, category, pillar, timestamps, TipTap doc)
 *  - v1 -> v2: ensure every block-level node has a stable UUID `attrs.id`
 */
export function migrateNote(
  rawNote: unknown,
  fallbackPillar: Pillar = 'manual',
): {note: NoteRecord; migrated: boolean} {
  if (!rawNote || typeof rawNote !== 'object') {
    throw new Error('Note data must be a JSON object.');
  }

  const draft: Record<string, unknown> = {...(rawNote as Record<string, unknown>)};
  let version =
    typeof draft.schemaVersion === 'number' && Number.isFinite(draft.schemaVersion)
      ? draft.schemaVersion
      : 0;
  let migrated = false;

  // Step v0 -> v1
  if (version < 1) {
    const now = new Date().toISOString();
    draft.id =
      typeof draft.id === 'string' && draft.id.trim() ? draft.id : createUuid();
    draft.title =
      typeof draft.title === 'string' && draft.title.trim()
        ? draft.title
        : 'Untitled Note';
    draft.category = isValidCategory(draft.category) ? draft.category : 'Study';
    draft.pillar = isValidPillar(draft.pillar) ? draft.pillar : fallbackPillar;
    draft.createdAt =
      typeof draft.createdAt === 'string' && draft.createdAt ? draft.createdAt : now;
    draft.updatedAt =
      typeof draft.updatedAt === 'string' && draft.updatedAt ? draft.updatedAt : now;
    draft.content = normalizeDoc(draft.content ?? draft.body);
    delete draft.body;
    draft.contentHash =
      typeof draft.contentHash === 'string' ? draft.contentHash : '';
    draft.schemaVersion = 1;
    version = 1;
    migrated = true;
  }

  // Step v1 -> v2
  if (version < 2) {
    const doc = normalizeDoc(draft.content);
    const withIds = ensureBlockIds(doc);
    draft.content = withIds;
    draft.schemaVersion = 2;
    version = 2;
    migrated = true;
  }

  const normalizedDoc = ensureBlockIds(normalizeDoc(draft.content));
  const rawAiMeta =
    draft.aiMeta && typeof draft.aiMeta === 'object'
      ? (draft.aiMeta as NoteRecord['aiMeta'])
      : undefined;

  const finalNote: NoteRecord = {
    id: typeof draft.id === 'string' ? draft.id : createUuid(),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title:
      typeof draft.title === 'string' && draft.title.trim()
        ? draft.title
        : 'Untitled Note',
    category: isValidCategory(draft.category) ? draft.category : 'Study',
    pillar: isValidPillar(draft.pillar) ? draft.pillar : fallbackPillar,
    createdAt:
      typeof draft.createdAt === 'string'
        ? draft.createdAt
        : new Date().toISOString(),
    updatedAt:
      typeof draft.updatedAt === 'string'
        ? draft.updatedAt
        : new Date().toISOString(),
    contentHash: typeof draft.contentHash === 'string' ? draft.contentHash : '',
    content: normalizedDoc,
    ...(rawAiMeta && rawAiMeta.isAiGenerated === true ? {aiMeta: rawAiMeta} : {}),
  };

  return {note: finalNote, migrated};
}

/**
 * Restrict links strictly to http, https, and mailto.
 */
export function isAllowedLinkUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== 'string') {
    return false;
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return (
      parsed.protocol === 'http:' ||
      parsed.protocol === 'https:' ||
      parsed.protocol === 'mailto:'
    );
  } catch {
    return false;
  }
}

/**
 * Validates that an image path is strictly workspace-relative inside assets/
 * (e.g. 'assets/diagram-1234.png'). Rejects absolute paths, Windows drives, URLs,
 * control characters, and '..' traversal.
 */
export function isWorkspaceRelativeAssetPath(rawPath: string): boolean {
  if (typeof rawPath !== 'string') {
    return false;
  }
  if (/[\u0000-\u001f\u007f]/.test(rawPath)) {
    return false;
  }
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return false;
  }
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\') ||
    trimmed.startsWith('~') ||
    /^[a-zA-Z]:/.test(trimmed) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
  ) {
    return false;
  }
  if (!trimmed.startsWith('assets/')) {
    return false;
  }
  const remainder = trimmed.slice('assets/'.length);
  if (
    !remainder ||
    remainder.includes('/') ||
    remainder.includes('\\') ||
    remainder === '.' ||
    remainder === '..' ||
    remainder.includes('..') ||
    remainder.length > 140
  ) {
    return false;
  }
  return true;
}

export function extractAssetPathsFromDoc(doc: TipTapDoc): string[] {
  const found = new Set<string>();

  function visit(node: TipTapNode): void {
    if (node.type === 'image') {
      const src = node.attrs?.src;
      if (typeof src === 'string' && isWorkspaceRelativeAssetPath(src)) {
        found.add(src.trim());
      }
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        visit(child);
      }
    }
  }

  for (const node of doc.content ?? []) {
    visit(node);
  }
  return Array.from(found);
}

/**
 * Throws if any image node inside the document has an absolute, external, or
 * non-workspace-relative src path.
 */
export function validateNoteAssetPaths(doc: TipTapDoc): void {
  function visit(node: TipTapNode): void {
    if (node.type === 'image') {
      const src = node.attrs?.src;
      if (typeof src !== 'string' || !isWorkspaceRelativeAssetPath(src)) {
        throw new Error(
          `Rejected invalid or absolute image path "${String(src ?? '')}". Images must use workspace-relative assets/<name> paths.`,
        );
      }
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        visit(child);
      }
    }
  }

  for (const node of doc.content ?? []) {
    visit(node);
  }
}

export function formatMissingImageMessage(relativePath: string): string {
  return `Image not found: ${relativePath}`;
}

/**
 * Pure guard preventing autosave on initial open / hydration / UniqueID init.
 */
export function shouldScheduleAutosave(params: {
  editable: boolean;
  isHydrating: boolean;
  docChanged: boolean;
  isUniqueIdInit: boolean;
  currentCanonical: string;
  lastSavedCanonical: string;
}): boolean {
  if (!params.editable) {
    return false;
  }
  if (params.isHydrating || params.isUniqueIdInit) {
    return false;
  }
  if (!params.docChanged) {
    return false;
  }
  return params.currentCanonical !== params.lastSavedCanonical;
}

/**
 * Derives a short single-line title from the first non-empty block of TipTap content.
 */
export function deriveFirstLineTitle(doc: TipTapDoc): string {
  function extractInline(node: TipTapNode): string {
    if (node.type === 'text') {
      return node.text ?? '';
    }
    if (!Array.isArray(node.content)) {
      return '';
    }
    return node.content.map(extractInline).join('');
  }

  for (const node of doc.content ?? []) {
    const raw = extractInline(node).replace(/\s+/g, ' ').trim();
    if (raw) {
      return raw.slice(0, 80);
    }
  }
  return 'Untitled Note';
}
