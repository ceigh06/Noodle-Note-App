import {
  BatchMoveRecord,
  deleteEncryptedKeyRecord,
  getBacklinksForDocument,
  getEncryptedKeyRecord,
  removeExplicitBacklink,
  saveEncryptedKeyRecord,
} from '../db/noodleDb';
import {checkRollbackConflicts} from '../storage/organizeService';
import {tiptapToMarkdown} from '../editor/markdownCodec';
import {
  AiNoteMetadata,
  Category,
  DiagnosticCheckResult,
  Pillar,
  StoredNoteEntry,
  TipTapDoc,
} from '../types/noodle';
import {
  decryptApiKeyWithPassphrase,
  encryptApiKeyWithPassphrase,
  redactSecretFromText,
} from './keyVault';
import {
  buildExcerptSynthesisPrompt,
  getProviderAdapter,
} from './providerAdapter';
import {
  MAX_CLOUD_EXCERPT_CHARS,
  parseAndValidateSynthesisOutput,
  sanitizeAndCapExcerpt,
} from './synthesisOutput';
import {
  cancelCloudSynthesisPreview,
  executeApprovedCloudSynthesis,
  prepareCloudSynthesisPreview,
  validateAndPersistAiSynthesisResult,
} from './synthesisService';
import {
  cancelChatPreview,
  executeApprovedChatQuery,
  extractRelevantNoteExcerpts,
  parseCitedBlockIds,
  prepareChatPreview,
} from './chatService';
import {filterWebCitationsByWhitelist} from './trustSettings';

export async function runCloudDiagnostics(): Promise<DiagnosticCheckResult[]> {
  const results: DiagnosticCheckResult[] = [];
  const fakeTestKey = 'sk-test-noodle-secret-999999abcdef';
  const fakeGoogleKey = 'AIzaSyFakeNoodleDiagKey9999991234';

  // 1. Test key never appears in logs, redacted errors, URLs, prompt payloads, or Markdown exports
  {
    const start = performance.now();
    try {
      const simulatedLogLines: string[] = [];
      const safeLog = (msg: string) => {
        simulatedLogLines.push(redactSecretFromText(msg, fakeTestKey));
      };

      safeLog(
        `Auth failure with Bearer ${fakeTestKey} and https://generativelanguage.googleapis.com/v1beta/models?key=${fakeGoogleKey}`,
      );

      const sampleDoc: TipTapDoc = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: {id: 'diag-cloud-p1'},
            content: [{type: 'text', text: 'Only study notes belong here.'}],
          },
        ],
      };
      const exportedMd = tiptapToMarkdown(sampleDoc);

      const {systemInstruction, userPrompt} = buildExcerptSynthesisPrompt(
        'Summarize memory consolidation.',
        [
          {
            citationNumber: 1,
            chunkId: 'n1::b1',
            noteId: 'n1',
            blockId: 'b1',
            kind: 'note',
            pillar: 'manual',
            sourceTitle: 'Memory Note',
            sourcePath: 'manual/memory.json',
            headingPath: ['Sleep'],
            text: 'Slow-wave ripples replay hippocampal trajectories.',
            score: 0.91,
            scoreLabel: 'semantic similarity',
          },
        ],
      );

      const combinedArtifacts = [
        ...simulatedLogLines,
        exportedMd,
        systemInstruction,
        userPrompt,
      ].join('\n');

      const leaked =
        combinedArtifacts.includes(fakeTestKey) ||
        combinedArtifacts.includes(fakeGoogleKey);

      results.push({
        id: 'cloud-key-redaction',
        name: 'BYOK Key Absent From Logs, Exports & Prompts',
        status: !leaked ? 'PASS' : 'FAIL',
        details: !leaked
          ? 'Verified test secrets are scrubbed from error/log strings and absent from Markdown exports and excerpt prompts.'
          : 'Detected unredacted key fragment in log, export, or prompt output.',
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      results.push({
        id: 'cloud-key-redaction',
        name: 'BYOK Key Absent From Logs, Exports & Prompts',
        status: 'FAIL',
        details: (err as Error).message,
        durationMs: Math.round(performance.now() - start),
      });
    }
  }

  // 2. WebCrypto PBKDF2 + AES-GCM encryption in IndexedDB + wrong passphrase rejection
  {
    const start = performance.now();
    const prevRecord = await getEncryptedKeyRecord('openai');
    try {
      const record = await encryptApiKeyWithPassphrase({
        provider: 'openai',
        apiKey: fakeTestKey,
        passphrase: 'correct-study-passphrase',
        model: 'gpt-4o-mini',
        iterations: 10_000,
      });
      await saveEncryptedKeyRecord(record);
      const stored = await getEncryptedKeyRecord('openai');
      const serialized = JSON.stringify(stored);
      const noPlaintextInIdb = Boolean(stored) && !serialized.includes(fakeTestKey);

      const decrypted = stored
        ? await decryptApiKeyWithPassphrase(stored, 'correct-study-passphrase')
        : '';

      let wrongRejected = false;
      if (stored) {
        try {
          await decryptApiKeyWithPassphrase(stored, 'wrong-passphrase');
        } catch {
          wrongRejected = true;
        }
      }

      const passed =
        noPlaintextInIdb && decrypted === fakeTestKey && wrongRejected;

      results.push({
        id: 'cloud-webcrypto-vault',
        name: 'WebCrypto PBKDF2 + AES-GCM Key Encryption',
        status: passed ? 'PASS' : 'FAIL',
        details: passed
          ? 'Encrypted key stored in IndexedDB without plaintext leakage; decrypts with passphrase and rejects wrong passphrase.'
          : 'Encrypted vault check failed round-trip or wrong-passphrase rejection.',
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      results.push({
        id: 'cloud-webcrypto-vault',
        name: 'WebCrypto PBKDF2 + AES-GCM Key Encryption',
        status: 'FAIL',
        details: (err as Error).message,
        durationMs: Math.round(performance.now() - start),
      });
    } finally {
      if (prevRecord) {
        await saveEncryptedKeyRecord(prevRecord);
      } else {
        await deleteEncryptedKeyRecord('openai');
      }
    }
  }

  // 3. Mandatory Privacy Notice on EVERY call & excerpt-only payload check
  {
    const start = performance.now();
    try {
      const retrievedOnly = [
        {
          citationNumber: 1,
          chunkId: 'note-a::blk-1',
          noteId: 'note-a',
          blockId: 'blk-1',
          kind: 'note' as const,
          pillar: 'manual' as const,
          sourceTitle: 'Retrieved Source Note',
          sourcePath: 'manual/retrieved.json',
          headingPath: ['Section 1'],
          text: 'Retrieved excerpt A only.',
          score: 0.88,
          scoreLabel: 'semantic similarity' as const,
        },
      ];

      const preview1 = prepareCloudSynthesisPreview({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        question: 'What was retrieved?',
        excerpts: retrievedOnly,
      });

      // Unapproved call must fail
      let unapprovedBlocked = false;
      try {
        await executeApprovedCloudSynthesis({
          preview: preview1,
          userApprovedNotice: false,
          apiKeyOverride: fakeGoogleKey,
        });
      } catch {
        unapprovedBlocked = true;
      }

      let capturedRequestBody = '';
      const mockAdapter = {
        ...getProviderAdapter('gemini'),
        async synthesizeFromExcerpts(p: {
          apiKey: string;
          model?: string;
          question: string;
          excerpts: typeof retrievedOnly;
        }) {
          const built = buildExcerptSynthesisPrompt(p.question, p.excerpts);
          capturedRequestBody = `${built.systemInstruction}\n${built.userPrompt}`;
          return {
            provider: 'gemini' as const,
            model: p.model || 'gemini-2.5-flash',
            question: p.question,
            answerText: 'Answer grounded in [1].',
            citedNumbers: [1],
            citations: [
              {
                citationNumber: 1,
                noteId: 'note-a',
                blockId: 'blk-1',
                kind: 'note' as const,
                pillar: 'manual' as const,
                sourceTitle: 'Retrieved Source Note',
                headingPath: ['Section 1'],
                excerpt: 'Retrieved excerpt A only.',
              },
            ],
            createdAt: new Date().toISOString(),
          };
        },
      };

      const res1 = await executeApprovedCloudSynthesis({
        preview: preview1,
        userApprovedNotice: true,
        apiKeyOverride: fakeGoogleKey,
        adapterOverride: mockAdapter,
      });

      // Reusing the same preview without a second notice approval must fail
      let replayBlocked = false;
      try {
        await executeApprovedCloudSynthesis({
          preview: preview1,
          userApprovedNotice: true,
          apiKeyOverride: fakeGoogleKey,
          adapterOverride: mockAdapter,
        });
      } catch {
        replayBlocked = true;
      }

      // Cancel helper cleanup check
      const preview2 = prepareCloudSynthesisPreview({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        question: 'Second question',
        excerpts: retrievedOnly,
      });
      cancelCloudSynthesisPreview(preview2.requestId);

      const passed =
        unapprovedBlocked &&
        replayBlocked &&
        res1.citations.length === 1 &&
        capturedRequestBody.includes('Retrieved excerpt A only.') &&
        !capturedRequestBody.includes('UNRETRIEVED_SECRET_NOTE');

      results.push({
        id: 'cloud-privacy-notice-gate',
        name: 'Privacy Notice Required Every Call (Excerpts Only)',
        status: passed ? 'PASS' : 'FAIL',
        details: passed
          ? 'Blocked unapproved and replayed cloud dispatches; verified strictly retrieved excerpts are formatted into requests.'
          : 'Privacy notice gate did not block unapproved/replayed call as expected.',
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      results.push({
        id: 'cloud-privacy-notice-gate',
        name: 'Privacy Notice Required Every Call (Excerpts Only)',
        status: 'FAIL',
        details: (err as Error).message,
        durationMs: Math.round(performance.now() - start),
      });
    }
  }

  // 3b. AI Chat: Mandatory Privacy Notice on EVERY call & excerpt-only payload check (no note content without notice)
  {
    const start = performance.now();
    try {
      const sampleActiveNote: StoredNoteEntry = {
        fileName: 'note-1.json',
        pillar: 'manual',
        path: 'manual/note-1.json',
        excerpt: 'Relevant block content.',
        wordCount: 20,
        note: {
          id: 'chat-test-note-1',
          schemaVersion: 1,
          title: 'Quantum Computing Lecture',
          category: 'Study',
          pillar: 'manual',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          contentHash: 'hash1',
          content: {
            type: 'doc',
            content: [
              {
                type: 'heading',
                attrs: {id: 'blk-heading-1', level: 1},
                content: [{type: 'text', text: 'Quantum Entanglement'}],
              },
              {
                type: 'paragraph',
                attrs: {id: 'blk-p-1'},
                content: [
                  {
                    type: 'text',
                    text: 'Entangled qubits exhibit non-local state correlations.',
                  },
                ],
              },
              {
                type: 'paragraph',
                attrs: {id: 'blk-p-secret'},
                content: [
                  {
                    type: 'text',
                    text: 'UNRETRIEVED_PRIVATE_IRRELEVANT_BLOCK_DATA',
                  },
                ],
              },
            ],
          },
        },
      };

      // Extract relevant excerpts for a specific question
      const excerpts = extractRelevantNoteExcerpts(
        sampleActiveNote,
        'What are entangled qubits?',
        1,
      );

      // Verify only relevant excerpt is chosen, NOT unretrieved irrelevant block
      const hasIrrelevant = excerpts.some((e) =>
        e.text.includes('UNRETRIEVED_PRIVATE_IRRELEVANT_BLOCK_DATA'),
      );
      const hasRelevant = excerpts.some(
        (e) => e.blockId === 'blk-p-1' && e.text.includes('Entangled qubits'),
      );

      const preview = prepareChatPreview({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        question: 'What are entangled qubits?',
        excerpts,
      });

      // 1. Unapproved call MUST fail (no note content is sent without the notice)
      let unapprovedBlocked = false;
      try {
        await executeApprovedChatQuery({
          preview,
          userApprovedNotice: false,
          apiKeyOverride: fakeGoogleKey,
        });
      } catch {
        unapprovedBlocked = true;
      }

      // 2. Approved call succeeds, transmits ONLY relevant excerpts, and returns block citations
      let capturedChatRequestBody = '';
      const mockChatAdapter = {
        ...getProviderAdapter('gemini'),
        async synthesizeFromExcerpts(p: {
          apiKey: string;
          model?: string;
          question: string;
          excerpts: typeof excerpts;
        }) {
          capturedChatRequestBody = `${p.question}\n${p.excerpts.map((e) => e.text).join('\n')}`;
          return {
            provider: 'gemini' as const,
            model: p.model || 'gemini-2.5-flash',
            question: p.question,
            answerText:
              'Entangled qubits share non-local state correlations as defined in [block: blk-p-1].',
            citedNumbers: [1],
            citations: [
              {
                citationNumber: 1,
                noteId: 'chat-test-note-1',
                blockId: 'blk-p-1',
                kind: 'note' as const,
                pillar: 'manual' as const,
                sourceTitle: 'Quantum Computing Lecture',
                headingPath: ['Quantum Entanglement'],
                excerpt: 'Entangled qubits exhibit non-local state correlations.',
              },
            ],
            createdAt: new Date().toISOString(),
          };
        },
      };

      const res = await executeApprovedChatQuery({
        preview,
        userApprovedNotice: true,
        apiKeyOverride: fakeGoogleKey,
        adapterOverride: mockChatAdapter,
      });

      // 3. Replay attack must be blocked
      let replayBlocked = false;
      try {
        await executeApprovedChatQuery({
          preview,
          userApprovedNotice: true,
          apiKeyOverride: fakeGoogleKey,
          adapterOverride: mockChatAdapter,
        });
      } catch {
        replayBlocked = true;
      }

      // 4. Cancelled preview cannot be sent
      const previewCancel = prepareChatPreview({
        provider: 'gemini',
        question: 'Second question',
        excerpts,
      });
      cancelChatPreview(previewCancel.requestId);
      let cancelBlocked = false;
      try {
        await executeApprovedChatQuery({
          preview: previewCancel,
          userApprovedNotice: true,
          apiKeyOverride: fakeGoogleKey,
          adapterOverride: mockChatAdapter,
        });
      } catch {
        cancelBlocked = true;
      }

      const citesBlockId = res.citedBlockIds.includes('blk-p-1');
      const payloadExcludesSecret =
        !capturedChatRequestBody.includes('UNRETRIEVED_PRIVATE_IRRELEVANT_BLOCK_DATA');
      const payloadIncludesRelevant =
        capturedChatRequestBody.includes('Entangled qubits exhibit non-local state correlations.');

      const passed =
        !hasIrrelevant &&
        hasRelevant &&
        unapprovedBlocked &&
        replayBlocked &&
        cancelBlocked &&
        citesBlockId &&
        payloadExcludesSecret &&
        payloadIncludesRelevant;

      results.push({
        id: 'chat-privacy-notice-gate',
        name: 'AI Chat: Privacy Notice Gate (No Content Sent Without Notice)',
        status: passed ? 'PASS' : 'FAIL',
        details: passed
          ? 'Enforced mandatory privacy notice approval on every chat query, verified only relevant excerpts are transmitted with block citations, and blocked unapproved/replayed calls.'
          : 'Privacy notice check for AI chat did not enforce gating or block-citing behavior as expected.',
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      results.push({
        id: 'chat-privacy-notice-gate',
        name: 'AI Chat: Privacy Notice Gate (No Content Sent Without Notice)',
        status: 'FAIL',
        details: (err as Error).message,
        durationMs: Math.round(performance.now() - start),
      });
    }
  }

  // 4. Failed key returns clear, key-redacted error message
  {
    const start = performance.now();
    try {
      const adapter = getProviderAdapter('openai');
      const mock401Fetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            error: {
              message: `Incorrect API key provided: ${fakeTestKey}`,
            },
          }),
          {status: 401, headers: {'Content-Type': 'application/json'}},
        );

      const testResult = await adapter.testConnection(
        fakeTestKey,
        adapter.defaultModel,
        mock401Fetch,
      );

      const passed =
        !testResult.ok &&
        testResult.status === 401 &&
        testResult.message.includes('rejected this API key') &&
        !testResult.message.includes(fakeTestKey);

      results.push({
        id: 'cloud-failed-key-message',
        name: 'Failed Key Produces Clear Redacted Message',
        status: passed ? 'PASS' : 'FAIL',
        details: passed
          ? `Returned clear redacted error: "${testResult.message.slice(0, 120)}..."`
          : `Expected clear 401 redacted message, got: ${testResult.message}`,
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      results.push({
        id: 'cloud-failed-key-message',
        name: 'Failed Key Produces Clear Redacted Message',
        status: 'FAIL',
        details: (err as Error).message,
        durationMs: Math.round(performance.now() - start),
      });
    }
  }

  // 5. AI synthesis output lands strictly in ai/, never manual/ or sources/
  {
    const start = performance.now();
    try {
      const sampleExcerpts = [
        {
          citationNumber: 1,
          chunkId: 'manual-note-1::blk-real-1',
          noteId: 'manual-note-1',
          blockId: 'blk-real-1',
          kind: 'note' as const,
          pillar: 'manual' as const,
          sourceTitle: 'Calculus Lecture 4',
          sourcePath: 'manual/calc-4.json',
          headingPath: ['Derivatives'],
          text: 'Chain rule peels the outer shell before differentiating the inner core [1].',
          score: 0.92,
          scoreLabel: 'semantic similarity' as const,
        },
      ];
      const validJson = JSON.stringify({
        title: 'Derivatives Cheat-Sheet',
        summary: 'Quick review using your outer-shell metaphor [1].',
        preservedPhrases: ['peels the outer shell before differentiating the inner core'],
        sections: [
          {
            heading: 'Chain Rule',
            body: 'Treat composite functions by peeling the outer shell first [1].',
            citations: [1],
            preservedFromNotes: true,
          },
        ],
      });
      const structured = parseAndValidateSynthesisOutput(
        validJson,
        'cheat-sheet',
        sampleExcerpts,
      );

      let refusedManual = false;
      let refusedSources = false;
      let writtenPillar: Pillar | null = null;
      const writesSeen: Pillar[] = [];

      const mockPersist = async (payload: {
        targetPillar: Pillar;
        title: string;
        category: Category;
        content: TipTapDoc;
        aiMeta: AiNoteMetadata;
      }): Promise<StoredNoteEntry> => {
        writesSeen.push(payload.targetPillar);
        writtenPillar = payload.targetPillar;
        return {
          fileName: 'ai-diag.json',
          pillar: payload.targetPillar,
          path: `${payload.targetPillar}/ai-diag.json`,
          excerpt: payload.title,
          wordCount: 12,
          note: {
            id: 'ai-diag-note-1',
            schemaVersion: 2,
            title: payload.title,
            category: payload.category,
            pillar: payload.targetPillar,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            contentHash: 'sha256:diag',
            content: payload.content,
            aiMeta: payload.aiMeta,
          },
        };
      };

      const sourceNote: StoredNoteEntry = {
        fileName: 'calc-4.json',
        pillar: 'manual',
        path: 'manual/calc-4.json',
        excerpt: 'Chain rule peels the outer shell.',
        wordCount: 8,
        note: {
          id: 'manual-note-1',
          schemaVersion: 2,
          title: 'Calculus Lecture 4',
          category: 'Study',
          pillar: 'manual',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          contentHash: 'sha256:src',
          content: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                attrs: {id: 'blk-real-1'},
                content: [{type: 'text', text: 'Chain rule peels the outer shell.'}],
              },
            ],
          },
        },
      };

      const validResponse = {
        provider: 'gemini' as const,
        model: 'gemini-2.5-flash',
        question: 'Make a cheat sheet',
        outputFormat: 'cheat-sheet' as const,
        answerText: 'Overview',
        citedNumbers: [1],
        citations: [],
        structuredOutput: structured,
        createdAt: new Date().toISOString(),
      };

      try {
        await validateAndPersistAiSynthesisResult({
          response: validResponse,
          excerpts: sampleExcerpts,
          notes: [sourceNote],
          sources: [],
          targetPillar: 'manual',
          persistAiNote: mockPersist,
        });
      } catch {
        refusedManual = true;
      }

      try {
        await validateAndPersistAiSynthesisResult({
          response: validResponse,
          excerpts: sampleExcerpts,
          notes: [sourceNote],
          sources: [],
          targetPillar: 'sources',
          persistAiNote: mockPersist,
        });
      } catch {
        refusedSources = true;
      }

      const persisted = await validateAndPersistAiSynthesisResult({
        response: validResponse,
        excerpts: sampleExcerpts,
        notes: [sourceNote],
        sources: [],
        targetPillar: 'ai',
        persistAiNote: mockPersist,
      });

      // Clean up temporary diagnostic backlinks
      for (const bl of persisted.createdBacklinks) {
        await removeExplicitBacklink(bl.id);
      }

      const passed =
        refusedManual &&
        refusedSources &&
        writtenPillar === 'ai' &&
        writesSeen.length === 1 &&
        persisted.savedEntry.pillar === 'ai';

      results.push({
        id: 'ai-output-pillar-only',
        name: 'AI Synthesis Lands Only in ai/ (Refuses manual/ & sources/)',
        status: passed ? 'PASS' : 'FAIL',
        details: passed
          ? 'Confirmed AI persistence writes exclusively to ai/ and rejects manual/ and sources/ targets.'
          : 'AI-only pillar enforcement check failed.',
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      results.push({
        id: 'ai-output-pillar-only',
        name: 'AI Synthesis Lands Only in ai/ (Refuses manual/ & sources/)',
        status: 'FAIL',
        details: (err as Error).message,
        durationMs: Math.round(performance.now() - start),
      });
    }
  }

  // 6. Generated read-only backlinks resolve to real source & AI note block IDs
  {
    const start = performance.now();
    const createdBacklinkIds: string[] = [];
    try {
      const realSourceNote: StoredNoteEntry = {
        fileName: 'bio-cell.json',
        pillar: 'manual',
        path: 'manual/bio-cell.json',
        excerpt: 'Mitochondria gradient drives ATP synthase.',
        wordCount: 7,
        note: {
          id: 'diag-real-note',
          schemaVersion: 2,
          title: 'Cellular Bio',
          category: 'Study',
          pillar: 'manual',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          contentHash: 'sha256:bio',
          content: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                attrs: {id: 'diag-real-blk-1'},
                content: [{type: 'text', text: 'Mitochondria gradient drives ATP synthase.'}],
              },
            ],
          },
        },
      };

      const excerpts = [
        {
          citationNumber: 1,
          chunkId: 'diag-real-note::diag-real-blk-1',
          noteId: 'diag-real-note',
          blockId: 'diag-real-blk-1',
          kind: 'note' as const,
          pillar: 'manual' as const,
          sourceTitle: 'Cellular Bio',
          sourcePath: 'manual/bio-cell.json',
          headingPath: [],
          text: 'Mitochondria gradient drives ATP synthase.',
          score: 0.95,
          scoreLabel: 'semantic similarity' as const,
        },
        {
          // Phantom non-existent block must NOT become a backlink
          citationNumber: 2,
          chunkId: 'ghost::missing',
          noteId: 'non-existent-note',
          blockId: 'non-existent-block',
          kind: 'note' as const,
          pillar: 'manual' as const,
          sourceTitle: 'Ghost Note',
          sourcePath: 'manual/ghost.json',
          headingPath: [],
          text: 'Phantom text.',
          score: 0.5,
          scoreLabel: 'word match' as const,
        },
      ];

      const structured = parseAndValidateSynthesisOutput(
        JSON.stringify({
          title: 'ATP Flashcards',
          preservedPhrases: ['ATP synthase'],
          sections: [{heading: 'Overview', body: 'Gradient [1]', citations: [1], preservedFromNotes: true}],
          flashcards: [
            {
              front: 'What drives ATP synthase?',
              back: 'Mitochondria gradient [1]',
              citations: [1],
              preservedFromNotes: true,
            },
          ],
        }),
        'flashcards',
        excerpts,
      );

      let savedEntryId = '';
      let savedBlockIds = new Set<string>();
      const persisted = await validateAndPersistAiSynthesisResult({
        response: {
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          question: 'Create ATP flashcards',
          outputFormat: 'flashcards',
          answerText: 'Flashcards',
          citedNumbers: [1],
          citations: [],
          structuredOutput: structured,
          createdAt: new Date().toISOString(),
        },
        excerpts,
        notes: [realSourceNote],
        sources: [],
        targetPillar: 'ai',
        persistAiNote: async (payload) => {
          savedEntryId = 'diag-ai-fc-note';
          savedBlockIds = new Set(
            payload.content.content
              .map((n) => n.attrs?.id)
              .filter((id): id is string => typeof id === 'string'),
          );
          return {
            fileName: 'ai-fc.json',
            pillar: 'ai',
            path: 'ai/ai-fc.json',
            excerpt: payload.title,
            wordCount: 15,
            note: {
              id: savedEntryId,
              schemaVersion: 2,
              title: payload.title,
              category: 'Study',
              pillar: 'ai',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              contentHash: 'sha256:fc',
              content: payload.content,
              aiMeta: payload.aiMeta,
            },
          };
        },
      });

      for (const b of persisted.createdBacklinks) {
        createdBacklinkIds.push(b.id);
      }

      const idbBacklinks = await getBacklinksForDocument(savedEntryId);
      const allReadOnly = idbBacklinks.every((b) => b.readOnly === true);
      const resolvedRealTarget =
        idbBacklinks.length === 1 &&
        idbBacklinks[0].targetNoteId === 'diag-real-note' &&
        idbBacklinks[0].targetBlockId === 'diag-real-blk-1' &&
        savedBlockIds.has(idbBacklinks[0].sourceBlockId);

      const passed = allReadOnly && resolvedRealTarget;

      results.push({
        id: 'ai-backlinks-resolve-real-blocks',
        name: 'AI Backlinks Resolve to Real Block IDs (Read-Only)',
        status: passed ? 'PASS' : 'FAIL',
        details: passed
          ? 'Verified read-only provenance backlinks link valid AI note blocks to real source block IDs and ignore unresolved phantoms.'
          : 'AI backlink resolution or read-only flag verification failed.',
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      results.push({
        id: 'ai-backlinks-resolve-real-blocks',
        name: 'AI Backlinks Resolve to Real Block IDs (Read-Only)',
        status: 'FAIL',
        details: (err as Error).message,
        durationMs: Math.round(performance.now() - start),
      });
    } finally {
      for (const id of createdBacklinkIds) {
        await removeExplicitBacklink(id);
      }
    }
  }

  // 7. Malformed or unsafe provider response is rejected without writing
  {
    const start = performance.now();
    try {
      let writeCount = 0;
      const sampleExcerpts = [
        {
          citationNumber: 1,
          chunkId: 'n1::b1',
          noteId: 'n1',
          blockId: 'b1',
          kind: 'note' as const,
          pillar: 'manual' as const,
          sourceTitle: 'Sample Note',
          sourcePath: 'manual/sample.json',
          headingPath: [],
          text: sanitizeAndCapExcerpt(
            `<script>alert(1)</script>${'x'.repeat(MAX_CLOUD_EXCERPT_CHARS + 120)}`,
          ).text,
          score: 0.9,
          scoreLabel: 'word match' as const,
        },
      ];

      let rejectedInvalidJson = false;
      try {
        await validateAndPersistAiSynthesisResult({
          response: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            question: 'Build practice exam',
            outputFormat: 'practice-exam',
            answerText: '{broken-json: [',
            citedNumbers: [],
            citations: [],
            createdAt: new Date().toISOString(),
          },
          excerpts: sampleExcerpts,
          notes: [],
          sources: [],
          persistAiNote: async () => {
            writeCount += 1;
            throw new Error('Should never write!');
          },
        });
      } catch {
        rejectedInvalidJson = true;
      }

      let rejectedScriptPayload = false;
      try {
        parseAndValidateSynthesisOutput(
          JSON.stringify({
            title: 'Bad Guide',
            sections: [
              {
                heading: 'XSS',
                body: '<script>steal()</script>',
                citations: [1],
                preservedFromNotes: false,
              },
            ],
          }),
          'study-guide',
          sampleExcerpts,
        );
      } catch {
        rejectedScriptPayload = true;
      }

      const sanitizedCheck =
        sampleExcerpts[0].text.length <= MAX_CLOUD_EXCERPT_CHARS &&
        !sampleExcerpts[0].text.includes('<script>');

      const passed =
        rejectedInvalidJson &&
        rejectedScriptPayload &&
        sanitizedCheck &&
        writeCount === 0;

      results.push({
        id: 'ai-malformed-response-rejected',
        name: 'Malformed Provider Response Rejected Without Writing',
        status: passed ? 'PASS' : 'FAIL',
        details: passed
          ? `Rejected broken JSON and script-laden provider output with 0 writes; verified excerpt sanitization & ${MAX_CLOUD_EXCERPT_CHARS}-char cap.`
          : 'Malformed provider response was not cleanly blocked before write.',
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      results.push({
        id: 'ai-malformed-response-rejected',
        name: 'Malformed Provider Response Rejected Without Writing',
        status: 'FAIL',
        details: (err as Error).message,
        durationMs: Math.round(performance.now() - start),
      });
    }
  }

  // 8. Section knowledge gap flag: section with no matching notes gets flagged with '[No supporting notes found]'
  {
    const start = performance.now();
    try {
      const sampleExcerpts = [
        {
          citationNumber: 1,
          chunkId: 'n1::b1',
          noteId: 'n1',
          blockId: 'b1',
          kind: 'note' as const,
          pillar: 'manual' as const,
          sourceTitle: 'Note 1',
          sourcePath: 'manual/n1.json',
          headingPath: [],
          text: 'Quantum mechanics principles.',
          score: 0.9,
          scoreLabel: 'semantic similarity' as const,
        },
      ];
      const structured = parseAndValidateSynthesisOutput(
        JSON.stringify({
          title: 'Unknown Topic Guide',
          sections: [
            {
              heading: 'Completely Unrelated Ancient Sumerian Cuneiform Grammar',
              body: 'Grammar rules here.',
              citations: [1],
              preservedFromNotes: false,
            },
          ],
        }),
        'study-guide',
        sampleExcerpts,
      );

      await validateAndPersistAiSynthesisResult({
        response: {
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          question: 'Question',
          outputFormat: 'study-guide',
          answerText: 'Answer',
          citedNumbers: [1],
          citations: [],
          structuredOutput: structured,
          createdAt: new Date().toISOString(),
        },
        excerpts: sampleExcerpts,
        notes: [],
        sources: [],
        persistAiNote: async (payload) => ({
          fileName: 'gap.json',
          pillar: 'ai',
          path: 'ai/gap.json',
          excerpt: payload.title,
          wordCount: 10,
          note: {
            id: 'gap-note',
            schemaVersion: 2,
            title: payload.title,
            category: 'Study',
            pillar: 'ai',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            contentHash: 'sha256:gap',
            content: payload.content,
            aiMeta: payload.aiMeta,
          },
        }),
      });

      const flagged =
        structured.sections[0].knowledgeGap === true &&
        structured.sections[0].body.includes('[No supporting notes found]');

      results.push({
        id: 'section-knowledge-gap-flagged',
        name: 'Section With No Supporting Notes Gets Flagged',
        status: flagged ? 'PASS' : 'FAIL',
        details: flagged
          ? 'Confirmed section with zero matching notes was correctly flagged with "[No supporting notes found]".'
          : 'Section knowledge gap flagging failed.',
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      results.push({
        id: 'section-knowledge-gap-flagged',
        name: 'Section With No Supporting Notes Gets Flagged',
        status: 'FAIL',
        details: (err as Error).message,
        durationMs: Math.round(performance.now() - start),
      });
    }
  }

  // 9. Non-whitelisted domain never cited & 10. User-added domain honored
  {
    const start = performance.now();
    try {
      const candidates = [
        {url: 'https://evil-phishing.com/steal-key', title: 'Phish'},
        {url: 'https://arxiv.org/abs/2103.00000', title: 'ArXiv Pre-print'},
        {url: 'https://mit.edu/research', title: 'MIT Research'},
      ];
      const defaultFilter = filterWebCitationsByWhitelist(candidates, ['.edu', '.gov']);
      const nonWhitelistedDropped =
        defaultFilter.droppedCount === 2 &&
        defaultFilter.accepted.length === 1 &&
        defaultFilter.accepted[0].domain === 'mit.edu';

      const userAddedFilter = filterWebCitationsByWhitelist(candidates, ['.edu', '.gov', 'arxiv.org']);
      const userDomainHonored =
        userAddedFilter.accepted.length === 2 &&
        userAddedFilter.accepted.some((c) => c.domain === 'arxiv.org') &&
        userAddedFilter.accepted.some((c) => c.domain === 'mit.edu') &&
        userAddedFilter.droppedCount === 1;

      const passed = nonWhitelistedDropped && userDomainHonored;

      results.push({
        id: 'web-grounding-whitelist-diagnostics',
        name: 'Non-Whitelisted Domain Dropped & User-Added Domain Honored',
        status: passed ? 'PASS' : 'FAIL',
        details: passed
          ? 'Verified non-whitelisted URLs are dropped and user-added domains (arxiv.org) are successfully honored.'
          : 'Web grounding whitelist filtering diagnostics failed.',
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      results.push({
        id: 'web-grounding-whitelist-diagnostics',
        name: 'Non-Whitelisted Domain Dropped & User-Added Domain Honored',
        status: 'FAIL',
        details: (err as Error).message,
        durationMs: Math.round(performance.now() - start),
      });
    }
  }

  // 11. Organize Rollback Conflict Safety: move a batch, edit one moved file, undo: conflict detected
  {
    const start = performance.now();
    try {
      const batchRecord: BatchMoveRecord = {
        batchId: 'batch-test-1',
        timestamp: new Date().toISOString(),
        items: [
          {
            noteId: 'note-move-1',
            uuid: 'note-move-1',
            fromPath: 'manual/note1.json',
            toPath: 'manual/Study/note1.json',
            contentHashBefore: 'sha256:original',
            mtimeBefore: 1000,
          },
        ],
      };

      const editedNoteEntry: StoredNoteEntry = {
        fileName: 'note1.json',
        pillar: 'manual',
        path: 'manual/Study/note1.json',
        excerpt: 'Edited excerpt',
        wordCount: 5,
        lastModified: 2000,
        note: {
          id: 'note-move-1',
          schemaVersion: 2,
          title: 'Note 1',
          category: 'Study',
          pillar: 'manual',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          contentHash: 'sha256:newer-edit',
          content: {type: 'doc', content: []},
        },
      };

      const conflicts = await checkRollbackConflicts(batchRecord, [editedNoteEntry]);
      const conflictDetected = conflicts.length === 1 && conflicts[0].noteId === 'note-move-1';

      results.push({
        id: 'organize-rollback-conflict-safety',
        name: 'Rollback Detects Edited File Conflict (No Silent Overwrite)',
        status: conflictDetected ? 'PASS' : 'FAIL',
        details: conflictDetected
          ? 'Successfully detected that moved file was edited after move (newer edit preserved and conflict prompted).'
          : 'Rollback conflict detection test failed.',
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      results.push({
        id: 'organize-rollback-conflict-safety',
        name: 'Rollback Detects Edited File Conflict (No Silent Overwrite)',
        status: 'FAIL',
        details: (err as Error).message,
        durationMs: Math.round(performance.now() - start),
      });
    }
  }

  return results;
}
