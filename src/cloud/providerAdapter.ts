import {
  CloudProviderId,
  CloudRetrievedExcerpt,
  CloudSynthesisCitation,
  CloudSynthesisResponse,
  SynthesisOutputFormat,
  WebGroundingCitation,
} from '../types/noodle';
import {redactSecretFromText} from './keyVault';
import {
  formatSynthesisAnswerText,
  parseAndValidateSynthesisOutput,
} from './synthesisOutput';
import {filterWebCitationsByWhitelist} from './trustSettings';

export interface ProviderConnectionTestResult {
  ok: boolean;
  status?: number;
  message: string;
  modelUsed?: string;
}

export interface ProviderModelOption {
  id: string;
  label: string;
}

export interface CloudProviderAdapter {
  readonly id: CloudProviderId;
  readonly label: string;
  readonly endpointHost: string;
  readonly keyPortalUrl: string;
  readonly keyPortalLabel: string;
  readonly defaultModel: string;
  readonly availableModels: ProviderModelOption[];
  readonly freeTierNote?: string;
  readonly browserCorsStatus: 'works' | 'works-with-header' | 'cors-caveat';
  readonly browserCorsNote: string;
  testConnection(
    apiKey: string,
    model?: string,
    fetchImpl?: typeof fetch,
  ): Promise<ProviderConnectionTestResult>;
  synthesizeFromExcerpts(params: {
    apiKey: string;
    model?: string;
    question: string;
    excerpts: CloudRetrievedExcerpt[];
    outputFormat?: SynthesisOutputFormat;
    webGroundingEnabled?: boolean;
    allowedDomains?: string[];
    fetchImpl?: typeof fetch;
  }): Promise<CloudSynthesisResponse>;
}

const FORMAT_SCHEMA_INSTRUCTIONS: Record<SynthesisOutputFormat, string> = {
  'study-guide':
    'Output format: Study Guide. Return ONLY valid JSON (no markdown fences needed, no prose outside JSON) matching:\n' +
    '{\n' +
    '  "title": "Concise study guide title",\n' +
    '  "summary": "2-3 sentence overview grounded in the excerpts with [N] citations",\n' +
    '  "preservedPhrases": ["exact phrasing, example, or structural metaphor reused from the student notes"],\n' +
    '  "sections": [\n' +
    '    {\n' +
    '      "heading": "Section heading",\n' +
    '      "body": "Detailed study guide explanation reusing the student examples/metaphors where accurate and citing [1], [2]",\n' +
    '      "citations": [1, 2],\n' +
    '      "preservedFromNotes": true\n' +
    '    }\n' +
    '  ]\n' +
    '}',
  'cheat-sheet':
    'Output format: Summary Cheat-Sheet. Return ONLY valid JSON matching:\n' +
    '{\n' +
    '  "title": "Cheat-Sheet title",\n' +
    '  "summary": "1-2 sentence scope note with [N] citations",\n' +
    '  "preservedPhrases": ["exact formula, mnemonic, or metaphor from student notes"],\n' +
    '  "sections": [\n' +
    '    {\n' +
    '      "heading": "Compact topic cluster",\n' +
    '      "body": "High-yield bullet-style lines separated by newlines preserving exact terms from the excerpts [1]",\n' +
    '      "citations": [1],\n' +
    '      "preservedFromNotes": true\n' +
    '    }\n' +
    '  ]\n' +
    '}',
  flashcards:
    'Output format: Flashcard Set (4 to 8 cards). Return ONLY valid JSON matching:\n' +
    '{\n' +
    '  "title": "Flashcard deck title",\n' +
    '  "summary": "Brief deck focus summary",\n' +
    '  "preservedPhrases": ["student metaphor or example preserved in cards"],\n' +
    '  "sections": [\n' +
    '    {\n' +
    '      "heading": "Deck Overview",\n' +
    '      "body": "Core concepts tested across these cards [1]",\n' +
    '      "citations": [1],\n' +
    '      "preservedFromNotes": true\n' +
    '    }\n' +
    '  ],\n' +
    '  "flashcards": [\n' +
    '    {\n' +
    '      "front": "Active recall prompt / question",\n' +
    '      "back": "Clear answer preserving student phrasing/examples [1]",\n' +
    '      "hint": "Optional short memory cue",\n' +
    '      "citations": [1],\n' +
    '      "preservedFromNotes": true\n' +
    '    }\n' +
    '  ]\n' +
    '}',
  'practice-exam':
    'Output format: Practice Exam (4 to 6 multiple-choice questions). Return ONLY valid JSON matching:\n' +
    '{\n' +
    '  "title": "Practice Exam title",\n' +
    '  "summary": "Exam scope summary grounded in retrieved excerpts [1]",\n' +
    '  "preservedPhrases": ["student wording or example retained in questions"],\n' +
    '  "sections": [\n' +
    '    {\n' +
    '      "heading": "Exam Instructions & Focus",\n' +
    '      "body": "Topics covered and key traps from your notes [1]",\n' +
    '      "citations": [1],\n' +
    '      "preservedFromNotes": true\n' +
    '    }\n' +
    '  ],\n' +
    '  "examQuestions": [\n' +
    '    {\n' +
    '      "prompt": "Exam question grounded in the excerpts",\n' +
    '      "options": ["Option A", "Option B", "Option C", "Option D"],\n' +
    '      "correctIndex": 0,\n' +
    '      "explanation": "Why this option is right using student notes [1]",\n' +
    '      "citations": [1],\n' +
    '      "preservedFromNotes": true\n' +
    '    }\n' +
    '  ]\n' +
    '}',
};

export function buildExcerptSynthesisPrompt(
  question: string,
  excerpts: CloudRetrievedExcerpt[],
  outputFormat?: SynthesisOutputFormat,
): {systemInstruction: string; userPrompt: string} {
  const formattedExcerpts = excerpts
    .map((ex) => {
      const section =
        ex.headingPath.length > 0 ? ` (${ex.headingPath.join(' › ')})` : '';
      const blockPart = ex.blockId ? ` [block: ${ex.blockId}]` : '';
      return `[${ex.citationNumber}] Source: "${ex.sourceTitle}" (${ex.pillar})${section}${blockPart}\nExcerpt: ${ex.text}`;
    })
    .join('\n\n');

  const retentionDirective =
    "RETENTION-BIASED GENERATION: Strongly favor and preserve the student's own phrasing, worked examples, terminology, and structural metaphors verbatim from the retrieved excerpts whenever accurate, rather than paraphrasing them into generic textbook wording. " +
    'Mark sections/items that preserve the student\'s wording, examples, or metaphors with "preservedFromNotes": true and list those exact reused phrases in "preservedPhrases". ';

  const baseSystem =
    'You are a study-notes synthesizer. Answer the student task using ONLY the provided sanitized excerpts. ' +
    retentionDirective +
    'Cite supporting excerpts inline using bracketed numbers like [1] or specific block IDs like [block: <blockId>]. ' +
    'If the excerpts lack information needed for part of the task, state that gap plainly instead of inventing facts.';

  if (!outputFormat) {
    const userPrompt =
      `Question:\n${question.trim()}\n\n` +
      `Retrieved Excerpts (only these excerpts were shared):\n${formattedExcerpts}\n\n` +
      "Write a clear, concise synthesis grounded strictly in these excerpts with [N] citations, favoring the student's own phrasing and examples.";

    return {systemInstruction: baseSystem, userPrompt};
  }

  const schemaPrompt = FORMAT_SCHEMA_INSTRUCTIONS[outputFormat];
  const systemInstruction = `${baseSystem}\n\n${schemaPrompt}`;
  const userPrompt =
    `Synthesis Task:\n${question.trim()}\n\n` +
    `Retrieved Sanitized Excerpts (only these excerpts were shared):\n${formattedExcerpts}\n\n` +
    'Return ONLY the strict JSON object for the requested output format.';

  return {systemInstruction, userPrompt};
}

export function mapAnswerCitations(
  answerText: string,
  excerpts: CloudRetrievedExcerpt[],
): {citedNumbers: number[]; citations: CloudSynthesisCitation[]} {
  const byNum = new Map<number, CloudRetrievedExcerpt>(
    excerpts.map((e) => [e.citationNumber, e]),
  );
  const foundNums: number[] = [];
  const seen = new Set<number>();

  const regex = /\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(answerText)) !== null) {
    const num = Number(match[1]);
    if (byNum.has(num) && !seen.has(num)) {
      seen.add(num);
      foundNums.push(num);
    }
  }

  const citations: CloudSynthesisCitation[] = foundNums.map((num) => {
    const ex = byNum.get(num)!;
    return {
      citationNumber: num,
      noteId: ex.noteId,
      blockId: ex.blockId,
      kind: ex.kind,
      pillar: ex.pillar,
      sourceTitle: ex.sourceTitle,
      headingPath: ex.headingPath,
      excerpt: ex.text,
    };
  });

  return {citedNumbers: foundNums, citations};
}

export function extractAndFilterWebCitations(
  data: unknown,
  allowedDomains: string[],
  providerId: CloudProviderId,
): {
  webCitations: WebGroundingCitation[];
  droppedCount: number;
  droppedDomains: string[];
  notice: string;
} {
  const rawCandidates: Array<{url: string; title?: string}> = [];
  const typedData = data as {
    candidates?: Array<{
      groundingMetadata?: {
        groundingChunks?: Array<{
          web?: {uri?: string; title?: string};
        }>;
      };
    }>;
    choices?: Array<{
      message?: {sources?: Array<{url?: string; title?: string}>};
    }>;
    sources?: Array<{url?: string; title?: string}>;
  };

  const chunks = typedData?.candidates?.[0]?.groundingMetadata?.groundingChunks;
  if (Array.isArray(chunks)) {
    for (const ch of chunks) {
      if (ch?.web?.uri) {
        rawCandidates.push({
          url: ch.web.uri,
          title: ch.web.title,
        });
      }
    }
  }

  const choiceSources =
    typedData?.choices?.[0]?.message?.sources || typedData?.sources;
  if (Array.isArray(choiceSources)) {
    for (const s of choiceSources) {
      if (s?.url) {
        rawCandidates.push({url: s.url, title: s.title});
      }
    }
  }

  const filtered = filterWebCitationsByWhitelist(rawCandidates, allowedDomains);
  const supportsNative = providerId === 'openai' || providerId === 'anthropic';
  const notice = supportsNative
    ? `${getProviderAdapter(providerId).label} web search enabled with native allowed_domains configuration plus Noodle post-filtering enforcement (${filtered.accepted.length} accepted, ${filtered.droppedCount} dropped non-whitelisted domains).`
    : `Google Search grounding enabled for ${getProviderAdapter(providerId).label}. Note: AI Studio developer API does not natively restrict search domains at the API level; Noodle automatically enforced domain whitelisting by accepting only whitelisted citations and dropping non-whitelisted ones (${filtered.accepted.length} accepted, ${filtered.droppedCount} dropped non-whitelisted domains).`;

  return {
    webCitations: filtered.accepted,
    droppedCount: filtered.droppedCount,
    droppedDomains: filtered.droppedDomains,
    notice,
  };
}

async function parseErrorMessage(
  response: Response,
  apiKey: string,
  providerLabel: string,
): Promise<string> {
  let detail = '';
  try {
    const raw = await response.text();
    try {
      const parsed = JSON.parse(raw) as {
        error?: {message?: string; type?: string; status?: string};
        message?: string;
      };
      detail = parsed?.error?.message || parsed?.message || raw;
    } catch {
      detail = raw;
    }
  } catch {
    detail = response.statusText;
  }

  const safeDetail = redactSecretFromText(detail, apiKey).slice(0, 260).trim();

  if (response.status === 401 || response.status === 403) {
    return `${providerLabel} rejected this API key (HTTP ${response.status}). Check that the key is active and copied without extra spaces.${safeDetail ? ` Details: ${safeDetail}` : ''}`;
  }
  if (response.status === 429) {
    return `${providerLabel} rate limit or quota exceeded (HTTP 429). Wait briefly or check your provider billing/free-tier quota.${safeDetail ? ` Details: ${safeDetail}` : ''}`;
  }
  if (response.status === 404) {
    return `${providerLabel} could not find the selected model (HTTP 404). Pick another model in API Key setup.${safeDetail ? ` Details: ${safeDetail}` : ''}`;
  }
  return `${providerLabel} returned HTTP ${response.status}.${safeDetail ? ` ${safeDetail}` : ''}`;
}

function formatBrowserNetworkError(
  err: unknown,
  providerLabel: string,
  apiKey: string,
): string {
  const msg = redactSecretFromText(
    (err as Error)?.message || String(err),
    apiKey,
  );
  if (/failed to fetch|networkerror|cors|load failed/i.test(msg)) {
    return `Browser request to ${providerLabel} was blocked by CORS or network rules (${msg}). Noodle never sends keys through a proxy server; check network connectivity or try Gemini/Anthropic.`;
  }
  return `${providerLabel} request failed: ${msg}`;
}

const geminiAdapter: CloudProviderAdapter = {
  id: 'gemini',
  label: 'Google Gemini',
  endpointHost: 'generativelanguage.googleapis.com',
  keyPortalUrl: 'https://aistudio.google.com/apikey',
  keyPortalLabel: 'Get Gemini API key (Google AI Studio)',
  defaultModel: 'gemini-2.5-flash',
  availableModels: [
    {id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Default Free/Standard)'},
    {id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite'},
    {id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen'},
  ],
  freeTierNote:
    'Gemini has a free tier in Google AI Studio (rate-limited, no credit card required in supported regions).',
  browserCorsStatus: 'works',
  browserCorsNote:
    'Works directly from the browser via fetch using the x-goog-api-key header (key never placed in the URL; omit SDK telemetry headers to pass CORS preflight).',
  async testConnection(apiKey, model, fetchImpl = fetch) {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      return {ok: false, message: 'Enter a Gemini API key first.'};
    }
    try {
      const res = await fetchImpl(
        'https://generativelanguage.googleapis.com/v1beta/models?pageSize=20',
        {
          method: 'GET',
          headers: {
            'x-goog-api-key': trimmed,
          },
        },
      );
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          message: await parseErrorMessage(res, trimmed, 'Gemini'),
        };
      }
      return {
        ok: true,
        status: res.status,
        modelUsed: model || geminiAdapter.defaultModel,
        message: 'Connected directly to Gemini API from your browser.',
      };
    } catch (err) {
      return {
        ok: false,
        message: formatBrowserNetworkError(err, 'Gemini', trimmed),
      };
    }
  },
  async synthesizeFromExcerpts({
    apiKey,
    model,
    question,
    excerpts,
    outputFormat,
    webGroundingEnabled,
    allowedDomains = ['.edu', '.gov'],
    fetchImpl = fetch,
  }) {
    const trimmed = apiKey.trim();
    const targetModel = model || geminiAdapter.defaultModel;
    const {systemInstruction, userPrompt} = buildExcerptSynthesisPrompt(
      question,
      excerpts,
      outputFormat,
    );

    try {
      const res = await fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(targetModel)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': trimmed,
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{text: systemInstruction}],
            },
            contents: [
              {
                role: 'user',
                parts: [{text: userPrompt}],
              },
            ],
            ...(webGroundingEnabled
              ? {
                  tools: [{googleSearch: {}}],
                }
              : {}),
            ...(outputFormat
              ? {
                  generationConfig: {
                    responseMimeType: 'application/json',
                  },
                }
              : {}),
          }),
        },
      );

      if (!res.ok) {
        throw new Error(await parseErrorMessage(res, trimmed, 'Gemini'));
      }

      const data = (await res.json()) as unknown;
      const typedData = data as {
        candidates?: Array<{
          content?: {parts?: Array<{text?: string}>};
        }>;
      };
      const rawText =
        typedData.candidates?.[0]?.content?.parts
          ?.map((p) => p.text ?? '')
          .join('')
          .trim() || '';

      if (!rawText) {
        throw new Error('Gemini returned an empty response. Nothing was saved.');
      }

      const webFiltering = webGroundingEnabled
        ? extractAndFilterWebCitations(data, allowedDomains, 'gemini')
        : undefined;

      if (outputFormat) {
        const structured = parseAndValidateSynthesisOutput(
          rawText,
          outputFormat,
          excerpts,
        );
        if (webFiltering && webFiltering.webCitations.length > 0) {
          structured.webCitations = webFiltering.webCitations;
          structured.droppedWebCitationsCount = webFiltering.droppedCount;
          structured.droppedWebDomains = webFiltering.droppedDomains;
        }
        const answerText = formatSynthesisAnswerText(structured);
        const {citedNumbers, citations} = mapAnswerCitations(
          `${answerText} ${structured.sections.flatMap((s) => s.citations.map((n) => `[${n}]`)).join(' ')} ${(structured.flashcards ?? []).flatMap((c) => c.citations.map((n) => `[${n}]`)).join(' ')} ${(structured.examQuestions ?? []).flatMap((q) => q.citations.map((n) => `[${n}]`)).join(' ')}`,
          excerpts,
        );
        return {
          provider: 'gemini',
          model: targetModel,
          question,
          outputFormat,
          answerText,
          citedNumbers,
          citations,
          structuredOutput: structured,
          ...(webFiltering
            ? {
                webCitations: webFiltering.webCitations,
                droppedWebCitationsCount: webFiltering.droppedCount,
                droppedWebDomains: webFiltering.droppedDomains,
                webGroundingNotice: webFiltering.notice,
              }
            : {}),
          createdAt: new Date().toISOString(),
        };
      }

      const {citedNumbers, citations} = mapAnswerCitations(rawText, excerpts);
      return {
        provider: 'gemini',
        model: targetModel,
        question,
        answerText: rawText,
        citedNumbers,
        citations,
        ...(webFiltering
          ? {
              webCitations: webFiltering.webCitations,
              droppedWebCitationsCount: webFiltering.droppedCount,
              droppedWebDomains: webFiltering.droppedDomains,
              webGroundingNotice: webFiltering.notice,
            }
          : {}),
        createdAt: new Date().toISOString(),
      };
    } catch (err) {
      throw new Error(
        redactSecretFromText((err as Error).message || String(err), trimmed),
      );
    }
  },
};

const openaiAdapter: CloudProviderAdapter = {
  id: 'openai',
  label: 'OpenAI',
  endpointHost: 'api.openai.com',
  keyPortalUrl: 'https://platform.openai.com/api-keys',
  keyPortalLabel: 'Get OpenAI API key',
  defaultModel: 'gpt-4o-mini',
  availableModels: [
    {id: 'gpt-4o-mini', label: 'GPT-4o mini'},
    {id: 'gpt-4.1-mini', label: 'GPT-4.1 mini'},
    {id: 'gpt-4o', label: 'GPT-4o'},
  ],
  browserCorsStatus: 'works',
  browserCorsNote:
    'Works via plain browser fetch (Authorization: Bearer + Content-Type: application/json). Note: OpenAI officially recommends server proxies for developer keys and blocks the JS SDK unless dangerouslyAllowBrowser is set.',
  async testConnection(apiKey, model, fetchImpl = fetch) {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      return {ok: false, message: 'Enter an OpenAI API key first.'};
    }
    try {
      const res = await fetchImpl('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${trimmed}`,
        },
      });
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          message: await parseErrorMessage(res, trimmed, 'OpenAI'),
        };
      }
      return {
        ok: true,
        status: res.status,
        modelUsed: model || openaiAdapter.defaultModel,
        message: 'Connected directly to OpenAI API from your browser.',
      };
    } catch (err) {
      return {
        ok: false,
        message: formatBrowserNetworkError(err, 'OpenAI', trimmed),
      };
    }
  },
  async synthesizeFromExcerpts({
    apiKey,
    model,
    question,
    excerpts,
    outputFormat,
    webGroundingEnabled,
    allowedDomains = ['.edu', '.gov'],
    fetchImpl = fetch,
  }) {
    const trimmed = apiKey.trim();
    const targetModel = model || openaiAdapter.defaultModel;
    const {systemInstruction, userPrompt} = buildExcerptSynthesisPrompt(
      question,
      excerpts,
      outputFormat,
    );

    const cleanAllowedDomains = allowedDomains.map((d) => d.replace(/^\./, ''));

    try {
      const res = await fetchImpl(
        'https://api.openai.com/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${trimmed}`,
          },
          body: JSON.stringify({
            model: targetModel,
            messages: [
              {role: 'system', content: systemInstruction},
              {role: 'user', content: userPrompt},
            ],
            ...(webGroundingEnabled
              ? {
                  tools: [
                    {
                      type: 'web_search',
                      filters: {
                        allowed_domains: cleanAllowedDomains,
                      },
                    },
                  ],
                }
              : {}),
            ...(outputFormat ? {response_format: {type: 'json_object'}} : {}),
          }),
        },
      );

      if (!res.ok) {
        throw new Error(await parseErrorMessage(res, trimmed, 'OpenAI'));
      }

      const data = (await res.json()) as unknown;
      const typedData = data as {
        choices?: Array<{message?: {content?: string}}>;
      };
      const rawText = typedData.choices?.[0]?.message?.content?.trim() || '';
      if (!rawText) {
        throw new Error('OpenAI returned an empty response. Nothing was saved.');
      }

      const webFiltering = webGroundingEnabled
        ? extractAndFilterWebCitations(data, allowedDomains, 'openai')
        : undefined;

      if (outputFormat) {
        const structured = parseAndValidateSynthesisOutput(
          rawText,
          outputFormat,
          excerpts,
        );
        if (webFiltering && webFiltering.webCitations.length > 0) {
          structured.webCitations = webFiltering.webCitations;
          structured.droppedWebCitationsCount = webFiltering.droppedCount;
          structured.droppedWebDomains = webFiltering.droppedDomains;
        }
        const answerText = formatSynthesisAnswerText(structured);
        const {citedNumbers, citations} = mapAnswerCitations(
          `${answerText} ${structured.sections.flatMap((s) => s.citations.map((n) => `[${n}]`)).join(' ')} ${(structured.flashcards ?? []).flatMap((c) => c.citations.map((n) => `[${n}]`)).join(' ')} ${(structured.examQuestions ?? []).flatMap((q) => q.citations.map((n) => `[${n}]`)).join(' ')}`,
          excerpts,
        );
        return {
          provider: 'openai',
          model: targetModel,
          question,
          outputFormat,
          answerText,
          citedNumbers,
          citations,
          structuredOutput: structured,
          ...(webFiltering
            ? {
                webCitations: webFiltering.webCitations,
                droppedWebCitationsCount: webFiltering.droppedCount,
                droppedWebDomains: webFiltering.droppedDomains,
                webGroundingNotice: webFiltering.notice,
              }
            : {}),
          createdAt: new Date().toISOString(),
        };
      }

      const {citedNumbers, citations} = mapAnswerCitations(rawText, excerpts);
      return {
        provider: 'openai',
        model: targetModel,
        question,
        answerText: rawText,
        citedNumbers,
        citations,
        ...(webFiltering
          ? {
              webCitations: webFiltering.webCitations,
              droppedWebCitationsCount: webFiltering.droppedCount,
              droppedWebDomains: webFiltering.droppedDomains,
              webGroundingNotice: webFiltering.notice,
            }
          : {}),
        createdAt: new Date().toISOString(),
      };
    } catch (err) {
      throw new Error(
        redactSecretFromText((err as Error).message || String(err), trimmed),
      );
    }
  },
};

const anthropicAdapter: CloudProviderAdapter = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',
  endpointHost: 'api.anthropic.com',
  keyPortalUrl: 'https://console.anthropic.com/settings/keys',
  keyPortalLabel: 'Get Anthropic API key',
  defaultModel: 'claude-sonnet-4-20250514',
  availableModels: [
    {id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4'},
    {id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku'},
  ],
  browserCorsStatus: 'works-with-header',
  browserCorsNote:
    'Requires the special header "anthropic-dangerous-direct-browser-access: true" alongside "x-api-key" and "anthropic-version: 2023-06-01" to permit browser CORS calls (some enterprise org policies may disable direct browser access).',
  async testConnection(apiKey, model, fetchImpl = fetch) {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      return {ok: false, message: 'Enter an Anthropic API key first.'};
    }
    try {
      const res = await fetchImpl('https://api.anthropic.com/v1/models', {
        method: 'GET',
        headers: {
          'x-api-key': trimmed,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
      });
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          message: await parseErrorMessage(res, trimmed, 'Anthropic'),
        };
      }
      return {
        ok: true,
        status: res.status,
        modelUsed: model || anthropicAdapter.defaultModel,
        message:
          'Connected directly to Anthropic API (browser CORS opt-in header verified).',
      };
    } catch (err) {
      return {
        ok: false,
        message: formatBrowserNetworkError(err, 'Anthropic', trimmed),
      };
    }
  },
  async synthesizeFromExcerpts({
    apiKey,
    model,
    question,
    excerpts,
    outputFormat,
    webGroundingEnabled,
    allowedDomains = ['.edu', '.gov'],
    fetchImpl = fetch,
  }) {
    const trimmed = apiKey.trim();
    const targetModel = model || anthropicAdapter.defaultModel;
    const {systemInstruction, userPrompt} = buildExcerptSynthesisPrompt(
      question,
      excerpts,
      outputFormat,
    );

    const cleanAllowedDomains = allowedDomains.map((d) => d.replace(/^\./, ''));

    try {
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': trimmed,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: targetModel,
          max_tokens: 2048,
          system: systemInstruction,
          messages: [{role: 'user', content: userPrompt}],
          ...(webGroundingEnabled
            ? {
                tools: [
                  {
                    type: 'web_search_20250305',
                    name: 'web_search',
                    allowed_domains: cleanAllowedDomains,
                  },
                ],
              }
            : {}),
        }),
      });

      if (!res.ok) {
        throw new Error(await parseErrorMessage(res, trimmed, 'Anthropic'));
      }

      const data = (await res.json()) as unknown;
      const typedData = data as {
        content?: Array<{type?: string; text?: string}>;
      };
      const rawText =
        typedData.content
          ?.filter((c) => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('\n')
          .trim() || '';

      if (!rawText) {
        throw new Error('Anthropic returned an empty response. Nothing was saved.');
      }

      const webFiltering = webGroundingEnabled
        ? extractAndFilterWebCitations(data, allowedDomains, 'anthropic')
        : undefined;

      if (outputFormat) {
        const structured = parseAndValidateSynthesisOutput(
          rawText,
          outputFormat,
          excerpts,
        );
        if (webFiltering && webFiltering.webCitations.length > 0) {
          structured.webCitations = webFiltering.webCitations;
          structured.droppedWebCitationsCount = webFiltering.droppedCount;
          structured.droppedWebDomains = webFiltering.droppedDomains;
        }
        const answerText = formatSynthesisAnswerText(structured);
        const {citedNumbers, citations} = mapAnswerCitations(
          `${answerText} ${structured.sections.flatMap((s) => s.citations.map((n) => `[${n}]`)).join(' ')} ${(structured.flashcards ?? []).flatMap((c) => c.citations.map((n) => `[${n}]`)).join(' ')} ${(structured.examQuestions ?? []).flatMap((q) => q.citations.map((n) => `[${n}]`)).join(' ')}`,
          excerpts,
        );
        return {
          provider: 'anthropic',
          model: targetModel,
          question,
          outputFormat,
          answerText,
          citedNumbers,
          citations,
          structuredOutput: structured,
          ...(webFiltering
            ? {
                webCitations: webFiltering.webCitations,
                droppedWebCitationsCount: webFiltering.droppedCount,
                droppedWebDomains: webFiltering.droppedDomains,
                webGroundingNotice: webFiltering.notice,
              }
            : {}),
          createdAt: new Date().toISOString(),
        };
      }

      const {citedNumbers, citations} = mapAnswerCitations(rawText, excerpts);
      return {
        provider: 'anthropic',
        model: targetModel,
        question,
        answerText: rawText,
        citedNumbers,
        citations,
        ...(webFiltering
          ? {
              webCitations: webFiltering.webCitations,
              droppedWebCitationsCount: webFiltering.droppedCount,
              droppedWebDomains: webFiltering.droppedDomains,
              webGroundingNotice: webFiltering.notice,
            }
          : {}),
        createdAt: new Date().toISOString(),
      };
    } catch (err) {
      throw new Error(
        redactSecretFromText((err as Error).message || String(err), trimmed),
      );
    }
  },
};

export const CLOUD_PROVIDER_ADAPTERS: Record<
  CloudProviderId,
  CloudProviderAdapter
> = {
  gemini: geminiAdapter,
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
};

export const CLOUD_PROVIDER_LIST: CloudProviderAdapter[] = [
  geminiAdapter,
  openaiAdapter,
  anthropicAdapter,
];

export function getProviderAdapter(
  provider: CloudProviderId,
): CloudProviderAdapter {
  return CLOUD_PROVIDER_ADAPTERS[provider];
}
