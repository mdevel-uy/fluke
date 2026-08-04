import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Store, TerminalSquare } from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@vibe/ui/components/Command';
import type { ScriptStep } from '../model/graph';

interface StepPickerProps {
  x: number;
  y: number;
  onPick: (step: ScriptStep) => void;
  onPickMarketplace: (query: string) => void;
  onClose: () => void;
}

const PICKER_WIDTH = 300;
const PICKER_MAX_HEIGHT = 300;

/**
 * Quick-add picker inside the drill-down: inserts steps, not jobs. The
 * Community row chains into the marketplace popover — an action inserted
 * here becomes a `uses` step.
 */
export function StepPicker({
  x,
  y,
  onPick,
  onPickMarketplace,
  onClose,
}: StepPickerProps) {
  const { t } = useTranslation('common');
  const containerRef = useRef<HTMLDivElement>(null);
  const queryRef = useRef('');

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [onClose]);

  const left = Math.max(8, Math.min(x, window.innerWidth - PICKER_WIDTH - 8));
  const top = Math.max(
    8,
    Math.min(y, window.innerHeight - PICKER_MAX_HEIGHT - 8)
  );

  const item = (
    key: string,
    icon: 'run' | 'uses',
    title: string,
    subtitle: string,
    step: ScriptStep
  ) => (
    <CommandItem
      key={key}
      value={`${title} ${subtitle}`}
      onSelect={() => onPick(step)}
      className="gap-2"
    >
      <span
        className={`flex h-5 w-5 flex-none items-center justify-center rounded-[5px] ${
          icon === 'uses'
            ? 'bg-success/15 text-success'
            : 'bg-brand/15 text-brand'
        }`}
      >
        {icon === 'uses' ? (
          <Store className="h-3 w-3" strokeWidth={1.75} />
        ) : (
          <TerminalSquare className="h-3 w-3" strokeWidth={1.75} />
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-high">
          {title}
        </span>
        <span className="block truncate text-[11px] text-low">{subtitle}</span>
      </span>
    </CommandItem>
  );

  return (
    <div
      ref={containerRef}
      className="fixed z-50 overflow-hidden rounded-[10px] border border-md-outline bg-panel shadow-lg"
      style={{ left, top, width: PICKER_WIDTH }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
        if (event.key === 'Tab') event.preventDefault();
      }}
    >
      <Command loop>
        <CommandInput
          autoFocus
          placeholder={t('ciPipelines.stepPicker.placeholder', {
            defaultValue: 'Add a step…',
          })}
          onValueChange={(value) => {
            queryRef.current = value;
          }}
        />
        <CommandList className="max-h-[220px] p-1">
          <CommandEmpty>
            {t('ciPipelines.picker.noResults', { defaultValue: 'No results' })}
          </CommandEmpty>
          <CommandGroup
            heading={t('ciPipelines.stepPicker.steps', {
              defaultValue: 'Steps',
            })}
          >
            {item(
              'run',
              'run',
              t('ciPipelines.stepPicker.runStep', {
                defaultValue: 'Run step',
              }),
              t('ciPipelines.stepPicker.runStepHint', {
                defaultValue: 'shell command',
              }),
              { run: '' }
            )}
            {item(
              'uses',
              'uses',
              t('ciPipelines.stepPicker.usesStep', {
                defaultValue: 'Uses step',
              }),
              t('ciPipelines.stepPicker.usesStepHint', {
                defaultValue: 'action by owner/repo@ref',
              }),
              { uses: '' }
            )}
            {item(
              'checkout',
              'uses',
              t('ciPipelines.stepPicker.checkout', {
                defaultValue: 'Checkout',
              }),
              'actions/checkout@v4',
              { name: 'Checkout', uses: 'actions/checkout@v4' }
            )}
          </CommandGroup>
          <CommandGroup
            heading={t('ciPipelines.picker.community', {
              defaultValue: 'Community',
            })}
          >
            <CommandItem
              value={`marketplace ${queryRef.current}`}
              forceMount
              onSelect={() => onPickMarketplace(queryRef.current)}
              className="gap-2"
            >
              <span className="flex h-5 w-5 flex-none items-center justify-center rounded-[5px] bg-success/15 text-success">
                <Store className="h-3 w-3" strokeWidth={1.75} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-high">
                  {t('ciPipelines.picker.searchMarketplace', {
                    defaultValue: 'Search marketplace…',
                  })}
                </span>
                <span className="block truncate text-[11px] text-low">
                  {t('ciPipelines.stepPicker.marketplaceHint', {
                    defaultValue: 'insert an action as a step',
                  })}
                </span>
              </span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}
