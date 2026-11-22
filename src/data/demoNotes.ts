import {extractPlainText} from '../editor/plainText';
import {NoteRecord, StoredNoteEntry} from '../types/noodle';

const RAW_DEMO_NOTES: Array<{note: NoteRecord; fileName: string; sourceRef?: string}> = [
  {
    fileName: 'memory-consolidation-hippocampal-replay.json',
    sourceRef: 'sources/buzsaki-2015-sharp-wave-ripples.pdf',
    note: {
      id: '4f3a1c82-9e20-4b8d-8a11-7d5c9a0b1201',
      schemaVersion: 1,
      title: 'Memory Consolidation & Hippocampal Replay',
      category: 'Study',
      pillar: 'sources',
      createdAt: '2026-11-12T09:15:00Z',
      updatedAt: '2026-11-18T14:22:00Z',
      contentHash: 'sha256:demo-8a91c4e2',
      content: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: {id: 'blk-4f3a-01', level: 2},
            content: [{type: 'text', text: 'Two-Stage Memory Architecture'}],
          },
          {
            type: 'paragraph',
            attrs: {id: 'blk-4f3a-02'},
            content: [
              {
                type: 'text',
                text: 'Sharp-wave ripples during slow-wave sleep coordinate compressed replay of waking firing sequences across neocortical assemblies.',
              },
            ],
          },
          {
            type: 'blockquote',
            attrs: {id: 'blk-4f3a-03'},
            content: [
              {
                type: 'text',
                text: 'Disrupting post-learning ripples selectively impairs spatial consolidation while leaving immediate acquisition intact.',
              },
            ],
          },
        ],
      },
    },
  },
  {
    fileName: 'seminar-notes-distributed-consensus-raft.json',
    note: {
      id: '8c19e412-3b71-41f0-9c42-2e6d110a9044',
      schemaVersion: 1,
      title: 'Seminar Notes: Distributed Consensus & Raft Safety',
      category: 'Study',
      pillar: 'manual',
      createdAt: '2026-11-15T16:40:00Z',
      updatedAt: '2026-11-20T19:05:00Z',
      contentHash: 'sha256:demo-31fe9b04',
      content: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: {id: 'blk-8c19-01', level: 2},
            content: [{type: 'text', text: 'Why Current-Term Commit Rule Matters'}],
          },
          {
            type: 'paragraph',
            attrs: {id: 'blk-8c19-02'},
            content: [
              {
                type: 'text',
                text: 'Leader completeness guarantees every committed log entry survives election without requiring leaders to replay uncommitted entries from prior terms.',
              },
            ],
          },
        ],
      },
    },
  },
  {
    fileName: 'synthesis-spaced-repetition-interleaved-practice.json',
    note: {
      id: 'a772b901-6510-4f88-a2d1-9f0c441e8211',
      schemaVersion: 1,
      title: 'Synthesis: Spaced Repetition vs. Interleaved Practice',
      category: 'Study',
      pillar: 'ai',
      createdAt: '2026-11-19T11:10:00Z',
      updatedAt: '2026-11-20T21:14:00Z',
      contentHash: 'sha256:demo-c702d44a',
      content: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: {id: 'blk-a772-01', level: 2},
            content: [{type: 'text', text: 'Complementary Mechanisms'}],
          },
          {
            type: 'paragraph',
            attrs: {id: 'blk-a772-02'},
            content: [
              {
                type: 'text',
                text: 'Cross-note comparison showing spacing strengthens retrieval strength over time while interleaving sharpens discriminative cue selection.',
              },
            ],
          },
        ],
      },
    },
  },
  {
    fileName: 'cs441-problem-set-4-formal-proofs.json',
    note: {
      id: 'c209f114-18e2-40a1-b310-5b8e723d0199',
      schemaVersion: 1,
      title: 'CS 441 Problem Set 4: Formal Proofs Draft',
      category: 'Assignment',
      pillar: 'manual',
      createdAt: '2026-11-17T08:00:00Z',
      updatedAt: '2026-11-21T01:40:00Z',
      contentHash: 'sha256:demo-112ab98c',
      content: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: {id: 'blk-c209-01', level: 2},
            content: [{type: 'text', text: 'Clause Gadget Construction'}],
          },
          {
            type: 'paragraph',
            attrs: {id: 'blk-c209-02'},
            content: [
              {
                type: 'text',
                text: 'Working proof outline for NP-completeness reduction from 3-SAT to Bounded Vertex Cover with edge gadget verification.',
              },
            ],
          },
        ],
      },
    },
  },
  {
    fileName: 'local-first-sync-engine-architecture.json',
    note: {
      id: 'e931d440-7c21-4d2e-94aa-3c1a892b5520',
      schemaVersion: 1,
      title: 'Local-First Sync Engine Architecture Sketch',
      category: 'Projects',
      pillar: 'manual',
      createdAt: '2026-11-14T13:25:00Z',
      updatedAt: '2026-11-19T18:50:00Z',
      contentHash: 'sha256:demo-6e44f12d',
      content: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: {id: 'blk-e931-01', level: 2},
            content: [{type: 'text', text: 'Reconciler Loop Prevention'}],
          },
          {
            type: 'paragraph',
            attrs: {id: 'blk-e931-02'},
            content: [
              {
                type: 'text',
                text: 'Designing deterministic file-system reconciliation where JSON documents remain canonical and IndexedDB caches vector indexes.',
              },
            ],
          },
        ],
      },
    },
  },
  {
    fileName: 'gil-strang-lecture-18-determinants.json',
    sourceRef: 'sources/mit-1806-lecture-18-transcript.txt',
    note: {
      id: '1d66a098-44b9-4e11-8b73-8a2e019c3305',
      schemaVersion: 1,
      title: 'Gil Strang Lecture 18: Determinants & Properties',
      category: 'Videos',
      pillar: 'sources',
      createdAt: '2026-11-10T20:10:00Z',
      updatedAt: '2026-11-16T10:02:00Z',
      contentHash: 'sha256:demo-50ab881f',
      content: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: {id: 'blk-1d66-01', level: 2},
            content: [{type: 'text', text: 'Timestamp 14:20 — Big Formula'}],
          },
          {
            type: 'paragraph',
            attrs: {id: 'blk-1d66-02'},
            content: [
              {
                type: 'text',
                text: 'Three defining properties—det(I)=1, sign flip on row swap, linearity in each row—uniquely determine the cofactor formula.',
              },
            ],
          },
        ],
      },
    },
  },
  {
    fileName: 'lab-assistant-weekly-protocol.json',
    note: {
      id: '7b52c310-0a44-4c91-9e12-6f4b218a7710',
      schemaVersion: 1,
      title: 'Lab Assistant Weekly Protocol & Calibration Log',
      category: 'Work',
      pillar: 'manual',
      createdAt: '2026-11-11T08:45:00Z',
      updatedAt: '2026-11-18T17:30:00Z',
      contentHash: 'sha256:demo-91dc207e',
      content: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: {id: 'blk-7b52-01', level: 2},
            content: [{type: 'text', text: 'Baseline Check'}],
          },
          {
            type: 'paragraph',
            attrs: {id: 'blk-7b52-02'},
            content: [
              {
                type: 'text',
                text: 'Checklist for Monday spectrometer baseline drift verification, sample labeling standards, and weekly PI summary handoff.',
              },
            ],
          },
        ],
      },
    },
  },
  {
    fileName: 'reading-list-philosophy-of-science.json',
    note: {
      id: '9e04f881-5d12-4a77-8f30-1a9d650c4412',
      schemaVersion: 1,
      title: 'Reading List: Primary Texts on Philosophy of Science',
      category: 'Wishlist',
      pillar: 'ai',
      createdAt: '2026-11-13T19:00:00Z',
      updatedAt: '2026-11-20T09:12:00Z',
      contentHash: 'sha256:demo-44ba719c',
      content: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: {id: 'blk-9e04-01', level: 2},
            content: [{type: 'text', text: 'Suggested Sequence'}],
          },
          {
            type: 'paragraph',
            attrs: {id: 'blk-9e04-02'},
            content: [
              {
                type: 'text',
                text: 'Structured winter break reading sequence linking Kuhn, Lakatos, and Cartwright excerpts referenced in your seminar notes.',
              },
            ],
          },
        ],
      },
    },
  },
];

function extractDemoExcerptAndWords(note: NoteRecord) {
  const {text} = extractPlainText(note.content);
  const normalized = text.replace(/\s+/g, ' ').trim();
  const wordCount = normalized ? normalized.split(/\s+/).length : 0;
  return {
    excerpt: (normalized || 'Empty note.').slice(0, 180),
    wordCount,
  };
}

export const DEMO_NOTES: StoredNoteEntry[] = RAW_DEMO_NOTES.map((item) => {
  const {excerpt, wordCount} = extractDemoExcerptAndWords(item.note);
  return {
    note: item.note,
    fileName: item.fileName,
    pillar: item.note.pillar,
    excerpt,
    wordCount,
    sourceRef: item.sourceRef,
  };
});
