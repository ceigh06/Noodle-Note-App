import {noodleDb} from '../db/noodleDb';
import {
  TrustSettingsState,
  TunableSectionScoreRow,
  WebGroundingCitation,
} from '../types/noodle';

export const DEFAULT_KNOWLEDGE_GAP_THRESHOLD = 0.25;
export const MIN_KNOWLEDGE_GAP_THRESHOLD = 0.05;
export const MAX_KNOWLEDGE_GAP_THRESHOLD = 0.9;

export const DEFAULT_ALLOWED_DOMAINS: readonly string[] = ['.edu', '.gov'];

const THRESHOLD_KEY = 'trustKnowledgeGapThreshold';
const WEB_GROUNDING_KEY = 'trustWebGroundingEnabled';
const USER_DOMAINS_KEY = 'trustUserAllowedDomains';
const SECTION_SCORES_KEY = 'trustSectionScoreHistoryV1';

type TrustListener = () => void;
const listeners = new Set<TrustListener>();

function emitTrustChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeTrustSettingsChanges(
  listener: TrustListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clampKnowledgeGapThreshold(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_KNOWLEDGE_GAP_THRESHOLD;
  }
  const bounded = Math.min(
    MAX_KNOWLEDGE_GAP_THRESHOLD,
    Math.max(MIN_KNOWLEDGE_GAP_THRESHOLD, value),
  );
  return Number(bounded.toFixed(2));
}

/**
 * Normalizes a user-supplied domain or TLD rule (e.g., `arxiv.org`, `.ac.uk`,
 * or `https://OpenStax.org/books`) into a safe canonical matcher rule.
 * Returns null if invalid or unsafe (wildcards, localhost, IPs, spaces).
 */
export function normalizeDomainRule(rawInput: string): string | null {
  let candidate = String(rawInput ?? '').trim().toLowerCase();
  if (!candidate || candidate.length > 200) {
    return null;
  }

  // Extract hostname if a full URL was pasted
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      candidate = parsed.hostname.toLowerCase();
    } catch {
      return null;
    }
  } else {
    candidate = candidate.replace(/^\/\//, '');
    // Strip path/query/fragment/port if entered without protocol
    candidate = candidate.split('/')[0].split('?')[0].split('#')[0];
    candidate = candidate.split(':')[0];
  }

  candidate = candidate.replace(/^\*+\./, '.').replace(/\.+$/, '').trim();
  if (!candidate || /\s/.test(candidate) || candidate.includes('*')) {
    return null;
  }

  // Block localhost / loopback / bare IP literals
  if (
    candidate === 'localhost' ||
    candidate.endsWith('.localhost') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(candidate) ||
    candidate.includes('[') ||
    candidate.includes(']')
  ) {
    return null;
  }

  // Must either be a leading-dot TLD/suffix like `.edu`, `.gov`, `.ac.uk`
  // or a valid domain with at least one dot (e.g. `arxiv.org`).
  if (candidate.startsWith('.')) {
    const body = candidate.slice(1);
    if (!body || !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(body)) {
      return null;
    }
    return candidate;
  }

  if (!candidate.includes('.')) {
    return null;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(candidate)) {
    return null;
  }
  return candidate;
}

export function getEffectiveAllowedDomains(userDomains: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const base of DEFAULT_ALLOWED_DOMAINS) {
    const norm = normalizeDomainRule(base);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }

  for (const raw of userDomains) {
    const norm = normalizeDomainRule(raw);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }

  return out;
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]'
  ) {
    return true;
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^169\.254\./.test(host)) {
    return true;
  }
  if (/^192\.168\./.test(host)) {
    return true;
  }
  const m172 = /^172\.(\d+)\./.exec(host);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) {
      return true;
    }
  }
  return false;
}

export function hostnameMatchesRule(hostname: string, rule: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  const cleanRule = rule.toLowerCase().replace(/\.+$/, '');
  if (!host || !cleanRule) {
    return false;
  }
  if (cleanRule.startsWith('.')) {
    // e.g. `.edu` matches `mit.edu` or `cs.stanford.edu`, NOT `evil.edu.com` or `.edu` alone
    return host.endsWith(cleanRule) && host.length > cleanRule.length;
  }
  // Exact domain or subdomain match (`arxiv.org` matches `arxiv.org` and `export.arxiv.org`, NOT `evil-arxiv.org`)
  return host === cleanRule || host.endsWith(`.${cleanRule}`);
}

export function isUrlAllowedByDomainWhitelist(
  rawUrl: string,
  allowedDomains: string[],
): {
  allowed: boolean;
  normalizedUrl?: string;
  hostname?: string;
  reason?: string;
} {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) {
    return {allowed: false, reason: 'Empty URL'};
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {allowed: false, reason: 'Invalid URL'};
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      allowed: false,
      reason: `Disallowed scheme (${parsed.protocol})`,
    };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (!hostname || isPrivateOrLoopbackHost(hostname)) {
    return {
      allowed: false,
      hostname,
      reason: 'Private or local network hostships cannot be cited',
    };
  }

  const normalizedRules = getEffectiveAllowedDomains(allowedDomains);
  const matched = normalizedRules.some((rule) =>
    hostnameMatchesRule(hostname, rule),
  );
  if (!matched) {
    return {
      allowed: false,
      hostname,
      reason: `Domain "${hostname}" is not in the allowed whitelist`,
    };
  }

  return {
    allowed: true,
    normalizedUrl: parsed.toString(),
    hostname,
  };
}

export function filterWebCitationsByWhitelist(
  candidates: Array<{url: string; title?: string; claim?: string}>,
  allowedDomains: string[],
): {
  accepted: WebGroundingCitation[];
  droppedCount: number;
  droppedDomains: string[];
} {
  const accepted: WebGroundingCitation[] = [];
  const seenKeys = new Set<string>();
  const droppedDomainsSet = new Set<string>();
  let droppedCount = 0;

  for (const item of candidates) {
    const check = isUrlAllowedByDomainWhitelist(item.url, allowedDomains);
    if (!check.allowed || !check.normalizedUrl || !check.hostname) {
      droppedCount += 1;
      droppedDomainsSet.add(check.hostname || 'invalid-url');
      continue;
    }

    const dedupeKey = `${check.normalizedUrl}::${(item.claim ?? '').trim()}`;
    if (seenKeys.has(dedupeKey)) {
      continue;
    }
    seenKeys.add(dedupeKey);

    accepted.push({
      id: `web-${accepted.length + 1}`,
      url: check.normalizedUrl,
      title:
        item.title && item.title.trim().length > 0
          ? item.title.trim().slice(0, 140)
          : check.hostname,
      domain: check.hostname,
      ...(item.claim && item.claim.trim()
        ? {claim: item.claim.trim().slice(0, 500)}
        : {}),
    });
  }

  return {
    accepted,
    droppedCount,
    droppedDomains: Array.from(droppedDomainsSet),
  };
}

export async function loadTrustSettings(): Promise<TrustSettingsState> {
  const [thresholdRow, groundedRow, domainsRow] = await Promise.all([
    noodleDb.appSettings.get(THRESHOLD_KEY),
    noodleDb.appSettings.get(WEB_GROUNDING_KEY),
    noodleDb.appSettings.get(USER_DOMAINS_KEY),
  ]);

  const knowledgeGapThreshold =
    typeof thresholdRow?.value === 'number'
      ? clampKnowledgeGapThreshold(thresholdRow.value)
      : DEFAULT_KNOWLEDGE_GAP_THRESHOLD;

  // Web grounding is strictly OFF by default
  const webGroundingEnabled = groundedRow?.value === true;

  let userAllowedDomains: string[] = [];
  if (typeof domainsRow?.value === 'string') {
    try {
      const parsed = JSON.parse(domainsRow.value) as unknown;
      if (Array.isArray(parsed)) {
        userAllowedDomains = parsed
          .filter((d): d is string => typeof d === 'string')
          .map((d) => normalizeDomainRule(d))
          .filter((d): d is string => Boolean(d));
      }
    } catch {
      userAllowedDomains = [];
    }
  }

  return {
    knowledgeGapThreshold,
    webGroundingEnabled,
    userAllowedDomains,
  };
}

export async function saveKnowledgeGapThreshold(
  threshold: number,
): Promise<TrustSettingsState> {
  const clamped = clampKnowledgeGapThreshold(threshold);
  await noodleDb.appSettings.put({key: THRESHOLD_KEY, value: clamped});
  emitTrustChange();
  return loadTrustSettings();
}

export async function saveWebGroundingEnabled(
  enabled: boolean,
): Promise<TrustSettingsState> {
  await noodleDb.appSettings.put({
    key: WEB_GROUNDING_KEY,
    value: Boolean(enabled),
  });
  emitTrustChange();
  return loadTrustSettings();
}

export async function saveUserAllowedDomains(
  domains: string[],
): Promise<TrustSettingsState> {
  const clean: string[] = [];
  const seen = new Set<string>();
  for (const raw of domains) {
    const norm = normalizeDomainRule(raw);
    if (
      norm &&
      !DEFAULT_ALLOWED_DOMAINS.includes(norm) &&
      !seen.has(norm)
    ) {
      seen.add(norm);
      clean.push(norm);
    }
  }
  await noodleDb.appSettings.put({
    key: USER_DOMAINS_KEY,
    value: JSON.stringify(clean),
  });
  emitTrustChange();
  return loadTrustSettings();
}

export async function loadTunableSectionScores(): Promise<
  TunableSectionScoreRow[]
> {
  const row = await noodleDb.appSettings.get(SECTION_SCORES_KEY);
  if (typeof row?.value !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is TunableSectionScoreRow =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as TunableSectionScoreRow).id === 'string' &&
        typeof (item as TunableSectionScoreRow).bestScore === 'number',
    );
  } catch {
    return [];
  }
}

export async function recordTunableSectionScores(
  rows: TunableSectionScoreRow[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const existing = await loadTunableSectionScores();
  const merged = [...rows, ...existing].slice(0, 60);
  await noodleDb.appSettings.put({
    key: SECTION_SCORES_KEY,
    value: JSON.stringify(merged),
  });
  emitTrustChange();
}
