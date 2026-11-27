import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cancelChatPreview,
  executeApprovedChatQuery,
  extractRelevantNoteExcerpts,
  formatChatAsAiNote,
  parseCitedBlockIds,
  prepareChatPreview,
} from '../../cloud/chatService';
import {
  buildGapAnalysisReport,
  cancelSyllabusPreview,
  executeApprovedSyllabusExtraction,
  mapTopicsAgainstLocalIndex,
  parseSyllabusTopicsResponse,
  prepareSyllabusPreview,
} from '../../cloud/gapAnalysisService';
import {
  decryptApiKeyWithPassphrase,
  encryptApiKeyWithPassphrase,
  redactSecretFromText,
} from '../../cloud/keyVault';
import {
  buildExcerptSynthesisPrompt,
  getProviderAdapter,
  mapAnswerCitations,
} from '../../cloud/providerAdapter';
import {
  buildTipTapDocFromSynthesis,
  MAX_CLOUD_EXCERPT_CHARS,
  parseAndValidateSynthesisOutput,
  sanitizeAndCapExcerpt,
} from '../../cloud/synthesisOutput';
import type {NoteIndexRow} from '../../db/noodleDb';
import {
  buildPdfCoordKey,
  buildSampleAcademicPdfBytes,
  computeBoundingBox,
  normalizeSelectionRects,
  sortPdfAnnotations,
} from '../../pdf/pdfAnnotations';
import {
  chunkPdfPages,
  chunkPlainTextSource,
  chunkTipTapDocument,
  computeCosineSimilarity,
  scoreWordMatch,
} from '../../search/chunker';
import {
  addSubfolderToCategory,
  addTopCategory,
  deleteSubfolderInCategory,
  deleteTopCategory,
  getCategoryStyle,
  getDefaultCategoryConfigs,
  mergeDiscoveredNoteCategories,
  renameSubfolderInCategory,
  renameTopCategory,
  updateTopCategoryColor,
} from '../../storage/categoryConfig';
import {
  OwnWriteExpectation,
  reconcileWorkspaceSnapshot,
} from '../../storage/changeDetector';
import {
  parseWorkspaceRelativeNoteTarget,
  summarizeWorkspaceFolderEntries,
} from '../../storage/workspaceStorage';
import {
  CloudRetrievedExcerpt,
  ScanProblem,
  StoredNoteEntry,
  TipTapDoc,
} from '../../types/noodle';
import {markdownToTiptap, tiptapToMarkdown} from '../markdownCodec';
import {
  canonicalStringify,
  computeCanonicalContentHash,
  CURRENT_SCHEMA_VERSION,
  ensureBlockIds,
  extractAssetPathsFromDoc,
  formatMissingImageMessage,
  isAllowedLinkUrl,
  isWorkspaceRelativeAssetPath,
  migrateNote,
  shouldScheduleAutosave,
  validateNoteAssetPaths,
} from '../noteSchema';
import {extractPlainText} from '../plainText';
import {
  concatenateFloat32Chunks,
  getActiveMicrophoneTrackCount,
  getTrackedAudioContextCount,
  getTrackedStreamCount,
  killAllMicrophoneAccess,
  prepareAudioForWhisper,
  registerAudioContext,
  registerMicrophoneStream,
  registerMicrophoneTeardownHook,
  resampleTo16kMono,
  zeroOutChunks,
} from '../../voice/microphoneController';
import {startPorcupineWakeWord} from '../../voice/porcupineWakeWord';
import {cleanWhisperTranscript} from '../../voice/transcriptCleaner';
import {
  getDefaultVoiceSearchSettings,
  matchesPushToTalkHotkey,
} from '../../voice/voiceConfig';
import {runVoiceDiagnostics} from '../../voice/voiceDiagnostics';

test('extractPlainText returns document-order blocks with blockIds and joined text', () => {
  const doc: TipTapDoc = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: {id: 'h-1', level: 1},
        content: [{type: 'text', text: 'Lecture Title'}],
      },
      {
        type: 'paragraph',
        attrs: {id: 'p-1'},
        content: [
          {type: 'text', text: 'First line'},
          {type: 'hardBreak'},
          {type: 'text', text: 'continued'},
        ],
      },
      {
        type: 'bulletList',
        attrs: {id: 'ul-1'},
        content: [
          {
            type: 'listItem',
            attrs: {id: 'li-1'},
            content: [
              {
                type: 'paragraph',
                attrs: {id: 'p-2'},
                content: [{type: 'text', text: 'Nested item'}],
              },
            ],
          },
        ],
      },
      {
        type: 'paragraph',
        attrs: {id: 'p-empty'},
        content: [],
      },
      {
        type: 'table',
        attrs: {id: 'tbl-1'},
        content: [
          {
            type: 'tableRow',
            attrs: {id: 'tr-1'},
            content: [
              {
                type: 'tableHeader',
                attrs: {id: 'th-1'},
                content: [
                  {
                    type: 'paragraph',
                    attrs: {id: 'p-3'},
                    content: [{type: 'text', text: 'Header'}],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const result = extractPlainText(doc);
  assert.deepEqual(result.blocks, [
    {blockId: 'h-1', text: 'Lecture Title'},
    {blockId: 'p-1', text: 'First line\ncontinued'},
    {blockId: 'p-2', text: 'Nested item'},
    {blockId: 'p-3', text: 'Header'},
  ]);
  assert.equal(
    result.text,
    'Lecture Title\nFirst line\ncontinued\nNested item\nHeader',
  );
});

test('computeCanonicalContentHash is invariant to object key reordering', async () => {
  const doc1: TipTapDoc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: {id: 'blk-a', level: 1},
        content: [{type: 'text', text: 'Canonical hash test'}],
      },
    ],
  };
  const doc2: TipTapDoc = {
    content: [
      {
        content: [{text: 'Canonical hash test', type: 'text'}],
        attrs: {level: 1, id: 'blk-a'},
        type: 'paragraph',
      },
    ],
    type: 'doc',
  };

  const h1 = await computeCanonicalContentHash(doc1);
  const h2 = await computeCanonicalContentHash(doc2);
  assert.equal(h1, h2);
});

test('migrateNote upgrades unversioned legacy notes and preserves existing block IDs', () => {
  const legacy = {
    title: 'Old Note',
    body: 'Alpha\nBeta',
  };
  const {note, migrated} = migrateNote(legacy, 'manual');
  assert.equal(migrated, true);
  assert.equal(note.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(note.content.content.length, 2);

  const firstId = note.content.content[0].attrs?.id;
  assert.equal(typeof firstId, 'string');

  const secondPass = migrateNote(note, 'manual');
  assert.equal(secondPass.migrated, false);
  assert.equal(secondPass.note.content.content[0].attrs?.id, firstId);

  // ensureBlockIds never overwrites existing ids
  const ensured = ensureBlockIds(note.content);
  assert.equal(ensured.content[0].attrs?.id, firstId);
});

test('isAllowedLinkUrl permits only http, https, and mailto', () => {
  assert.equal(isAllowedLinkUrl('https://example.com/paper'), true);
  assert.equal(isAllowedLinkUrl('http://localhost:3000'), true);
  assert.equal(isAllowedLinkUrl('mailto:student@university.edu'), true);
  assert.equal(isAllowedLinkUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedLinkUrl('data:text/html,<h1>x</h1>'), false);
  assert.equal(isAllowedLinkUrl('/relative/path'), false);
});

test('markdownCodec round-trips CommonMark + tables + task lists and strips raw HTML', () => {
  const md = [
    '# Title',
    '',
    'Hello **world** and [safe](https://example.com) and [bad](javascript:alert(1)).',
    '',
    '- [ ] Todo 1',
    '- [x] Done 2',
    '',
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '<div onclick="evil()">Inline</div><script>steal()</script><scr<script></script>ipt>nestedSteal()</script><iframe src="https://evil.example">hidden</iframe>',
  ].join('\n');

  const doc = markdownToTiptap(md);
  const exported = tiptapToMarkdown(doc);
  const plain = extractPlainText(doc);

  assert.ok(exported.includes('# Title'));
  assert.ok(exported.includes('- [ ] Todo 1'));
  assert.ok(exported.includes('- [x] Done 2'));
  assert.ok(exported.includes('| A | B |'));
  assert.ok(!exported.includes('javascript:'));
  assert.ok(!plain.text.includes('steal()'));
  assert.ok(!plain.text.includes('nestedSteal()'));
  assert.ok(!plain.text.includes('hidden'));
  assert.ok(plain.text.includes('Inline'));
});

test('shouldScheduleAutosave blocks autosave on open/hydration and allows real edits', () => {
  const doc: TipTapDoc = {
    type: 'doc',
    content: [{type: 'paragraph', attrs: {id: '1'}, content: [{type: 'text', text: 'A'}]}],
  };
  const canon = canonicalStringify(doc);

  assert.equal(
    shouldScheduleAutosave({
      editable: true,
      isHydrating: true,
      docChanged: true,
      isUniqueIdInit: false,
      currentCanonical: canon,
      lastSavedCanonical: canon,
    }),
    false,
  );
  assert.equal(
    shouldScheduleAutosave({
      editable: true,
      isHydrating: false,
      docChanged: true,
      isUniqueIdInit: false,
      currentCanonical: canon,
      lastSavedCanonical: 'different',
    }),
    true,
  );
});

test('isWorkspaceRelativeAssetPath accepts assets/<name> and rejects traversal or absolute paths', () => {
  assert.equal(isWorkspaceRelativeAssetPath('assets/diagram-a1b2c3d4.png'), true);
  assert.equal(isWorkspaceRelativeAssetPath('assets/scan.webp'), true);
  assert.equal(isWorkspaceRelativeAssetPath('/Users/student/pic.png'), false);
  assert.equal(isWorkspaceRelativeAssetPath('C:\\Users\\pic.png'), false);
  assert.equal(isWorkspaceRelativeAssetPath('assets/../manual/note.json'), false);
  assert.equal(isWorkspaceRelativeAssetPath('https://example.com/a.png'), false);
  assert.equal(isWorkspaceRelativeAssetPath('data:image/png;base64,AAA'), false);
  assert.equal(isWorkspaceRelativeAssetPath('manual/image.png'), false);
});

test('validateNoteAssetPaths and extractAssetPathsFromDoc enforce relative assets/', () => {
  const validDoc: TipTapDoc = {
    type: 'doc',
    content: [
      {
        type: 'image',
        attrs: {id: 'img-1', src: 'assets/one-11111111.png', alt: 'One'},
      },
      {
        type: 'image',
        attrs: {id: 'img-2', src: 'assets/one-11111111.png', alt: 'Dup'},
      },
    ],
  };

  assert.doesNotThrow(() => validateNoteAssetPaths(validDoc));
  assert.deepEqual(extractAssetPathsFromDoc(validDoc), [
    'assets/one-11111111.png',
  ]);

  const invalidDoc: TipTapDoc = {
    type: 'doc',
    content: [
      {
        type: 'image',
        attrs: {id: 'img-bad', src: '/tmp/absolute.png'},
      },
    ],
  };
  assert.throws(() => validateNoteAssetPaths(invalidDoc));
  assert.equal(
    formatMissingImageMessage('assets/missing.png'),
    'Image not found: assets/missing.png',
  );
});

test('markdownCodec round-trips workspace-relative images and omits external/absolute image URLs', () => {
  const md = [
    '# Visual Note',
    '',
    '![Diagram](assets/diagram-12345678.png)',
    '',
    '![Remote](https://evil.example/track.png)',
    '',
    '![Absolute](/etc/passwd)',
  ].join('\n');

  const doc = markdownToTiptap(md);
  const paths = extractAssetPathsFromDoc(doc);
  assert.deepEqual(paths, ['assets/diagram-12345678.png']);

  const exported = tiptapToMarkdown(doc);
  assert.ok(exported.includes('![Diagram](assets/diagram-12345678.png)'));
  assert.ok(!exported.includes('https://evil.example'));
  assert.ok(!exported.includes('/etc/passwd'));
});

function makeIndexRow(overrides: Partial<NoteIndexRow> = {}): NoteIndexRow {
  return {
    id: 'uuid-note-1',
    path: 'manual/note-1.json',
    pillar: 'manual',
    fileName: 'note-1.json',
    title: 'Note One',
    category: 'Study',
    updatedAt: '2026-01-01T00:00:00.000Z',
    contentHash: 'sha256:hash-1',
    size: 250,
    lastModified: 1700000000000,
    ...overrides,
  };
}

function makeScannedEntry(
  overrides: Partial<StoredNoteEntry> & {
    noteOverrides?: Partial<StoredNoteEntry['note']>;
  } = {},
): StoredNoteEntry {
  const {noteOverrides, ...entryOverrides} = overrides;
  const pillar = entryOverrides.pillar ?? noteOverrides?.pillar ?? 'manual';
  const fileName = entryOverrides.fileName ?? 'note-1.json';
  return {
    fileName,
    pillar,
    excerpt: 'Hello',
    wordCount: 1,
    path: `${pillar}/${fileName}`,
    size: 250,
    lastModified: 1700000000000,
    ...entryOverrides,
    note: {
      id: 'uuid-note-1',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      title: 'Note One',
      category: 'Study',
      pillar,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      contentHash: 'sha256:hash-1',
      content: {
        type: 'doc',
        content: [{type: 'paragraph', attrs: {id: 'blk-1'}, content: [{type: 'text', text: 'Hello'}]}],
      },
      ...noteOverrides,
    },
  };
}

test('reconcileWorkspaceSnapshot detects folder moves by UUID and preserves identity', () => {
  const prev = [makeIndexRow()];
  const movedEntry = makeScannedEntry({
    pillar: 'ai',
    fileName: 'nested/note-1.json',
    path: 'ai/nested/note-1.json',
    noteOverrides: {pillar: 'ai'},
  });

  const res = reconcileWorkspaceSnapshot({
    previousIndex: prev,
    scannedEntries: [movedEntry],
    ownWrites: new Map(),
  });

  assert.equal(res.moved.length, 1);
  assert.equal(res.moved[0].noteId, 'uuid-note-1');
  assert.equal(res.moved[0].fromPath, 'manual/note-1.json');
  assert.equal(res.moved[0].toPath, 'ai/nested/note-1.json');
  assert.equal(res.added.length, 0);
  assert.equal(res.deletedNoteIds.length, 0);
  assert.equal(res.upserts.length, 1);
});

test('reconcileWorkspaceSnapshot falls back to contentHash matching on moves', () => {
  const prev = [
    makeIndexRow({
      id: 'original-uuid',
      path: 'manual/old.json',
      fileName: 'old.json',
      contentHash: 'sha256:same-content',
    }),
  ];
  const movedDifferentId = makeScannedEntry({
    pillar: 'ai',
    fileName: 'copied.json',
    path: 'ai/copied.json',
    noteOverrides: {
      id: 'regenerated-uuid',
      pillar: 'ai',
      contentHash: 'sha256:same-content',
    },
  });

  const res = reconcileWorkspaceSnapshot({
    previousIndex: prev,
    scannedEntries: [movedDifferentId],
    ownWrites: new Map(),
  });

  assert.equal(res.moved.length, 1);
  assert.equal(res.moved[0].noteId, 'original-uuid');
  assert.equal(res.entries[0].note.id, 'original-uuid');
  assert.equal(res.deletedNoteIds.length, 0);
  assert.equal(res.added.length, 0);
});

test('reconcileWorkspaceSnapshot detects external edits on contentHash or title changes', () => {
  const prev = [makeIndexRow()];
  const editedTitleEntry = makeScannedEntry({
    lastModified: 1700000005000,
    noteOverrides: {title: 'Externally Edited Title'},
  });

  const res = reconcileWorkspaceSnapshot({
    previousIndex: prev,
    scannedEntries: [editedTitleEntry],
    ownWrites: new Map(),
  });

  assert.equal(res.edited.length, 1);
  assert.equal(res.edited[0].note.id, 'uuid-note-1');
  assert.equal(res.upserts.length, 1);
});

test('reconcileWorkspaceSnapshot ignores own writes and own deletes cleanly', () => {
  const prev = [
    makeIndexRow({id: 'n-1', path: 'manual/n1.json', fileName: 'n1.json'}),
    makeIndexRow({id: 'n-2', path: 'manual/n2.json', fileName: 'n2.json', contentHash: 'sha256:h2'}),
  ];
  const ownWrites = new Map<string, OwnWriteExpectation>([
    [
      'manual/n1.json',
      {
        path: 'manual/n1.json',
        noteId: 'n-1',
        contentHash: 'sha256:updated-by-app',
        writtenAt: Date.now(),
        op: 'write',
      },
    ],
    [
      'manual/n2.json',
      {
        path: 'manual/n2.json',
        noteId: 'n-2',
        contentHash: 'sha256:h2',
        writtenAt: Date.now(),
        op: 'delete',
      },
    ],
  ]);

  const scanned = [
    makeScannedEntry({
      fileName: 'n1.json',
      path: 'manual/n1.json',
      lastModified: 1700000009999,
      noteOverrides: {id: 'n-1', contentHash: 'sha256:updated-by-app'},
    }),
  ];

  const res = reconcileWorkspaceSnapshot({
    previousIndex: prev,
    scannedEntries: scanned,
    ownWrites,
  });

  assert.equal(res.edited.length, 0);
  assert.equal(res.added.length, 0);
  assert.equal(res.moved.length, 0);
  assert.equal(res.deletedNoteIds.length, 0);
  assert.equal(res.ignoredOwnWritesCount, 2);
});

test('reconcileWorkspaceSnapshot preserves previous index entry when file is malformed in problems', () => {
  const prev = [
    makeIndexRow({id: 'valid-1', path: 'manual/ok.json', fileName: 'ok.json'}),
    makeIndexRow({id: 'broken-1', path: 'manual/broken.json', fileName: 'broken.json'}),
  ];
  const scanned = [
    makeScannedEntry({
      fileName: 'ok.json',
      path: 'manual/ok.json',
      noteOverrides: {id: 'valid-1'},
    }),
  ];
  const problems: ScanProblem[] = [
    {
      id: 'manual/broken.json',
      path: 'manual/broken.json',
      pillar: 'manual',
      fileName: 'broken.json',
      reason: 'Unexpected token',
      detectedAt: '2026-01-01T00:00:00.000Z',
    },
  ];

  const res = reconcileWorkspaceSnapshot({
    previousIndex: prev,
    scannedEntries: scanned,
    ownWrites: new Map(),
    problems,
  });

  assert.equal(res.entries.length, 1);
  assert.equal(res.deletedNoteIds.length, 0);
});

test('chunkTipTapDocument builds hierarchical heading paths and preserves blockId per chunk', () => {
  const doc: TipTapDoc = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: {id: 'h1-neuro', level: 1},
        content: [{type: 'text', text: 'Memory Systems'}],
      },
      {
        type: 'heading',
        attrs: {id: 'h2-hippo', level: 2},
        content: [{type: 'text', text: 'Hippocampus'}],
      },
      {
        type: 'paragraph',
        attrs: {id: 'p-replay'},
        content: [
          {
            type: 'text',
            text: 'Sharp-wave ripples coordinate replay with neocortical spindles.',
          },
        ],
      },
      {
        type: 'heading',
        attrs: {id: 'h1-systems', level: 1},
        content: [{type: 'text', text: 'Distributed Systems'}],
      },
      {
        type: 'paragraph',
        attrs: {id: 'p-raft'},
        content: [{type: 'text', text: 'Raft elects one leader per term.'}],
      },
    ],
  };

  const chunks = chunkTipTapDocument('note-1', 'Study Note', doc);
  const replayChunk = chunks.find((c) => c.blockId === 'p-replay');
  const raftChunk = chunks.find((c) => c.blockId === 'p-raft');

  assert.ok(replayChunk);
  assert.deepEqual(replayChunk.headingPath, ['Memory Systems', 'Hippocampus']);
  assert.ok(replayChunk.embedText.includes('Memory Systems > Hippocampus'));

  assert.ok(raftChunk);
  assert.deepEqual(raftChunk.headingPath, ['Distributed Systems']);
});

test('chunkPlainTextSource and chunkPdfPages produce deterministic blockIds and sections', () => {
  const mdChunks = chunkPlainTextSource(
    '# Intro\n\nFirst paragraph about attention.\n\n## Details\n\nScaled dot-product formula.',
    'md',
  );
  assert.equal(mdChunks.length, 4);
  assert.deepEqual(mdChunks[1].headingPath, ['Intro']);
  assert.equal(mdChunks[1].text, 'First paragraph about attention.');
  assert.deepEqual(mdChunks[3].headingPath, ['Intro', 'Details']);
  assert.equal(mdChunks[3].text, 'Scaled dot-product formula.');

  const pdfChunks = chunkPdfPages([
    {
      pageNumber: 1,
      text: 'Abstract: Local vector search keeps private student notes on device.',
    },
    {
      pageNumber: 2,
      text: 'Conclusion: Explicit backlinks point to stable block identifiers.',
    },
  ]);
  assert.equal(pdfChunks.length, 2);
  assert.equal(pdfChunks[0].pageNumber, 1);
  assert.equal(pdfChunks[1].pageNumber, 2);
  assert.ok(pdfChunks[0].blockId.startsWith('page-1-'));
});

test('computeCosineSimilarity and scoreWordMatch rank matching blocks cleanly', () => {
  const same = computeCosineSimilarity([1, 0, 0], [1, 0, 0]);
  const orthogonal = computeCosineSimilarity([1, 0, 0], [0, 1, 0]);
  assert.equal(same, 1);
  assert.equal(orthogonal, 0);

  const high = scoreWordMatch(
    'hippocampal ripple consolidation',
    'Sharp-wave ripples drive hippocampal memory consolidation.',
    'Neuro Notes',
    ['Sleep'],
  );
  const low = scoreWordMatch(
    'hippocampal ripple consolidation',
    'TCP congestion control uses slow start.',
    'Networks',
    ['Transport'],
  );
  assert.ok(high > low);
  assert.equal(low, 0);
});

test('redactSecretFromText scrubs OpenAI, Anthropic, Google, Bearer, and query-param keys', () => {
  const secret = 'sk-test-noodle-9876543210';
  const raw =
    `Error calling endpoint with ${secret}, Bearer tok_abcdef123456, ` +
    'sk-ant-api03-secretvalue12345, AIzaSyDummyKeyValue12345678, and ?key=secretInUrl';
  const scrubbed = redactSecretFromText(raw, secret);

  assert.ok(!scrubbed.includes(secret));
  assert.ok(!scrubbed.includes('tok_abcdef123456'));
  assert.ok(!scrubbed.includes('sk-ant-api03-secretvalue12345'));
  assert.ok(!scrubbed.includes('AIzaSyDummyKeyValue12345678'));
  assert.ok(!scrubbed.includes('secretInUrl'));
});

test('encryptApiKeyWithPassphrase and decryptApiKeyWithPassphrase round-trip and reject wrong passphrases', async () => {
  const apiKey = 'AIzaSyTestExampleKey99887766';
  const record = await encryptApiKeyWithPassphrase({
    provider: 'gemini',
    apiKey,
    passphrase: 'correct-study-passphrase',
    model: 'gemini-2.5-flash',
    iterations: 5_000,
  });

  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes(apiKey));
  assert.ok(!serialized.includes('correct-study-passphrase'));

  const decrypted = await decryptApiKeyWithPassphrase(
    record,
    'correct-study-passphrase',
  );
  assert.equal(decrypted, apiKey);

  await assert.rejects(
    decryptApiKeyWithPassphrase(record, 'wrong-passphrase'),
    /Incorrect passphrase/i,
  );
});

test('buildExcerptSynthesisPrompt and mapAnswerCitations send only retrieved excerpts and link citations', () => {
  const excerpts: CloudRetrievedExcerpt[] = [
    {
      citationNumber: 1,
      chunkId: 'n1::b1',
      noteId: 'note-1',
      blockId: 'b1',
      kind: 'note',
      pillar: 'manual',
      sourceTitle: 'Sleep Consolidation',
      sourcePath: 'manual/sleep-consolidation.json',
      headingPath: ['Stages', 'NREM'],
      text: 'Slow-wave sleep replays hippocampal traces.',
      score: 0.88,
      scoreLabel: 'semantic similarity',
    },
    {
      citationNumber: 2,
      chunkId: 's1::page-3-0',
      noteId: 'source-1',
      blockId: 'page-3-0',
      kind: 'source',
      pillar: 'sources',
      sourceTitle: 'Neuro Textbook.pdf',
      sourcePath: 'sources/neuro-textbook.pdf',
      headingPath: ['Page 3'],
      text: 'Sleep spindles gate cortical plasticity.',
      score: 0.81,
      scoreLabel: 'semantic similarity',
    },
  ];

  const {userPrompt} = buildExcerptSynthesisPrompt(
    'How does NREM sleep help memory?',
    excerpts,
  );
  assert.ok(userPrompt.includes('[1] Source: "Sleep Consolidation"'));
  assert.ok(userPrompt.includes('Slow-wave sleep replays hippocampal traces.'));
  assert.ok(!userPrompt.includes('UNRETRIEVED_PRIVATE_NOTE_TEXT'));

  const {citedNumbers, citations} = mapAnswerCitations(
    'Consolidation combines hippocampal replay [1] with sleep spindles [2] and ignores invalid [99].',
    excerpts,
  );
  assert.deepEqual(citedNumbers, [1, 2]);
  assert.equal(citations.length, 2);
  assert.equal(citations[0].noteId, 'note-1');
  assert.equal(citations[0].blockId, 'b1');
  assert.equal(citations[1].noteId, 'source-1');
  assert.equal(citations[1].blockId, 'page-3-0');
});

test('cloud provider adapters send browser CORS headers without URL keys and redact 401 failures', async () => {
  const captured: Array<{url: string; headers: Record<string, string>}> = [];

  const mock401Fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(input),
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    const usedKey =
      (init?.headers as Record<string, string>)?.['x-goog-api-key'] ||
      (init?.headers as Record<string, string>)?.['x-api-key'] ||
      (init?.headers as Record<string, string>)?.Authorization ||
      '';
    return new Response(
      JSON.stringify({error: {message: `Invalid key rejected: ${usedKey}`}}),
      {status: 401, headers: {'Content-Type': 'application/json'}},
    );
  }) as typeof fetch;

  const geminiKey = 'AIzaSyMockRejected1234567890';
  const geminiRes = await getProviderAdapter('gemini').testConnection(
    geminiKey,
    'gemini-2.5-flash',
    mock401Fetch,
  );
  assert.equal(geminiRes.ok, false);
  assert.equal(geminiRes.status, 401);
  assert.ok(!captured[0].url.includes('?key='));
  assert.equal(captured[0].headers['x-goog-api-key'], geminiKey);
  assert.ok(!geminiRes.message.includes(geminiKey));

  const anthropicKey = 'sk-ant-mock-rejected-12345678';
  const anthropicRes = await getProviderAdapter('anthropic').testConnection(
    anthropicKey,
    undefined,
    mock401Fetch,
  );
  assert.equal(anthropicRes.ok, false);
  assert.equal(
    captured[1].headers['anthropic-dangerous-direct-browser-access'],
    'true',
  );
  assert.equal(captured[1].headers['x-api-key'], anthropicKey);
  assert.ok(!anthropicRes.message.includes(anthropicKey));

  const openaiKey = 'sk-proj-mockrejected12345678';
  const openaiRes = await getProviderAdapter('openai').testConnection(
    openaiKey,
    undefined,
    mock401Fetch,
  );
  assert.equal(openaiRes.ok, false);
  assert.equal(captured[2].headers.Authorization, `Bearer ${openaiKey}`);
  assert.ok(!openaiRes.message.includes(openaiKey));
});

test('sanitizeAndCapExcerpt strips scripts/HTML/markdown URLs and enforces length cap', () => {
  const dirty =
    '<script>stealKey()</script><p>Important <b>derivative</b> note [link](https://example.com) ' +
    'javascript:alert(1) ' +
    'word '.repeat(260) +
    '</p>';
  const res = sanitizeAndCapExcerpt(dirty);

  assert.equal(res.hadMarkupStripped, true);
  assert.equal(res.wasTruncated, true);
  assert.ok(res.text.length <= MAX_CLOUD_EXCERPT_CHARS);
  assert.ok(!res.text.includes('<script>'));
  assert.ok(!res.text.includes('stealKey'));
  assert.ok(!res.text.includes('javascript:'));
  assert.ok(!res.text.includes('https://example.com'));
  assert.ok(res.text.includes('Important derivative note link'));
});

test('buildExcerptSynthesisPrompt includes retention-biased directive and format schema', () => {
  const {systemInstruction, userPrompt} = buildExcerptSynthesisPrompt(
    'Prepare calculus flashcards',
    [
      {
        citationNumber: 1,
        chunkId: 'n1::b1',
        noteId: 'n1',
        blockId: 'b1',
        kind: 'note',
        pillar: 'manual',
        sourceTitle: 'Calculus Lecture',
        sourcePath: 'manual/calc.json',
        headingPath: ['Chain Rule'],
        text: 'Chain rule peels the onion from outer layer to inner layer.',
        score: 0.9,
        scoreLabel: 'semantic similarity',
      },
    ],
    'flashcards',
  );

  assert.ok(/RETENTION-BIASED GENERATION/i.test(systemInstruction));
  assert.ok(systemInstruction.includes('"flashcards"'));
  assert.ok(systemInstruction.includes('"preservedFromNotes"'));
  assert.ok(userPrompt.includes('peels the onion'));
});

test('parseAndValidateSynthesisOutput rejects malformed responses and builds TipTap JSON with aiMeta', () => {
  const excerpts: CloudRetrievedExcerpt[] = [
    {
      citationNumber: 1,
      chunkId: 'n1::b1',
      noteId: 'note-calc-1',
      blockId: 'blk-calc-1',
      kind: 'note',
      pillar: 'manual',
      sourceTitle: 'Calc Notes',
      sourcePath: 'manual/calc.json',
      headingPath: ['Derivatives'],
      text: 'Power rule drops the exponent down in front.',
      score: 0.91,
      scoreLabel: 'semantic similarity',
    },
  ];

  // Reject malformed JSON
  assert.throws(
    () =>
      parseAndValidateSynthesisOutput('not json at all', 'study-guide', excerpts),
    /malformed JSON/i,
  );

  // Reject invalid practice-exam question missing valid correctIndex
  assert.throws(
    () =>
      parseAndValidateSynthesisOutput(
        JSON.stringify({
          title: 'Bad Exam',
          sections: [{heading: 'A', body: 'B', citations: [1], preservedFromNotes: false}],
          examQuestions: [
            {
              prompt: 'Q1?',
              options: ['A', 'B'],
              correctIndex: 5,
              explanation: 'Out of bounds',
            },
          ],
        }),
        'practice-exam',
        excerpts,
      ),
    /invalid prompt, options, correctIndex/i,
  );

  // Valid flashcards JSON -> builds TipTap JSON doc + aiMeta + citation block mapping
  const valid = parseAndValidateSynthesisOutput(
    JSON.stringify({
      title: 'Derivative Recall Deck',
      summary: 'Covers power rule [1].',
      preservedPhrases: ['drops the exponent down in front'],
      sections: [
        {
          heading: 'Core Rule',
          body: 'Power rule drops the exponent down in front [1].',
          citations: [1],
          preservedFromNotes: true,
        },
      ],
      flashcards: [
        {
          front: 'How does the power rule work?',
          back: 'It drops the exponent down in front [1].',
          hint: 'Think exponent step-down',
          citations: [1],
          preservedFromNotes: true,
        },
      ],
    }),
    'flashcards',
    excerpts,
  );

  const built = buildTipTapDocFromSynthesis({
    output: valid,
    excerpts,
    provider: 'gemini',
    providerLabel: 'Google Gemini',
    model: 'gemini-2.5-flash',
    question: 'Derivative flashcards',
    generatedAt: '2026-11-21T10:00:00.000Z',
  });

  assert.equal(built.doc.type, 'doc');
  assert.ok(built.doc.content.length >= 4);
  assert.equal(built.aiMeta.isAiGenerated, true);
  assert.equal(built.aiMeta.format, 'flashcards');
  assert.equal(built.aiMeta.flashcards?.length, 1);
  assert.equal(built.aiMeta.sourcesUsed[0].blockId, 'blk-calc-1');
  assert.ok(typeof built.blockIdByCitationNumber.get(1) === 'string');
});

test('extractRelevantNoteExcerpts selects only relevant blocks and preserves block IDs', () => {
  const sampleNote: StoredNoteEntry = {
    fileName: 'dna.json',
    pillar: 'manual',
    path: 'manual/dna.json',
    excerpt: 'DNA transcription note',
    wordCount: 40,
    note: {
      id: 'note-bio-1',
      schemaVersion: 1,
      title: 'Molecular Genetics',
      category: 'Study',
      pillar: 'manual',
      createdAt: '2026-11-22T00:00:00.000Z',
      updatedAt: '2026-11-22T00:00:00.000Z',
      contentHash: 'hash-bio-1',
      content: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: {id: 'blk-dna-h1', level: 1},
            content: [{type: 'text', text: 'Central Dogma'}],
          },
          {
            type: 'paragraph',
            attrs: {id: 'blk-dna-p1'},
            content: [
              {
                type: 'text',
                text: 'DNA helicase unzips the double helix during replication.',
              },
            ],
          },
          {
            type: 'paragraph',
            attrs: {id: 'blk-dna-p2'},
            content: [
              {
                type: 'text',
                text: 'RNA polymerase synthesizes messenger RNA from the template strand.',
              },
            ],
          },
          {
            type: 'paragraph',
            attrs: {id: 'blk-dna-secret'},
            content: [
              {
                type: 'text',
                text: 'UNRETRIEVED_PRIVATE_STORY_AND_JOURNAL_DETAILS',
              },
            ],
          },
        ],
      },
    },
  };

  const excerpts = extractRelevantNoteExcerpts(sampleNote, 'RNA polymerase template', 1);
  assert.equal(excerpts.length, 1);
  assert.equal(excerpts[0].blockId, 'blk-dna-p2');
  assert.ok(excerpts[0].text.includes('RNA polymerase'));
  assert.ok(!excerpts[0].text.includes('UNRETRIEVED_PRIVATE_STORY_AND_JOURNAL_DETAILS'));
  assert.equal(excerpts[0].noteId, 'note-bio-1');
  assert.equal(excerpts[0].sourceTitle, 'Molecular Genetics');
});

test('parseCitedBlockIds extracts explicit [block: <id>] and maps numeric citations', () => {
  const excerpts: CloudRetrievedExcerpt[] = [
    {
      citationNumber: 1,
      chunkId: 'n1::b1',
      noteId: 'n1',
      blockId: 'blk-helices-1',
      kind: 'note',
      pillar: 'manual',
      sourceTitle: 'Biology',
      sourcePath: 'manual/bio.json',
      headingPath: [],
      text: 'Alpha helices are coiled secondary structures.',
      score: 0.9,
      scoreLabel: 'word match',
    },
    {
      citationNumber: 2,
      chunkId: 'n1::b2',
      noteId: 'n1',
      blockId: 'blk-sheets-2',
      kind: 'note',
      pillar: 'manual',
      sourceTitle: 'Biology',
      sourcePath: 'manual/bio.json',
      headingPath: [],
      text: 'Beta pleated sheets form planar arrays.',
      score: 0.85,
      scoreLabel: 'word match',
    },
  ];

  const parsed1 = parseCitedBlockIds(
    'Alpha helices coil [block: blk-helices-1] and beta sheets lay flat [block: blk-sheets-2].',
    excerpts,
  );
  assert.deepEqual(parsed1.citedBlockIds, ['blk-helices-1', 'blk-sheets-2']);
  assert.equal(parsed1.citations.length, 2);

  const parsed2 = parseCitedBlockIds(
    'Alpha helices are coiled structures [1] while beta sheets form planar arrays [2].',
    excerpts,
  );
  assert.deepEqual(parsed2.citedBlockIds, ['blk-helices-1', 'blk-sheets-2']);
});

test('AI Chat privacy gate blocks unapproved requests, blocks replay, and preserves memory-only until saved to ai/', async () => {
  const excerpt: CloudRetrievedExcerpt = {
    citationNumber: 1,
    chunkId: 'n1::b1',
    noteId: 'note-chem-1',
    blockId: 'blk-atom-1',
    kind: 'note',
    pillar: 'manual',
    sourceTitle: 'Chemistry Lecture',
    sourcePath: 'manual/chem.json',
    headingPath: ['Atomic Structure'],
    text: 'Electrons occupy quantized orbitals around the dense nucleus.',
    score: 0.95,
    scoreLabel: 'word match',
  };

  const preview = prepareChatPreview({
    provider: 'gemini',
    question: 'Where do electrons live?',
    excerpts: [excerpt],
  });

  // 1. Mandatory Privacy Notice enforcement: unapproved call MUST throw
  await assert.rejects(
    () =>
      executeApprovedChatQuery({
        preview,
        userApprovedNotice: false,
        apiKeyOverride: 'test-key',
      }),
    /Privacy notice approval is required/,
  );

  let capturedPrompt = '';
  const mockAdapter = {
    ...getProviderAdapter('gemini'),
    async synthesizeFromExcerpts(p: {
      apiKey: string;
      model?: string;
      question: string;
      excerpts: CloudRetrievedExcerpt[];
    }) {
      capturedPrompt = `${p.question}\n${p.excerpts.map((e) => e.text).join('\n')}`;
      return {
        provider: 'gemini' as const,
        model: 'gemini-2.5-flash',
        question: p.question,
        answerText: 'Electrons occupy quantized orbitals [block: blk-atom-1].',
        citedNumbers: [1],
        citations: [
          {
            citationNumber: 1,
            noteId: 'note-chem-1',
            blockId: 'blk-atom-1',
            kind: 'note' as const,
            pillar: 'manual' as const,
            sourceTitle: 'Chemistry Lecture',
            headingPath: ['Atomic Structure'],
            excerpt: 'Electrons occupy quantized orbitals around the dense nucleus.',
          },
        ],
        createdAt: new Date().toISOString(),
      };
    },
  };

  // 2. Approved call succeeds and includes block citation directive
  const res = await executeApprovedChatQuery({
    preview,
    userApprovedNotice: true,
    apiKeyOverride: 'test-key',
    adapterOverride: mockAdapter,
  });

  assert.ok(res.citedBlockIds.includes('blk-atom-1'));
  assert.ok(capturedPrompt.includes('Electrons occupy quantized orbitals'));
  assert.ok(capturedPrompt.includes('[block: <blockId>]'));

  // 3. Replay attack blocked
  await assert.rejects(
    () =>
      executeApprovedChatQuery({
        preview,
        userApprovedNotice: true,
        apiKeyOverride: 'test-key',
        adapterOverride: mockAdapter,
      }),
    /already sent or cancelled/,
  );

  // 4. Cancelled preview blocked
  const preview2 = prepareChatPreview({
    provider: 'gemini',
    question: 'Cancelled question',
    excerpts: [excerpt],
  });
  cancelChatPreview(preview2.requestId);
  await assert.rejects(
    () =>
      executeApprovedChatQuery({
        preview: preview2,
        userApprovedNotice: true,
        apiKeyOverride: 'test-key',
        adapterOverride: mockAdapter,
      }),
    /already sent or cancelled/,
  );

  // 5. Save conversation into ai/ formatting
  const sampleNote: StoredNoteEntry = {
    fileName: 'chem.json',
    pillar: 'manual',
    path: 'manual/chem.json',
    excerpt: 'Chemistry note',
    wordCount: 30,
    note: {
      id: 'note-chem-1',
      schemaVersion: 1,
      title: 'Chemistry Lecture',
      category: 'Study',
      pillar: 'manual',
      createdAt: '2026-11-22T00:00:00.000Z',
      updatedAt: '2026-11-22T00:00:00.000Z',
      contentHash: 'hash-chem',
      content: {
        type: 'doc',
        content: [],
      },
    },
  };

  const formattedAiNote = formatChatAsAiNote({
    activeNote: sampleNote,
    messages: [
      {
        id: '1',
        role: 'user',
        text: 'Where do electrons live?',
        timestamp: '10:00 AM',
      },
      {
        id: '2',
        role: 'assistant',
        text: 'Electrons occupy quantized orbitals [block: blk-atom-1].',
        citedBlockIds: ['blk-atom-1'],
        citations: res.citations,
        timestamp: '10:01 AM',
      },
    ],
    provider: 'gemini',
    model: 'gemini-2.5-flash',
  });

  assert.equal(formattedAiNote.targetPillar, 'ai');
  assert.ok(formattedAiNote.title.includes('AI Chat: Chemistry Lecture'));
  assert.equal(formattedAiNote.aiMeta.isAiGenerated, true);
  assert.equal(formattedAiNote.aiMeta.sourcesUsed[0].blockId, 'blk-atom-1');
  assert.ok(formattedAiNote.content.content.length >= 3);
});

test('parseSyllabusTopicsResponse extracts course title and topics from raw/fenced JSON', () => {
  const jsonWithFences = `\`\`\`json
{
  "courseTitle": "Intro to Operating Systems",
  "topics": [
    {
      "id": "t-threads",
      "name": "Kernel vs User Threads",
      "description": "Concurrency primitives, context switches, and PCB state.",
      "entities": ["mutex", "semaphore", "spinlocks"]
    },
    {
      "id": "t-vm",
      "name": "Virtual Memory & Paging",
      "description": "TLB misses, page tables, and demand paging.",
      "entities": ["TLB", "inverted page table", "dirty bit"]
    }
  ]
}
\`\`\``;

  const parsed = parseSyllabusTopicsResponse(jsonWithFences);
  assert.equal(parsed.courseTitle, 'Intro to Operating Systems');
  assert.equal(parsed.topics.length, 2);
  assert.equal(parsed.topics[0].id, 't-threads');
  assert.deepEqual(parsed.topics[0].entities, ['mutex', 'semaphore', 'spinlocks']);
  assert.equal(parsed.topics[1].name, 'Virtual Memory & Paging');
});

test('mapTopicsAgainstLocalIndex flags topics with no notes as zero coverage and links covered topics to best matches', async () => {
  const coveredNote: StoredNoteEntry = {
    fileName: 'memory.json',
    pillar: 'manual',
    path: 'manual/memory.json',
    excerpt: 'Virtual memory uses page tables and TLB caches.',
    wordCount: 30,
    note: {
      id: 'note-vm-1',
      schemaVersion: 1,
      title: 'Virtual Memory Study Guide',
      category: 'Study',
      pillar: 'manual',
      createdAt: '2026-11-22T00:00:00.000Z',
      updatedAt: '2026-11-22T00:00:00.000Z',
      contentHash: 'hash-vm',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: {id: 'blk-vm-p1'},
            content: [
              {
                type: 'text',
                text: 'Virtual memory isolates processes with hardware page tables and TLB translation caches.',
              },
            ],
          },
        ],
      },
    },
  };

  const topics = [
    {
      id: 't-covered',
      name: 'Virtual Memory & Paging',
      description: 'Page tables, TLB hits, and memory translation.',
      entities: ['TLB', 'page table'],
    },
    {
      id: 't-zero',
      name: 'Quantum Circuit Compilation',
      description: 'Clifford+T decomposition and surface codes.',
      entities: ['Clifford gates', 'T-count', 'syndrome extraction'],
    },
  ];

  const results = await mapTopicsAgainstLocalIndex({
    topics,
    notes: [coveredNote],
    sources: [],
    aiEnabled: false,
    threshold: 0.25,
  });

  assert.equal(results.length, 2);

  // 1. Covered topic matches note and provides links
  const coveredResult = results.find((r) => r.topic.id === 't-covered')!;
  assert.equal(coveredResult.coverage, 'covered');
  assert.equal(coveredResult.knowledgeGap, false);
  assert.ok(coveredResult.bestScore >= 0.25);
  assert.equal(coveredResult.bestMatches.length, 1);
  assert.equal(coveredResult.bestMatches[0].noteId, 'note-vm-1');
  assert.equal(coveredResult.bestMatches[0].blockId, 'blk-vm-p1');

  // 2. Diagnostics requirement: a topic with no notes is cleanly flagged with zero coverage
  const zeroResult = results.find((r) => r.topic.id === 't-zero')!;
  assert.equal(zeroResult.coverage, 'zero');
  assert.equal(zeroResult.knowledgeGap, true);
  assert.equal(zeroResult.bestScore, 0);
  assert.equal(zeroResult.bestMatches.length, 0);

  // 3. Build gap analysis report
  const rep = buildGapAnalysisReport({
    courseTitle: 'OS & Quantum Test',
    syllabusSnippet: 'Virtual Memory and Quantum Circuits',
    threshold: 0.25,
    topics: results,
  });

  assert.equal(rep.totalTopics, 2);
  assert.equal(rep.coveredCount, 1);
  assert.equal(rep.zeroCoverageCount, 1);
  assert.equal(rep.weakCoverageCount, 0);
});

test('Syllabus gap analysis privacy gate enforces user notice approval before sending syllabus text', async () => {
  const preview = prepareSyllabusPreview({
    provider: 'gemini',
    syllabusText: 'Week 1: Graph Theory. Week 2: Dynamic Programming.',
  });

  // Unapproved call must throw
  await assert.rejects(
    () =>
      executeApprovedSyllabusExtraction({
        preview,
        userApprovedNotice: false,
        apiKeyOverride: 'test-key',
      }),
    /Privacy notice approval is required/,
  );

  // Replay blocked
  let capturedBody = '';
  const mockAdapter = {
    ...getProviderAdapter('gemini'),
    async synthesizeFromExcerpts(p: {
      apiKey: string;
      model?: string;
      question: string;
      excerpts: CloudRetrievedExcerpt[];
    }) {
      capturedBody = p.excerpts[0]?.text || '';
      return {
        provider: 'gemini' as const,
        model: 'gemini-2.5-flash',
        question: p.question,
        answerText: JSON.stringify({
          courseTitle: 'Algorithms',
          topics: [
            {
              id: 't-dp',
              name: 'Dynamic Programming',
              description: 'Memoization and tabulation.',
              entities: ['memoization', 'DAG'],
            },
          ],
        }),
        citedNumbers: [1],
        citations: [],
        createdAt: new Date().toISOString(),
      };
    },
  };

  const res = await executeApprovedSyllabusExtraction({
    preview,
    userApprovedNotice: true,
    apiKeyOverride: 'test-key',
    adapterOverride: mockAdapter,
  });

  assert.equal(res.topics.length, 1);
  assert.ok(capturedBody.includes('Graph Theory'));

  // Replay fails
  await assert.rejects(
    () =>
      executeApprovedSyllabusExtraction({
        preview,
        userApprovedNotice: true,
        apiKeyOverride: 'test-key',
        adapterOverride: mockAdapter,
      }),
    /already sent or cancelled/,
  );
});

test('PDF annotation coordinate normalization merges same-line rects and builds deterministic hash coordKey', () => {
  const pageRect = {left: 100, top: 200, width: 500, height: 800};
  const rects = normalizeSelectionRects(
    [
      {left: 150, top: 280, width: 100, height: 16},
      {left: 251, top: 280, width: 99, height: 16},
      {left: 150, top: 310, width: 120, height: 16},
    ],
    pageRect,
  );

  assert.equal(rects.length, 2);
  assert.ok(Math.abs(rects[0].x - 0.1) < 1e-4);
  assert.ok(Math.abs(rects[0].width - 0.4) < 1e-4);

  const bbox = computeBoundingBox(rects);
  assert.ok(Math.abs(bbox.x - 0.1) < 1e-4);
  assert.ok(Math.abs(bbox.y - 0.1) < 1e-4);
  assert.ok(Math.abs(bbox.width - 0.4) < 1e-4);

  const anchor = {
    pageNumber: 3,
    startSpanIndex: 4,
    startCharOffset: 2,
    endSpanIndex: 6,
    endCharOffset: 9,
    rects,
    boundingBox: bbox,
  };
  const keyA = buildPdfCoordKey('sha256:abc123', anchor);
  const keyB = buildPdfCoordKey('sha256:abc123', anchor);
  const keyOtherHash = buildPdfCoordKey('sha256:different', anchor);

  assert.equal(keyA, keyB);
  assert.notEqual(keyA, keyOtherHash);
  assert.ok(keyA.startsWith('sha256:abc123::p3::s4:2-e6:9::'));
});

test('sortPdfAnnotations orders annotations by page then vertical and horizontal coordinates', () => {
  const mk = (id: string, pageNumber: number, x: number, y: number) => ({
    id,
    contentHash: 'sha256:same',
    coordKey: `sha256:same::p${pageNumber}::${x},${y}`,
    quote: `quote-${id}`,
    comment: '',
    color: 'amber' as const,
    anchor: {
      pageNumber,
      startSpanIndex: 0,
      startCharOffset: 0,
      endSpanIndex: 0,
      endCharOffset: 5,
      rects: [{x, y, width: 0.2, height: 0.02}],
      boundingBox: {x, y, width: 0.2, height: 0.02},
    },
    createdAt: '2026-11-22T00:00:00Z',
    updatedAt: '2026-11-22T00:00:00Z',
  });

  const sorted = sortPdfAnnotations([
    mk('p2', 2, 0.1, 0.2),
    mk('p1-low', 1, 0.1, 0.7),
    mk('p1-top-right', 1, 0.5, 0.15),
    mk('p1-top-left', 1, 0.1, 0.15),
  ]);

  assert.deepEqual(
    sorted.map((item) => item.id),
    ['p1-top-left', 'p1-top-right', 'p1-low', 'p2'],
  );
});

test('buildSampleAcademicPdfBytes produces a valid 2-page PDF byte stream without mutating inputs', () => {
  const bytes = buildSampleAcademicPdfBytes();
  const decoded = new TextDecoder().decode(bytes);
  assert.ok(decoded.startsWith('%PDF-1.4\n'));
  assert.ok(decoded.includes('/Count 2'));
  assert.ok(decoded.includes('%%EOF'));
});

test('Voice Search defaults to experimental OFF with zero hard-coded keys and safe hotkey matching', () => {
  const defaults = getDefaultVoiceSearchSettings();
  assert.equal(defaults.experimentalVoiceEnabled, false);
  assert.equal(defaults.wakeWordEnabled, false);
  assert.equal(defaults.pushToTalkHotkey, 'Alt+Space');
  assert.equal('accessKey' in defaults, false);

  assert.equal(
    matchesPushToTalkHotkey(
      {
        code: 'Space',
        key: ' ',
        altKey: true,
        ctrlKey: false,
        shiftKey: false,
        metaKey: false,
      },
      'Alt+Space',
    ),
    true,
  );

  // Unmodified Space must NOT hijack typing inside editable inputs
  assert.equal(
    matchesPushToTalkHotkey(
      {
        code: 'Space',
        key: ' ',
        altKey: false,
        ctrlKey: false,
        shiftKey: false,
        metaKey: false,
      },
      'Space',
      {tagName: 'TEXTAREA', isContentEditable: false},
    ),
    false,
  );
});

test('Master Kill Switch stops every registered microphone track, closes AudioContexts, and zeros RAM audio', async () => {
  const track1 = {
    id: 'test-track-1',
    readyState: 'live',
    stopCalled: false,
    stop() {
      this.readyState = 'ended';
      this.stopCalled = true;
    },
  };
  const track2 = {
    id: 'test-track-2',
    readyState: 'live',
    stopCalled: false,
    stop() {
      this.readyState = 'ended';
      this.stopCalled = true;
    },
  };
  let ctxClosed = false;
  let hookCalled = false;

  registerMicrophoneStream({
    getTracks: () => [track1, track2],
  });
  registerAudioContext({
    state: 'running',
    async close() {
      ctxClosed = true;
    },
  });
  const unsub = registerMicrophoneTeardownHook(() => {
    hookCalled = true;
  });

  assert.equal(getActiveMicrophoneTrackCount() >= 2, true);
  const report = await killAllMicrophoneAccess();
  unsub();

  assert.equal(track1.stopCalled, true);
  assert.equal(track2.stopCalled, true);
  assert.equal(track1.readyState, 'ended');
  assert.equal(track2.readyState, 'ended');
  assert.equal(ctxClosed, true);
  assert.equal(hookCalled, true);
  assert.equal(report.remainingActiveTracks, 0);
  assert.equal(getActiveMicrophoneTrackCount(), 0);
  assert.equal(getTrackedStreamCount(), 0);
  assert.equal(getTrackedAudioContextCount(), 0);

  // RAM-only resampling + explicit buffer zeroing
  const merged = concatenateFloat32Chunks([
    new Float32Array([0.4, -0.4]),
    new Float32Array([0.2, -0.2]),
  ]);
  const resampled = resampleTo16kMono(merged, 48000);
  assert.ok(resampled.length >= 1);
  const arr = [merged, resampled];
  zeroOutChunks(arr);
  assert.equal(arr.length, 0);
  assert.equal(merged.every((v) => v === 0), true);
  assert.equal(resampled.every((v) => v === 0), true);
});

test('Porcupine wake word rejects missing AccessKey and voice diagnostics pass', async () => {
  await assert.rejects(
    () =>
      startPorcupineWakeWord({
        accessKey: '   ',
        keyword: 'Porcupine',
        onDetected: () => undefined,
        onError: () => undefined,
      }),
    /AccessKey is required/i,
  );

  const diag = await runVoiceDiagnostics();
  assert.equal(diag.length, 3);
  assert.equal(
    diag.every((c) => c.status === 'PASS'),
    true,
    `Voice diagnostics failed: ${JSON.stringify(diag)}`,
  );
});

test('parseWorkspaceRelativeNoteTarget supports nested subfolders and rejects unsafe/immutable paths', () => {
  const nestedManual = parseWorkspaceRelativeNoteTarget(
    'manual\\Calculus\\Week 1\\derivatives.json',
  );
  assert.deepEqual(nestedManual, {
    toPillar: 'manual',
    targetRelPath: 'Calculus/Week 1/derivatives.json',
    subdirs: ['Calculus', 'Week 1'],
    leafFileName: 'derivatives.json',
  });

  const aiTarget = parseWorkspaceRelativeNoteTarget('ai/guides/midterm.json');
  assert.deepEqual(aiTarget, {
    toPillar: 'ai',
    targetRelPath: 'guides/midterm.json',
    subdirs: ['guides'],
    leafFileName: 'midterm.json',
  });

  assert.throws(() => parseWorkspaceRelativeNoteTarget('/manual/a.json'));
  assert.throws(() => parseWorkspaceRelativeNoteTarget('manual/../ai/a.json'));
  assert.throws(() => parseWorkspaceRelativeNoteTarget('manual/a.txt'));
  assert.throws(() =>
    parseWorkspaceRelativeNoteTarget('sources/Calculus/a.json'),
  );
});

test('buildTipTapDocFromSynthesis includes validated Web Sources links and Knowledge Gap markers', () => {
  assert.equal(isAllowedLinkUrl('https://ocw.mit.edu/calculus'), true);
  assert.equal(isAllowedLinkUrl('javascript:alert(1)'), false);

  const excerpts: CloudRetrievedExcerpt[] = [
    {
      citationNumber: 1,
      chunkId: 'c1',
      noteId: 'n1',
      blockId: 'b1',
      kind: 'note',
      pillar: 'manual',
      sourceTitle: 'Calc Lecture 1',
      sourcePath: 'manual/calc1.json',
      headingPath: ['Derivatives'],
      text: 'slope of tangent',
      score: 0.9,
      scoreLabel: 'semantic similarity',
      hadMarkupStripped: false,
      wasTruncated: false,
    },
  ];

  const output = parseAndValidateSynthesisOutput(
    JSON.stringify({
      format: 'study-guide',
      title: 'Derivatives Review',
      summary: 'Core rules.',
      preservedPhrases: ['slope of tangent'],
      sections: [
        {
          heading: 'Power Rule',
          body: '[No supporting notes found] Differentiate x^n as n*x^(n-1).',
          preservedFromNotes: true,
          citations: [1],
        },
      ],
    }),
    'study-guide',
    excerpts,
  );

  const built = buildTipTapDocFromSynthesis({
    output,
    excerpts,
    provider: 'gemini',
    providerLabel: 'Google Gemini',
    model: 'gemini-2.5-flash',
    question: 'Review derivatives',
    generatedAt: '2026-11-23T12:00:00.000Z',
    webCitations: [
      {
        id: 'wc-1',
        title: 'MIT OpenCourseWare',
        url: 'https://ocw.mit.edu/calculus',
        domain: 'ocw.mit.edu',
        claim: 'Derivative definition',
      },
      {
        id: 'wc-2',
        title: 'Unsafe Link',
        url: 'javascript:alert(1)',
        domain: 'evil.example',
      },
    ],
    webGroundingNotice: 'Filtered to allowed domains.',
  });

  const plain = extractPlainText(built.doc).text;
  assert.ok(plain.includes('[No supporting notes found]'));
  assert.ok(plain.includes('Sources Used'));
  assert.ok(plain.includes('Web Sources'));
  assert.ok(plain.includes('MIT OpenCourseWare (ocw.mit.edu)'));

  const serialized = JSON.stringify(built.doc);
  assert.ok(serialized.includes('https://ocw.mit.edu/calculus'));
  assert.equal(serialized.includes('javascript:alert(1)'), false);
});

test('summarizeWorkspaceFolderEntries recognizes clean lazy workspaces and flags code/dependency folders', () => {
  const emptyNotesDir = summarizeWorkspaceFolderEntries('Noodle Notes', [], false);
  assert.equal(emptyNotesDir.isEmpty, true);
  assert.equal(emptyNotesDir.hasKnownNoodleWorkspace, false);
  assert.equal(emptyNotesDir.looksLikeCodeProject, false);

  const lazySinglePillar = summarizeWorkspaceFolderEntries(
    'Noodle Notes',
    ['manual'],
    false,
  );
  assert.equal(lazySinglePillar.isEmpty, false);
  assert.equal(lazySinglePillar.hasKnownNoodleWorkspace, true);
  assert.equal(lazySinglePillar.looksLikeCodeProject, false);

  const codeProjectDir = summarizeWorkspaceFolderEntries(
    'noodle-app',
    ['node_modules', 'package.json', 'src', 'sources'],
    false,
  );
  assert.equal(codeProjectDir.looksLikeCodeProject, true);
  assert.deepEqual(codeProjectDir.projectMarkerNames, [
    'node_modules',
    'package.json',
  ]);
  assert.equal(codeProjectDir.hasKnownNoodleWorkspace, false);
  assert.equal(codeProjectDir.looksLikeDirectManualSubfolder, false);

  const directManualDir = summarizeWorkspaceFolderEntries(
    'manual',
    ['testing-42f6672f.json', 'Acads'],
    false,
    {directManualNotesCount: 1, rootMarkdownOrTextCount: 0},
  );
  assert.equal(directManualDir.looksLikeDirectManualSubfolder, true);
  assert.equal(directManualDir.directManualNotesCount, 1);

  const rootNotesDir = summarizeWorkspaceFolderEntries(
    'Study Notes',
    ['note-a.json', 'readings.md'],
    false,
    {directManualNotesCount: 1, rootMarkdownOrTextCount: 1},
  );
  assert.equal(rootNotesDir.looksLikeDirectManualSubfolder, true);
  assert.equal(rootNotesDir.rootMarkdownOrTextCount, 1);
});

test('categoryConfig supports custom top-level categories, colors, and nested subfolders', () => {
  let configs = getDefaultCategoryConfigs();
  assert.ok(configs.some((c) => c.name === 'Work'));
  assert.ok(configs.some((c) => c.name === 'Study'));

  const added = addTopCategory(configs, '  Research / Lab  ', 'violet');
  assert.equal(added.error, undefined);
  assert.ok(added.created);
  assert.equal(added.created?.name, 'Research Lab');
  configs = added.configs;

  const dup = addTopCategory(configs, 'research lab');
  assert.ok(dup.error);

  const researchId = added.created!.id;
  configs = updateTopCategoryColor(configs, researchId, 'emerald');
  assert.equal(
    getCategoryStyle('Research Lab', configs).dot,
    getCategoryStyle('Projects', configs).dot,
  );
  assert.ok(getCategoryStyle('Unknown Custom Category', configs).dot);

  const sub1 = addSubfolderToCategory(configs, researchId, 'Cell Biology');
  assert.equal(sub1.error, undefined);
  assert.equal(sub1.addedName, 'Cell Biology');
  configs = sub1.configs;

  const subDup = addSubfolderToCategory(configs, researchId, 'cell biology');
  assert.ok(subDup.error);

  const renamedSub = renameSubfolderInCategory(
    configs,
    researchId,
    'Cell Biology',
    'Genetics',
  );
  assert.equal(renamedSub.error, undefined);
  assert.equal(renamedSub.newName, 'Genetics');
  configs = renamedSub.configs;
  assert.deepEqual(
    configs.find((c) => c.id === researchId)?.subfolders,
    ['Genetics'],
  );

  const renamedTop = renameTopCategory(configs, researchId, 'Biology');
  assert.equal(renamedTop.oldName, 'Research Lab');
  assert.equal(renamedTop.newName, 'Biology');
  configs = renamedTop.configs;

  configs = mergeDiscoveredNoteCategories(configs, [
    {category: 'Biology', subfolder: 'Neuroscience'},
    {category: 'Music', subfolder: 'Jazz'},
  ]);
  assert.deepEqual(
    configs.find((c) => c.name === 'Biology')?.subfolders,
    ['Genetics', 'Neuroscience'],
  );
  assert.deepEqual(
    configs.find((c) => c.name === 'Music')?.subfolders,
    ['Jazz'],
  );

  const deletedSub = deleteSubfolderInCategory(configs, researchId, 'Genetics');
  configs = deletedSub.configs;
  assert.deepEqual(
    configs.find((c) => c.id === researchId)?.subfolders,
    ['Neuroscience'],
  );

  const deletedTop = deleteTopCategory(configs, researchId);
  assert.equal(deletedTop.deletedName, 'Biology');
  assert.ok(deletedTop.fallbackName);
  assert.equal(
    deletedTop.configs.some((c) => c.id === researchId),
    false,
  );
});

test('migrateNote preserves custom categories and optional subfolders while sanitizing unsafe chars', () => {
  const {note} = migrateNote({
    id: 'note-custom-1',
    title: 'Lab Notes',
    category: '  Biology / Honors  ',
    subfolder: 'Week 3\\Lab  ',
    pillar: 'manual',
    content: {type: 'doc', content: [{type: 'paragraph', content: []}]},
  });

  assert.equal(note.category, 'Biology Honors');
  assert.equal(note.subfolder, 'Week 3 Lab');
});

test('resampleTo16kMono attenuates ultrasonic alias tones while preserving speech-band signals', () => {
  const sr = 48000;
  const durationSec = 0.25;
  const n = sr * durationSec;

  const speechTone = new Float32Array(n);
  const aliasTone = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    speechTone[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * t);
    aliasTone[i] = 0.5 * Math.sin(2 * Math.PI * 18000 * t);
  }

  const resampledSpeech = resampleTo16kMono(speechTone, sr);
  const resampledAlias = resampleTo16kMono(aliasTone, sr);

  const rms = (arr: Float32Array) => {
    let sum = 0;
    // Skip tiny edge fade regions
    for (let i = 100; i < arr.length - 100; i += 1) {
      sum += arr[i] * arr[i];
    }
    return Math.sqrt(sum / Math.max(1, arr.length - 200));
  };

  assert.ok(rms(resampledSpeech) > 0.3, '1 kHz speech signal should be preserved');
  assert.ok(
    rms(resampledAlias) < 0.05,
    '18 kHz alias signal must be strongly attenuated by anti-aliasing filter',
  );
});

test('prepareAudioForWhisper rejects silence/clicks and normalizes quiet speech cleanly', () => {
  // 1. Pure silence + single 10ms click spike -> rejected
  const silenceWithClick = new Float32Array(16000);
  for (let i = 0; i < 80; i += 1) {
    silenceWithClick[200 + i] = 0.6;
  }
  const silentResult = prepareAudioForWhisper(silenceWithClick);
  assert.equal(silentResult.hasSpeech, false);
  assert.equal(silentResult.audio.length, 0);

  // 2. 1.5s clip with 0.5s dead air, 0.5s quiet speech (0.04 amp), 0.5s dead air
  const quietSpeech = new Float32Array(24000);
  for (let i = 8000; i < 16000; i += 1) {
    quietSpeech[i] = 0.04 * Math.sin((2 * Math.PI * 440 * i) / 16000);
  }
  const prepared = prepareAudioForWhisper(quietSpeech);
  assert.equal(prepared.hasSpeech, true);
  assert.ok(prepared.audio.length < quietSpeech.length, 'Dead air should be trimmed');
  let maxPeak = 0;
  for (let i = 0; i < prepared.audio.length; i += 1) {
    const a = Math.abs(prepared.audio[i]);
    if (a > maxPeak) maxPeak = a;
  }
  assert.ok(maxPeak > 0.35 && maxPeak <= 1.0, `Quiet speech should normalize cleanly (got ${maxPeak})`);
});

test('cleanWhisperTranscript removes artifacts, hallucinations, and repetition loops while keeping queries', () => {
  assert.equal(
    cleanWhisperTranscript('<|startoftranscript|><|en|>[BLANK_AUDIO] (keyboard clicking)'),
    '',
  );
  assert.equal(cleanWhisperTranscript('Thank you for watching.'), '');
  assert.equal(
    cleanWhisperTranscript('calculus calculus calculus chain rule.'),
    'calculus chain rule',
  );
  assert.equal(
    cleanWhisperTranscript('  machine learning machine learning notes  '),
    'machine learning notes',
  );
  assert.equal(
    cleanWhisperTranscript('Thank you letter template for internship'),
    'Thank you letter template for internship',
  );
});










