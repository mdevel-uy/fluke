import { useCallback, useState } from 'react';
import type { WorkerTask } from '@/features/sprint/types';
import {
  useAgentActions,
  useRetryAgentActions,
} from '@/features/sprint/model/useAgentActions';
import { AgentActionsBadge } from './AgentActionsBadge';
import { AgentActionsPanel } from './AgentActionsPanel';

interface AgentActionsSectionProps {
  task: WorkerTask;
  /**
   * When `true`, the query fires on mount so the badge can render without any
   * user interaction — reserved for card states where actions are plausible
   * (today: `failed`). When `false` (default) the fetch is lazy: it only fires
   * on the first panel open, and the card renders no badge. Kept opt-in to
   * avoid fanning out N pollers across a board full of tasks that never
   * declared a single agent action.
   */
  eager?: boolean;
  className?: string;
}

// Composes the fetch, badge and detail panel for one task. Owns the
// "panel open" state locally so parents don't have to plumb it into their own
// UI graph — the panel is a fixed-position overlay so there is no z-index
// conflict with the card that mounted it.
export function AgentActionsSection({
  task,
  eager = false,
  className,
}: AgentActionsSectionProps) {
  const [isOpen, setIsOpen] = useState(false);
  // Lazy path: the fetch stays disabled until the user actually opens the
  // panel. Eager path: fetch on mount so the badge shows without interaction.
  const query = useAgentActions(task.worker_id, task.id, eager || isOpen);
  const retryMutation = useRetryAgentActions();
  const actions = query.data ?? [];

  // Retry is only meaningful when the drain has work AND the coding agent is
  // not currently running — the retry endpoint refuses to interfere with an
  // in-progress task (409) and we mirror that here so the button never lies.
  const hasRetryable = actions.some(
    (a) => a.status === 'pending' || a.status === 'failed'
  );
  const canRetry = hasRetryable && task.status !== 'in_progress';

  const handleRetry = useCallback(() => {
    retryMutation.mutate({ workerId: task.worker_id, taskId: task.id });
  }, [retryMutation, task.worker_id, task.id]);

  return (
    <>
      <AgentActionsBadge
        actions={actions}
        onClick={() => setIsOpen(true)}
        className={className}
      />
      {isOpen && (
        <AgentActionsPanel
          task={task}
          actions={actions}
          isLoading={query.isLoading}
          isRetrying={retryMutation.isPending}
          canRetry={canRetry}
          onRetry={handleRetry}
          onClose={() => setIsOpen(false)}
        />
      )}
    </>
  );
}
