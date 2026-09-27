import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import type { RepoIssue } from '@/features/issues/types';
import type { WorkerTask } from '@/features/sprint/types';
import { buildExecutionPlan } from '../lib/executionLabels';
import { IssuesGroup } from './IssuesGroup';

/**
 * The execution plan: the backlog read as "what can two workers take at the
 * same time".
 *
 * Everything shown here comes from labels the analyst wrote when it created
 * the issues (`feature:`, `wave:`, `resource:`) — there is no dependency graph
 * in the database and nothing is inferred from the code. The consequence is
 * deliberate and visible: an issue nobody labelled shows up in its own bucket
 * marked "hand out one at a time", never folded into a wave. Absence of a
 * declaration is not evidence that an issue is safe to parallelise.
 */

interface ExecutionPlanViewProps {
  issues: RepoIssue[];
  repoId: string | undefined;
  taskByIssueNumber: Map<number, WorkerTask>;
  workerNameById: Map<string, string>;
  branchByWorkspaceId: Map<string, string>;
  selectedIssueId?: string;
  onSelectIssue?: (issue: RepoIssue) => void;
  onArchive?: (issueNumber: number) => Promise<void>;
}

export function ExecutionPlanView({
  issues,
  repoId,
  taskByIssueNumber,
  workerNameById,
  branchByWorkspaceId,
  selectedIssueId,
  onSelectIssue,
  onArchive,
}: ExecutionPlanViewProps) {
  const { t } = useTranslation('common');
  const plan = useMemo(() => buildExecutionPlan(issues), [issues]);

  const groupProps = {
    repoId,
    taskByIssueNumber,
    workerNameById,
    branchByWorkspaceId,
    selectedIssueId,
    onSelectIssue,
    onArchive,
  };

  const isEmpty = plan.features.length === 0 && plan.unclassified.length === 0;

  if (isEmpty) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-body-md text-md-on-surface-variant">
        {t('issues.execution.empty')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8 py-6">
      {/* Serialized-resource contention is the one signal that crosses
          features, so it leads the page instead of hiding inside a wave: the
          analyst who planned one feature could not see the other one. */}
      {plan.contentions.length > 0 && (
        <section className="mx-6 flex flex-col gap-2 rounded-lg border border-md-error/40 bg-md-error/5 p-3">
          <div className="flex items-center gap-2">
            <MaterialIcon name="warning" size="sm" className="text-md-error" />
            <h3 className="font-sans text-label uppercase text-md-error">
              {t('issues.execution.contentionTitle')}
            </h3>
          </div>
          <p className="text-xs text-md-on-surface-variant">
            {t('issues.execution.contentionHint')}
          </p>
          <ul className="flex flex-col gap-1">
            {plan.contentions.map((contention) => (
              <li key={contention.resource} className="text-body-sm">
                <code className="rounded bg-md-surface-container px-1 py-0.5 text-xs">
                  {contention.resource}
                </code>
                <span className="ml-2 text-md-on-surface-variant">
                  {contention.issues.map((i) => `#${i.number}`).join(', ')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {plan.features.map((feature) => (
        <section key={feature.feature} className="flex flex-col gap-4">
          <h2 className="mx-6 flex items-center gap-2 border-b border-border pb-1 font-sans text-body-md font-semibold text-normal">
            <MaterialIcon
              name="account_tree"
              size="sm"
              className="text-brand"
            />
            {feature.feature}
          </h2>

          {feature.waves.map((wave) => (
            <IssuesGroup
              key={`${feature.feature}-wave-${wave.wave}`}
              title={t('issues.execution.wave', { n: wave.wave })}
              count={wave.issues.length}
              subtitle={
                wave.issues.length > 1
                  ? t('issues.execution.parallel', { n: wave.issues.length })
                  : t('issues.execution.single')
              }
              issues={wave.issues}
              {...groupProps}
            />
          ))}

          {feature.unwaved.length > 0 && (
            <IssuesGroup
              key={`${feature.feature}-unwaved`}
              title={t('issues.execution.unwaved')}
              count={feature.unwaved.length}
              subtitle={t('issues.execution.unwavedHint')}
              warning
              issues={feature.unwaved}
              {...groupProps}
            />
          )}
        </section>
      ))}

      {plan.unclassified.length > 0 && (
        <IssuesGroup
          title={t('issues.execution.unclassified')}
          count={plan.unclassified.length}
          subtitle={t('issues.execution.unclassifiedHint')}
          warning
          issues={plan.unclassified}
          {...groupProps}
        />
      )}
    </div>
  );
}
