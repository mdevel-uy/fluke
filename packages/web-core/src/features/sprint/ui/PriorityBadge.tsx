import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import type { IssuePriority } from '@/features/issues/types';

interface PriorityBadgeProps {
  priority: IssuePriority;
  className?: string;
  showLabel?: boolean;
}

const PRIORITY_CONFIG: Record<
  IssuePriority,
  { icon: string; colorClass: string; bgClass: string; labelKey: string }
> = {
  urgent: {
    icon: '⚡',
    colorClass: 'text-error',
    bgClass: 'bg-error/10 border-error/20',
    labelKey: 'sprint.priority.urgent',
  },
  high: {
    icon: '↑',
    colorClass: 'text-warning',
    bgClass: 'bg-warning/10 border-warning/20',
    labelKey: 'sprint.priority.high',
  },
  medium: {
    icon: '→',
    colorClass: 'text-mod',
    bgClass: 'bg-mod/10 border-mod/20',
    labelKey: 'sprint.priority.medium',
  },
  low: {
    icon: '↓',
    colorClass: 'text-low',
    bgClass: 'bg-secondary border-border/50',
    labelKey: 'sprint.priority.low',
  },
};

export function PriorityBadge({
  priority,
  className,
  showLabel = false,
}: PriorityBadgeProps) {
  const { t } = useTranslation('common');
  const config = PRIORITY_CONFIG[priority];

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 h-5 px-1.5 rounded-md border text-xs font-medium whitespace-nowrap',
        config.bgClass,
        config.colorClass,
        className
      )}
    >
      <span aria-hidden="true" className="text-[10px] leading-none font-bold">
        {config.icon}
      </span>
      {showLabel && <span>{t(config.labelKey)}</span>}
    </span>
  );
}
