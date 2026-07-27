import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CollapsibleSectionHeader } from '@vibe/ui/components/CollapsibleSectionHeader';
import { cn } from '@/shared/lib/utils';
import { useRepos, repoLabel } from '@/shared/hooks/useRepos';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';

/** 22px single-select row for shell sidebar filter/nav lists (SHELL-SPEC R11). */
export function SidebarRow({
  selected = false,
  onClick,
  children,
}: {
  selected?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // VSCode-style inset rows: side gutter + rounded hover/selection
        'relative flex items-center gap-2 h-[22px] mx-1.5 pl-4 pr-2 rounded-[4px] text-left text-sm',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-brand',
        selected
          ? 'bg-sel text-high before:absolute before:left-0 before:top-0.5 before:bottom-0.5 before:w-[2px] before:rounded-full before:bg-brand-on-surface'
          : 'text-normal hover:bg-secondary'
      )}
    >
      {children}
    </button>
  );
}

/** Collapsible section wrapper with persisted expanded state. */
export function SidebarSection({
  persistKey,
  title,
  count,
  defaultOpen = true,
  children,
}: {
  persistKey: string;
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  // Wrapper div keeps the header's `h-full` root harmless: inside an
  // auto-height parent it collapses to content (same trick WorkspacesSidebar
  // uses). Without it every section stretches to the panel height.
  return (
    <div className="flex-none">
      <CollapsibleSectionHeader
        persistKey={persistKey}
        title={title}
        count={count}
        defaultExpanded={defaultOpen}
      >
        <div className="flex flex-col">{children}</div>
      </CollapsibleSectionHeader>
    </div>
  );
}

/**
 * Repository picker section for repo-scoped sidebars (Sprint, Issues).
 * Replaces the old NavbarRepoSelector (removed in SHELL-SPEC F1/R4): the
 * repo selection store is the same, and Sprint/Issues keep mirroring the
 * repo into their URL.
 */
export function SidebarRepoSection({ persistKey }: { persistKey: string }) {
  const { t } = useTranslation('common');
  const { repos } = useRepos();
  const destination = useCurrentAppDestination();
  const appNavigation = useAppNavigation();
  const storedRepoId = useSelectedRepoStore((s) => s.selectedRepoId);
  const setStoredRepoId = useSelectedRepoStore((s) => s.setSelectedRepoId);

  const kind = destination?.kind ?? null;
  const selectedRepoId = useMemo(() => {
    if (storedRepoId && repos.some((r) => r.id === storedRepoId)) {
      return storedRepoId;
    }
    return repos[0]?.id ?? null;
  }, [storedRepoId, repos]);

  const handleSelect = useCallback(
    (repoId: string) => {
      setStoredRepoId(repoId);
      if (kind === 'sprint') appNavigation.goToSprint(repoId);
      else if (kind === 'issues') appNavigation.goToIssues(repoId);
    },
    [setStoredRepoId, kind, appNavigation]
  );

  if (repos.length === 0) return null;

  return (
    <SidebarSection
      persistKey={persistKey}
      title={t('navbar.repoSelector.placeholder', {
        defaultValue: 'Repository',
      })}
      count={repos.length}
      defaultOpen={repos.length > 1}
    >
      {repos.map((repo) => (
        <SidebarRow
          key={repo.id}
          selected={repo.id === selectedRepoId}
          onClick={() => handleSelect(repo.id)}
        >
          <span className="truncate font-mono text-code">
            {repoLabel(repo)}
          </span>
        </SidebarRow>
      ))}
    </SidebarSection>
  );
}
