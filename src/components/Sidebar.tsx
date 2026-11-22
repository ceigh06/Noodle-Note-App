import {
  BookOpen,
  ClipboardCheck,
  Cpu,
  FolderOpen,
  FolderTree,
  GitMerge,
  GraduationCap,
  Layers,
  PenLine,
  Sliders,
  Target,
  X,
} from 'lucide-react';
import {PillarFilter, RoutePath} from '../types/noodle';

interface SidebarProps {
  route: RoutePath;
  activePillar: PillarFilter;
  counts: {
    all: number;
    sources: number;
    manual: number;
    ai: number;
  };
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onSelectPillar: (pillar: PillarFilter) => void;
  onNavigate: (route: RoutePath) => void;
}

export function Sidebar({
  route,
  activePillar,
  counts,
  mobileOpen,
  onCloseMobile,
  onSelectPillar,
  onNavigate,
}: SidebarProps) {
  const isWorkspaceGrid = route === '/workspace';

  const pillarItems: Array<{
    id: PillarFilter;
    label: string;
    subtitle: string;
    count: number;
    icon: typeof Layers;
  }> = [
    {
      id: 'all',
      label: 'All Notes',
      subtitle: 'Unified vault index',
      count: counts.all,
      icon: Layers,
    },
    {
      id: 'sources',
      label: 'Sources',
      subtitle: 'Papers, PDFs, references',
      count: counts.sources,
      icon: BookOpen,
    },
    {
      id: 'manual',
      label: 'Manual Notes',
      subtitle: 'Your writing · AI read-only',
      count: counts.manual,
      icon: PenLine,
    },
    {
      id: 'ai',
      label: 'AI Outputs',
      subtitle: 'Study guides & synthesis',
      count: counts.ai,
      icon: Cpu,
    },
  ];

  const toolItems: Array<{
    path: RoutePath;
    label: string;
    icon: typeof GraduationCap;
  }> = [
    {path: '/workspace/study', label: 'Study', icon: GraduationCap},
    {path: '/workspace/synthesizer', label: 'Synthesizer', icon: GitMerge},
    {path: '/workspace/gap-analysis', label: 'Gap Analysis', icon: Target},
    {path: '/workspace/organize', label: 'Organize Notes', icon: FolderTree},
    {path: '/workspace/trust-tuning', label: 'Trust & Tuning', icon: Sliders},
    {path: '/diagnostics', label: 'Diagnostics', icon: ClipboardCheck},
  ];

  const handlePillarClick = (pillar: PillarFilter) => {
    onSelectPillar(pillar);
    if (route !== '/workspace') {
      onNavigate('/workspace');
    }
    onCloseMobile();
  };

  const handleRouteClick = (nextRoute: RoutePath) => {
    onNavigate(nextRoute);
    onCloseMobile();
  };

  const sidebarContent = (
    <aside className="flex h-full w-64 flex-col border-r border-[#232733] bg-[#12141A] select-none">
      {/* Brand Title Bar */}
      <div className="flex h-14 items-center justify-between border-b border-[#232733] px-5">
        <button
          type="button"
          onClick={() => handlePillarClick('all')}
          className="flex items-baseline gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]/60 rounded"
        >
          <span className="font-serif text-xl font-semibold tracking-tight text-[#F3EFE6]">
            Noodle
          </span>
        </button>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close navigation drawer"
          className="rounded-md p-1.5 text-[#8E95A5] hover:bg-[#1C202B] hover:text-[#ECEBE6] lg:hidden"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Scrollable Nav */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
        {/* Pillars */}
        <div>
          <p className="px-2.5 pb-2 text-[11px] font-semibold tracking-wide text-[#767D8F]">
            Pillars
          </p>
          <nav aria-label="Workspace Pillars" className="space-y-1">
            {pillarItems.map((item) => {
              const Icon = item.icon;
              const isActive = isWorkspaceGrid && activePillar === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handlePillarClick(item.id)}
                  className={`group flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]/60 ${
                    isActive
                      ? 'bg-[#E0A83E]/12 text-[#F5EFE2]'
                      : 'text-[#B2B7C4] hover:bg-[#1A1D26] hover:text-[#ECEBE6]'
                  }`}
                >
                  <Icon
                    className={`mt-0.5 h-4 w-4 shrink-0 ${
                      isActive
                        ? 'text-[#E0A83E]'
                        : 'text-[#777E91] group-hover:text-[#B2B7C4]'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium whitespace-nowrap">
                        {item.label}
                      </span>
                      <span
                        className={`text-xs tabular-nums ${
                          isActive ? 'text-[#E0A83E]' : 'text-[#6E7587]'
                        }`}
                      >
                        {item.count}
                      </span>
                    </div>
                    <p className="truncate text-[11px] text-[#737A8C]">
                      {item.subtitle}
                    </p>
                  </div>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Workspace Views */}
        <div>
          <p className="px-2.5 pb-2 text-[11px] font-semibold tracking-wide text-[#767D8F]">
            Modes & System
          </p>
          <nav aria-label="Workspace Views" className="space-y-1">
            {toolItems.map((item) => {
              const Icon = item.icon;
              const isActive = route === item.path;
              return (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => handleRouteClick(item.path)}
                  className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]/60 ${
                    isActive
                      ? 'bg-[#E0A83E]/12 text-[#F5EFE2]'
                      : 'text-[#B2B7C4] hover:bg-[#1A1D26] hover:text-[#ECEBE6]'
                  }`}
                >
                  <Icon
                    className={`h-4 w-4 shrink-0 ${
                      isActive ? 'text-[#E0A83E]' : 'text-[#777E91]'
                    }`}
                  />
                  <span className="whitespace-nowrap">{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
      </div>

      {/* Footer Switch Folder */}
      <div className="border-t border-[#232733] p-3">
        <button
          type="button"
          onClick={() => handleRouteClick('/')}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium text-[#9CA1AE] transition-colors hover:bg-[#1A1D26] hover:text-[#ECEBE6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E]/60"
        >
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[#777E91]" />
          <span className="whitespace-nowrap">Workspace Setup</span>
        </button>
      </div>
    </aside>
  );

  return (
    <>
      {/* Desktop persistent sidebar */}
      <div className="hidden lg:block lg:shrink-0">{sidebarContent}</div>

      {/* Mobile slide-over drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-xs"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <div className="relative z-50 flex h-full">{sidebarContent}</div>
        </div>
      )}
    </>
  );
}
