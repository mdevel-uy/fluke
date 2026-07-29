import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { GitBranch, GitCompareArrows, X } from 'lucide-react';
import { repoApi } from '@/shared/lib/api';
import { ShellSidebarPortal } from '@/shared/components/ui-new/shell/ShellSidebar';
import { ShellAsidePortal } from '@/shared/components/ui-new/shell/ShellAside';
import { useRepos } from '@/shared/hooks/useRepos';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { useEditorSourceStore } from '@/shared/stores/useEditorSourceStore';
import { cn } from '@/shared/lib/utils';
import { useFleetBranches } from '../model/useFleetBranches';
import { SourceControlSidebar } from './SourceControlSidebar';
import { SourceControlAside } from './SourceControlAside';
import { CommitDetailAside } from './CommitDetailAside';
import { CommitFileDiffView } from './CommitFileDiffView';
import { FleetGraphView } from './FleetGraphView';
import { GraphBranchFilter } from './GraphBranchFilter';
import { StagingView } from './StagingView';

/** 'graph' | 'changes' | `diff:{oid}:{path}` (in-page diff tabs). */
type MainTab = string;

interface DiffTab {
  oid: string;
  path: string;
}

const diffTabKey = (tab: DiffTab) => `diff:${tab.oid}:${tab.path}`;

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

/**
 * Source control section (SHELL-SPEC R34-R40): fleet-wide git view. Main
 * area holds the Fleet graph and the Changes tab (R37); the sidebar lists
 * attempt branches by state (R35); the aside is the branch master-detail.
 */
export function SourceControlPage() {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const storedRepoId = useSelectedRepoStore((s) => s.selectedRepoId);
  const { repos } = useRepos();
  const selectedRepoId = useMemo(() => {
    if (storedRepoId && repos.some((r) => r.id === storedRepoId)) {
      return storedRepoId;
    }
    return repos[0]?.id ?? null;
  }, [storedRepoId, repos]);

  const fleet = useFleetBranches(selectedRepoId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mainTab, setMainTab] = useState<MainTab>('graph');

  // Selected commit (graph row click): the aside switches to its detail.
  const [selectedCommit, setSelectedCommit] = useState<{
    oid: string;
    branches: string[];
  } | null>(null);

  // In-page diff tabs (GitHub-style, R37 tab bar) — one per commit file.
  const [diffTabs, setDiffTabs] = useState<DiffTab[]>([]);

  // Commit selection and diff tabs are repo-scoped — drop them when the
  // project changes.
  useEffect(() => {
    setSelectedCommit(null);
    setHiddenBranches(new Set());
    setDiffTabs([]);
    setMainTab('graph');
  }, [selectedRepoId]);

  // Sidebar → graph navigation: reveal a branch tip or a tag's commit.
  const [revealRequest, setRevealRequest] = useState<
    { kind: 'oid'; oid: string } | { kind: 'branch'; name: string } | null
  >(null);
  const requestReveal = (
    request: { kind: 'oid'; oid: string } | { kind: 'branch'; name: string }
  ) => {
    setMainTab('graph');
    setRevealRequest(request);
  };

  const openDiffTab = (oid: string, path: string) => {
    const tab = { oid, path };
    setDiffTabs((prev) =>
      prev.some((d) => d.oid === oid && d.path === path) ? prev : [...prev, tab]
    );
    setMainTab(diffTabKey(tab));
  };

  const closeDiffTab = (tab: DiffTab) => {
    setDiffTabs((prev) =>
      prev.filter((d) => !(d.oid === tab.oid && d.path === tab.path))
    );
    setMainTab((current) => (current === diffTabKey(tab) ? 'graph' : current));
  };

  // Graph scope: which local branches ride along as graph tips.
  const [hiddenBranches, setHiddenBranches] = useState<Set<string>>(new Set());
  const { data: repoBranches } = useQuery({
    queryKey: ['repo-branches', selectedRepoId],
    queryFn: () => repoApi.getBranches(selectedRepoId!),
    enabled: !!selectedRepoId,
    staleTime: 30_000,
  });

  // The graph must not depend on having active workspaces: fall back to the
  // repo's default branch when the fleet is empty.
  const selectedRepo = repos.find((r) => r.id === selectedRepoId) ?? null;
  const baseBranch =
    fleet.baseBranch ?? selectedRepo?.default_target_branch ?? null;

  // Default selection: first branch needing attention, else first branch.
  // Re-run when the selected workspace leaves the fleet (archived/removed).
  useEffect(() => {
    if (
      selectedId &&
      fleet.branches.some((b) => b.workspace.id === selectedId)
    ) {
      return;
    }
    const fallback =
      fleet.groups.attention[0] ??
      fleet.branches.find((b) => b.group !== 'merged') ??
      fleet.branches[0];
    setSelectedId(fallback?.workspace.id ?? null);
  }, [selectedId, fleet.branches, fleet.groups.attention]);

  const selected =
    fleet.branches.find((b) => b.workspace.id === selectedId) ?? null;

  // The Staging tab follows the selection — fall back to the graph when the
  // selected branch (or its git status) goes away.
  useEffect(() => {
    if (mainTab === 'changes' && !selected?.primaryStatus) {
      setMainTab('graph');
    }
  }, [mainTab, selected]);

  return (
    <>
      <ShellSidebarPortal>
        <SourceControlSidebar
          groups={fleet.groups}
          baseBranch={baseBranch}
          repoId={selectedRepoId}
          selectedWorkspaceId={selectedId}
          onSelect={setSelectedId}
          onRevealBranch={(name) => requestReveal({ kind: 'branch', name })}
          onRevealCommit={(oid) => requestReveal({ kind: 'oid', oid })}
          pendingReveal={revealRequest}
        />
      </ShellSidebarPortal>

      {selectedCommit && selectedRepoId ? (
        <ShellAsidePortal>
          <CommitDetailAside
            key={selectedCommit.oid}
            repoId={selectedRepoId}
            oid={selectedCommit.oid}
            containingBranches={selectedCommit.branches}
            onClose={() => setSelectedCommit(null)}
            onOpenInEditor={(summary) => {
              useEditorSourceStore.getState().setCommitSource({
                repoId: selectedRepoId,
                oid: selectedCommit.oid,
                summary,
              });
              const prefs = useUiPreferencesStore.getState();
              prefs.setWorkspacesSidebarMode('explorer');
              prefs.setLeftSidebarVisible(true);
              const wsId = selectedId ?? fleet.branches[0]?.workspace.id;
              if (wsId) {
                prefs.openWorkspaceViewTab(wsId, 'editor');
                appNavigation.goToWorkspace(wsId);
              } else {
                appNavigation.goToWorkspaces();
              }
            }}
            onOpenFileAtCommit={(path) =>
              openDiffTab(selectedCommit.oid, path)
            }
          />
        </ShellAsidePortal>
      ) : (
        selected && (
          <ShellAsidePortal>
            <SourceControlAside
              key={selected.workspace.id}
              branch={selected}
            />
          </ShellAsidePortal>
        )
      )}

      <div className="flex h-full min-h-0 flex-col bg-primary">
        {/* R37: main tabs — Fleet graph / Changes · {branch} + base chip */}
        <div className="flex h-8 flex-none items-center border-b border-md-outline-variant bg-md-surface-container-low">
          <button
            type="button"
            onClick={() => setMainTab('graph')}
            className={cn(
              'flex h-full cursor-pointer items-center gap-1.5 border-r border-md-outline-variant px-3 text-sm',
              mainTab === 'graph'
                ? 'bg-primary text-high'
                : 'text-low hover:text-high'
            )}
          >
            <GitBranch className="h-3.5 w-3.5" strokeWidth={1.75} />
            {t('sourceControl.tabs.fleetGraph', {
              defaultValue: 'Fleet graph',
            })}
          </button>
          {/* Staging (R38) is worktree work — the tab only exists when a
              workspace-backed branch is selected. Committed diffs live in
              the editor's diff tabs instead. */}
          {selected && selected.primaryStatus && (
            <button
              type="button"
              onClick={() => setMainTab('changes')}
              className={cn(
                'flex h-full cursor-pointer items-center gap-1.5 border-r border-md-outline-variant px-3 text-sm',
                mainTab === 'changes'
                  ? 'bg-primary text-high'
                  : 'text-low hover:text-high'
              )}
            >
              <GitCompareArrows className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span className="max-w-[260px] truncate">
                {t('sourceControl.tabs.staging', {
                  defaultValue: 'Staging · {{branch}}',
                  branch: selected.workspace.branch,
                })}
              </span>
            </button>
          )}
          {diffTabs.map((tab) => {
            const key = diffTabKey(tab);
            const isActive = mainTab === key;
            return (
              <div
                key={key}
                className={cn(
                  'group/difftab flex h-full flex-none items-center gap-1.5 border-r border-md-outline-variant px-3 text-sm',
                  isActive ? 'bg-primary text-high' : 'text-low hover:text-high'
                )}
              >
                <button
                  type="button"
                  onClick={() => setMainTab(key)}
                  title={`${tab.path} @ ${tab.oid.slice(0, 7)}`}
                  className="flex cursor-pointer items-center gap-1.5 focus:outline-none"
                >
                  <span className="max-w-[180px] truncate font-mono text-code">
                    {basename(tab.path)}
                  </span>
                  <span className="font-mono text-[10px] text-low">
                    @{tab.oid.slice(0, 7)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => closeDiffTab(tab)}
                  aria-label={t('workspaces.tabs.close', {
                    defaultValue: 'Close',
                  })}
                  className={cn(
                    '-mr-1 flex h-4 w-4 cursor-pointer items-center justify-center rounded-sm text-low',
                    'hover:bg-md-surface-container-high hover:text-high',
                    isActive
                      ? 'visible'
                      : 'invisible group-hover/difftab:visible'
                  )}
                >
                  <X size={11} strokeWidth={2} />
                </button>
              </div>
            );
          })}
          <div className="ml-auto mr-2 flex items-center gap-1.5">
            <GraphBranchFilter
              branchNames={(repoBranches ?? [])
                .filter((b) => !b.is_remote && b.name !== baseBranch)
                .map((b) => b.name)}
              hidden={hiddenBranches}
              onChange={setHiddenBranches}
            />
            {baseBranch && (
              <span className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-low">
                <span className="uppercase tracking-wider text-[9px]">
                  {t('sourceControl.baseChip', { defaultValue: 'base' })}
                </span>
                {baseBranch}
              </span>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {mainTab === 'graph' ? (
            selectedRepoId && baseBranch ? (
              <FleetGraphView
                repoId={selectedRepoId}
                baseBranch={baseBranch}
                branches={fleet.branches}
                selectedWorkspaceId={selectedId}
                onSelect={setSelectedId}
                selectedCommitOid={selectedCommit?.oid ?? null}
                onSelectCommit={(oid, branches) =>
                  setSelectedCommit(oid ? { oid, branches } : null)
                }
                hiddenBranches={hiddenBranches}
                revealRequest={revealRequest}
                onRevealHandled={() => setRevealRequest(null)}
              />
            ) : (
              <FleetGraphPlaceholder
                branchCount={fleet.branches.length}
                isLoading={fleet.isLoading}
              />
            )
          ) : mainTab === 'changes' ? (
            selected && selected.primaryStatus ? (
              <StagingView
                key={selected.workspace.id}
                branch={selected}
                repoId={selected.primaryStatus.repo_id}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-sm text-low">
                {t('sourceControl.changesPlaceholder', {
                  defaultValue:
                    'Select a branch in the sidebar to review and stage its changes.',
                })}
              </div>
            )
          ) : (
            (() => {
              const tab = diffTabs.find((d) => diffTabKey(d) === mainTab);
              return tab && selectedRepoId ? (
                <CommitFileDiffView
                  key={diffTabKey(tab)}
                  repoId={selectedRepoId}
                  oid={tab.oid}
                  path={tab.path}
                />
              ) : null;
            })()
          )}
        </div>
      </div>
    </>
  );
}

function FleetGraphPlaceholder({
  branchCount,
  isLoading,
}: {
  branchCount: number;
  isLoading: boolean;
}) {
  const { t } = useTranslation('common');
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <GitBranch className="h-8 w-8 text-low" strokeWidth={1.25} />
      <div className="text-sm font-medium text-high">
        {t('sourceControl.graphPlaceholder.title', {
          defaultValue: 'Fleet graph',
        })}
      </div>
      <div className="max-w-md text-sm text-low">
        {isLoading
          ? t('sourceControl.graphPlaceholder.loading', {
              defaultValue: 'Loading the fleet…',
            })
          : t('sourceControl.graphPlaceholder.subtitle', {
              defaultValue:
                '{{count}} active branches. The multi-branch commit graph renders here.',
              count: branchCount,
            })}
      </div>
    </div>
  );
}
