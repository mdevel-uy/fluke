import { useQuery } from '@tanstack/react-query';
import { planLimitsApi, type PlanLimitsResponse } from '@/shared/lib/api';

const PLAN_LIMITS_QUERY_KEY = ['plan-limits'] as const;

/**
 * Concurrent-agents cap + upsell CTA + today's cap-hit counter.
 *
 * The cap and CTA are driven by env vars and only change on server restart,
 * but the counter changes as new cap-hits are recorded. We refetch on window
 * focus so an operator that opens a new tab sees the current numbers without
 * having to explicitly reload, and we keep polling low-frequency so the
 * "Sprint" and "Workers" screens can show a fresh "N hits today" without
 * spamming requests.
 */
export function usePlanLimits() {
  return useQuery<PlanLimitsResponse>({
    queryKey: PLAN_LIMITS_QUERY_KEY,
    queryFn: () => planLimitsApi.get(),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}
