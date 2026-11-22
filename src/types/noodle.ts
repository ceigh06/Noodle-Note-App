export type Pillar = 'sources' | 'manual' | 'ai';

export type WritablePillar = 'manual' | 'ai';

export type PillarFilter = 'all' | Pillar;

export type Category =
  | 'Work'
  | 'Study'
  | 'Assignment'
  | 'Projects'
  | 'Videos'
  | 'Wishlist';

export type RoutePath =
  | '/'
  | '/workspace'
  | '/workspace/study'
  | '/workspace/synthesizer'
  | '/workspace/trust-tuning'
  | '/workspace/organize'
  | '/settings'
  | '/diagnostics';

export interface TipTapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface TipTapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TipTapNode[];
  marks?: TipTapMark[];
  text?: string;
}

export interface TipTapDoc {
  type: 'doc';
  content: TipTapNode[];
}

export type SynthesisOutputFormat =
  | 'study-guide'
  | 'cheat-sheet'
  | 'flashcards'
  | 'practice-exam';

export interface AiSourceReference {
  citationNumber: number;
  noteId: string;
  blockId: string;
  kind: 'note' | 'source';
  pillar: Pillar;
  title: string;
  path: string;
  excerpt: string;
}

export interface AiWebClaim {
  claim: string;
  url: string;
  title: string;
  domain: string;
}

export interface WebGroundingCitation {
  id: string;
  url: string;
  title: string;
  domain: string;
  claim?: string;
}

export interface ProviderGroundingCapability {
  supportsWebSearch: boolean;
  supportsDomainRestrictedSearch: boolean;
  note: string;
}

export interface SectionRetrievalPlanItem {
  sectionId: string;
  sectionIndex: number;
  sectionTitle: string;
  query: string;
  bestScore: number;
  scoreLabel: ScoreLabel;
  knowledgeGap: boolean;
  excerpts: CloudRetrievedExcerpt[];
}

export interface AiSynthesisSection {
  sectionId?: string;
  sectionIndex?: number;
  sectionQuery?: string;
  heading: string;
  body: string;
  citations: number[];
  preservedFromNotes: boolean;
  bestSimilarityScore?: number;
  scoreLabel?: ScoreLabel;
  thresholdUsed?: number;
  knowledgeGap?: boolean;
  webClaims?: AiWebClaim[];
}

export interface AiFlashcardItem {
  id: string;
  front: string;
  back: string;
  hint?: string;
  citations: number[];
  preservedFromNotes: boolean;
}

export interface AiExamQuestion {
  id: string;
  prompt: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  citations: number[];
  preservedFromNotes: boolean;
}

export interface ValidatedSynthesisOutput {
  format: SynthesisOutputFormat;
  title: string;
  summary?: string;
  preservedPhrases: string[];
  sections: AiSynthesisSection[];
  flashcards?: AiFlashcardItem[];
  examQuestions?: AiExamQuestion[];
  webClaims?: AiWebClaim[];
  webCitations?: WebGroundingCitation[];
  droppedWebCitationsCount?: number;
  droppedWebDomains?: string[];
}

export interface SectionScoreRecord {
  heading: string;
  query: string;
  bestScore: number;
  scoreLabel: ScoreLabel;
  knowledgeGap: boolean;
}

export interface AiNoteMetadata {
  isAiGenerated: true;
  format: SynthesisOutputFormat;
  model: string;
  provider: CloudProviderId;
  generatedAt: string;
  question: string;
  sourcesUsed: AiSourceReference[];
  preservedPhrases?: string[];
  flashcards?: AiFlashcardItem[];
  examQuestions?: AiExamQuestion[];
  knowledgeGapThreshold?: number;
  sectionScores?: SectionScoreRecord[];
  webGroundingEnabled?: boolean;
  allowedDomains?: string[];
  webCitations?: WebGroundingCitation[];
  droppedWebCitationsCount?: number;
  droppedWebDomains?: string[];
  webGroundingNotice?: string;
}

export interface TrustSettingsState {
  knowledgeGapThreshold: number;
  webGroundingEnabled: boolean;
  userAllowedDomains: string[];
}

export interface TunableSectionScoreRow {
  id: string;
  synthesisTitle: string;
  sectionHeading: string;
  query: string;
  bestScore: number;
  scoreLabel: ScoreLabel;
  recordedAt: string;
}

export interface NoteRecord {
  id: string;
  schemaVersion: number;
  title: string;
  category: Category;
  pillar: Pillar;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
  content: TipTapDoc;
  aiMeta?: AiNoteMetadata;
}

export interface StoredNoteEntry {
  note: NoteRecord;
  fileName: string;
  pillar: Pillar;
  excerpt: string;
  wordCount: number;
  sourceRef?: string;
  path?: string;
  size?: number;
  lastModified?: number;
}

export interface ScanProblem {
  id: string;
  path: string;
  pillar: Pillar;
  fileName: string;
  reason: string;
  detectedAt: string;
}

export interface ExternalEditConflict {
  noteId: string;
  path: string;
  pillar: Pillar;
  fileName: string;
  diskEntry: StoredNoteEntry;
  detectedAt: string;
}

export interface WorkspaceScanSummary {
  reason: 'startup' | 'focus' | 'interval' | 'manual' | 'diagnostics';
  scannedFiles: number;
  addedCount: number;
  editedCount: number;
  deletedCount: number;
  movedCount: number;
  ignoredOwnWritesCount: number;
  problemCount: number;
  durationMs: number;
  addedNoteIds: string[];
  editedNoteIds: string[];
  deletedNoteIds: string[];
  movedNoteIds: string[];
  problems: ScanProblem[];
  entries: StoredNoteEntry[];
}

export type WorkspaceConnectionState =
  | 'checking'
  | 'unselected'
  | 'restored-needs-permission'
  | 'confirm-non-empty'
  | 'connected'
  | 'blocked-iframe'
  | 'unsupported';

export interface DiagnosticCheckResult {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL' | 'PENDING';
  details: string;
  durationMs?: number;
}

export type SourceDocumentKind = 'pdf' | 'txt' | 'md' | 'unsupported-pptx';

export interface SourceDocumentChunk {
  blockId: string;
  headingPath: string[];
  pageNumber?: number;
  text: string;
}

export interface SourceDocumentEntry {
  id: string;
  fileName: string;
  path: string;
  pillar: 'sources';
  title: string;
  kind: SourceDocumentKind;
  size: number;
  lastModified: number;
  contentHash: string;
  chunks: SourceDocumentChunk[];
  unsupportedReason?: string;
  updatedAt: string;
}

export interface EmbeddingModelConfig {
  modelId: string;
  vectorSize: number;
  isDownloaded: boolean;
  cachedAt?: string;
}

export type EmbeddingLifecycleStatus =
  | 'idle'
  | 'downloading'
  | 'loading'
  | 'ready'
  | 'indexing'
  | 'cancelled'
  | 'error';

export interface EmbeddingProgressState {
  status: EmbeddingLifecycleStatus;
  modelId: string;
  vectorSize: number;
  progress: number;
  loadedBytes: number;
  totalBytes: number;
  currentFile?: string;
  message?: string;
  indexedCount?: number;
  totalToIndex?: number;
}

export type ScoreLabel = 'semantic similarity' | 'word match';

export interface SearchResultItem {
  chunkId: string;
  noteId: string;
  blockId: string;
  kind: 'note' | 'source';
  pillar: Pillar;
  title: string;
  path: string;
  headingPath: string[];
  text: string;
  score: number;
  scoreLabel: ScoreLabel;
}

export interface SuggestedConnection {
  suggestionKey: string;
  fromNoteId: string;
  targetNoteId: string;
  targetBlockId: string;
  targetKind: 'note' | 'source';
  targetPillar: Pillar;
  targetTitle: string;
  targetPath: string;
  targetExcerpt: string;
  headingPath: string[];
  score: number;
  scoreLabel: ScoreLabel;
}

export interface BacklinkRecord {
  id: string;
  sourceNoteId: string;
  sourceBlockId: string;
  sourceTitle: string;
  targetNoteId: string;
  targetBlockId: string;
  targetTitle: string;
  targetPillar: Pillar;
  targetKind: 'note' | 'source';
  score: number;
  scoreLabel: ScoreLabel;
  readOnly?: boolean;
  createdAt: string;
}

export type CloudProviderId = 'openai' | 'anthropic' | 'gemini';

export type KeyStorageMode = 'encrypted-indexeddb' | 'session-only';

export interface EncryptedKeyRecord {
  provider: CloudProviderId;
  saltBase64: string;
  ivBase64: string;
  ciphertextBase64: string;
  iterations: number;
  model: string;
  updatedAt: string;
}

export interface ProviderKeyStatus {
  provider: CloudProviderId;
  model: string;
  hasSessionKey: boolean;
  hasEncryptedKey: boolean;
  storageMode: KeyStorageMode | 'none';
  updatedAt?: string;
}

export interface CloudRetrievedExcerpt {
  citationNumber: number;
  chunkId: string;
  noteId: string;
  blockId: string;
  kind: 'note' | 'source';
  pillar: Pillar;
  sourceTitle: string;
  sourcePath: string;
  headingPath: string[];
  text: string;
  score: number;
  scoreLabel: ScoreLabel;
  wasTruncated?: boolean;
  hadMarkupStripped?: boolean;
}

export interface CloudSynthesisRequestPreview {
  requestId: string;
  provider: CloudProviderId;
  providerLabel: string;
  endpointHost: string;
  model: string;
  question: string;
  outputFormat?: SynthesisOutputFormat;
  maxExcerptChars?: number;
  excerpts: CloudRetrievedExcerpt[];
  sectionPlans?: SectionRetrievalPlanItem[];
  knowledgeGapThreshold?: number;
  webGroundingEnabled?: boolean;
  allowedDomains?: string[];
  providerDomainRestrictionNote?: string;
  totalChars: number;
  createdAt: string;
}

export interface CloudSynthesisCitation {
  citationNumber: number;
  noteId: string;
  blockId: string;
  kind: 'note' | 'source';
  pillar: Pillar;
  sourceTitle: string;
  headingPath: string[];
  excerpt: string;
}

export interface CloudSynthesisResponse {
  provider: CloudProviderId;
  model: string;
  question: string;
  outputFormat?: SynthesisOutputFormat;
  answerText: string;
  citedNumbers: number[];
  citations: CloudSynthesisCitation[];
  structuredOutput?: ValidatedSynthesisOutput;
  sectionPlans?: SectionRetrievalPlanItem[];
  knowledgeGapThreshold?: number;
  webGroundingEnabled?: boolean;
  allowedDomains?: string[];
  webCitations?: WebGroundingCitation[];
  droppedWebCitationsCount?: number;
  droppedWebDomains?: string[];
  webGroundingNotice?: string;
  createdAt: string;
}

export const CATEGORIES: Category[] = [
  'Work',
  'Study',
  'Assignment',
  'Projects',
  'Videos',
  'Wishlist',
];

export const CATEGORY_STYLE: Record<
  Category,
  {
    dot: string;
    text: string;
    activeBg: string;
    activeBorder: string;
  }
> = {
  Work: {
    dot: 'bg-sky-400',
    text: 'text-sky-300',
    activeBg: 'bg-sky-500/15',
    activeBorder: 'border-sky-400/50',
  },
  Study: {
    dot: 'bg-amber-400',
    text: 'text-amber-300',
    activeBg: 'bg-amber-500/15',
    activeBorder: 'border-amber-400/50',
  },
  Assignment: {
    dot: 'bg-rose-400',
    text: 'text-rose-300',
    activeBg: 'bg-rose-500/15',
    activeBorder: 'border-rose-400/50',
  },
  Projects: {
    dot: 'bg-emerald-400',
    text: 'text-emerald-300',
    activeBg: 'bg-emerald-500/15',
    activeBorder: 'border-emerald-400/50',
  },
  Videos: {
    dot: 'bg-violet-400',
    text: 'text-violet-300',
    activeBg: 'bg-violet-500/15',
    activeBorder: 'border-violet-400/50',
  },
  Wishlist: {
    dot: 'bg-teal-400',
    text: 'text-teal-300',
    activeBg: 'bg-teal-500/15',
    activeBorder: 'border-teal-400/50',
  },
};
