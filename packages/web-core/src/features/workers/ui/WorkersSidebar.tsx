import { useTranslation } from 'react-i18next';
import type { WorkerResponse } from 'shared/types';
import { CollapsibleSectionHeader } from '@vibe/ui/components/CollapsibleSectionHeader';
import {
  SidebarRow,
  SidebarSection,
} from '@/shared/components/ui-new/shell/SidebarPrimitives';
import { cn } from '@/shared/lib/utils';

interface WorkersSidebarProps {
  workers: WorkerResponse[];
  archivedWorkers: WorkerResponse[];
  workingWorkerIds: Set<string>;
  attentionWorkerIds: Set<string>;
}

export function workerCardDomId(workerId: string): string {
  return `worker-card-${workerId}`;
}

function scrollToWorker(workerId: string) {
  document
    .getElementById(workerCardDomId(workerId))
    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/**
 * Shell sidebar for the Workers section (SHELL-SPEC R9): Active / Archived
 * master list; selecting a row scrolls its card into view.
 */
export function WorkersSidebar({
  workers,
  archivedWorkers,
  workingWorkerIds,
  attentionWorkerIds,
}: WorkersSidebarProps) {
  const { t } = useTranslation('common');

  const dotClass = (worker: WorkerResponse) =>
    attentionWorkerIds.has(worker.id)
      ? 'bg-warning'
      : workingWorkerIds.has(worker.id)
        ? 'bg-brand-on-surface'
        : 'bg-border-strong';

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-md-surface-container-lowest">
      <CollapsibleSectionHeader
        title={t('appBar.workers')}
        collapsible={false}
        className="border-b"
      />
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        <SidebarSection
          persistKey="workers-sidebar-active"
          title={t('workers.sidebar.active', { defaultValue: 'Active' })}
          count={workers.length}
        >
          {workers.map((worker) => (
            <SidebarRow key={worker.id} onClick={() => scrollToWorker(worker.id)}>
              <span
                className={cn('h-2 w-2 flex-none rounded-full', dotClass(worker))}
                aria-hidden
              />
              <span className="truncate">{worker.name}</span>
            </SidebarRow>
          ))}
        </SidebarSection>
        {archivedWorkers.length > 0 && (
          <SidebarSection
            persistKey="workers-sidebar-archived"
            title={t('workers.sidebar.archived', { defaultValue: 'Archived' })}
            count={archivedWorkers.length}
            defaultOpen={false}
          >
            {archivedWorkers.map((worker) => (
              <SidebarRow
                key={worker.id}
                onClick={() => scrollToWorker(worker.id)}
              >
                <span
                  className="h-2 w-2 flex-none rounded-full bg-border-strong opacity-50"
                  aria-hidden
                />
                <span className="truncate text-low">{worker.name}</span>
              </SidebarRow>
            ))}
          </SidebarSection>
        )}
      </div>
    </div>
  );
}
