import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { XIcon } from '@phosphor-icons/react';
import { useWorkers } from '@/features/workers/model/useWorkers';
import { useAllWorkerTasks } from '@/features/sprint/model/useWorkers';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import { isProviderAuthFailure } from '@/shared/lib/providerAuthFailure';

/**
 * Watches worker tasks and returns the failure reason of the latest task that
 * failed because its provider is not connected or its credential is no
 * longer valid (#625). Tasks already failed on load are the baseline; only a
 * transition into such a failure raises the alert.
 */
export function useProviderAuthAlert() {
  const { data: workers } = useWorkers();
  const { tasks, isLoading } = useAllWorkerTasks(workers);
  const previousRef = useRef<Set<string> | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    if (!workers || isLoading) return;
    const failed = tasks.filter(
      (task) =>
        task.status === 'failed' && isProviderAuthFailure(task.failure_reason)
    );
    const previous = previousRef.current;
    previousRef.current = new Set(failed.map((task) => task.id));
    if (!previous) return;
    const fresh = failed.find((task) => !previous.has(task.id));
    if (fresh) setReason(fresh.failure_reason ?? null);
  }, [workers, tasks, isLoading]);

  return { reason, dismiss: () => setReason(null) };
}

export function ProviderAuthBanner({
  reason,
  onDismiss,
}: {
  reason: string;
  onDismiss: () => void;
}) {
  const { t } = useTranslation('settings');

  return (
    <div
      role="alert"
      className="flex w-full items-center justify-center gap-3 border-b border-warning/40 bg-warning/10 px-base py-half text-sm text-normal"
    >
      <span className="min-w-0 truncate" title={reason}>
        <span className="font-medium text-high">
          {t('settings.providers.alert.message')}
        </span>{' '}
        <span className="text-low">{reason}</span>
      </span>
      <button
        type="button"
        className="shrink-0 font-medium underline underline-offset-2"
        onClick={() => {
          onDismiss();
          void SettingsDialog.show({ initialSection: 'agents' });
        }}
      >
        {t('settings.providers.alert.action')}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('settings.providers.alert.dismiss')}
        className="shrink-0 rounded-sm p-0.5 text-low hover:text-high"
      >
        <XIcon className="size-icon-xs" weight="bold" />
      </button>
    </div>
  );
}
