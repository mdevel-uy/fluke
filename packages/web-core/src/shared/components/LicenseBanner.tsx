import { cn } from '@/shared/lib/utils';
import type { LicenseStatusResponse } from '@/shared/lib/api';

interface LicenseBannerProps {
  license: LicenseStatusResponse | undefined;
}

/**
 * Full-width banner for the licensing state, rendered above the navbar.
 *
 * Shows nothing when licensing is not enforced (no embedded key) or the license
 * is valid — the common case. In `grace` it warns (the license expired but the
 * grace period is still running); in `suspended` it states plainly that new
 * agents won't start **and that the data is still available**, which is the
 * contractual promise (T&C cl. 9). It never offers a way to dismiss: the state
 * is real and only clears when the license is renewed.
 */
export function LicenseBanner({ license }: LicenseBannerProps) {
  if (!license || !license.enforced || license.status === 'valid') {
    return null;
  }

  const suspended = license.status === 'suspended';

  const message = suspended
    ? 'Licencia suspendida: no se inician agentes nuevos. Tus datos, el tablero y el historial siguen disponibles.'
    : license.reason
      ? `Licencia por vencer — ${license.reason}.`
      : 'La licencia está por vencer.';

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'w-full border-b px-base py-half text-center text-sm font-medium',
        suspended
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : 'border-warning/40 bg-warning/10 text-warning-foreground'
      )}
    >
      {message}{' '}
      <a
        href="mailto:sales@mdevel.dev"
        className="underline underline-offset-2"
      >
        Contactar a fluke
      </a>
    </div>
  );
}
