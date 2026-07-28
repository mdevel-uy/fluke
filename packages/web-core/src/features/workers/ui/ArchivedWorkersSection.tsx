import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  ChevronDown,
  ChevronUp,
  Loader2,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import type { WorkerResponse } from 'shared/types';
import { Button } from '@vibe/ui/components/Button';
import { cn } from '@/shared/lib/utils';
import {
  modelChipClass,
  ROLE_CHIP_CLASS,
  ROLE_CHIP_FALLBACK,
} from '../model/chipColors';

interface ArchivedWorkerRowProps {
  worker: WorkerResponse;
  isRestoring: boolean;
  isPurging: boolean;
  onRestore: () => void;
  onPurge: () => void;
}

function ArchivedWorkerRow({
  worker,
  isRestoring,
  isPurging,
  onRestore,
  onPurge,
}: ArchivedWorkerRowProps) {
  const { t } = useTranslation('common');
  const busy = isRestoring || isPurging;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-md-surface-container-lowest px-3 py-2">
      <span className="shrink-0 text-lg leading-none">{worker.emoji}</span>
      <h4 className="min-w-0 truncate font-sans text-title text-high">
        {worker.name}
      </h4>
      <span
        className={cn(
          'shrink-0 rounded-full px-2 py-px text-xs font-medium',
          ROLE_CHIP_CLASS[worker.role ?? 'developer'] ?? ROLE_CHIP_FALLBACK
        )}
      >
        {t(`workers.roles.${worker.role ?? 'developer'}`)}
      </span>
      {worker.model && (
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-px font-mono text-xs',
            modelChipClass(worker.model)
          )}
        >
          {worker.model}
        </span>
      )}
      <span className="shrink-0 text-xs text-low tabular-nums">
        {t('workers.card.completedLabel')}: {worker.completed_count}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={onRestore}
          disabled={busy}
        >
          {isRestoring ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
          )}
          {t('workers.unarchive')}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={onPurge}
          disabled={busy}
        >
          {isPurging ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
          ) : (
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          )}
          {t('workers.purge')}
        </Button>
      </div>
    </div>
  );
}

interface ArchivedWorkersSectionProps {
  workers: WorkerResponse[];
  isLoading: boolean;
  isError: boolean;
  restoringWorkerId: string | null;
  purgingWorkerId: string | null;
  onRestore: (worker: WorkerResponse) => void;
  onPurge: (worker: WorkerResponse) => void;
}

export function ArchivedWorkersSection({
  workers,
  isLoading,
  isError,
  restoringWorkerId,
  purgingWorkerId,
  onRestore,
  onPurge,
}: ArchivedWorkersSectionProps) {
  const { t } = useTranslation('common');
  // Collapsed by default: the section is a low-frequency admin surface and
  // should not steal attention from the active workers listed above.
  const [isExpanded, setIsExpanded] = useState(false);

  // Hide the whole section when there is nothing to show and we're not
  // loading; a permanent empty block would just add noise.
  if (!isLoading && !isError && workers.length === 0) {
    return null;
  }

  return (
    <section className="mt-4 border-t border-border px-container-padding py-4">
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-normal hover:text-high"
        aria-expanded={isExpanded}
      >
        <Archive className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        <span className="font-sans text-title text-high">
          {t('workers.archived_section_title')}
        </span>
        <span className="text-sm text-low tabular-nums">
          ({workers.length})
        </span>
        {isExpanded ? (
          <ChevronUp
            className="ml-auto h-4 w-4"
            strokeWidth={1.75}
            aria-hidden
          />
        ) : (
          <ChevronDown
            className="ml-auto h-4 w-4"
            strokeWidth={1.75}
            aria-hidden
          />
        )}
      </button>

      {isExpanded && (
        <div className="mt-3 flex flex-col gap-2">
          {isLoading ? (
            <div className="flex items-center gap-2 px-1 py-2 text-normal">
              <Loader2
                className="h-4 w-4 animate-spin text-brand-on-surface"
                strokeWidth={1.75}
              />
              <span className="text-sm">{t('workers.loading')}</span>
            </div>
          ) : isError ? (
            <p className="px-1 py-2 text-sm text-md-error">
              {t('workers.loadError')}
            </p>
          ) : (
            workers.map((worker) => (
              <ArchivedWorkerRow
                key={worker.id}
                worker={worker}
                isRestoring={restoringWorkerId === worker.id}
                isPurging={purgingWorkerId === worker.id}
                onRestore={() => onRestore(worker)}
                onPurge={() => onPurge(worker)}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}
