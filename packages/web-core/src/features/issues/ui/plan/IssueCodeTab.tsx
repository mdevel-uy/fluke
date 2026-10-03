import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { WorkspaceProvider } from '@/shared/providers/WorkspaceProvider';
import { ReviewProvider } from '@/shared/hooks/ReviewProvider';
import { ChangesViewProvider } from '@/shared/hooks/ChangesViewProvider';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useDiffs } from '@/shared/stores/useWorkspaceDiffStore';
import { useTerminal } from '@/shared/hooks/useTerminal';
import { XTermInstance } from '@/shared/components/XTermInstance';
import { FileTreeContainer } from '@/pages/workspaces/FileTreeContainer';
import { ChangesPanelContainer } from '@/pages/workspaces/ChangesPanelContainer';

/**
 * "Código" tab of the issue page (#689), "3 · Issue" of
 * design/mockups/fluke-v2/pantallas.html: the issue's changed files, the
 * diff and a terminal of its workspace. The workbench is the same one the
 * workspace page uses, fed by a WorkspaceProvider with an explicit id.
 *
 * The diff store is a global singleton, so only one Code tab may be mounted
 * at a time; the tab unmounts when another one is selected.
 */
export function IssueCodeTab({
  workspaceId,
  branch,
  prUrl,
}: {
  workspaceId: string;
  branch?: string;
  prUrl?: string | null;
}) {
  const { t } = useTranslation('common');
  return (
    <WorkspaceProvider workspaceId={workspaceId}>
      <ReviewProvider workspaceId={workspaceId}>
        <ChangesViewProvider>
          <div className="grid gap-3.5">
            <div className="flex flex-wrap items-center gap-2.5 text-[12.5px] text-normal">
              {branch && (
                <code className="rounded border border-md-outline-variant bg-md-surface-container-lowest px-1 font-mono text-xs">
                  {branch}
                </code>
              )}
              {prUrl && (
                <a
                  href={prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-full border border-md-outline-variant px-2 py-px text-xs text-normal hover:text-high"
                >
                  {t('issues.plan.issuePage.viewPr')}
                </a>
              )}
            </div>
            <CodeBody workspaceId={workspaceId} />
          </div>
        </ChangesViewProvider>
      </ReviewProvider>
    </WorkspaceProvider>
  );
}

function CodeBody({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation('common');
  const diffs = useDiffs();
  const { workspace } = useWorkspaceContext();
  const { getTabsForWorkspace, createTab } = useTerminal();
  const tabs = getTabsForWorkspace(workspaceId);
  const canRunTerminal =
    !!workspace?.container_ref &&
    !workspace.archived &&
    !workspace.worktree_deleted;

  useEffect(() => {
    if (canRunTerminal && tabs.length === 0 && workspace?.container_ref) {
      createTab(workspaceId, workspace.container_ref);
    }
  }, [
    canRunTerminal,
    tabs.length,
    workspace?.container_ref,
    workspaceId,
    createTab,
  ]);

  return (
    <div className="grid overflow-hidden rounded-[10px] border border-md-outline-variant bg-md-surface-container-low lg:grid-cols-[240px_minmax(0,1fr)]">
      <div className="min-h-0 border-b border-md-outline-variant p-3 lg:border-b-0 lg:border-r">
        <p className="mb-1 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-normal">
          {t('issues.plan.code.changes')}
        </p>
        <div className="h-[420px] min-h-0 overflow-auto">
          <FileTreeContainer
            workspaceId={workspaceId}
            diffs={diffs}
            className=""
          />
        </div>
      </div>
      <div className="grid min-w-0 grid-rows-[minmax(0,1fr)_auto]">
        <div className="h-[420px] min-h-0 overflow-hidden">
          <ChangesPanelContainer workspaceId={workspaceId} className="h-full" />
        </div>
        <div className="border-t border-md-outline-variant bg-md-surface-container-lowest">
          <div className="flex flex-wrap justify-between gap-2 border-b border-md-outline-variant px-3.5 py-1.5 font-mono text-[11.5px] text-normal">
            <span>{t('issues.plan.code.terminal')}</span>
            <span>{t('issues.plan.code.terminalHint')}</span>
          </div>
          <div className="h-[220px] min-h-0">
            {canRunTerminal && tabs[0] ? (
              <XTermInstance
                tabId={tabs[0].id}
                workspaceId={workspaceId}
                isActive
              />
            ) : (
              <p className="m-0 px-3.5 py-3 text-xs text-normal">
                {t('issues.plan.code.noTerminal')}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
