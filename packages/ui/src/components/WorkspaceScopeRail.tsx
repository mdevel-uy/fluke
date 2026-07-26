import { useTranslation } from 'react-i18next';
import {
  Archive,
  Bell,
  Moon,
  Play,
  Rows3,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/cn';

/** Slices of the workspace list, excluding the archive. */
export type WorkspaceScope = 'attention' | 'running' | 'idle' | 'all';

/** Everything the rail can select, archive included. */
export type WorkspaceRailScope = WorkspaceScope | 'archive';

export const WORKSPACE_SCOPES: WorkspaceScope[] = [
  'attention',
  'running',
  'idle',
  'all',
];

export type WorkspaceScopeCounts = Record<WorkspaceRailScope, number>;

const SCOPE_ICON: Record<WorkspaceRailScope, LucideIcon> = {
  attention: Bell,
  running: Play,
  idle: Moon,
  all: Rows3,
  archive: Archive,
};

const SCOPE_LABEL_KEY: Record<WorkspaceRailScope, string> = {
  attention: 'common:workspaces.scopes.attention',
  running: 'common:workspaces.scopes.running',
  idle: 'common:workspaces.scopes.idle',
  all: 'common:workspaces.scopes.all',
  archive: 'common:workspaces.scopes.archive',
};

interface ScopeItemProps {
  scope: WorkspaceRailScope;
  label: string;
  count: number;
  isActive: boolean;
  /** Draws the count in the accent colour when the scope wants attention */
  isUrgent?: boolean;
  onClick: () => void;
}

function ScopeItem({
  scope,
  label,
  count,
  isActive,
  isUrgent = false,
  onClick,
}: ScopeItemProps) {
  const Icon = SCOPE_ICON[scope];

  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={`${label} (${count})`}
      aria-current={isActive ? 'true' : undefined}
      className={cn(
        'flex h-9 w-full flex-col items-center justify-center gap-px rounded-md transition-colors duration-100',
        isActive
          ? 'bg-sel text-brand-on-surface'
          : 'text-low hover:bg-secondary hover:text-normal'
      )}
    >
      <Icon className="size-icon-base" strokeWidth={1.75} aria-hidden />
      <span
        className={cn(
          'text-[10px] leading-none tabular-nums',
          !isActive && isUrgent && 'font-semibold text-brand-on-surface'
        )}
      >
        {count}
      </span>
    </button>
  );
}

export interface WorkspaceScopeRailProps {
  scope: WorkspaceRailScope;
  counts: WorkspaceScopeCounts;
  onScopeChange: (scope: WorkspaceRailScope) => void;
  className?: string;
}

/**
 * Second-level navigation for the workspaces panel: which slice of the list
 * you are looking at. Deliberately shares none of the activity rail's signals
 * (no accent edge stripe, narrower, its own panel background, always counts)
 * so the two never read as peer navigations — see design/UI-SPEC.md.
 */
export function WorkspaceScopeRail({
  scope,
  counts,
  onScopeChange,
  className,
}: WorkspaceScopeRailProps) {
  const { t } = useTranslation(['common']);

  return (
    <nav
      aria-label={t('common:workspaces.scopeRailLabel')}
      className={cn(
        'flex w-11 shrink-0 flex-col gap-half border-r border-border bg-md-surface-container-lowest px-1 py-1.5',
        className
      )}
    >
      {WORKSPACE_SCOPES.map((item) => (
        <ScopeItem
          key={item}
          scope={item}
          label={t(SCOPE_LABEL_KEY[item])}
          count={counts[item]}
          isActive={scope === item}
          isUrgent={item === 'attention' && counts.attention > 0}
          onClick={() => onScopeChange(item)}
        />
      ))}

      <div className="flex-1" />
      <div className="mx-1.5 h-px shrink-0 bg-border" />

      <ScopeItem
        scope="archive"
        label={t(SCOPE_LABEL_KEY.archive)}
        count={counts.archive}
        isActive={scope === 'archive'}
        onClick={() => onScopeChange('archive')}
      />
    </nav>
  );
}
