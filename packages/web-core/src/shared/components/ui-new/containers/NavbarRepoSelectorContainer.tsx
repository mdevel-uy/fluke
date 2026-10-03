import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { NavbarRepoSelector } from '@vibe/ui/components/NavbarRepoSelector';
import { useRepos, repoLabel } from '@/shared/hooks/useRepos';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';

/** Views scoped to a single repo — the only ones that show the picker. */
const REPO_SCOPED_VIEWS = ['sprint', 'issues'] as const;

/**
 * The one repo picker for the app. Sprint, Issues and Analyst Desk used to
 * carry a selector each, all three backed by the same `useSelectedRepoStore`.
 */
export function NavbarRepoSelectorContainer() {
  const { t } = useTranslation('common');
  const { repos } = useRepos();
  const destination = useCurrentAppDestination();
  const appNavigation = useAppNavigation();
  const storedRepoId = useSelectedRepoStore((s) => s.selectedRepoId);
  const setStoredRepoId = useSelectedRepoStore((s) => s.setSelectedRepoId);

  const kind = destination?.kind ?? null;
  const isRepoScoped = (REPO_SCOPED_VIEWS as readonly string[]).includes(
    kind ?? ''
  );

  const selectedRepoId = useMemo(() => {
    if (storedRepoId && repos.some((r) => r.id === storedRepoId)) {
      return storedRepoId;
    }
    return repos[0]?.id ?? null;
  }, [storedRepoId, repos]);

  const options = useMemo(
    () => repos.map((repo) => ({ id: repo.id, label: repoLabel(repo) })),
    [repos]
  );

  const handleSelect = useCallback(
    (repoId: string) => {
      setStoredRepoId(repoId);
      // Sprint and Issues mirror the repo into the URL, so keep them in sync.
      if (kind === 'sprint') appNavigation.goToSprint(repoId);
      else if (kind === 'issues') appNavigation.goToIssues(repoId);
    },
    [setStoredRepoId, kind, appNavigation]
  );

  if (!isRepoScoped || repos.length === 0) return null;

  return (
    <NavbarRepoSelector
      repos={options}
      selectedRepoId={selectedRepoId}
      onSelect={handleSelect}
      placeholder={t('navbar.repoSelector.placeholder')}
      ariaLabel={t('navbar.repoSelector.ariaLabel')}
    />
  );
}
