import { useQuery } from '@tanstack/react-query';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import { useHostId } from '@/shared/providers/HostIdProvider';
import type {
  ValueGeneratedMonth,
  ValueGeneratedSummaryResponse,
} from 'shared/types';

export type { ValueGeneratedMonth };
export type ValueGeneratedSummary = ValueGeneratedSummaryResponse;

/**
 * Trailing history depths offered by the panel, in months.
 *
 * 3 = current quarter narrative, 6 = mid-year, 12 = the rolling-year story we
 * pitch on with clients. Capped by the backend at `MAX_HISTORY_MONTHS`.
 */
export const VALUE_HISTORY_WINDOWS = [3, 6, 12] as const;
export type ValueHistoryWindow = (typeof VALUE_HISTORY_WINDOWS)[number];

/**
 * Fetch the value-generated summary for the last `months` calendar months.
 *
 * The response is normalised to always include an entry for the current month
 * (backend fills a zero bucket if nothing has completed yet), so consumers can
 * safely read `months[0]` without special-casing an empty response.
 *
 * Polls every five minutes: the panel is a monthly narrative, not a live
 * counter, so a tighter interval only burns bandwidth without changing what
 * the viewer sees.
 */
export function useValueGenerated(months: ValueHistoryWindow): {
  summary: ValueGeneratedSummary;
  isLoading: boolean;
} {
  const hostId = useHostId();
  const basePath = hostId ? `/api/host/${hostId}` : '/api';

  const { data, isLoading } = useQuery({
    queryKey: ['value-generated', 'summary', hostId, months],
    queryFn: async (): Promise<ValueGeneratedSummary> => {
      const response = await makeLocalApiRequest(
        `${basePath}/value-generated/summary?months=${months}`
      );
      if (!response.ok) return { months: [] };
      const payload = await response.json();
      const raw = (payload?.data?.months ?? []) as unknown[];
      return {
        months: raw.map(normaliseMonth),
      };
    },
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  return {
    summary: data ?? { months: [] },
    isLoading,
  };
}

/**
 * Defensive-parse a single month bucket: SQLite `SUM(...)` can come back as a
 * string in edge cases, and a stale response should never crash the panel.
 */
function normaliseMonth(raw: unknown): ValueGeneratedMonth {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    year_month: String(source.year_month ?? ''),
    done_count: toNumber(source.done_count),
    tasks_with_override: toNumber(source.tasks_with_override),
    override_hours_sum: toNumber(source.override_hours_sum),
  };
}

function toNumber(value: unknown): number {
  const parsed =
    typeof value === 'number' ? value : Number.parseFloat(String(value ?? 0));
  return Number.isFinite(parsed) ? parsed : 0;
}
