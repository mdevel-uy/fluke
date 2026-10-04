import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@vibe/ui/components/Button';
import { cn } from '@/shared/lib/utils';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import type { DashboardData } from '@/features/dashboard/model/useDashboardData';
import { Panel } from './parts/primitives';

/** Blocker kinds (`IssueBlocker.kind`) plus the two the workspace stream knows. */
type AttentionKind =
  | 'question'
  | 'credential'
  | 'failed'
  | 'review_cap'
  | 'no_progress'
  | 'approval'
  | 'conflict';

const KIND_CLASS: Record<AttentionKind, string> = {
  question: 'border-warning text-warning',
  credential: 'border-error text-error',
  failed: 'border-error text-error',
  review_cap: 'border-merged text-merged',
  no_progress: 'border-warning text-warning',
  approval: 'border-warning text-warning',
  conflict: 'border-error text-error',
};

type AttentionItem = {
  key: string;
  kind: AttentionKind;
  ref: string;
  repo: string;
  text: string;
  action: string;
  onAction: () => void;
};

export function useAttentionItems(data: DashboardData) {
  const { t } = useTranslation('common');
  const nav = useAppNavigation();

  return useMemo(() => {
    const items: AttentionItem[] = [];
    for (const b of data.overview?.blockers ?? []) {
      const kind = b.blocker.kind as AttentionKind;
      items.push({
        key: `blocker-${b.repo_id}-${b.issue_number}`,
        kind,
        ref: `#${b.issue_number}`,
        repo: b.repo_name,
        text: b.blocker.message || b.issue_title,
        action:
          kind === 'question'
            ? t('dashboard.attention.answer')
            : kind === 'credential'
              ? t('dashboard.attention.configure')
              : t('dashboard.attention.viewIssue'),
        onAction:
          kind === 'credential'
            ? () => void SettingsDialog.show({ initialSection: 'agents' })
            : () => nav.goToIssue(b.issue_number, b.repo_id),
      });
    }
    for (const ws of data.approvalWorkspaces) {
      items.push({
        key: `approval-${ws.id}`,
        kind: 'approval',
        ref: '',
        repo: '',
        text: t('dashboard.attention.approvalText', { name: ws.name }),
        action: t('dashboard.attention.review'),
        onAction: () => nav.goToWorkspace(ws.id),
      });
    }
    // An issue's conflicting PR already shows as its `conflict` blocker.
    const blocked = new Set(
      (data.overview?.blockers ?? []).map((b) => b.blocker.workspace_id)
    );
    for (const ws of data.conflictingPrs) {
      if (blocked.has(ws.id)) continue;
      items.push({
        key: `conflict-${ws.id}`,
        kind: 'conflict',
        ref: `#${ws.prNumber}`,
        repo: '',
        text: t('dashboard.attention.conflictText', { name: ws.name }),
        action: t('dashboard.attention.open'),
        onAction: () => nav.goToWorkspace(ws.id),
      });
    }

    const counts = new Map<AttentionKind, number>();
    for (const item of items)
      counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
    const summary = [...counts]
      .map(([kind, count]) => t(`dashboard.attention.count.${kind}`, { count }))
      .join(', ');
    return { items, summary };
  }, [data, nav, t]);
}

export function AttentionPanel({ items }: { items: AttentionItem[] }) {
  const { t } = useTranslation('common');
  if (items.length === 0) return null;
  return (
    <Panel title={t('dashboard.attention.title')} chip={items.length}>
      <div className="flex flex-col gap-2 p-3">
        {items.map((item) => (
          <div
            key={item.key}
            className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-secondary/40 px-3 py-2"
          >
            <span
              className={cn(
                'shrink-0 rounded border px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-wide',
                KIND_CLASS[item.kind]
              )}
            >
              {t(`dashboard.attention.kind.${item.kind}`)}
            </span>
            <p className="min-w-0 flex-[1_1_320px] text-sm text-normal">
              {item.ref && (
                <span className="font-mono font-semibold text-high">
                  {item.ref}{' '}
                </span>
              )}
              {item.repo && <span className="text-low">{item.repo} · </span>}
              {item.text}
            </p>
            <Button
              type="button"
              size="sm"
              variant={item.kind === 'question' ? 'default' : 'outline'}
              onClick={item.onAction}
            >
              {item.action}
            </Button>
          </div>
        ))}
      </div>
    </Panel>
  );
}
