import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import type { CiFact } from '@/features/issues/lib/mergeGate';

type Tone = 'ok' | 'warn' | 'err' | 'mute';

const DOT_CLASS: Record<Tone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  err: 'bg-md-error',
  mute: 'border border-md-on-surface-variant bg-transparent',
};

const CI_TONE: Record<CiFact, Tone> = {
  ok: 'ok',
  failing: 'err',
  pending: 'warn',
  none: 'mute',
  unavailable: 'warn',
};

function Dot({ tone }: { tone: Tone }) {
  return (
    <i
      aria-hidden
      className={cn(
        'inline-block size-[7px] shrink-0 rounded-full',
        DOT_CLASS[tone]
      )}
    />
  );
}

export function CiFactText({ ci }: { ci: CiFact }) {
  const { t } = useTranslation('common');
  switch (ci) {
    case 'ok':
      return <>{t('mergePr.ci.ok')}</>;
    case 'failing':
      return <>{t('mergePr.ci.failing')}</>;
    case 'pending':
      return <>{t('mergePr.ci.pending')}</>;
    case 'none':
      return <>{t('mergePr.ci.none')}</>;
    default:
      return <>{t('mergePr.ci.unavailable')}</>;
  }
}

/** CI and conflicts at a glance, next to the merge button. */
export function MergeFacts({
  ci,
  conflicts,
  mergeableKnown,
}: {
  ci: CiFact;
  conflicts: boolean;
  mergeableKnown: boolean;
}) {
  const { t } = useTranslation('common');
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-normal">
      <span className="inline-flex items-center gap-1">
        <Dot tone={CI_TONE[ci]} />
        <CiFactText ci={ci} />
      </span>
      <span className="inline-flex items-center gap-1">
        <Dot tone={conflicts ? 'err' : mergeableKnown ? 'ok' : 'mute'} />
        {conflicts
          ? t('mergePr.conflicts.yes')
          : mergeableKnown
            ? t('mergePr.conflicts.no')
            : t('mergePr.conflicts.unknown')}
      </span>
    </div>
  );
}
