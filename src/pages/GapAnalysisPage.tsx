import {useEffect, useState} from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Filter,
  Lock,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Upload,
  XCircle,
} from 'lucide-react';
import {
  buildGapAnalysisReport,
  cancelSyllabusPreview,
  executeApprovedSyllabusExtraction,
  mapTopicsAgainstLocalIndex,
  MAX_SYLLABUS_CHARS,
  prepareSyllabusPreview,
} from '../cloud/gapAnalysisService';
import {
  getUnlockedSessionKey,
  resolvePreferredProvider,
  subscribeKeyVaultChanges,
} from '../cloud/keyVault';
import {getProviderAdapter} from '../cloud/providerAdapter';
import {
  DEFAULT_KNOWLEDGE_GAP_THRESHOLD,
  loadTrustSettings,
} from '../cloud/trustSettings';
import {CloudPrivacyNoticeModal} from '../components/CloudPrivacyNoticeModal';
import {extractPdfPagesInWorker} from '../search/pdfExtractor';
import {
  Category,
  CloudProviderId,
  CloudSynthesisRequestPreview,
  ExtractedSyllabusTopic,
  GapAnalysisReport,
  RoutePath,
  SearchResultItem,
  SourceDocumentEntry,
  StoredNoteEntry,
  SyllabusTopicCoverageResult,
} from '../types/noodle';

interface GapAnalysisPageProps {
  notes: StoredNoteEntry[];
  sourceDocuments: SourceDocumentEntry[];
  aiEnabled: boolean;
  onNavigate: (route: RoutePath) => void;
  onNavigateToBlock: (
    noteId: string,
    blockId: string,
    kind: 'note' | 'source',
  ) => void;
  onOpenNewNote?: (initialTitle?: string, initialText?: string) => void;
  onOpenKeySetup: () => void;
}

const SAMPLE_SYLLABUS = `CS 106B: Programming Abstractions & Data Structures

Week 1: Algorithmic Analysis and Big-O Notation
- Complexity classes: O(1), O(log n), O(n), O(n log n), O(n^2)
- Asymptotic growth and recurrence relations
- Master theorem basics

Week 2: Recursive Backtracking and Combinatorics
- Decision trees and exploring permutations
- Subsets and knapsack optimization
- Pruning recursive branches and memoization

Week 3: Linear Data Structures and Memory
- Arrays vs Linked lists
- Dynamic arrays, amortized resizing, and pointer arithmetic
- Stack and Queue implementations with linked nodes

Week 4: Trees, Heaps, and Priority Queues
- Binary search trees, in-order traversal, and BST invariants
- AVL self-balancing trees and tree rotations
- Binary heap representations and priority queue percolate-up/down

Week 5: Graphs and Pathfinding
- Adjacency lists and adjacency matrices
- Breadth-first search (BFS) and Depth-first search (DFS)
- Dijkstra's algorithm and A* heuristic search`;

export function GapAnalysisPage({
  notes,
  sourceDocuments,
  aiEnabled,
  onNavigate,
  onNavigateToBlock,
  onOpenNewNote,
  onOpenKeySetup,
}: GapAnalysisPageProps) {
  const [syllabusInput, setSyllabusInput] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [extractingFile, setExtractingFile] = useState(false);
  const [fileNotice, setFileNotice] = useState<string | null>(null);

  // Provider configuration
  const [provider, setProvider] = useState<CloudProviderId>('gemini');
  const [model, setModel] = useState('gemini-2.5-flash');
  const [hasSessionKey, setHasSessionKey] = useState(false);

  // Analysis workflow
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [privacyPreview, setPrivacyPreview] =
    useState<CloudSynthesisRequestPreview | null>(null);
  const [report, setReport] = useState<GapAnalysisReport | null>(null);

  // Dashboard filtering
  const [filterMode, setFilterMode] = useState<
    'all' | 'gaps' | 'zero' | 'weak' | 'covered'
  >('all');
  const [expandedTopicId, setExpandedTopicId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const syncKeyStatus = async () => {
      try {
        const preferred = await resolvePreferredProvider();
        if (!active) return;
        setProvider(preferred.provider);
        setModel(preferred.model);
        const unlocked = getUnlockedSessionKey(preferred.provider);
        setHasSessionKey(Boolean(unlocked?.apiKey));
      } catch {
        if (!active) return;
        const unlocked = getUnlockedSessionKey('gemini');
        setHasSessionKey(Boolean(unlocked?.apiKey));
      }
    };
    void syncKeyStatus();
    const unsubscribe = subscribeKeyVaultChanges(() => {
      void syncKeyStatus();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const handleProcessFile = async (file: File) => {
    setAnalysisError(null);
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.pptx') || lower.endsWith('.ppt')) {
      setFileNotice(null);
      setAnalysisError(
        'Slide formats (.pptx) are not supported yet. Upload a PDF, .txt, or .md file.',
      );
      return;
    }
    const isPdf = lower.endsWith('.pdf');
    const isPlainText =
      lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.markdown');
    if (!isPdf && !isPlainText) {
      setFileNotice(null);
      setAnalysisError(
        'Unsupported file type. Please upload a .pdf, .txt, or .md syllabus.',
      );
      return;
    }

    setFileNotice(`Reading ${file.name}...`);
    try {
      if (isPdf) {
        setExtractingFile(true);
        const buffer = await file.arrayBuffer();
        const pages = await extractPdfPagesInWorker(buffer);
        const text = pages.map((p) => p.text).join('\n\n');
        setSyllabusInput(text.slice(0, MAX_SYLLABUS_CHARS));
        setFileNotice(`Loaded ${pages.length} pages from ${file.name}`);
      } else {
        const text = await file.text();
        setSyllabusInput(text.slice(0, MAX_SYLLABUS_CHARS));
        setFileNotice(`Loaded text from ${file.name}`);
      }
    } catch (err) {
      setFileNotice(null);
      setAnalysisError(
        `Could not read ${file.name}: ${(err as Error).message}`,
      );
    } finally {
      setExtractingFile(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      await handleProcessFile(file);
    }
  };

  const handleStartAnalysis = (e: React.FormEvent) => {
    e.preventDefault();
    setAnalysisError(null);

    const trimmed = syllabusInput.trim();
    if (!trimmed) {
      setAnalysisError(
        'Please paste or drop syllabus text before analyzing.',
      );
      return;
    }

    if (!hasSessionKey) {
      setAnalysisError(
        `No API key found for ${getProviderAdapter(provider).label}. Please configure your API key first.`,
      );
      return;
    }

    try {
      // Step 1: Prepare preview for mandatory Privacy Notice
      const preview = prepareSyllabusPreview({
        provider,
        model,
        syllabusText: trimmed,
      });

      // Step 2: Show Privacy Notice modal before any data leaves the device
      setPrivacyPreview(preview);
    } catch (err) {
      setAnalysisError((err as Error).message);
    }
  };

  const handleCancelPrivacyNotice = () => {
    if (privacyPreview) {
      cancelSyllabusPreview(privacyPreview.requestId);
    }
    setPrivacyPreview(null);
  };

  const handleConfirmPrivacyNotice = async () => {
    if (!privacyPreview) return;
    const previewToRun = privacyPreview;
    setPrivacyPreview(null);
    setAnalyzing(true);
    setAnalysisError(null);

    try {
      // Step 3: Extract topics & entities via cloud model (only after notice approval)
      const {courseTitle, topics} = await executeApprovedSyllabusExtraction({
        preview: previewToRun,
        userApprovedNotice: true,
      });

      // Step 4: Map extracted topics against local vector index / notes
      const trustSettings = await loadTrustSettings();
      const threshold = trustSettings.knowledgeGapThreshold || DEFAULT_KNOWLEDGE_GAP_THRESHOLD;

      const mapped = await mapTopicsAgainstLocalIndex({
        topics,
        notes,
        sources: sourceDocuments,
        aiEnabled,
        threshold,
      });

      // Step 5: Build comprehensive gap analysis report
      const rep = buildGapAnalysisReport({
        courseTitle,
        syllabusSnippet: syllabusInput,
        threshold,
        topics: mapped,
      });

      setReport(rep);
    } catch (err) {
      setAnalysisError((err as Error).message || 'Failed to complete gap analysis.');
    } finally {
      setAnalyzing(false);
    }
  };

  const filteredTopics = report?.topics.filter((item) => {
    if (filterMode === 'all') return true;
    if (filterMode === 'gaps') return item.knowledgeGap;
    if (filterMode === 'zero') return item.coverage === 'zero';
    if (filterMode === 'weak') return item.coverage === 'weak';
    if (filterMode === 'covered') return item.coverage === 'covered';
    return true;
  });

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 lg:px-8">
      {/* Page Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 pb-1">
        <div className="space-y-1">
          <h1 className="font-serif text-2xl font-semibold text-[#F5F1E8] sm:text-3xl">
            Syllabus Topic Check
          </h1>
          <p className="max-w-prose text-xs text-[#9198A8] sm:text-sm">
            Compare your notes against a course syllabus to spot missing topics.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onOpenKeySetup}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#2B3040] bg-[#161922] px-3.5 text-xs font-medium text-[#C8CCD6] transition-colors hover:text-white"
          >
            <Lock className="h-3.5 w-3.5 text-[#E0A83E]" />
            <span>{hasSessionKey ? 'AI Key Ready' : 'Add AI Key'}</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('/workspace')}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#282D3B] bg-[#141720] px-3.5 text-xs font-medium text-[#C8CCD6] transition-colors hover:border-[#383F52] hover:text-[#ECEBE6]"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Back to Workspace</span>
          </button>
        </div>
      </div>

      <div className="space-y-6">
        {/* Syllabus Drop-Zone & Input Area */}
        <section aria-labelledby="syllabus-input-title" className="rounded-xl border border-[#232733] bg-[#141720] p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 id="syllabus-input-title" className="text-sm font-semibold text-[#F4F1EA] flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-[#E0A83E]" />
              <span>Course Syllabus</span>
            </h2>

            <button
              type="button"
              onClick={() => {
                setSyllabusInput(SAMPLE_SYLLABUS);
                setFileNotice('Loaded sample CS 106B syllabus');
              }}
              className="text-xs text-[#E0A83E] hover:underline"
            >
              Try Sample Syllabus
            </button>
          </div>

          <form onSubmit={handleStartAnalysis} className="space-y-4">
            {/* Drag & Drop Zone */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`relative flex flex-col items-center justify-center rounded-lg border border-dashed p-6 transition-colors ${
                dragActive
                  ? 'border-[#E0A83E] bg-[#1C1A15]'
                  : 'border-[#262C3D] bg-[#0E1015] hover:border-[#384158]'
              }`}
            >
              <Upload className="mb-2 h-7 w-7 text-[#687082]" />
              <p className="text-center text-xs font-medium text-[#C8CCD6]">
                Drop a syllabus (.pdf, .txt, or .md) here
              </p>
              <p className="mt-1 text-[11px] text-[#71788A]">or paste it below</p>

              <label className="mt-3 inline-flex h-8 cursor-pointer items-center rounded-md bg-[#202532] px-3 text-xs font-medium text-[#ECEBE6] transition-colors hover:bg-[#282E3E]">
                <span>Choose File</span>
                <input
                  type="file"
                  accept=".pdf,.txt,.md,.markdown"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleProcessFile(file);
                    e.target.value = '';
                  }}
                  className="hidden"
                />
              </label>

              {extractingFile && (
                <div className="mt-2 flex items-center gap-1.5 text-xs text-[#E0A83E]">
                  <RefreshCw className="h-3 w-3 animate-spin" />
                  <span>Reading PDF...</span>
                </div>
              )}

              {fileNotice && !extractingFile && (
                <p className="mt-2 text-xs font-medium text-emerald-400">{fileNotice}</p>
              )}
            </div>

            {/* Direct Textarea */}
            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs text-[#8E95A5]">
                <span>Syllabus Text</span>
                <span className="text-[11px] tabular-nums">
                  {syllabusInput.length} / {MAX_SYLLABUS_CHARS} characters
                </span>
              </div>
              <textarea
                rows={6}
                value={syllabusInput}
                onChange={(e) => setSyllabusInput(e.target.value)}
                placeholder="Paste course modules, exam outlines, or weekly topics here..."
                className="w-full rounded-lg border border-[#252B3B] bg-[#0E1015] p-3 text-xs text-[#ECEBE6] placeholder-[#5C6374] focus:border-[#E0A83E] focus:outline-none"
              />
            </div>

            {/* Privacy indicator banner */}
            <div className="flex items-center justify-between rounded-lg bg-[#11131B] px-3.5 py-2.5 text-xs text-[#8E95A5]">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-[#E0A83E]" />
                <span>
                  Asks your permission before sending syllabus text to{' '}
                  <span className="font-medium text-[#ECEBE6]">
                    {getProviderAdapter(provider).label}
                  </span>.
                </span>
              </div>
            </div>

            {analysisError && (
              <div className="flex items-center gap-2 rounded-lg bg-[#201318] p-3 text-xs text-rose-300">
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                <span>{analysisError}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-1">
              <button
                type="submit"
                disabled={!syllabusInput.trim() || analyzing || extractingFile}
                className="inline-flex items-center gap-2 rounded-lg bg-[#E0A83E] px-4 py-2 text-xs font-semibold text-[#111216] hover:bg-[#ECB955] transition-colors disabled:opacity-50"
              >
                {analyzing ? (
                  <>
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    <span>Checking your notes...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="h-3.5 w-3.5 stroke-[2.5]" />
                    <span>Check Coverage</span>
                  </>
                )}
              </button>
            </div>
          </form>
        </section>

        {/* Gap Analysis Results Dashboard */}
        {report && (
          <section aria-labelledby="dashboard-title" className="space-y-5">
            {/* Dashboard Summary Cards */}
            <div className="rounded-xl border border-[#232733] bg-[#141720] p-5">
              <div className="flex flex-col pb-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 id="dashboard-title" className="font-serif text-base font-semibold text-[#F4F1EA]">
                    {report.courseTitle} · Coverage Summary
                  </h2>
                  <p className="text-xs text-[#8E95A5] tabular-nums">
                    Minimum match score: <span className="font-semibold text-[#E0A83E]">{report.thresholdUsed}</span> · Checked at {new Date(report.analyzedAt).toLocaleTimeString()}
                  </p>
                </div>

                <div className="mt-2 flex items-center gap-2 sm:mt-0">
                  <span className="text-xs text-[#8E95A5]">Coverage Rate:</span>
                  <span className="text-sm font-semibold text-emerald-400 tabular-nums">
                    {Math.round((report.coveredCount / (report.totalTopics || 1)) * 100)}%
                  </span>
                </div>
              </div>

              {/* Stat Pillars */}
              <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
                <div className="rounded-lg bg-[#0E1015] p-3.5">
                  <p className="text-xs text-[#7E8597]">Total Topics</p>
                  <p className="mt-1 text-xl font-bold text-[#F4F1EA] tabular-nums">
                    {report.totalTopics}
                  </p>
                </div>

                <div className="rounded-lg bg-[#101C18] p-3.5">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-emerald-400">Well Covered</p>
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  </div>
                  <p className="mt-1 text-xl font-bold text-emerald-400 tabular-nums">
                    {report.coveredCount}
                  </p>
                </div>

                <div className="rounded-lg bg-[#1A160E] p-3.5">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-amber-400">Weak Coverage</p>
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                  </div>
                  <p className="mt-1 text-xl font-bold text-amber-400 tabular-nums">
                    {report.weakCoverageCount}
                  </p>
                </div>

                <div className="rounded-lg bg-[#1C1216] p-3.5">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-rose-400">Zero Coverage</p>
                    <XCircle className="h-3.5 w-3.5 text-rose-400" />
                  </div>
                  <p className="mt-1 text-xl font-bold text-rose-400 tabular-nums">
                    {report.zeroCoverageCount}
                  </p>
                </div>
              </div>

              {/* Progress bar */}
              <div className="mt-4">
                <div className="flex h-2 w-full overflow-hidden rounded-sm bg-[#1F2432]">
                  <div
                    style={{
                      width: `${(report.coveredCount / (report.totalTopics || 1)) * 100}%`,
                    }}
                    className="bg-emerald-500"
                    title={`Covered: ${report.coveredCount}`}
                  />
                  <div
                    style={{
                      width: `${(report.weakCoverageCount / (report.totalTopics || 1)) * 100}%`,
                    }}
                    className="bg-amber-500"
                    title={`Weak: ${report.weakCoverageCount}`}
                  />
                  <div
                    style={{
                      width: `${(report.zeroCoverageCount / (report.totalTopics || 1)) * 100}%`,
                    }}
                    className="bg-rose-500"
                    title={`Zero: ${report.zeroCoverageCount}`}
                  />
                </div>
              </div>
            </div>

            {/* Filter Tabs */}
            <div className="flex flex-wrap items-center gap-1.5 pb-1 text-xs">
              <span className="text-[#7A8192] mr-2 flex items-center gap-1">
                <Filter className="h-3.5 w-3.5" />
                <span>Filter:</span>
              </span>

              <button
                type="button"
                onClick={() => setFilterMode('all')}
                className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                  filterMode === 'all'
                    ? 'bg-[#E0A83E] text-[#111216] font-semibold'
                    : 'text-[#8E95A5] hover:text-[#ECEBE6]'
                }`}
              >
                All ({report.totalTopics})
              </button>

              <button
                type="button"
                onClick={() => setFilterMode('gaps')}
                className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                  filterMode === 'gaps'
                    ? 'bg-[#E0A83E] text-[#111216] font-semibold'
                    : 'text-[#8E95A5] hover:text-[#ECEBE6]'
                }`}
              >
                Gaps Only ({report.zeroCoverageCount + report.weakCoverageCount})
              </button>

              <button
                type="button"
                onClick={() => setFilterMode('zero')}
                className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                  filterMode === 'zero'
                    ? 'bg-rose-500 text-white font-semibold'
                    : 'text-rose-400/80 hover:text-rose-300'
                }`}
              >
                Zero Coverage ({report.zeroCoverageCount})
              </button>

              <button
                type="button"
                onClick={() => setFilterMode('weak')}
                className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                  filterMode === 'weak'
                    ? 'bg-amber-500 text-[#111216] font-semibold'
                    : 'text-amber-400/80 hover:text-amber-300'
                }`}
              >
                Weak ({report.weakCoverageCount})
              </button>

              <button
                type="button"
                onClick={() => setFilterMode('covered')}
                className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                  filterMode === 'covered'
                    ? 'bg-emerald-500 text-[#111216] font-semibold'
                    : 'text-emerald-400/80 hover:text-emerald-300'
                }`}
              >
                Covered ({report.coveredCount})
              </button>
            </div>

            {/* Topic List */}
            <div className="space-y-3">
              {filteredTopics?.length === 0 ? (
                <div className="rounded-lg border border-[#232734] bg-[#141720] p-8 text-center text-xs text-[#8E95A5]">
                  No topics in this filter view.
                </div>
              ) : (
                filteredTopics?.map((item) => {
                  const isExpanded = expandedTopicId === item.topic.id;
                  const isZero = item.coverage === 'zero';
                  const isWeak = item.coverage === 'weak';

                  return (
                    <div
                      key={item.topic.id}
                      className={`rounded-xl border transition-colors duration-150 ${
                        isZero
                          ? 'border-[#4D242E] bg-[#181216]'
                          : isWeak
                            ? 'border-[#4D3D20] bg-[#181510]'
                            : 'border-[#232734] bg-[#141720]'
                      }`}
                    >
                      {/* Topic Card Header */}
                      <div className="flex flex-col justify-between gap-3 p-4 md:flex-row md:items-center">
                        <div className="flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2.5">
                            <h3 className="text-sm font-semibold text-[#F4F1EA]">
                              {item.topic.name}
                            </h3>

                            {isZero ? (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-rose-300">
                                <XCircle className="h-3.5 w-3.5" />
                                <span>Zero Coverage</span>
                              </span>
                            ) : isWeak ? (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-300">
                                <AlertTriangle className="h-3.5 w-3.5" />
                                <span>Weak Coverage</span>
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-300">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                <span>Well Covered</span>
                              </span>
                            )}
                          </div>

                          {item.topic.description && (
                            <p className="max-w-prose text-xs leading-relaxed text-[#9CA1AE]">
                              {item.topic.description}
                            </p>
                          )}

                          {/* Extracted Key Terms */}
                          {item.topic.entities.length > 0 && (
                            <p className="pt-0.5 text-[11px] text-[#8E95A5]">
                              <span className="text-[#6E7587]">Key terms: </span>
                              {item.topic.entities.join(' · ')}
                            </p>
                          )}
                        </div>

                        {/* Best Score & Action */}
                        <div className="flex shrink-0 items-center gap-3">
                          <div className="text-right tabular-nums">
                            <p className="text-[11px] text-[#7D8496]">Best Score</p>
                            <p
                              className={`text-xs font-semibold ${
                                isZero
                                  ? 'text-rose-400'
                                  : isWeak
                                    ? 'text-amber-400'
                                    : 'text-emerald-400'
                              }`}
                            >
                              {item.bestScore > 0 ? item.bestScore.toFixed(2) : '0.00'}
                            </p>
                            <p className="text-[10px] text-[#656D7E]">
                              {item.scoreLabel}
                            </p>
                          </div>

                          {/* Actions */}
                          {item.bestMatches.length > 0 ? (
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedTopicId(isExpanded ? null : item.topic.id)
                              }
                              className="inline-flex h-8 items-center gap-1 rounded-md border border-[#2B3040] bg-[#181B24] px-2.5 text-xs text-[#C8CCD6] transition-colors hover:bg-[#202430] hover:text-white"
                            >
                              <span className="tabular-nums">{item.bestMatches.length} matches</span>
                              <ChevronDown
                                className={`h-3.5 w-3.5 transition-transform duration-150 ${
                                  isExpanded ? 'rotate-180' : ''
                                }`}
                              />
                            </button>
                          ) : (
                            onOpenNewNote && (
                              <button
                                type="button"
                                onClick={() =>
                                  onOpenNewNote(
                                    item.topic.name,
                                    `# ${item.topic.name}\n\n${item.topic.description}\n\n## Key Concepts\n${item.topic.entities
                                      .map((e) => `- ${e}`)
                                      .join('\n')}`,
                                  )
                                }
                                className="inline-flex h-8 items-center gap-1 rounded-md bg-[#232018] px-2.5 text-xs font-medium text-[#E0A83E] transition-colors hover:bg-[#322B1E]"
                              >
                                <Plus className="h-3.5 w-3.5" />
                                <span>Create Note</span>
                              </button>
                            )
                          )}
                        </div>
                      </div>

                      {/* Best Matches Accordion */}
                      {isExpanded && item.bestMatches.length > 0 && (
                        <div className="space-y-2 bg-[#0E1015] p-4">
                          <p className="text-[11px] font-medium text-[#8E95A5]">
                            Best note matches in your workspace:
                          </p>

                          <div className="space-y-1.5">
                            {item.bestMatches.map((m) => (
                              <div
                                key={m.chunkId}
                                className="flex items-start justify-between gap-3 rounded-lg bg-[#13151D] p-3 text-xs"
                              >
                                <div className="min-w-0 flex-1 space-y-1">
                                  <div className="flex items-center gap-1.5">
                                    <span className="truncate font-medium text-[#E0A83E]">
                                      {m.title}
                                    </span>
                                    <span className="text-[11px] text-[#8E95A5]">
                                      · {m.pillar === 'manual' ? 'My Notes' : m.pillar === 'sources' ? 'Sources' : 'AI Notes'}
                                    </span>
                                    {m.headingPath.length > 0 && (
                                      <span className="truncate text-[11px] text-[#71788B]">
                                        · {m.headingPath.join(' › ')}
                                      </span>
                                    )}
                                  </div>

                                  <p className="line-clamp-2 text-xs text-[#C8CCD6]">
                                    {m.text}
                                  </p>
                                </div>

                                <div className="flex shrink-0 items-center gap-2.5">
                                  <span className="text-xs text-[#8E95A5] tabular-nums">
                                    {m.score.toFixed(2)}
                                  </span>

                                  <button
                                    type="button"
                                    onClick={() =>
                                      onNavigateToBlock(m.noteId, m.blockId, m.kind)
                                    }
                                    className="inline-flex h-7 items-center gap-1 rounded bg-[#232018] px-2.5 text-[11px] font-medium text-[#F3CA77] transition-colors hover:bg-[#322B1E]"
                                  >
                                    <span>Open Section</span>
                                    <ArrowRight className="h-3 w-3" />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </section>
        )}
      </div>

      {/* Mandatory Privacy Notice Modal before sending syllabus text to cloud */}
      <CloudPrivacyNoticeModal
        preview={privacyPreview}
        sending={analyzing}
        onCancel={handleCancelPrivacyNotice}
        onConfirmSend={handleConfirmPrivacyNotice}
      />
    </div>
  );
}
