import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Ticket } from 'shared/types';
import { Button } from '@vibe/ui/components/Button';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import {
  awaitingMergeTickets,
  formatDurationSince,
} from '@/features/dashboard/model/dashboardMetrics';
import { Panel } from './parts/primitives';

/**
 * Work the agents finished whose PR is approved and waits for a person to
 * merge it. It already counts as resolved; the merge takes it out of here.
 */
export function MergeGatePanel({ tickets }: { tickets: Ticket[] }) {
  const { t } = useTranslation('common');
  const nav = useAppNavigation();
  const waiting = useMemo(() => awaitingMergeTickets(tickets), [tickets]);
  if (waiting.length === 0) return null;

  return (
    <Panel
      title={t('dashboard.mergeGate.title')}
      chip={waiting.length}
      aside={t('dashboard.mergeGate.subtitle')}
    >
      <div className="flex flex-col gap-2 p-3">
        {waiting.map((ticket) => {
          const gate = ticket.merge_gate;
          const workspaceId = gate?.workspace_id;
          const issueNumber = ticket.is_pr ? null : ticket.issue_number;
          return (
            <div
              key={ticket.key}
              className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-secondary/40 px-3 py-2"
            >
              <span className="shrink-0 rounded border border-success px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-wide text-success">
                {t('dashboard.mergeGate.approved')}
              </span>
              <p className="min-w-0 flex-[1_1_320px] text-sm text-normal">
                {issueNumber != null && (
                  <span className="font-mono font-semibold text-high">
                    #{issueNumber}{' '}
                  </span>
                )}
                {gate?.pr_number != null && (
                  <span className="font-mono text-low">
                    {t('dashboard.mergeGate.pr', { number: gate.pr_number })}
                    {' · '}
                  </span>
                )}
                {ticket.title}
              </p>
              {gate && (
                <span className="shrink-0 font-mono text-[11px] text-low">
                  {t('dashboard.mergeGate.waiting', {
                    time: formatDurationSince(gate.approved_at),
                  })}
                </span>
              )}
              {issueNumber != null && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => nav.goToIssue(issueNumber, ticket.repo_id)}
                >
                  {t('dashboard.mergeGate.viewIssue')}
                </Button>
              )}
              {workspaceId && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => nav.goToWorkspace(workspaceId)}
                >
                  {t('dashboard.mergeGate.viewPr')}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
