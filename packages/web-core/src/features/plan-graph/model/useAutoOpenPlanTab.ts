import { useEffect } from 'react';
import type { WorkspaceTabGroup } from '@/shared/lib/workspaceTabGroups';
import { usePlanStream } from './usePlanStream';

const SEEN_KEY = 'vk-plan-tab-autoopened';

function alreadyOpened(workspaceId: string): boolean {
  try {
    const seen = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[];
    if (seen.includes(workspaceId)) return true;
    localStorage.setItem(
      SEEN_KEY,
      JSON.stringify([...seen, workspaceId].slice(-200))
    );
  } catch {
    // localStorage no disponible: se abre igual, una vez por montaje
  }
  return false;
}

/**
 * Abre la pestaña Plan al lado del chat la primera vez que el agente de un
 * workspace publica su plan. Si después la cerrás, no se vuelve a abrir.
 */
export function useAutoOpenPlanTab(
  workspaceId: string | undefined,
  tabGroups: WorkspaceTabGroup[],
  setTabGroups: (groups: WorkspaceTabGroup[]) => void
) {
  const { plan } = usePlanStream(workspaceId);
  const hasPlan = !!plan && plan.steps.length > 0;
  const planOpen = tabGroups.some((g) => g.tabs.includes('plan'));

  useEffect(() => {
    if (!workspaceId || !hasPlan || planOpen) return;
    if (alreadyOpened(workspaceId)) return;
    setTabGroups([...tabGroups, { tabs: ['plan'], active: 'plan' }]);
  }, [workspaceId, hasPlan, planOpen, tabGroups, setTabGroups]);
}
