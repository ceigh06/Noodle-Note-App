import {useEffect, useState} from 'react';
import {
  ArrowLeft,
  Check,
  Globe,
  Plus,
  ShieldCheck,
  Sliders,
  Trash2,
  AlertCircle,
} from 'lucide-react';
import {
  DEFAULT_ALLOWED_DOMAINS,
  MAX_KNOWLEDGE_GAP_THRESHOLD,
  MIN_KNOWLEDGE_GAP_THRESHOLD,
  loadTrustSettings,
  loadTunableSectionScores,
  normalizeDomainRule,
  saveKnowledgeGapThreshold,
  saveUserAllowedDomains,
  saveWebGroundingEnabled,
  subscribeTrustSettingsChanges,
} from '../cloud/trustSettings';
import {RoutePath, TrustSettingsState, TunableSectionScoreRow} from '../types/noodle';

interface TrustTuningPageProps {
  onNavigate: (route: RoutePath) => void;
}

export function TrustTuningPage({onNavigate}: TrustTuningPageProps) {
  const [trustState, setTrustState] = useState<TrustSettingsState>({
    knowledgeGapThreshold: 0.25,
    webGroundingEnabled: false,
    userAllowedDomains: [],
  });
  const [sectionRows, setSectionRows] = useState<TunableSectionScoreRow[]>([]);
  const [newDomainInput, setNewDomainInput] = useState('');
  const [domainError, setDomainError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const refreshData = async () => {
    const [settings, scores] = await Promise.all([
      loadTrustSettings(),
      loadTunableSectionScores(),
    ]);
    setTrustState(settings);
    setSectionRows(scores);
  };

  useEffect(() => {
    void refreshData();
    const unsub = subscribeTrustSettingsChanges(() => {
      void refreshData();
    });
    return () => {
      unsub();
    };
  }, []);

  const handleThresholdChange = async (val: number) => {
    const updated = await saveKnowledgeGapThreshold(val);
    setTrustState(updated);
    setSuccessMessage('Knowledge gap threshold updated.');
    setTimeout(() => setSuccessMessage(null), 3000);
  };

  const handleToggleWebGrounding = async (enabled: boolean) => {
    const updated = await saveWebGroundingEnabled(enabled);
    setTrustState(updated);
    setSuccessMessage(
      enabled ? 'Web grounding enabled (whitelist restricted).' : 'Web grounding disabled.',
    );
    setTimeout(() => setSuccessMessage(null), 3000);
  };

  const handleAddDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    setDomainError(null);
    const normalized = normalizeDomainRule(newDomainInput);
    if (!normalized) {
      setDomainError('Enter a valid domain (e.g. arxiv.org or .ac.uk).');
      return;
    }
    const current = trustState.userAllowedDomains;
    if (current.includes(normalized) || DEFAULT_ALLOWED_DOMAINS.includes(normalized)) {
      setDomainError('Domain is already in the allowed list.');
      return;
    }
    const nextDomains = [...current, normalized];
    const updated = await saveUserAllowedDomains(nextDomains);
    setTrustState(updated);
    setNewDomainInput('');
    setSuccessMessage(`Added "${normalized}" to allowed whitelist.`);
    setTimeout(() => setSuccessMessage(null), 3000);
  };

  const handleRemoveDomain = async (domainToRemove: string) => {
    const nextDomains = trustState.userAllowedDomains.filter((d) => d !== domainToRemove);
    const updated = await saveUserAllowedDomains(nextDomains);
    setTrustState(updated);
    setSuccessMessage(`Removed "${domainToRemove}" from whitelist.`);
    setTimeout(() => setSuccessMessage(null), 3000);
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 lg:px-8">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#202430] pb-5">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-medium text-[#E0A83E]">
            <Sliders className="h-3.5 w-3.5" />
            <span>Trust Signals &amp; Knowledge Gap Tuning</span>
          </div>
          <h1 className="font-serif text-2xl font-semibold tracking-tight text-[#F5F1E8] sm:text-3xl">
            Trust &amp; Grounding Settings
          </h1>
          <p className="text-xs text-[#9198A8] sm:text-sm">
            Tune section knowledge gap thresholds, inspect local matching scores, and manage web grounding domain whitelists.
          </p>
        </div>

        <button
          type="button"
          onClick={() => onNavigate('/workspace/synthesizer')}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[#282D3B] bg-[#141720] px-3.5 py-2 text-xs font-medium text-[#C8CCD6] transition-colors hover:border-[#383F52] hover:text-[#ECEBE6]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Back to Synthesizer</span>
        </button>
      </div>

      {successMessage && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-200">
          <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-400" />
          <span>{successMessage}</span>
        </div>
      )}

      {/* Grid: Left = Knowledge Gap Threshold & Web Grounding, Right = Tunable Section Scores */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left Column */}
        <div className="space-y-6 lg:col-span-6">
          {/* Section 1: Knowledge Gap Threshold */}
          <section className="space-y-4 rounded-xl border border-[#232734] bg-[#13161E] p-5">
            <div className="space-y-1">
              <h2 className="font-serif text-base font-semibold text-[#F5F1E8]">
                Section-Level Knowledge Gap Threshold
              </h2>
              <p className="text-xs text-[#8E95A5]">
                If a synthesized section&apos;s best local retrieval similarity score falls below this threshold, the section is flagged with <code className="font-mono text-[#F4D084]">&apos;No supporting notes found&apos;</code>.
              </p>
            </div>

            <div className="space-y-3 rounded-lg border border-[#232734] bg-[#0E1015] p-4">
              <div className="flex items-center justify-between text-xs font-medium">
                <span className="text-[#C8CCD6]">Current Threshold</span>
                <span className="font-mono text-sm font-semibold text-[#E0A83E] tabular-nums">
                  {trustState.knowledgeGapThreshold.toFixed(2)}
                </span>
              </div>

              <input
                type="range"
                min={MIN_KNOWLEDGE_GAP_THRESHOLD}
                max={MAX_KNOWLEDGE_GAP_THRESHOLD}
                step={0.05}
                value={trustState.knowledgeGapThreshold}
                onChange={(e) => void handleThresholdChange(Number(e.target.value))}
                className="w-full accent-[#E0A83E] cursor-pointer"
              />

              <div className="flex justify-between text-[11px] text-[#7D8496] tabular-nums">
                <span>Stricter (0.05)</span>
                <span>Balanced (0.25)</span>
                <span>Lenient (0.90)</span>
              </div>
            </div>
          </section>

          {/* Section 2: Web Grounding & Domain Whitelist */}
          <section className="space-y-4 rounded-xl border border-[#232734] bg-[#13161E] p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="space-y-1">
                <h2 className="font-serif text-base font-semibold text-[#F5F1E8]">
                  Web Grounding (BYOK Cloud)
                </h2>
                <p className="text-xs text-[#8E95A5]">
                  Off by default. When enabled, cloud synthesis can incorporate web sources strictly filtered through your allowed domain whitelist.
                </p>
              </div>

              <label className="relative inline-flex cursor-pointer items-center">
                <input
                  type="checkbox"
                  checked={trustState.webGroundingEnabled}
                  onChange={(e) => void handleToggleWebGrounding(e.target.checked)}
                  className="peer sr-only"
                />
                <div className="peer h-6 w-11 rounded-full bg-[#222736] after:absolute after:top-[2px] after:left-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all after:content-[''] peer-checked:bg-[#E0A83E] peer-checked:after:translate-x-full peer-focus:outline-none" />
              </label>
            </div>

            {/* Allowed Domains */}
            <div className="space-y-3 pt-2">
              <p className="text-xs font-medium text-[#C8CCD6]">
                Allowed Domain Whitelist (.edu and .gov enabled by default)
              </p>

              <div className="flex flex-wrap gap-1.5">
                {DEFAULT_ALLOWED_DOMAINS.map((d) => (
                  <span
                    key={d}
                    className="inline-flex items-center gap-1 rounded-md border border-[#282D3B] bg-[#171A23] px-2.5 py-1 font-mono text-[11px] text-[#C8CCD6]"
                  >
                    <Globe className="h-3 w-3 text-[#E0A83E]" />
                    <span>{d}</span>
                    <span className="text-[9px] text-[#767D8F]">(default)</span>
                  </span>
                ))}
                {trustState.userAllowedDomains.map((d) => (
                  <span
                    key={d}
                    className="inline-flex items-center gap-1 rounded-md border border-[#3A4154] bg-[#1D2230] px-2.5 py-1 font-mono text-[11px] text-[#ECEBE6]"
                  >
                    <Globe className="h-3 w-3 text-emerald-400" />
                    <span>{d}</span>
                    <button
                      type="button"
                      onClick={() => void handleRemoveDomain(d)}
                      aria-label={`Remove domain ${d}`}
                      className="ml-1 rounded p-0.5 text-[#8E95A5] hover:text-rose-300"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>

              <form onSubmit={handleAddDomain} className="space-y-2 pt-1">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newDomainInput}
                    onChange={(e) => {
                      setNewDomainInput(e.target.value);
                      setDomainError(null);
                    }}
                    placeholder="e.g. arxiv.org or .ac.uk"
                    className="h-9 flex-1 rounded-lg border border-[#282D3B] bg-[#0E1015] px-3 font-mono text-xs text-[#ECEBE6] placeholder-[#656C7D] focus:border-[#E0A83E]/60 focus:outline-none"
                  />
                  <button
                    type="submit"
                    className="inline-flex h-9 items-center gap-1 rounded-lg bg-[#E0A83E] px-3.5 text-xs font-semibold text-[#111216] hover:bg-[#ECB955]"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Add domain</span>
                  </button>
                </div>
                {domainError && <p className="text-[11px] text-rose-400">{domainError}</p>}
              </form>
            </div>
          </section>
        </div>

        {/* Right Column: Tunable Section Scores Screen */}
        <div className="space-y-4 lg:col-span-6">
          <section className="flex flex-col rounded-xl border border-[#232734] bg-[#13161E] p-5">
            <div className="flex items-baseline justify-between gap-2 border-b border-[#202430] pb-3">
              <div>
                <h2 className="font-serif text-base font-semibold text-[#F5F1E8]">
                  Section Best Similarity Scores
                </h2>
                <p className="text-xs text-[#8E95A5]">
                  Recorded section retrieval scores across recent AI syntheses.
                </p>
              </div>
              <span className="font-mono text-xs text-[#7D8496] tabular-nums">
                {sectionRows.length} recorded
              </span>
            </div>

            <div className="mt-3 max-h-[520px] flex-1 space-y-2.5 overflow-y-auto pr-1">
              {sectionRows.length === 0 ? (
                <div className="py-16 text-center text-xs text-[#7D8496]">
                  <p className="font-medium text-[#9CA1AE]">No section scores recorded yet.</p>
                  <p className="mt-1">
                    Run a synthesis in <code className="font-mono">Synthesizer</code> to generate and evaluate section-level retrieval queries.
                  </p>
                </div>
              ) : (
                sectionRows.map((row) => {
                  const isGap = row.bestScore < trustState.knowledgeGapThreshold;
                  return (
                    <div
                      key={row.id}
                      className={`space-y-1.5 rounded-lg border p-3 text-xs transition-colors ${
                        isGap
                          ? 'border-amber-500/40 bg-amber-500/8'
                          : 'border-[#222634] bg-[#0F1117]'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-[#ECEBE6]">
                          {row.sectionHeading}
                        </span>
                        <span
                          className={`font-mono font-semibold tabular-nums ${
                            isGap ? 'text-amber-300' : 'text-emerald-400'
                          }`}
                        >
                          {row.bestScore.toFixed(2)} ({row.scoreLabel})
                        </span>
                      </div>

                      <p className="truncate text-[11px] text-[#8990A2]">
                        <span className="text-[#686F80]">Query:</span> &ldquo;{row.query}&rdquo;
                      </p>

                      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[10px]">
                        <span className="text-[#686F80]">
                          Synthesis: {row.synthesisTitle}
                        </span>
                        {isGap ? (
                          <span className="inline-flex items-center gap-1 font-semibold text-amber-200">
                            <AlertCircle className="h-3 w-3 text-amber-400" />
                            <span>No supporting notes found</span>
                          </span>
                        ) : (
                          <span className="font-medium text-emerald-300">
                            Supported (threshold {trustState.knowledgeGapThreshold.toFixed(2)})
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
