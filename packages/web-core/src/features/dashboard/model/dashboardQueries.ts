import { useQuery } from '@tanstack/react-query';
import type {
  DashboardOverview,
  ProvidersUsageResponse,
  Ticket,
  TicketsResponse,
} from 'shared/types';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import { useHostId } from '@/shared/providers/HostIdProvider';

/** Tickets of the last year: the chart windows and the monthly history. */
export const TICKETS_WINDOW_DAYS = 366;

function useBasePath() {
  const hostId = useHostId();
  return { hostId, basePath: hostId ? `/api/host/${hostId}` : '/api' };
}

async function getData<T>(url: string): Promise<T | null> {
  const response = await makeLocalApiRequest(url);
  if (!response.ok) return null;
  const payload = await response.json();
  return payload?.data ?? null;
}

/** Repos, running tasks, queue and blockers (`/dashboard/overview`). */
export function useDashboardOverview(): DashboardOverview | null {
  const { hostId, basePath } = useBasePath();
  const { data = null } = useQuery({
    queryKey: ['dashboard', 'overview', hostId],
    queryFn: () => getData<DashboardOverview>(`${basePath}/dashboard/overview`),
    refetchInterval: 10000,
  });
  return data;
}

/** Resolved tickets with their cost, newest first. */
export function useTickets(): { tickets: Ticket[]; isLoading: boolean } {
  const { hostId, basePath } = useBasePath();
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', 'tickets', hostId],
    queryFn: () =>
      getData<TicketsResponse>(
        `${basePath}/dashboard/tickets?days=${TICKETS_WINDOW_DAYS}`
      ),
    refetchInterval: 60000,
  });
  return { tickets: data?.tickets ?? [], isLoading };
}

/** Plan limits of every provider with a login here. */
export function useProvidersUsage(): ProvidersUsageResponse | null {
  const { hostId, basePath } = useBasePath();
  const { data = null } = useQuery({
    queryKey: ['agents', 'usage', hostId],
    queryFn: () => getData<ProvidersUsageResponse>(`${basePath}/agents/usage`),
    refetchInterval: 60000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  return data;
}
