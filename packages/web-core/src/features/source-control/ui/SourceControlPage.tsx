import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GitBranch, GitCompareArrows } from 'lucide-react';
import { ShellSidebarPortal } from '@/shared/components/ui-new/shell/ShellSidebar';
import { ShellAsidePortal } from '@/shared/components/ui-new/shell/ShellAside';
import { useRepos } from '@/shared/hooks/useRepos';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import { cn } from '@/shared/lib/utils';
import { useFleetBranches } from '../model/useFleetBranches';
import { SourceControlSidebar } from './SourceControlSidebar';
import { SourceControlAside } from './SourceControlAside';
import { FleetGraphView } from './FleetGraphView';
import { StagingView } from './StagingView';

type MainTab = 'graph' | 'changes';

/**
 * Source control section (SHELL-SPEC R34-R40): fleet-wide git view. Main
 * area holds the Fleet graph and the Changes tab (R37); the sidebar lists
 * attempt branches by state (R35); the aside is the branch master-detail.
 */
export function SourceControlPage() {
  const { t } = useTranslation('common');
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

  return (
    <>
      <ShellSidebarPortal>
        <SourceControlSidebar
          groups={fleet.groups}
          baseBranch={fleet.baseBranch}
          repoId={selectedRepoId}
          selectedWorkspaceId={selectedId}
          onSelect={setSelectedId}
        />
      </ShellSidebarPortal>

      {selected && (
        <ShellAsidePortal>
          <SourceControlAside
            key={selected.workspace.id}
            branch={selected}
          />
        </ShellAsidePortal>
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
              {selected
                ? t('sourceControl.tabs.changesFor', {
                    defaultValue: 'Changes · {{branch}}',
                    branch: selected.workspace.branch,
                  })
                : t('sourceControl.tabs.changes', {
                    defaultValue: 'Changes',
                  })}
            </span>
          </button>
          {fleet.baseBranch && (
            <span className="ml-auto mr-2 flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-low">
              <span className="uppercase tracking-wider text-[9px]">
                {t('sourceControl.baseChip', { defaultValue: 'base' })}
              </span>
              {fleet.baseBranch}
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {mainTab === 'graph' ? (
            selectedRepoId && fleet.baseBranch ? (
              <FleetGraphView
                repoId={selectedRepoId}
                baseBranch={fleet.baseBranch}
                branches={fleet.branches}
                selectedWorkspaceId={selectedId}
                onSelect={setSelectedId}
              />
            ) : (
              <FleetGraphPlaceholder
                branchCount={fleet.branches.length}
                isLoading={fleet.isLoading}
              />
            )
          ) : selected && selected.primaryStatus ? (
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
