import { useMemo, useState } from 'react';
import { useParams, useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { cn } from '@/shared/lib/utils';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useRepos } from '@/shared/hooks/useRepos';
import { useWorkspaces } from '@/shared/hooks/useWorkspaces';
import { useTheme, getResolvedTheme } from '@/shared/hooks/useTheme';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import { MarkdownPreview } from '@/shared/components/MarkdownPreview';
import { useRepoIssues } from '@/features/issues/model/useRepoIssues';
import {
  useAllWorkerTasks,
  useWorkers,
} from '@/features/sprint/model/useWorkers';
import {
  isExecutionLabel,
  waveNumber,
} from '@/features/issues/lib/executionLabels';
import { PM_DECISION_LABEL } from '@/features/issues/lib/milestonePlan';
import { useIssuePlan } from '@/features/issues/model/useIssuePlan';
import { AssignToAgentDialog } from './AssignToAgentDialog';
import { IssuePlanTab } from './plan/IssuePlanTab';
import { blockerAge, blockerPhaseKind } from '@/features/issues/lib/blocker';
import { IssueCodeTab } from './plan/IssueCodeTab';
import { IssueSessionsTab } from './plan/IssueSessionsTab';

/**
 * Issue page, `/issues/$issueNumber` (#667). Header and breadcrumb follow the
 * "3 · Issue" screen of design/mockups/fluke-v2/pantallas.html. The Plan tab
 * shows the phase plan (#686); Código holds the task and a link to its
 * workspace until the embedded workbench and Sesiones arrive (#689).
 */

const ACTIVE = new Set([
  'queued',
  'in_progress',
  'waiting_user',
  'in_review',
  'approved',
]);
const HOT_TAGS = new Set(['P0', 'P1', 'BUG']);

export function IssuePage() {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const { issueNumber: rawNumber } = useParams({ strict: false }) as {
    issueNumber?: string;
  };
  const search = useSearch({ strict: false }) as { repo?: string };
  const issueNumber = Number(rawNumber);
  const storedRepoId = useSelectedRepoStore((s) => s.selectedRepoId);
  const { repos } = useRepos();
  const repoId =
    (search.repo && repos.some((r) => r.id === search.repo) && search.repo) ||
    (storedRepoId &&
      repos.some((r) => r.id === storedRepoId) &&
      storedRepoId) ||
    repos[0]?.id;
  const repo = repos.find((r) => r.id === repoId);

  const { data: issues = [], isLoading } = useRepoIssues(repoId);
  const issue = issues.find((i) => i.number === issueNumber);
  usePageTitle(issue ? `#${issue.number} ${issue.title}` : t('issues.title'));

  const { data: workers } = useWorkers();
  const { tasks } = useAllWorkerTasks(workers);
  const { workspaces, archivedWorkspaces } = useWorkspaces();
  const { theme } = useTheme();
  const [tab, setTab] = useState<'plan' | 'code' | 'sessions'>('plan');
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const { data: plan } = useIssuePlan(repoId, issueNumber);

  const task = useMemo(() => {
    const own = tasks.filter(
      (task) => task.repo_id === repoId && task.issue_number === issueNumber
    );
    return own.find((task) => ACTIVE.has(task.status)) ?? own[0];
  }, [tasks, repoId, issueNumber]);
  const workerName = workers?.find((w) => w.id === task?.worker_id)?.name;
  const branch = task?.workspace_id
    ? [...workspaces, ...archivedWorkspaces].find(
        (ws) => ws.id === task.workspace_id
      )?.branch
    : undefined;
  // Code tab: the workspace of the latest development round (the follow-up
  // fixes run in it too), else the task's.
  const codeWorkspaceId =
    [...(plan?.phases ?? [])]
      .reverse()
      .find((p) => p.kind === 'dev' && p.workspace_id)?.workspace_id ??
    task?.workspace_id ??
    null;
  const sessionCount = plan?.phases.filter((p) => p.workspace_id).length ?? 0;

  const goBack = () => appNavigation.goToIssues(repoId);
  const blocker = plan?.blocker ?? null;
  const blockerKind = blocker ? blockerPhaseKind(blocker) : null;
  const blockerSince = blocker ? blockerAge(blocker.since) : null;
  const openSession = (key: string | null) => {
    setSessionKey(key);
    setTab('sessions');
  };
  // ponytail: Destrabar opens the stuck phase's session until the drawer (#696).
  const unstick = () => openSession(blocker?.phase ?? null);

  if (!isLoading && repoId && !issue) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-body-md text-normal">
        <p>{t('issues.plan.issuePage.notFound', { n: rawNumber })}</p>
        <button
          type="button"
          onClick={goBack}
          className="text-md-primary hover:underline"
        >
          {t('issues.plan.issuePage.backToIssues')}
        </button>
      </div>
    );
  }

  if (!issue) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-normal">
        <MaterialIcon
          name="progress_activity"
          size="base"
          className="animate-spin text-md-primary"
        />
        <span className="text-body-md">{t('issues.loading')}</span>
      </div>
    );
  }

  const wave = waveNumber(issue.labels);
  const tags = issue.labels
    .map((l) => l.name)
    .filter((n) => !isExecutionLabel(n) && n !== PM_DECISION_LABEL)
    .map((n) => n.toUpperCase());
  const githubUrl = repo?.name.includes('/')
    ? `https://github.com/${repo.name}/issues/${issue.number}`
    : null;

  return (
    <div className="flex h-full w-full flex-col bg-primary">
      <div className="flex flex-wrap items-center gap-3 border-b border-md-outline-variant px-[18px] py-3">
        <nav className="text-[13px] text-normal" aria-label="breadcrumb">
          <button
            type="button"
            onClick={goBack}
            className="text-normal hover:text-high hover:underline"
          >
            {t('issues.title')}
          </button>
          {issue.milestone && <> / {issue.milestone}</>}
          {wave !== null && <> / {t('issues.plan.wave', { n: wave })}</>}
        </nav>
        <span className="flex-1" />
        {task?.pr_url && (
          <a
            href={task.pr_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center rounded-md border border-md-outline-variant bg-md-surface-container px-3 text-[13px] text-high hover:border-md-on-surface-variant"
          >
            {t('issues.plan.issuePage.viewPr')}
          </a>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        <div className="mx-auto grid w-full max-w-[1240px] content-start gap-3.5 px-[18px] py-4">
          <div className="grid gap-1.5">
            <h1 className="m-0 text-lg font-semibold text-high [text-wrap:balance]">
              #{issue.number} {issue.title}
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-xs text-normal">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className={cn(
                    'rounded border px-1.5 py-px font-mono text-[10px] font-medium tracking-[0.04em]',
                    HOT_TAGS.has(tag)
                      ? 'border-md-error/40 text-md-error'
                      : 'border-md-outline-variant text-normal'
                  )}
                >
                  {tag}
                </span>
              ))}
              {wave !== null && (
                <span className="rounded border border-md-outline-variant px-1.5 py-px font-mono text-[10px] font-medium tracking-[0.04em]">
                  WAVE:{wave}
                </span>
              )}
              {branch && (
                <>
                  <span>·</span>
                  <span>
                    {t('issues.plan.issuePage.branch')}{' '}
                    <code className="rounded border border-md-outline-variant bg-md-surface-container-lowest px-1 font-mono text-xs">
                      {branch}
                    </code>
                  </span>
                </>
              )}
              {blockerSince && (
                <>
                  <span>·</span>
                  <span className="text-md-error">
                    {t('issues.plan.stuck.since', { age: blockerSince })}
                  </span>
                </>
              )}
              {githubUrl && (
                <>
                  <span>·</span>
                  <a
                    href={githubUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-md-primary hover:underline"
                  >
                    {t('issues.plan.decision.viewOnGithub')}
                  </a>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-md-outline-variant bg-md-surface-container-low px-3 py-[9px] text-[12.5px] text-normal">
            <i
              className="size-[7px] flex-none rounded-full bg-md-primary"
              aria-hidden
            />
            <span>
              {t('issues.plan.issuePage.templateLine')}{' '}
              <b className="font-medium text-high">
                {t(`issues.plan.templates.names.${plan?.template ?? 'none'}`)}
              </b>
              {plan && plan.template !== 'none' && (
                <>
                  {' '}
                  {t('issues.plan.issuePage.originBy')}{' '}
                  <b className="font-medium text-high">Fluke</b> ·{' '}
                  {t('issues.plan.issuePage.originFlow')}{' '}
                  <b className="font-medium text-high">Analyst</b>
                  {wave !== null &&
                    ` (${t('issues.plan.wave', { n: wave }).toLowerCase()})`}{' '}
                  · {t('issues.plan.issuePage.originSteps')}{' '}
                  <b className="font-medium text-high">dev</b>
                </>
              )}
            </span>
          </div>

          {blocker && (
            <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-md-error/60 bg-md-error/10 px-3.5 py-2.5">
              <span
                aria-hidden
                className="grid size-7 flex-none place-items-center rounded-full bg-md-error font-bold text-md-on-error"
              >
                ⚠
              </span>
              <div className="grid min-w-0 flex-[1_1_280px] gap-0.5">
                <b className="text-sm font-semibold text-high">
                  {t(
                    blockerSince
                      ? 'issues.plan.stuck.banner'
                      : 'issues.plan.stuck.bannerNoAge',
                    {
                      phase: blockerKind
                        ? t(`issues.plan.phases.kind.${blockerKind}`)
                        : '',
                      age: blockerSince,
                    }
                  )}
                </b>
                <span className="text-[12.5px] text-normal">
                  {t(`issues.plan.stuck.kinds.${blocker.kind}.title`)}:{' '}
                  {blocker.message}
                </span>
              </div>
              <span className="flex-1" />
              {blocker.workspace_id && (
                <button
                  type="button"
                  onClick={() => openSession(blocker.phase)}
                  className="inline-flex h-8 items-center rounded-md border border-md-outline-variant bg-md-surface-container px-3 text-[13px] text-high hover:border-md-on-surface-variant"
                >
                  {t('issues.plan.stuck.viewSession')}
                </button>
              )}
              <button
                type="button"
                onClick={unstick}
                className="inline-flex h-8 items-center rounded-md border border-md-error bg-md-error px-3 text-[13px] font-semibold text-md-on-error"
              >
                {t('issues.plan.stuck.unstick')}
              </button>
            </div>
          )}

          <div
            role="tablist"
            className="flex gap-0.5 border-b border-md-outline-variant"
          >
            {(['plan', 'code', 'sessions'] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={cn(
                  '-mb-px inline-flex items-center gap-2 border-b-2 border-transparent px-3.5 py-2 text-[13.5px] text-normal hover:text-high',
                  tab === key && 'border-md-primary text-high'
                )}
              >
                {t(`issues.plan.issuePage.tabs.${key}`)}
                {key === 'sessions' && sessionCount > 0 && (
                  <span className="rounded-full border border-md-outline-variant bg-md-surface-container-high px-[7px] font-mono text-[11px] text-normal">
                    {sessionCount}
                  </span>
                )}
              </button>
            ))}
          </div>

          {tab === 'sessions' && plan && (
            <IssueSessionsTab
              phases={plan.phases}
              selected={sessionKey}
              onSelect={setSessionKey}
            />
          )}

          {tab === 'code' && codeWorkspaceId && (
            <IssueCodeTab
              workspaceId={codeWorkspaceId}
              branch={branch}
              prUrl={plan?.pr_url}
            />
          )}

          {tab === 'plan' &&
            (plan ? (
              <IssuePlanTab
                plan={plan}
                onOpenSession={openSession}
                onUnstick={unstick}
              />
            ) : (
              <div className="flex items-center gap-2 py-6 text-normal">
                <MaterialIcon
                  name="progress_activity"
                  size="base"
                  className="animate-spin text-md-primary"
                />
                <span className="text-body-md">{t('issues.loading')}</span>
              </div>
            ))}

          {tab === 'code' && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-md-outline-variant bg-md-surface-container-low px-3 py-2.5 text-[13px] text-normal">
              {task ? (
                <>
                  <span
                    className="size-[7px] flex-none rounded-full bg-md-primary"
                    aria-hidden
                  />
                  <span>
                    <b className="font-medium text-high">
                      {t(`issues.taskStatus.${task.status}`, {
                        defaultValue: task.status,
                      })}
                    </b>
                    {workerName && <> · {workerName}</>}
                  </span>
                  <span className="flex-1" />
                  {task.workspace_id && (
                    <button
                      type="button"
                      onClick={() =>
                        appNavigation.goToWorkspace(task.workspace_id!)
                      }
                      className="inline-flex h-8 items-center rounded-md border border-md-outline-variant bg-md-surface-container px-3 text-[13px] text-high hover:border-md-on-surface-variant"
                    >
                      {t('issues.taskLinked.openWorkspace')}
                    </button>
                  )}
                </>
              ) : (
                <>
                  <span>{t('issues.plan.issuePage.noTask')}</span>
                  <span className="flex-1" />
                  {repoId && (
                    <button
                      type="button"
                      onClick={() =>
                        void AssignToAgentDialog.show({ issue, repoId })
                      }
                      className="inline-flex h-8 items-center rounded-md bg-md-primary px-3 text-[13px] font-medium text-md-on-primary"
                    >
                      {t('issues.assignToAgent')}
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {tab === 'plan' && issue.body.trim() && (
            <details className="rounded-[10px] border border-md-outline-variant bg-md-surface-container-low px-4 py-3">
              <summary className="cursor-pointer text-[13px] text-high">
                {t('issues.plan.issuePage.description')}
              </summary>
              <MarkdownPreview
                content={issue.body}
                theme={getResolvedTheme(theme)}
                className="mt-2 text-sm"
              />
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
