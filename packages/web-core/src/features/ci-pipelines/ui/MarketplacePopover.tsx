import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BadgeCheck, Search, Store } from 'lucide-react';
import { MARKETPLACE_ACTIONS } from '../model/catalog';

interface MarketplacePopoverProps {
  x: number;
  y: number;
  initialQuery?: string;
  onPick: (uses: string) => void;
  onClose: () => void;
}

const POPOVER_WIDTH = 384;
const POPOVER_MAX_HEIGHT = 420;

/**
 * Marketplace search popover. PR 1 searches a curated list plus a free-form
 * `owner/repo@ref` row so any action is insertable; live search against the
 * GitHub API arrives in a later PR.
 */
export function MarketplacePopover({
  x,
  y,
  initialQuery = '',
  onPick,
  onClose,
}: MarketplacePopoverProps) {
  const { t } = useTranslation('common');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [onClose]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return MARKETPLACE_ACTIONS;
    return MARKETPLACE_ACTIONS.filter((a) =>
      `${a.uses} ${a.description}`.toLowerCase().includes(q)
    );
  }, [query]);

  /** Free-form row appears when the query looks like `owner/repo[@ref]`. */
  const customUses = useMemo(() => {
    const trimmed = query.trim();
    return /^[\w.-]+\/[\w.-]+(@[\w.-]+)?$/.test(trimmed) ? trimmed : null;
  }, [query]);

  const rowCount = results.length + (customUses ? 1 : 0);

  const pickIndex = (index: number) => {
    if (customUses && index === results.length) {
      onPick(customUses.includes('@') ? customUses : `${customUses}@main`);
    } else if (results[index]) {
      onPick(results[index].uses);
    }
  };

  const left = Math.max(8, Math.min(x, window.innerWidth - POPOVER_WIDTH - 8));
  const top = Math.max(
    8,
    Math.min(y, window.innerHeight - POPOVER_MAX_HEIGHT - 8)
  );

  return (
    <div
      ref={containerRef}
      className="fixed z-50 flex flex-col overflow-hidden rounded-[10px] border border-md-outline bg-panel shadow-lg"
      style={{ left, top, width: POPOVER_WIDTH, maxHeight: POPOVER_MAX_HEIGHT }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, rowCount - 1));
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
        } else if (event.key === 'Enter') {
          event.preventDefault();
          pickIndex(activeIndex);
        } else if (event.key === 'Tab') {
          event.preventDefault();
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-md-outline-variant px-3 py-2.5 text-low">
        <Search className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          placeholder={t('ciPipelines.marketplace.placeholder', {
            defaultValue: 'Search GitHub Actions Marketplace…',
          })}
          className="w-full bg-transparent text-sm text-high outline-none placeholder:text-low"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {results.map((action, index) => (
          <button
            key={action.uses}
            type="button"
            onClick={() => pickIndex(index)}
            onMouseEnter={() => setActiveIndex(index)}
            className={`flex w-full cursor-pointer items-center gap-2 rounded-[7px] px-2 py-1.5 text-left ${
              index === activeIndex ? 'bg-secondary' : ''
            }`}
          >
            <span className="flex h-5 w-5 flex-none items-center justify-center rounded-[5px] bg-success/15 text-success">
              <Store className="h-3 w-3" strokeWidth={1.75} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1 truncate text-sm font-medium text-high">
                {action.uses.split('@')[0]}
                {action.verified && (
                  <BadgeCheck
                    className="h-3 w-3 flex-none text-success"
                    strokeWidth={2}
                  />
                )}
              </span>
              <span className="block truncate text-[11px] text-low">
                {action.description}
              </span>
            </span>
            <span className="flex-none text-right text-[10px] leading-tight text-low tabular-nums">
              ★ {action.stars}
              <br />
              {action.version}
            </span>
          </button>
        ))}
        {customUses && (
          <button
            type="button"
            onClick={() => pickIndex(results.length)}
            onMouseEnter={() => setActiveIndex(results.length)}
            className={`flex w-full cursor-pointer items-center gap-2 rounded-[7px] px-2 py-1.5 text-left ${
              activeIndex === results.length ? 'bg-secondary' : ''
            }`}
          >
            <span className="flex h-5 w-5 flex-none items-center justify-center rounded-[5px] bg-secondary text-normal">
              <Store className="h-3 w-3" strokeWidth={1.75} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-high">
                {t('ciPipelines.marketplace.useCustom', {
                  defaultValue: 'Use "{{uses}}"',
                  uses: customUses,
                })}
              </span>
              <span className="block truncate text-[11px] text-low">
                {t('ciPipelines.marketplace.useCustomHint', {
                  defaultValue: 'Insert any action by owner/repo@ref',
                })}
              </span>
            </span>
          </button>
        )}
        {results.length === 0 && !customUses && (
          <div className="px-3 py-4 text-center text-sm text-low">
            {t('ciPipelines.marketplace.noResults', {
              defaultValue:
                'No results — type owner/repo@ref to insert any action',
            })}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-md-outline-variant px-3 py-1.5 text-[10.5px] text-low">
        <span>
          {t('ciPipelines.marketplace.footerCount', {
            defaultValue: 'Curated set · live search coming soon',
          })}
        </span>
      </div>
    </div>
  );
}
