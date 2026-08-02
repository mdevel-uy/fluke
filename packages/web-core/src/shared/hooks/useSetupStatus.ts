import { useQuery } from '@tanstack/react-query';
import { setupStatusApi, type SetupStatusResponse } from '@/shared/lib/api';

const SETUP_STATUS_QUERY_KEY = ['setup-status'] as const;

/**
 * Polls the onboarding wizard checklist while any step is missing so the
 * Home wizard hides itself the moment the user finishes the last box —
 * without forcing a manual refresh after connecting an agent from Settings
 * or assigning the first task.
 *
 * Stops polling once `is_complete` is `true` to keep idle instances quiet;
 * the query still refetches on window focus so a user coming back after
 * disconnecting an agent sees the wizard reappear.
 */
export function useSetupStatus() {
  const query = useQuery<SetupStatusResponse>({
    queryKey: SETUP_STATUS_QUERY_KEY,
    queryFn: () => setupStatusApi.get(),
    refetchInterval: (q) => (q.state.data?.is_complete ? false : 5000),
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  return {
    status: query.data,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}
