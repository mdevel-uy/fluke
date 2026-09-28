import { useCallback } from 'react';
import type { PlanSnapshot } from 'shared/types';
import { useJsonPatchWsStream } from '@/shared/hooks/useJsonPatchWsStream';
import { planApi } from '@/shared/lib/api';

type PlanState = { plan: PlanSnapshot | null };

/** Plan del agente de un workspace, en vivo por WebSocket (JSON Patch). */
export function usePlanStream(workspaceId: string | undefined) {
  const enabled = !!workspaceId;
  const endpoint = workspaceId ? planApi.getStreamUrl(workspaceId) : undefined;
  const initialData = useCallback((): PlanState => ({ plan: null }), []);
  const { data, isInitialized, error } = useJsonPatchWsStream<PlanState>(
    endpoint,
    enabled,
    initialData
  );
  return {
    plan: data?.plan ?? null,
    isLoading: enabled && !isInitialized && !error,
    error,
  };
}
