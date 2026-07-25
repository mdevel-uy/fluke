import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * "live · updated Xs ago" ticker. Owns its own 5s interval so the rest of the
 * Dashboard is not re-rendered by the clock.
 */
export function LiveChip({
  isConnected,
  stampKey,
}: {
  isConnected: boolean;
  /** Changes whenever fresh data arrives; restarts the "updated ago" clock. */
  stampKey: unknown;
}) {
  const { t } = useTranslation('common');
  const lastUpdatedRef = useRef<number>(Date.now());
  const [, setTick] = useState(0);

  useEffect(() => {
    lastUpdatedRef.current = Date.now();
  }, [stampKey]);

  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 5000);
    return () => clearInterval(id);
  }, []);

  if (!isConnected) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-low">
        <span className="h-1.5 w-1.5 rounded-full bg-error" />
        {t('dashboard.offline')}
      </span>
    );
  }

  const secs = Math.max(
    0,
    Math.round((Date.now() - lastUpdatedRef.current) / 1000)
  );
  const label = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m`;

  return (
    <span className="flex items-center gap-1.5 text-xs text-low">
      <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse motion-reduce:animate-none" />
      {t('dashboard.live')} · {t('dashboard.updatedAgo', { time: label })}
    </span>
  );
}
