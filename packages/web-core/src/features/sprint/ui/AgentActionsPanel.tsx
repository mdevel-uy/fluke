import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { XIcon, ArrowSquareOutIcon } from '@phosphor-icons/react';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { Button } from '@vibe/ui/components/Button';
import { cn } from '@/shared/lib/utils';
import type { AgentAction, WorkerTask } from '@/features/sprint/types';

interface AgentActionsPanelProps {
  task: WorkerTask;
  actions: AgentAction[];
  isLoading: boolean;
  isRetrying: boolean;
  canRetry: boolean;
  onRetry: () => void;
  onClose: () => void;
}

const STATUS_STYLES: Record<AgentAction['status'], string> = {
  pending: 'bg-warning/10 border-warning/30 text-warning',
  done: 'bg-success/10 border-success/30 text-success',
  failed: 'bg-md-error/10 border-md-error/30 text-md-error',
  skipped: 'bg-secondary border-border/50 text-low',
};

export function AgentActionsPanel({
  task,
  actions,
  isLoading,
  isRetrying,
  canRetry,
  onRetry,
  onClose,
}: AgentActionsPanelProps) {
  const { t } = useTranslation('tasks');

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={cn(
          'fixed right-0 top-0 bottom-0 z-50 w-full max-w-[480px]',
          'bg-primary border-l border-border/70 shadow-overlay',
          'flex flex-col',
          'animate-in slide-in-from-right-8 duration-200'
        )}
        role="dialog"
        aria-modal="true"
        aria-label={t('agentActions.panelLabel')}
      >
        <header className="flex items-start gap-3 px-5 py-4 border-b border-border/60 shrink-0">
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-high leading-snug">
              {t('agentActions.title')}
            </h2>
            <p
              className="text-xs text-low mt-1 truncate"
              title={task.title}
            >
              {task.title}
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 p-1.5 rounded-lg text-low hover:text-high hover:bg-secondary transition-all focus:outline-none focus:ring-1 focus:ring-brand/40"
            aria-label={t('agentActions.close')}
          >
            <XIcon className="size-4" />
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {isLoading && actions.length === 0 ? (
            <p className="text-sm text-low">{t('agentActions.loading')}</p>
          ) : actions.length === 0 ? (
            <p className="text-sm text-low italic">{t('agentActions.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {actions.map((action) => (
                <li
                  key={action.seq}
                  className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-secondary/40 px-3 py-2"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-ibm-plex-mono text-xs text-low">
                      #{action.seq}
                    </span>
                    <span
                      className="text-sm text-high font-medium truncate"
                      title={action.kind}
                    >
                      {action.kind}
                    </span>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 h-5 px-1.5 rounded-md border text-xs font-medium',
                        STATUS_STYLES[action.status]
                      )}
                    >
                      {t(`agentActions.status.${action.status}`)}
                    </span>
                  </div>
                  {action.status === 'failed' && action.last_error && (
                    <p
                      className="text-xs text-md-error break-words"
                      title={action.last_error}
                    >
                      {action.last_error}
                    </p>
                  )}
                  {action.status === 'done' && action.result_url && (
                    <a
                      href={action.result_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 self-start text-xs text-md-primary hover:underline"
                    >
                      {t('agentActions.resultLink')}
                      <ArrowSquareOutIcon className="size-3" />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {canRetry && (
          <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border/60 shrink-0">
            <Button
              variant="primary"
              size="sm"
              disabled={isRetrying}
              onClick={onRetry}
            >
              {isRetrying ? (
                <MaterialIcon
                  name="progress_activity"
                  size="xs"
                  className="animate-spin"
                />
              ) : (
                <MaterialIcon name="refresh" size="xs" />
              )}
              {t('agentActions.retryButton')}
            </Button>
          </footer>
        )}
      </aside>
    </>
  );
}
