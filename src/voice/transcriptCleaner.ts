/**
 * Pure transcript cleanup for local Whisper ASR output.
 * Strips special tokens, non-speech hallucination tags, repetition loops,
 * and well-known Whisper silence-only hallucinations without dropping real search queries.
 */

const EXACT_SILENCE_HALLUCINATIONS = new Set([
  'thank you',
  'thank you very much',
  'thank you so much',
  'thanks for watching',
  'thank you for watching',
  'please subscribe',
  'subscribe',
  'bye',
  'bye bye',
  'goodbye',
  'you',
  'um',
  'uh',
  'hmm',
  'mm',
  'mhm',
  'subtitles by',
  'transcribed by',
  'amara org',
  'mbc news',
]);

function collapseRepeatedWordsOrPhrases(text: string): string {
  // Collapse 3+ consecutive identical single words (e.g. "the the the" -> "the")
  let out = text.replace(/\b(\w+)(\s+\1){2,}\b/gi, '$1');

  // Collapse 2+ consecutive identical 2-to-5 word phrases
  out = out.replace(
    /\b((?:\w+\s+){1,4}\w+)(?:\s+\1){1,}\b/gi,
    '$1',
  );

  return out;
}

export function cleanWhisperTranscript(rawText: string): string {
  if (!rawText) {
    return '';
  }

  let cleaned = rawText
    // Remove Whisper special/timestamp tokens like <|startoftranscript|>, <|en|>, <|0.00|>
    .replace(/<\|[^|>]+\|>/g, ' ')
    // Remove bracketed non-speech markers like [BLANK_AUDIO], [Music], [INAUDIBLE], [SILENCE]
    .replace(
      /\[(?:blank[_ ]?audio|music|applause|laughter|inaudible|silence|noise|coughing|sighs?|clicking|keyboard(?: clicking)?|crosstalk|foreign|speaking [a-z]+)\]/gi,
      ' ',
    )
    // Remove parenthetical non-speech markers like (blank audio), (music), (sighs), (keyboard clicking)
    .replace(
      /\((?:blank[_ ]?audio|music|applause|laughter|inaudible|silence|noise|coughing|sighs?|clicking|keyboard(?: clicking)?|buzzing|static|panting|groaning|crying)\)/gi,
      ' ',
    )
    // Remove stray music notes
    .replace(/[♪♫]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return '';
  }

  cleaned = collapseRepeatedWordsOrPhrases(cleaned).replace(/\s+/g, ' ').trim();

  // Strip lone punctuation-only results
  const alphaNumNormalized = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!alphaNumNormalized) {
    return '';
  }

  if (EXACT_SILENCE_HALLUCINATIONS.has(alphaNumNormalized)) {
    return '';
  }

  // Strip trailing sentence-end period for cleaner search queries when there's only one sentence
  if (/^[^.!?]+\.$/.test(cleaned)) {
    cleaned = cleaned.slice(0, -1).trim();
  }

  return cleaned;
}
