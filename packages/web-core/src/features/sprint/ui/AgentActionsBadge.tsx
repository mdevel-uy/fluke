import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import type { AgentAction } from '@/features/sprint/types';

interface AgentActionsBadgeProps {
  actions: AgentAction[];
  onClick?: () => void;
  className?: string;
}

// Rendering rules per issue #541:
//   - any `failed`  → red badge naming the first failed action
//   - else any `pending` → yellow badge with the pending count
//   - otherwise nothing (all `done` / `skipped` collapses back into the card)
// The click-through opens the details panel; when there is no click handler
// the badge stays purely informational so it can also sit in read-only lists.
export function AgentActionsBadge({
  actions,
  onClick,
  className,
}: AgentActionsBadgeProps) {
  const { t } = useTranslation('tasks');

  const firstFailed = actions.find((a) => a.status === 'failed');
  const pendingCount = actions.filter((a) => a.status === 'pending').length;

  // Narrow into a discriminated union so TS knows `firstFailed` is defined
  // inside the failed branch — no non-null assertion needed downstream.
  let label: string;
  let styleClasses: string;
  if (firstFailed) {
    label = t('agentActions.failedAction', {
      seq: firstFailed.seq,
      kind: firstFailed.kind,
    });
    styleClasses = 'bg-md-error/10 border-md-error/30 text-md-error';
  } else if (pendingCount > 0) {
    label = t('agentActions.pendingCount', { count: pendingCount });
    styleClasses = 'bg-warning/10 border-warning/30 text-warning';
  } else {
    return null;
  }

  const baseClasses =
    'inline-flex items-center gap-1 h-6 px-2 rounded-md border text-xs font-medium max-w-full';

  if (!onClick) {
    return (
      <span
        className={cn(baseClasses, styleClasses, className)}
        title={label}
      >
        <span className="truncate">{label}</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        baseClasses,
        styleClasses,
        'cursor-pointer transition-opacity hover:opacity-80 focus:outline-none focus:ring-1 focus:ring-brand/40',
        className
      )}
    >
      <span className="truncate">{label}</span>
    </button>
  );
}
