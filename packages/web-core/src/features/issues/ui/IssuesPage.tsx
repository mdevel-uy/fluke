import { useMemo } from 'react';
import { useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ArrowClockwiseIcon, SpinnerIcon } from '@phosphor-icons/react';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import {
  useProjectIssues,
  useSyncProjectIssues,
} from '@/features/issues/model/useProjectIssues';
import type { ProjectIssue } from '@/features/issues/types';
import { IssuesGroup } from './IssuesGroup';
import { IssuesEmptyState } from './IssuesEmptyState';

function partitionByState(issues: ProjectIssue[]) {
  const open: ProjectIssue[] = [];
  const closed: ProjectIssue[] = [];
  for (const issue of issues) {
    if (issue.state === 'open') {
      open.push(issue);
    } else {
      closed.push(issue);
    }
  }
  return { open, closed };
}

export function IssuesPage() {
  const { projectId } = useParams({ strict: false });
  const { t } = useTranslation('common');
  usePageTitle(t('issues.title'));

  const { data: issues = [], isLoading, isError } = useProjectIssues(projectId);
  const syncMutation = useSyncProjectIssues(projectId);

  const { open, closed } = useMemo(() => partitionByState(issues), [issues]);
  const isSyncing = syncMutation.isPending;
  const hasIssues = issues.length > 0;

  const handleRefresh = () => {
    if (!projectId || isSyncing) return;
    syncMutation.mutate();
  };

  return (
    <div className="flex h-full w-full flex-col bg-primary">
      <header className="flex items-center justify-between px-double py-base border-b border-border">
        <div className="flex items-baseline gap-half">
          <h1 className="text-lg font-semibold text-high">
            {t('issues.title')}
          </h1>
          {hasIssues && (
            <span className="text-sm text-low">
              {t('issues.countLabel', { count: issues.length })}
            </span>
          )}
        </div>
        <PrimaryButton
          variant="tertiary"
          value={isSyncing ? t('issues.refreshing') : t('issues.refresh')}
          actionIcon={isSyncing ? 'spinner' : ArrowClockwiseIcon}
          onClick={handleRefresh}
          disabled={!projectId || isSyncing}
        />
      </header>

      <div className="flex-1 min-h-0 overflow-auto">
        {isLoading ? (
          <div className="flex h-full items-center justify-center gap-half text-low">
            <SpinnerIcon className="size-icon-base animate-spin" />
            <span className="text-sm">{t('issues.loading')}</span>
          </div>
        ) : isError ? (
          <div className="flex h-full items-center justify-center px-base text-sm text-error">
            {t('issues.loadError')}
          </div>
        ) : !hasIssues ? (
          <div className="flex h-full">
            <IssuesEmptyState />
          </div>
        ) : (
          <div className="flex flex-col gap-double py-base">
            <IssuesGroup
              title={t('issues.openGroup')}
              count={open.length}
              issues={open}
            />
            <IssuesGroup
              title={t('issues.closedGroup')}
              count={closed.length}
              issues={closed}
            />
          </div>
        )}
      </div>
    </div>
  );
}
