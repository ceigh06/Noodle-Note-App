import {DiagnosticCheckResult, TipTapDoc} from '../types/noodle';
import {markdownToTiptap, tiptapToMarkdown} from './markdownCodec';
import {
  canonicalStringify,
  computeCanonicalContentHash,
  CURRENT_SCHEMA_VERSION,
  ensureBlockIds,
  migrateNote,
  shouldScheduleAutosave,
} from './noteSchema';
import {extractPlainText} from './plainText';

export async function runEditorDiagnostics(): Promise<DiagnosticCheckResult[]> {
  const results: DiagnosticCheckResult[] = [];

  // 1. Block IDs stable across save & reload
  {
    const start = performance.now();
    try {
      const initialDoc: TipTapDoc = ensureBlockIds({
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: {level: 1},
            content: [{type: 'text', text: 'Heading'}],
          },
          {
            type: 'paragraph',
            content: [{type: 'text', text: 'Body paragraph'}],
          },
        ],
      });

      const originalIds = initialDoc.content.map(
        (n) => n.attrs?.id as string | undefined,
      );
      const serialized = JSON.stringify({
        id: 'diag-stable-id-note',
        schemaVersion: CURRENT_SCHEMA_VERSION,
        title: 'Stable IDs',
        category: 'Study',
        pillar: 'manual',
        createdAt: '2026-11-21T00:00:00Z',
        updatedAt: '2026-11-21T00:00:00Z',
        contentHash: await computeCanonicalContentHash(initialDoc),
        content: initialDoc,
      });

      const reloaded = migrateNote(JSON.parse(serialized), 'manual').note;
      const reloadedIds = reloaded.content.content.map(
        (n) => n.attrs?.id as string | undefined,
      );

      const allPresent = originalIds.every(
        (id) => typeof id === 'string' && id.length > 10,
      );
      const exactMatch =
        originalIds.length === reloadedIds.length &&
        originalIds.every((id, idx) => id === reloadedIds[idx]);

      results.push({
        id: 'editor-block-ids-stable',
        name: 'Block IDs Stable Across Save & Reload',
        status: allPresent && exactMatch ? 'PASS' : 'FAIL',
        details:
          allPresent && exactMatch
            ? `Preserved ${originalIds.length} block UUIDs identically across JSON save/reload.`
            : 'Block UUIDs changed or were missing after reload.',
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      results.push({
        id: 'editor-block-ids-stable',
        name: 'Block IDs Stable Across Save & Reload',
        status: 'FAIL',
        details: (err as Error).message,
        durationMs: Math.round(performance.now() - start),
      });
    }
  }

  // 2. Migration of an old note
  {
    const start = performance.now();
    try {
      const legacyV0Note = {
        title: 'Legacy Unversioned Note',
        body: 'First legacy line\nSecond legacy line',
      };
      const {note, migrated} = migrateNote(legacyV0Note, 'manual');
      const allBlocksHaveIds = note.content.content.every(
        (n) => typeof n.attrs?.id === 'string' && n.attrs.id.length > 0,
      );
      const passed =
        migrated &&
        note.schemaVersion === CURRENT_SCHEMA_VERSION &&
        note.content.type === 'doc' &&
        note.content.content.length === 2 &&
        allBlocksHaveIds;

      results.push({
        id: 'editor-note-migration',
        name: 'Ordered Note Migration (v0 -> v2)',
        status: passed ? 'PASS' : 'FAIL',
        details: passed
          ? `Migrated legacy note to schemaVersion ${note.schemaVersion} with ${note.content.content.length} block UUIDs.`
          : 'Legacy note migration did not produce expected schemaVersion or block IDs.',
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      results.push({
        id: 'editor-note-migration',
        name: 'Ordered Note Migration (v0 -> v2)',
        status: 'FAIL',
        details: (err as Error).message,
        durationMs: Math.round(performance.now() - start),
      });
    }
  }

  // 3. Hash stable across key reordering
  {
    const start = performance.now();
    try {
      const docA: TipTapDoc = {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: {id: 'id-1', level: 2},
            content: [{type: 'text', text: 'Title'}],
          },
        ],
      };
      const docB: TipTapDoc = {
        content: [
          {
            content: [{text: 'Title', type: 'text'}],
            attrs: {level: 2, id: 'id-1'},
            type: 'heading',
          },
        ],
        type: 'doc',
      };
      const hashA = await computeCanonicalContentHash(docA);
      const hashB = await computeCanonicalContentHash(docB);
      const passed = hashA === hashB && hashA.startsWith('sha256:');

      results.push({
        id: 'editor-canonical-hash',
        name: 'Canonical Hash Stable Across Key Reordering',
        status: passed ? 'PASS' : 'FAIL',
        details: passed
          ? `Identical canonical SHA-256 digest (${hashA.slice(0, 19)}...) despite reordered keys.`
          : `Hashes diverged: ${hashA} vs ${hashB}`,
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      results.push({
        id: 'editor-canonical-hash',
        name: 'Canonical Hash Stable Across Key Reordering',
        status: 'FAIL',
        details: (err as Error).message,
        durationMs: Math.round(performance.now() - start),
      });
    }
  }

  // 4. Markdown round-trip on a fixture
  {
    const start = performance.now();
    try {
      const fixtureMd = [
        '# Study Guide',
        '',
        'Paragraph with **bold**, *italic*, ~~strike~~, `code`, and [link](https://example.com).',
        '',
        '- [ ] Unchecked task',
        '- [x] Checked task',
        '',
        '> Quoted thesis statement.',
        '',
        '| Term | Definition |',
        '| --- | --- |',
        '| Replay | Hippocampal reactivation |',
        '',
        '<script>alert("xss")</script>Clean tail',
      ].join('\n');

      const importedDoc = markdownToTiptap(fixtureMd);
      const exportedMd = tiptapToMarkdown(importedDoc);
      const reparsedDoc = markdownToTiptap(exportedMd);
      const plain = extractPlainText(reparsedDoc);

      const hasNoScript = !plain.text.includes('alert("xss")');
      const preservesCore =
        exportedMd.includes('# Study Guide') &&
        exportedMd.includes('- [ ] Unchecked task') &&
        exportedMd.includes('- [x] Checked task') &&
        exportedMd.includes('| Term | Definition |') &&
        plain.text.includes('Hippocampal reactivation') &&
        plain.text.includes('Clean tail');

      const passed = hasNoScript && preservesCore;
      results.push({
        id: 'editor-markdown-roundtrip',
        name: 'Markdown Round-Trip & HTML Stripping',
        status: passed ? 'PASS' : 'FAIL',
        details: passed
          ? `Round-tripped CommonMark + task list + table fixture (${plain.blocks.length} text blocks extracted) and stripped raw <script> HTML.`
          : 'Markdown round-trip fixture failed integrity or HTML-strip assertion.',
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      results.push({
        id: 'editor-markdown-roundtrip',
        name: 'Markdown Round-Trip & HTML Stripping',
        status: 'FAIL',
        details: (err as Error).message,
        durationMs: Math.round(performance.now() - start),
      });
    }
  }

  // 5. No autosave on open
  {
    const start = performance.now();
    try {
      const sample: TipTapDoc = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: {id: 'blk-1'},
            content: [{type: 'text', text: 'Initial content'}],
          },
        ],
      };
      const canonical = canonicalStringify(sample);
      const onHydrate = shouldScheduleAutosave({
        editable: true,
        isHydrating: true,
        docChanged: true,
        isUniqueIdInit: false,
        currentCanonical: canonical,
        lastSavedCanonical: canonical,
      });
      const onUniqueIdInit = shouldScheduleAutosave({
        editable: true,
        isHydrating: false,
        docChanged: true,
        isUniqueIdInit: true,
        currentCanonical: canonical,
        lastSavedCanonical: canonical,
      });
      const onUnchanged = shouldScheduleAutosave({
        editable: true,
        isHydrating: false,
        docChanged: true,
        isUniqueIdInit: false,
        currentCanonical: canonical,
        lastSavedCanonical: canonical,
      });
      const onRealEdit = shouldScheduleAutosave({
        editable: true,
        isHydrating: false,
        docChanged: true,
        isUniqueIdInit: false,
        currentCanonical: canonicalStringify({
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              attrs: {id: 'blk-1'},
              content: [{type: 'text', text: 'Edited content'}],
            },
          ],
        }),
        lastSavedCanonical: canonical,
      });

      const passed = !onHydrate && !onUniqueIdInit && !onUnchanged && onRealEdit;
      results.push({
        id: 'editor-no-autosave-open',
        name: 'No Autosave on Open Guard',
        status: passed ? 'PASS' : 'FAIL',
        details: passed
          ? 'Blocked autosave during hydration, UniqueID init, and unchanged content; enabled on user edit.'
          : 'Autosave guard failed one or more open/edit conditions.',
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      results.push({
        id: 'editor-no-autosave-open',
        name: 'No Autosave on Open Guard',
        status: 'FAIL',
        details: (err as Error).message,
        durationMs: Math.round(performance.now() - start),
      });
    }
  }

  return results;
}
