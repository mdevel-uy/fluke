import * as SelectPrimitive from '@radix-ui/react-select';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WorkerResponse } from 'shared/types';
import { cn } from '@/shared/lib/utils';
import {
  ROLE_CHIP_CLASS,
  ROLE_CHIP_FALLBACK,
} from '@/features/workers/model/chipColors';

interface WorkerSelectItemProps {
  worker: WorkerResponse;
  showEmoji?: boolean;
}

/**
 * `Select.Item` for the assign/reassign worker pickers. Only the display
 * name goes into `ItemText` so the trigger stays compact; role and status
 * render as siblings and appear only in the open dropdown.
 */
export function WorkerSelectItem({
  worker,
  showEmoji = false,
}: WorkerSelectItemProps) {
  const { t } = useTranslation('common');
  const role = worker.role ?? 'developer';
  const isRunning = worker.active_workspace_id !== null;
  const displayName =
    showEmoji && worker.emoji ? `${worker.emoji} ${worker.name}` : worker.name;
  return (
    <SelectPrimitive.Item
      value={worker.id}
      textValue={displayName}
      className={cn(
        'relative flex w-full cursor-pointer select-none items-center gap-2 rounded-md py-1.5 pl-8 pr-2 text-sm text-normal outline-none transition-colors',
        'focus:bg-secondary focus:text-high data-[disabled]:pointer-events-none data-[disabled]:opacity-50'
      )}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="h-4 w-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{displayName}</SelectPrimitive.ItemText>
      <span
        className={cn(
          'shrink-0 rounded-full px-2 py-px text-xs font-medium',
          ROLE_CHIP_CLASS[role] ?? ROLE_CHIP_FALLBACK
        )}
      >
        {t(`workers.roles.${role}`)}
      </span>
      <span
        className={cn(
          'ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
          isRunning ? 'bg-success/10 text-success' : 'bg-secondary text-low'
        )}
      >
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            isRunning
              ? 'animate-pulse bg-success motion-reduce:animate-none'
              : 'bg-md-outline'
          )}
          aria-hidden
        />
        {t(isRunning ? 'dashboard.running' : 'dashboard.idle')}
      </span>
    </SelectPrimitive.Item>
  );
}
