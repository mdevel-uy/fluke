import { useQuery } from '@tanstack/react-query';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import { useHostId } from '@/shared/providers/HostIdProvider';

export type ClaudeUsageMeterKey = 'session' | 'week_all' | 'week_opus';

/** Mirrors ClaudeUsageMeter in crates/server/src/routes/agents.rs. */
export interface ClaudeUsageMeter {
  key: ClaudeUsageMeterKey | string;
  /** 0-100, as reported by Claude Code. */
  used_percent: number;
  /** RFC3339; null when Claude did not report a reset time. */
  resets_at: string | null;
}

/** Mirrors ClaudeUsageResponse in crates/server/src/routes/agents.rs. */
export interface ClaudeUsage {
  /** Raw plan name from Claude Code (e.g. "Max 20x"); never translated. */
  plan: string | null;
  meters: ClaudeUsageMeter[];
  workers_on_claude: number;
}

/**
 * Claude plan limits, mined from the `rate_limit_event` messages Claude Code
 * emits. Returns null while loading, when the endpoint is unavailable (older
 * backend) and when no Claude worker has reported limits yet — the Dashboard
 * then hides the panel entirely.
 */
export function useClaudeUsage(): ClaudeUsage | null {
  const hostId = useHostId();
  const basePath = hostId ? `/api/host/${hostId}` : '/api';

  const { data = null } = useQuery({
    queryKey: ['agents', 'claude', 'usage', hostId],
    queryFn: async (): Promise<ClaudeUsage | null> => {
      const response = await makeLocalApiRequest(
        `${basePath}/agents/claude/usage`
      );
      if (!response.ok) return null;
      const payload = await response.json();
      return payload?.data ?? null;
    },
    refetchInterval: 60000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  return data;
}
