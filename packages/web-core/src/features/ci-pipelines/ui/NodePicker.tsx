import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Clock,
  Code2,
  GitPullRequest,
  Package,
  Play,
  Store,
  TerminalSquare,
  Zap,
} from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@vibe/ui/components/Command';
import { CATALOG, type CatalogItem } from '../model/catalog';
import type { TriggerKind } from '../model/graph';

const TRIGGER_ICONS: Record<TriggerKind, typeof Zap> = {
  push: Zap,
  pull_request: GitPullRequest,
  schedule: Clock,
  workflow_dispatch: Play,
};

interface NodePickerProps {
  /** Viewport coordinates where the picker opens (clamped). */
  x: number;
  y: number;
  onPick: (item: CatalogItem) => void;
  onPickMarketplace: (query: string) => void;
  onClose: () => void;
}

const PICKER_WIDTH = 300;
const PICKER_MAX_HEIGHT = 360;

/**
 * Quick-add picker (Tab / context menu): same catalog as the palette, one
 * keyboard-first surface. The permanent Community row chains into the
 * marketplace popover carrying the current query.
 */
export function NodePicker({
  x,
  y,
  onPick,
  onPickMarketplace,
  onClose,
}: NodePickerProps) {
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

  const triggers = CATALOG.filter((i) => i.kind === 'trigger');
  const scripts = CATALOG.filter((i) => i.kind === 'script');
  const prefabs = CATALOG.filter((i) => i.kind === 'prefab');
  const raw = CATALOG.filter((i) => i.kind === 'raw');

  const itemIcon = (item: CatalogItem) => {
    if (item.kind === 'trigger') {
      const Icon = TRIGGER_ICONS[item.triggerKind];
      return <Icon className="h-3 w-3" strokeWidth={1.75} />;
    }
    if (item.kind === 'prefab') {
      return <Package className="h-3 w-3" strokeWidth={1.75} />;
    }
    if (item.kind === 'script') {
      return <TerminalSquare className="h-3 w-3" strokeWidth={1.75} />;
    }
    return <Code2 className="h-3 w-3" strokeWidth={1.75} />;
  };

  const toneClass = (item: CatalogItem) =>
    item.kind === 'trigger'
      ? 'bg-warning/15 text-warning'
      : item.kind === 'prefab' || item.kind === 'script'
        ? 'bg-brand/15 text-brand'
        : 'bg-secondary text-normal';

  const renderItem = (item: CatalogItem) => (
    <CommandItem
      key={`${item.kind}-${item.name}`}
      value={`${item.name} ${item.subtitle}`}
      onSelect={() => onPick(item)}
      className="gap-2"
    >
      <span
        className={`flex h-5 w-5 flex-none items-center justify-center rounded-[5px] ${toneClass(item)}`}
      >
        {itemIcon(item)}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-high">
          {item.name}
        </span>
        <span className="block truncate text-[11px] text-low">
          {item.subtitle}
        </span>
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
          placeholder={t('ciPipelines.picker.placeholder', {
            defaultValue: 'Search nodes…',
          })}
          onValueChange={(value) => {
            queryRef.current = value;
          }}
        />
        <CommandList className="max-h-[280px] p-1">
          <CommandEmpty>
            {t('ciPipelines.picker.noResults', { defaultValue: 'No results' })}
          </CommandEmpty>
          <CommandGroup
            heading={t('ciPipelines.picker.triggers', {
              defaultValue: 'Triggers',
            })}
          >
            {triggers.map(renderItem)}
          </CommandGroup>
          <CommandGroup
            heading={t('ciPipelines.picker.jobs', {
              defaultValue: 'Jobs',
            })}
          >
            {scripts.map(renderItem)}
          </CommandGroup>
          <CommandGroup
            heading={t('ciPipelines.picker.prefabs', {
              defaultValue: 'Prefabs',
            })}
          >
            {prefabs.map(renderItem)}
          </CommandGroup>
          <CommandGroup
            heading={t('ciPipelines.picker.escapeHatch', {
              defaultValue: 'Escape hatch',
            })}
          >
            {raw.map(renderItem)}
          </CommandGroup>
          <CommandGroup
            heading={t('ciPipelines.picker.community', {
              defaultValue: 'Community',
            })}
          >
            <CommandItem
              // Always visible regardless of the query: cmdk matches on this
              // value, so mirror the query into it.
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
                  {t('ciPipelines.picker.marketplaceHint', {
                    defaultValue: '20k+ community actions',
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
