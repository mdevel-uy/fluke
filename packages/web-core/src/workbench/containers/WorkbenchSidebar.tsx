import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { GitBranch, MoreHorizontal, Plus } from 'lucide-react';
import {
  Dot,
  PanelIconButton,
  SidePanel,
  TreeEmpty,
  TreeRow,
  TreeSection,
} from '../ui/chrome';
import { useWorkers } from '@/features/workers/model/useWorkers';
import { useWorkspaces } from '@/shared/hooks/useWorkspaces';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';

/* The mockup's side panel with live data: WORKERS (active), WORKSPACES
   (branches, mono) and ARCHIVED. */

export function WorkbenchSidebar() {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const { workspace: selectedWorkspace } = useWorkspaceContext();
  const { data: workers = [] } = useWorkers();
  const { workspaces, archivedWorkspaces } = useWorkspaces();

  const sortedWorkers = useMemo(
    () =>
      [...workers].sort((a, b) => {
        const aBusy = a.active_workspace_id ? 0 : 1;
        const bBusy = b.active_workspace_id ? 0 : 1;
        return aBusy - bBusy || a.name.localeCompare(b.name);
      }),
    [workers]
  );

  return (
    <SidePanel
      title={t('workspaces.title', { defaultValue: 'Workspaces' })}
      actions={
        <PanelIconButton
          label={t('workers.newWorker', { defaultValue: 'New worker' })}
          onClick={() => appNavigation.goToWorkers()}
        >
          <Plus size={14} strokeWidth={1.75} />
        </PanelIconButton>
      }
    >
      <TreeSection
        title={t('appBar.workers', { defaultValue: 'Workers' })}
        count={workers.length}
      >
        {sortedWorkers.length === 0 ? (
          <TreeEmpty>
            {t('workers.emptyTitle', { defaultValue: 'No workers yet' })}
          </TreeEmpty>
        ) : (
          sortedWorkers.map((worker) => {
            const busy = worker.active_workspace_id !== null;
            const queued = worker.queued_count;
            return (
              <TreeRow
                key={worker.id}
                onClick={() => appNavigation.goToWorkers()}
                meta={
                  busy || queued > 0
                    ? t('workbench.tasksCount', {
                        defaultValue: '{{count}} tasks',
                        count: queued + (busy ? 1 : 0),
                      })
                    : t('workbench.idle', { defaultValue: 'idle' })
                }
              >
                <Dot tone={busy ? 'busy' : 'ok'} />
                <span className="truncate">
                  <span className="color-emoji">{worker.emoji}</span>{' '}
                  {worker.name}
                </span>
              </TreeRow>
            );
          })
        )}
      </TreeSection>

      <TreeSection
        title={t('workspaces.title', { defaultValue: 'Workspaces' })}
        count={workspaces.length}
      >
        {workspaces.length === 0 ? (
          <TreeEmpty>
            {t('workspaces.noWorkspaces', { defaultValue: 'No workspaces' })}
          </TreeEmpty>
        ) : (
          workspaces.map((ws) => (
            <TreeRow
              key={ws.id}
              mono
              selected={selectedWorkspace?.id === ws.id}
              onClick={() => appNavigation.goToWorkspace(ws.id)}
              meta={ws.isRunning ? <Dot tone="busy" /> : undefined}
            >
              <GitBranch
                size={13}
                strokeWidth={1.75}
                className="shrink-0 text-low"
                aria-hidden
              />
              <span className="truncate">{ws.branch || ws.name}</span>
            </TreeRow>
          ))
        )}
      </TreeSection>

      <TreeSection
        title={t('workspaces.archived', { defaultValue: 'Archived' })}
        count={archivedWorkspaces.length}
        defaultOpen={false}
      >
        {archivedWorkspaces.length === 0 ? (
          <TreeEmpty>
            {t('workspaces.noArchived', {
              defaultValue: 'No archived workspaces',
            })}
          </TreeEmpty>
        ) : (
          archivedWorkspaces.map((ws) => (
            <TreeRow
              key={ws.id}
              mono
              onClick={() => appNavigation.goToWorkspace(ws.id)}
            >
              <MoreHorizontal
                size={13}
                strokeWidth={1.75}
                className="shrink-0 text-low"
                aria-hidden
              />
              <span className="truncate">{ws.branch || ws.name}</span>
            </TreeRow>
          ))
        )}
      </TreeSection>
    </SidePanel>
  );
}
