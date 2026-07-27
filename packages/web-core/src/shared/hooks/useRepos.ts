import { useQuery } from '@tanstack/react-query';
import { repoApi } from '@/shared/lib/api';
import type { Repo } from 'shared/types';

export const reposQueryKey = ['repos'] as const;

export function repoLabel(repo: Repo): string {
  return repo.display_name || repo.name;
}

/**
 * The single `['repos']` query. Previously inlined in Sprint, Issues and
 * Analyst Desk, which drifted on loading flags and label fallbacks.
 */
export function useRepos() {
  const { data, isLoading } = useQuery({
    queryKey: reposQueryKey,
    queryFn: () => repoApi.list(),
  });
  return { repos: data ?? [], isLoadingRepos: isLoading };
}
