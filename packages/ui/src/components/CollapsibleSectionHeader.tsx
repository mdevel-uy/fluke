import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { Icon } from '@phosphor-icons/react';
import { cn } from '../lib/cn';
import { MaterialIcon } from './MaterialIcon';

const STORAGE_KEY_PREFIX = 'vibe.ui.collapsible.';

function getInitialExpanded(
  persistKey: string | undefined,
  defaultExpanded: boolean
) {
  if (!persistKey || typeof window === 'undefined') return defaultExpanded;
  try {
    const stored = window.localStorage.getItem(
      `${STORAGE_KEY_PREFIX}${persistKey}`
    );
    if (stored == null) return defaultExpanded;
    return stored === 'true';
  } catch {
    return defaultExpanded;
  }
}

export type SectionAction = {
  /** @deprecated Prefer materialIcon */
  icon?: Icon;
  materialIcon?: string;
  onClick: () => void;
  isActive?: boolean;
};

interface CollapsibleSectionHeaderProps {
  persistKey?: string;
  title: string;
  /** Item count shown after the title, VSCode-style ("RUNNING — 2") */
  count?: number;
  defaultExpanded?: boolean;
  collapsible?: boolean;
  actions?: SectionAction[];
  headerExtra?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function CollapsibleSectionHeader({
  persistKey,
  title,
  count,
  defaultExpanded = true,
  collapsible = true,
  actions = [],
  headerExtra,
  children,
  className,
}: CollapsibleSectionHeaderProps) {
  const [expanded, setExpanded] = useState(() =>
    getInitialExpanded(persistKey, defaultExpanded)
  );

  useEffect(() => {
    setExpanded(getInitialExpanded(persistKey, defaultExpanded));
  }, [persistKey, defaultExpanded]);

  useEffect(() => {
    if (!persistKey) return;
    try {
      window.localStorage.setItem(
        `${STORAGE_KEY_PREFIX}${persistKey}`,
        String(expanded)
      );
    } catch {
      // Ignore localStorage failures (private mode/quota/security errors).
    }
  }, [persistKey, expanded]);

  const handleActionClick = (
    e: MouseEvent<HTMLSpanElement>,
    onClick: () => void
  ) => {
    e.stopPropagation();
    onClick();
  };

  const handleActionKeyDown = (
    e: KeyboardEvent<HTMLSpanElement>,
    onClick: () => void
  ) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    onClick();
  };

  const isExpanded = collapsible ? expanded : true;

  const headerContent = (
    <>
      <span className="flex items-center gap-0.5 min-w-0">
        {collapsible && (
          <MaterialIcon
            name="chevron_left"
            size="xs"
            className={cn(
              'text-md-on-surface-variant transition-transform duration-150 shrink-0',
              expanded ? '-rotate-90' : 'rotate-180'
            )}
          />
        )}
        <span
          className={cn(
            'text-label uppercase tracking-wider truncate',
            // VSCode: section headers read darker/heavier than the panel title
            collapsible ? 'font-bold text-high' : 'font-semibold text-normal'
          )}
        >
          {title}
          {count !== undefined && (
            <span className="text-low font-normal tabular-nums">
              {' '}
              — {count}
            </span>
          )}
        </span>
      </span>
      <div className="flex items-center gap-0.5">
        {headerExtra}
        {actions.map((action, index) => {
          const ActionIcon = action.icon;
          return (
            <span
              key={index}
              role="button"
              tabIndex={0}
              onClick={(e) => handleActionClick(e, action.onClick)}
              onKeyDown={(e) => handleActionKeyDown(e, action.onClick)}
              className={cn(
                'flex items-center justify-center w-5 h-5 rounded-sm transition-colors duration-150 hover:bg-md-surface-container hover:text-md-on-surface',
                action.isActive
                  ? 'text-brand-on-surface'
                  : 'text-md-on-surface-variant'
              )}
            >
              {action.materialIcon ? (
                <MaterialIcon
                  name={action.materialIcon}
                  fill={action.isActive ? 1 : 0}
                  size="xs"
                />
              ) : ActionIcon ? (
                <ActionIcon className="size-icon-xs" weight="bold" />
              ) : null}
            </span>
          );
        })}
      </div>
    </>
  );

  return (
    <div className={cn('flex flex-col h-full min-h-0', className)}>
      <div className="">
        {collapsible ? (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="flex items-center justify-between w-full h-[22px] px-1.5 cursor-pointer hover:text-md-on-surface select-none"
          >
            {headerContent}
          </button>
        ) : (
          <div className="flex items-center justify-between w-full h-[30px] pl-[22px] pr-2 mb-1 select-none">
            {headerContent}
          </div>
        )}
      </div>
      {isExpanded && children}
    </div>
  );
}
