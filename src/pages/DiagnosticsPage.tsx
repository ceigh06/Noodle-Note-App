import {useCallback, useEffect, useState} from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  ClipboardCheck,
  Play,
  XCircle,
} from 'lucide-react';
import {runCloudDiagnostics} from '../cloud/cloudDiagnostics';
import {runEditorDiagnostics} from '../editor/editorDiagnostics';
import {runPdfAnnotationDiagnostics} from '../pdf/pdfDiagnostics';
import {runSearchDiagnostics} from '../search/searchDiagnostics';
import {
  runChangeDetectionDiagnostics,
  runImageDiagnostics,
  runStorageDiagnostics,
} from '../storage/workspaceStorage';
import {runVoiceDiagnostics} from '../voice/voiceDiagnostics';
import {
  DiagnosticCheckResult,
  RoutePath,
  SourceDocumentEntry,
  StoredNoteEntry,
} from '../types/noodle';

interface DiagnosticsPageProps {
  notes: StoredNoteEntry[];
  sourceDocuments: SourceDocumentEntry[];
  onNavigate: (route: RoutePath) => void;
}

export function DiagnosticsPage({
  notes,
  sourceDocuments,
  onNavigate,
}: DiagnosticsPageProps) {
  const [checks, setChecks] = useState<DiagnosticCheckResult[]>([]);
  const [running, setRunning] = useState(false);
  const [activeSuiteNote, setActiveSuiteNote] = useState<string | null>(null);

  const runChecks = useCallback(async () => {
    const runToken = Date.now() + Math.random();
    (runChecks as {latestToken?: number}).latestToken = runToken;
    setRunning(true);
    setChecks([]);
    setActiveSuiteNote('Running storage, editor, PDF, voice, and cloud checks...');

    const suiteOrder = [
      'storage',
      'editor',
      'image',
      'change',
      'pdf',
      'voice',
      'cloud',
      'search',
    ] as const;
    const suiteBuckets = new Map<string, DiagnosticCheckResult[]>();

    const publish = () => {
      if ((runChecks as {latestToken?: number}).latestToken !== runToken) {
        return;
      }
      const ordered: DiagnosticCheckResult[] = [];
      for (const key of suiteOrder) {
        const items = suiteBuckets.get(key);
        if (items) {
          ordered.push(...items);
        }
      }
      setChecks(ordered);
    };

    const runSuite = async (
      key: (typeof suiteOrder)[number],
      fn: () => Promise<DiagnosticCheckResult[]>,
    ) => {
      try {
        const res = await fn();
        suiteBuckets.set(key, res);
      } catch (err) {
        suiteBuckets.set(key, [
          {
            id: `${key}-suite-error`,
            name: `${key} suite`,
            status: 'FAIL',
            details: (err as Error).message || 'Diagnostic suite threw an error.',
            durationMs: 0,
          },
        ]);
      } finally {
        publish();
      }
    };

    try {
      await Promise.all([
        runSuite('storage', runStorageDiagnostics),
        runSuite('editor', runEditorDiagnostics),
        runSuite('image', runImageDiagnostics),
        runSuite('change', runChangeDetectionDiagnostics),
        runSuite('pdf', () => runPdfAnnotationDiagnostics(sourceDocuments)),
        runSuite('voice', runVoiceDiagnostics),
        runSuite('cloud', runCloudDiagnostics),
        (async () => {
          await runSuite('search', () =>
            runSearchDiagnostics(notes, sourceDocuments),
          );
          if ((runChecks as {latestToken?: number}).latestToken === runToken) {
            setActiveSuiteNote(null);
          }
        })(),
      ]);
    } finally {
      if ((runChecks as {latestToken?: number}).latestToken === runToken) {
        setRunning(false);
        setActiveSuiteNote(null);
      }
    }
  }, [notes, sourceDocuments]);

  useEffect(() => {
    void runChecks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const passedCount = checks.filter((c) => c.status === 'PASS').length;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#202430] pb-5">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-medium text-[#E0A83E]">
            <ClipboardCheck className="h-3.5 w-3.5" />
            <span>System Verification</span>
          </div>
          <h1 className="font-serif text-2xl font-semibold tracking-tight text-[#F5F1E8] sm:text-3xl">
            Diagnostics
          </h1>
          <p className="text-xs text-[#9198A8] sm:text-sm">
            Automated storage, block-ID stability, schema migration, canonical
            hash, Markdown round-trip, autosave, image asset, change-detection,
            on-device search, PDF immutability, voice kill switch &amp; zero audio
            storage, and BYOK cloud privacy self-checks.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={runChecks}
            disabled={running}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#E0A83E] px-3.5 py-2 text-xs font-semibold text-[#111216] transition-colors hover:bg-[#ECB955] disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" />
            <span>{running ? 'Running checks...' : 'Run Self-Checks'}</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('/workspace')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#282D3B] bg-[#141720] px-3.5 py-2 text-xs font-medium text-[#C8CCD6] transition-colors hover:border-[#383F52] hover:text-[#ECEBE6]"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Back to Workspace</span>
          </button>
        </div>
      </div>

      {/* Summary line */}
      {checks.length > 0 && (
        <div className="flex items-center justify-between text-xs text-[#8E95A5] tabular-nums">
          <span>
            Passed{' '}
            <span className="font-semibold text-[#ECEBE6]">{passedCount}</span>{' '}
            of {checks.length} checks
          </span>
          <span>
            Storage, Editor, Asset, Change-Detection, Local Search, Voice &amp; BYOK
            Privacy invariants
          </span>
        </div>
      )}

      {running && activeSuiteNote && checks.length > 0 && (
        <div className="rounded-lg border border-[#232734] bg-[#13161E] px-4 py-2 text-xs text-[#9198A8]">
          Loading local embedding model in Web Worker for search diagnostics…
        </div>
      )}

      {/* Self-checks table */}
      <div className="overflow-hidden rounded-xl border border-[#232734] bg-[#13161E]">
        <div className="grid grid-cols-12 border-b border-[#202430] bg-[#101218] px-5 py-3 text-[11px] font-semibold tracking-wide text-[#7D8496]">
          <div className="col-span-4">Check</div>
          <div className="col-span-2">Status</div>
          <div className="col-span-5">Details</div>
          <div className="col-span-1 text-right">Time</div>
        </div>

        {checks.length === 0 ? (
          <div className="px-5 py-12 text-center text-xs text-[#848B9B]">
            Running self-checks...
          </div>
        ) : (
          <div className="divide-y divide-[#1E222E]">
            {checks.map((check) => {
              const isPass = check.status === 'PASS';
              return (
                <div
                  key={check.id}
                  className="grid grid-cols-12 items-start gap-2 px-5 py-3.5 text-xs"
                >
                  <div className="col-span-12 font-medium text-[#ECEBE6] sm:col-span-4">
                    {check.name}
                  </div>
                  <div className="col-span-4 sm:col-span-2">
                    <span
                      className={`inline-flex items-center gap-1.5 font-semibold ${
                        isPass ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {isPass ? (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5" />
                      )}
                      <span>{check.status}</span>
                    </span>
                  </div>
                  <div className="col-span-8 leading-relaxed text-[#A4AAB7] sm:col-span-5">
                    {check.details}
                  </div>
                  <div className="col-span-12 text-right font-mono text-[11px] text-[#7D8496] tabular-nums sm:col-span-1">
                    {check.durationMs !== undefined
                      ? `${check.durationMs}ms`
                      : '—'}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
