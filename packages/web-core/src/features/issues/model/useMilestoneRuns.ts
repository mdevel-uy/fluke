import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { MilestoneRun } from 'shared/types';
import { milestoneRunsApi } from '@/shared/lib/api';
import { workersKeys } from '@/features/workers/model/workersKeys';
import { repoIssuesKeys } from './repoIssuesKeys';

/**
 * Milestone runs of a repo (fluke v2, #666). Polled every 10 s while the
 * Plan view is open so play / waiting / next-wave changes show up without a
 * refresh; every action also refreshes runs, tasks and issues right away.
 */

export const milestoneRunsKeys = {
  all: ['milestone-runs'] as const,
  byRepo: (repoId: string) => [...milestoneRunsKeys.all, repoId] as const,
};

export function useMilestoneRuns(repoId: string | undefined) {
  return useQuery({
    queryKey: repoId ? milestoneRunsKeys.byRepo(repoId) : milestoneRunsKeys.all,
    queryFn: () => milestoneRunsApi.list(repoId!),
    enabled: !!repoId,
    refetchInterval: 10_000,
  });
}

export function useMilestoneRunActions(repoId: string | undefined) {
  const queryClient = useQueryClient();
  const refresh = () => {
    if (!repoId) return;
    void queryClient.invalidateQueries({
      queryKey: milestoneRunsKeys.byRepo(repoId),
    });
    void queryClient.invalidateQueries({ queryKey: workersKeys.all });
    void queryClient.invalidateQueries({
      queryKey: repoIssuesKeys.byRepo(repoId),
    });
  };
  const need = () => {
    if (!repoId) throw new Error('repoId required');
    return repoId;
  };

  return {
    play: useMutation({
      mutationFn: (v: { milestone: string; stepMode: boolean }) =>
        milestoneRunsApi.play(need(), v.milestone, v.stepMode),
      onSettled: refresh,
    }),
    playAll: useMutation({
      mutationFn: (v: { milestones: string[]; stepMode: boolean }) =>
        milestoneRunsApi.playAll(need(), v.milestones, v.stepMode),
      onSettled: refresh,
    }),
    pause: useMutation({
      mutationFn: (milestone: string) =>
        milestoneRunsApi.pause(need(), milestone),
      onSettled: refresh,
    }),
    reset: useMutation({
      mutationFn: (milestone: string) =>
        milestoneRunsApi.reset(need(), milestone),
      onSettled: refresh,
    }),
    setStepMode: useMutation({
      mutationFn: (stepMode: boolean) =>
        milestoneRunsApi.setStepMode(need(), stepMode),
      onSettled: refresh,
    }),
  };
}

/** "Pausar al terminar cada wave": remembered per browser, sent with play. */
export const usePlanStepModeStore = create<{
  stepMode: boolean;
  setStepMode: (v: boolean) => void;
}>()(
  persist(
    (set) => ({
      stepMode: false,
      setStepMode: (stepMode) => set({ stepMode }),
    }),
    { name: 'issues-plan-step-mode' }
  )
);

export type { MilestoneRun };
