import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { GitMerge, RotateCcw } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { ApiError } from '@/shared/lib/api';
import { mergeGateState } from '@/features/issues/lib/mergeGate';
import { useMergePullRequest } from '@/features/issues/model/useMergePullRequest';
import { MergeFacts } from './MergeFacts';
import { MergePrConfirmDialog } from './MergePrConfirmDialog';

export interface MergePrActionProps {
  repoId: string;
  prNumber: number;
  prUrl?: string | null;
  /** Title shown in the confirmation. */
  title?: string;
  /** `mergeable | conflicting | unknown`, as last polled. */
  mergeable?: string | null;
  /** `passing | failing | pending | none | unknown`, as last polled. */
  ciStatus?: string | null;
  className?: string;
}

function Spinner() {
  return (
    <i
      aria-hidden
      className="inline-block size-[11px] animate-spin rounded-full border-[1.5px] border-current border-r-transparent motion-reduce:animate-none"
    />
  );
}

const BUTTON_BASE =
  'inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-md border px-2.5 text-sm sm:ml-auto sm:h-[22px] sm:w-auto sm:text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-md-primary';

/**
 * Merge button of an approved PR (#798), with its state line and the reason
 * when it cannot merge, always written on the card (never only a tooltip).
 * Shared by the Plan's «Pendiente de vos» cards and the dashboard's merge
 * gate. Contract: design/merge-button-placement-mock.html.
 */
export function MergePrAction({
  repoId,
  prNumber,
  prUrl,
  title,
  mergeable,
  ciStatus,
  className,
}: MergePrActionProps) {
  const { t } = useTranslation('common');
  const reasonId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const merge = useMergePullRequest(repoId, prNumber);
  const gate = mergeGateState(mergeable, ciStatus);

  const onMerge = async () => {
    if (gate.block || merge.isPending) return;
    const confirmed = await MergePrConfirmDialog.show({
      prNumber,
      prUrl,
      title,
      gate,
    });
    buttonRef.current?.focus();
    if (confirmed) merge.mutate();
  };

  if (merge.isSuccess) {
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn(
          'grid gap-1 border-t border-dashed border-md-outline-variant pt-2',
          className
        )}
      >
        <div className="flex items-center gap-1.5 text-xs font-semibold text-violet-600 dark:text-violet-400">
          <GitMerge className="size-3.5" aria-hidden />
          {t('mergePr.merged', { number: prNumber })}
        </div>
        <span className="text-[11px] text-normal">
          {t('mergePr.mergedNote')}
        </span>
      </div>
    );
  }

  const error = merge.error;
  const refused = error instanceof ApiError && error.status === 409;
  const blockText =
    gate.block === 'both'
      ? t('mergePr.blocked.both')
      : gate.block === 'conflicts'
        ? t('mergePr.blocked.conflicts')
        : gate.block === 'ciFailing'
          ? t('mergePr.blocked.ciFailing')
          : null;
  const noticeText =
    gate.notice === 'ciPending'
      ? t('mergePr.notice.ciPending')
      : gate.notice === 'ciUnavailable'
        ? t('mergePr.notice.ciUnavailable')
        : gate.notice === 'mergeableUnknown'
          ? t('mergePr.notice.mergeableUnknown')
          : gate.notice === 'ciNone'
            ? t('mergePr.notice.ciNone')
            : null;

  return (
    <div
      // The Plan card opens the issue on click; acting here must not.
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'grid gap-1.5 border-t border-dashed border-md-outline-variant pt-2',
        className
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <MergeFacts
          ci={gate.ci}
          conflicts={gate.conflicts}
          mergeableKnown={mergeable === 'mergeable'}
        />
        {merge.isPending ? (
          <button
            type="button"
            aria-disabled="true"
            aria-busy="true"
            className={cn(
              BUTTON_BASE,
              'cursor-progress border-md-primary bg-md-primary font-semibold text-md-on-primary opacity-90'
            )}
          >
            <Spinner />
            {t('mergePr.merging')}
          </button>
        ) : (
          <button
            ref={buttonRef}
            type="button"
            onClick={() => void onMerge()}
            aria-disabled={gate.block ? 'true' : undefined}
            aria-describedby={blockText || error ? reasonId : undefined}
            className={cn(
              BUTTON_BASE,
              gate.block
                ? 'cursor-not-allowed border-md-outline-variant bg-md-surface-container text-normal'
                : error
                  ? 'border-md-outline-variant bg-md-surface-container text-high hover:border-md-on-surface-variant'
                  : 'border-md-primary bg-md-primary font-semibold text-md-on-primary hover:opacity-90'
            )}
          >
            {error && !gate.block ? (
              <RotateCcw className="size-3.5" aria-hidden />
            ) : (
              <GitMerge className="size-3.5" aria-hidden />
            )}
            {error && !gate.block ? t('mergePr.retry') : t('mergePr.action')}
          </button>
        )}
      </div>
      {error && !merge.isPending ? (
        <div
          id={reasonId}
          role="alert"
          className="rounded bg-md-error/10 px-2 py-1.5 text-xs leading-[1.4] text-high"
        >
          {refused ? t('mergePr.error.refused') : t('mergePr.error.github')}
          <small className="mt-0.5 block break-words font-mono text-[11px] text-normal">
            {error.message}
          </small>
        </div>
      ) : blockText ? (
        <div
          id={reasonId}
          className="rounded bg-md-error/10 px-2 py-1.5 text-xs leading-[1.4] text-high"
        >
          {blockText}
          {prUrl && (
            <a
              href={prUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-0.5 block text-[11px] text-brand-on-surface hover:underline"
            >
              {t('mergePr.openOnGithub')}
            </a>
          )}
        </div>
      ) : noticeText ? (
        <div
          className={cn(
            'rounded px-2 py-1.5 text-xs leading-[1.4]',
            gate.notice === 'ciNone'
              ? 'px-0 py-0 text-[11px] text-normal'
              : 'bg-warning/10 text-high'
          )}
        >
          {noticeText}
        </div>
      ) : null}
    </div>
  );
}
