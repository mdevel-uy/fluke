import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import type { RepoIssue } from '@/features/issues/types';
import type { WorkerTask } from '@/features/sprint/types';
import { IssueTableRow } from './IssueTableRow';

const TH_CLASS = 'px-3 text-left font-sans text-label uppercase text-low';

interface IssuesGroupProps {
  /** Group key, exposed as data-group-key so the page can scroll back to it. */
  groupKey: string;
  title: string;
  count: number;
  /**
   * Optional caption under the title. The execution-plan grouping uses it to
   * state what the group promises ("these run in parallel") or why it does
   * not promise anything ("unlabelled — hand out one at a time").
   */
  subtitle?: string;
  /** Renders the subtitle in the warning tone. Groups that cannot be planned. */
  warning?: boolean;
  issues: RepoIssue[];
  repoId: string | undefined;
  taskByIssueNumber: Map<number, WorkerTask>;
  workerNameById: Map<string, string>;
  branchByWorkspaceId: Map<string, string>;
  selectedIssueId?: string;
  onSelectIssue?: (issue: RepoIssue) => void;
  onArchive?: (issueNumber: number) => Promise<void>;
}

export function IssuesGroup({
  groupKey,
  title,
  count,
  subtitle,
  warning = false,
  issues,
  repoId,
  taskByIssueNumber,
  workerNameById,
  branchByWorkspaceId,
  selectedIssueId,
  onSelectIssue,
  onArchive,
}: IssuesGroupProps) {
  const { t } = useTranslation('common');

  if (issues.length === 0) return null;

  return (
    <section data-group-key={groupKey} className="mx-6 flex flex-col gap-2">
      <header className="flex flex-col gap-0.5 px-1">
        <div className="flex items-center gap-2">
          <h3 className="font-sans text-label uppercase text-normal">
            {title}
          </h3>
          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1.5 text-xs font-semibold tabular-nums text-on-brand">
            {count}
          </span>
        </div>
        {subtitle && (
          <p
            className={cn(
              'text-xs',
              warning ? 'text-md-error' : 'text-md-on-surface-variant'
            )}
          >
            {subtitle}
          </p>
        )}
      </header>
      <div className="overflow-hidden rounded-lg border border-border bg-primary">
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            <col className="w-[72px]" />
            <col />
            <col className="w-[120px]" />
            <col className="w-[120px]" />
            <col className="w-[190px]" />
            <col className="w-[120px]" />
            <col className="w-[84px]" />
          </colgroup>
          <thead>
            <tr className="h-[30px] border-b border-border bg-md-surface-container-lowest">
              <th className={TH_CLASS}>{t('issues.table.issue')}</th>
              <th className={TH_CLASS}>{t('issues.table.title')}</th>
              <th className={TH_CLASS}>{t('issues.table.state')}</th>
              <th className={TH_CLASS}>{t('issues.table.worker')}</th>
              <th className={TH_CLASS}>{t('issues.table.branch')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>
                {t('issues.table.updated')}
              </th>
              <th>
                <span className="sr-only">{t('issues.table.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {issues.map((issue) => {
              const task = taskByIssueNumber.get(issue.number);
              return (
                <IssueTableRow
                  key={issue.id}
                  issue={issue}
                  repoId={repoId}
                  linkedTask={task}
                  workerName={
                    task ? workerNameById.get(task.worker_id) : undefined
                  }
                  branch={
                    task?.workspace_id
                      ? branchByWorkspaceId.get(task.workspace_id)
                      : undefined
                  }
                  isSelected={selectedIssueId === issue.id}
                  onSelect={onSelectIssue}
                  onArchive={onArchive}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
