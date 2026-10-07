import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { useDirectorStore } from '../model/useDirectorStore';
import {
  useAppErrorsLive,
  ignoreAppError,
  useLocalAppErrorsStore,
} from '../model/useAppErrorsLive';

export function AppErrorNotifications() {
  useAppErrorsLive();
  useAppErrorsLive('local');
  return <AppErrorBubbles />;
}

/** Crash fallback: keep polling local errors without the router/app providers. */
export function CrashAppErrorBubbles() {
  useAppErrorsLive('local');
  return <AppErrorBubbles localOnly />;
}

export function AppErrorBubbles({
  localOnly = false,
}: {
  localOnly?: boolean;
}) {
  const hostId = useHostId();
  const { t } = useTranslation('common');
  const errors = useDirectorStore((s) => s.appErrors);
  const ignored = useDirectorStore((s) => s.ignoredErrors);
  const localErrors = useLocalAppErrorsStore((s) => s.appErrors);
  const localIgnored = useLocalAppErrorsStore((s) => s.ignoredErrors);
  const visible = [
    ...localErrors
      .filter((error) => !localIgnored.includes(error.fingerprint))
      .map((error) => ({ ...error, scope: 'local' as const })),
    ...(localOnly || hostId === null
      ? []
      : errors
          .filter((error) => !ignored.includes(error.fingerprint))
          .map((error) => ({ ...error, scope: 'current' as const }))),
  ];
  if (!visible.length) return null;
  return createPortal(
    <div
      className="fixed bottom-[100px] right-7 z-[90] flex max-h-[calc(100vh-140px)] w-[320px] max-w-[calc(100vw-3.5rem)] flex-col gap-2 overflow-y-auto"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {visible.map((error) => (
        <section
          key={`${error.scope}:${error.fingerprint}`}
          className="rounded-lg border border-border/60 bg-primary p-3 shadow-overlay"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-label font-semibold text-high">
              {t('director.appErrors.title')}
            </p>
            <span className="shrink-0 font-mono text-label tabular-nums text-low">
              {t('director.appErrors.count', { count: error.count })}
            </span>
          </div>
          <p className="mt-2 break-words text-body text-normal">
            {error.message}
          </p>
          <button
            type="button"
            onClick={() => ignoreAppError(error.fingerprint, error.scope)}
            className="mt-3 min-h-8 rounded-md border border-border/60 px-3 text-label text-normal hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand"
          >
            {t('director.appErrors.ignore')}
          </button>
        </section>
      ))}
    </div>,
    document.body
  );
}
