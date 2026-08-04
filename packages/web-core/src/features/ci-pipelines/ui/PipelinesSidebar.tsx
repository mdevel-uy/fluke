import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Clock,
  Code2,
  FileCode2,
  GitPullRequest,
  Package,
  Play,
  Plus,
  Search,
  TerminalSquare,
  Workflow,
  Zap,
} from 'lucide-react';
import type { Repo } from 'shared/types';
import { cn } from '@/shared/lib/utils';
import { repoLabel } from '@/shared/hooks/useRepos';
import { CATALOG, type CatalogItem } from '../model/catalog';
import type { TriggerKind } from '../model/graph';
import type { WorkflowFileEntry } from '../model/workflowFiles';
import { MarketplacePopover } from './MarketplacePopover';

const TRIGGER_ICONS: Record<TriggerKind, typeof Zap> = {
  push: Zap,
  pull_request: GitPullRequest,
  schedule: Clock,
  workflow_dispatch: Play,
};

interface PipelinesSidebarProps {
  repos: Repo[];
  selectedRepoId: string | null;
  onSelectRepo: (repoId: string) => void;
  workflows: WorkflowFileEntry[];
  isLoadingWorkflows: boolean;
  activeWorkflowName: string | null;
  onOpenWorkflow: (entry: WorkflowFileEntry) => void;
  onNewWorkflow: () => void;
  /** Palette insert — the page places the node at a cascade position. */
  onInsertItem: (item: CatalogItem) => void;
  onInsertMarketplace: (uses: string) => void;
  /** Palette is disabled until a workflow is open. */
  canInsert: boolean;
}

/**
 * Shell sidebar for the CI Pipelines section: workflow list on top, node
 * palette below (SHELL-SPEC R9 — the page portals this in). The palette
 * lists only the bounded catalog; the marketplace is a search popover.
 */
export function PipelinesSidebar({
  repos,
  selectedRepoId,
  onSelectRepo,
  workflows,
  isLoadingWorkflows,
  activeWorkflowName,
  onOpenWorkflow,
  onNewWorkflow,
  onInsertItem,
  onInsertMarketplace,
  canInsert,
}: PipelinesSidebarProps) {
  const { t } = useTranslation('common');
  const [marketplaceAt, setMarketplaceAt] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const marketplaceButtonRef = useRef<HTMLButtonElement>(null);

  const sectionClass =
    'px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-low';

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

  const paletteSections: Array<{ heading: string; items: CatalogItem[] }> = [
    {
      heading: t('ciPipelines.palette.triggers', { defaultValue: 'Triggers' }),
      items: CATALOG.filter((i) => i.kind === 'trigger'),
    },
    {
      heading: t('ciPipelines.palette.jobs', { defaultValue: 'Jobs' }),
      items: CATALOG.filter((i) => i.kind === 'script'),
    },
    {
      heading: t('ciPipelines.palette.prefabs', { defaultValue: 'Prefabs' }),
      items: CATALOG.filter((i) => i.kind === 'prefab'),
    },
    {
      heading: t('ciPipelines.palette.escapeHatch', {
        defaultValue: 'Escape hatch',
      }),
      items: CATALOG.filter((i) => i.kind === 'raw'),
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-md-surface-container-low">
      {/* Repo selector */}
      <div className="border-b border-md-outline-variant p-2">
        <select
          value={selectedRepoId ?? ''}
          onChange={(e) => onSelectRepo(e.target.value)}
          className="w-full cursor-pointer rounded-md border border-md-outline-variant bg-panel px-2 py-1.5 text-xs text-high outline-none"
        >
          {repos.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repoLabel(repo)}
            </option>
          ))}
        </select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {/* Workflows */}
        <div className="flex items-center justify-between pr-2">
          <div className={sectionClass}>
            {t('ciPipelines.sidebar.workflows', {
              defaultValue: 'Workflows',
            })}
          </div>
          <button
            type="button"
            onClick={onNewWorkflow}
            className="flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-brand hover:bg-secondary"
          >
            <Plus className="h-3 w-3" strokeWidth={2} />
            {t('ciPipelines.sidebar.newWorkflow', { defaultValue: 'New' })}
          </button>
        </div>
        {isLoadingWorkflows ? (
          <div className="px-3 py-1 text-[11px] text-low">
            {t('ciPipelines.sidebar.loading', { defaultValue: 'Loading…' })}
          </div>
        ) : workflows.length === 0 ? (
          <div className="px-3 py-1 text-[11px] leading-relaxed text-low">
            {t('ciPipelines.sidebar.noWorkflows', {
              defaultValue: 'No workflows yet — create one to get started.',
            })}
          </div>
        ) : (
          workflows.map((entry) => (
            <button
              key={entry.ymlPath}
              type="button"
              onClick={() => onOpenWorkflow(entry)}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs',
                entry.name === activeWorkflowName
                  ? 'bg-secondary text-high'
                  : 'text-normal hover:bg-secondary/60'
              )}
            >
              {entry.hasSidecar ? (
                <Workflow
                  className="h-3.5 w-3.5 flex-none text-brand"
                  strokeWidth={1.75}
                />
              ) : (
                <FileCode2
                  className="h-3.5 w-3.5 flex-none text-low"
                  strokeWidth={1.75}
                />
              )}
              <span className="truncate">{entry.name}</span>
              {!entry.hasSidecar && (
                <span className="ml-auto flex-none rounded border border-md-outline-variant px-1 text-[9px] text-low">
                  {t('ciPipelines.sidebar.importedTag', {
                    defaultValue: 'yaml',
                  })}
                </span>
              )}
            </button>
          ))
        )}

        {/* Palette */}
        <div
          className={cn(
            'mt-2 border-t border-md-outline-variant',
            !canInsert && 'pointer-events-none opacity-40'
          )}
        >
          {paletteSections.map((section) => (
            <div key={section.heading}>
              <div className={sectionClass}>{section.heading}</div>
              {section.items.map((item) => (
                <button
                  key={`${item.kind}-${item.name}`}
                  type="button"
                  onClick={() => onInsertItem(item)}
                  className="mx-2 flex w-[calc(100%-16px)] cursor-pointer items-center gap-2 rounded-[7px] border border-md-outline-variant bg-panel px-2 py-1.5 text-left shadow-sm hover:border-md-outline mb-1"
                >
                  <span
                    className={cn(
                      'flex h-5 w-5 flex-none items-center justify-center rounded-[5px]',
                      toneClass(item)
                    )}
                  >
                    {itemIcon(item)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-high">
                      {item.name}
                    </span>
                    <span className="block truncate text-[10px] text-low">
                      {item.subtitle}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ))}

          <div className={sectionClass}>
            {t('ciPipelines.palette.community', {
              defaultValue: 'Community · Marketplace',
            })}
          </div>
          <button
            ref={marketplaceButtonRef}
            type="button"
            onClick={() => {
              const rect =
                marketplaceButtonRef.current?.getBoundingClientRect();
              setMarketplaceAt({
                x: (rect?.right ?? 240) + 10,
                y: (rect?.top ?? 200) - 8,
              });
            }}
            className="mx-2 flex w-[calc(100%-16px)] cursor-pointer items-center gap-2 rounded-[7px] border border-md-outline-variant bg-panel px-2 py-1.5 text-left shadow-sm hover:border-md-outline"
          >
            <span className="flex h-5 w-5 flex-none items-center justify-center rounded-[5px] bg-success/15 text-success">
              <Search className="h-3 w-3" strokeWidth={1.75} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium text-high">
                {t('ciPipelines.palette.searchMarketplace', {
                  defaultValue: 'Search marketplace…',
                })}
              </span>
              <span className="block truncate text-[10px] text-low">
                {t('ciPipelines.palette.marketplaceHint', {
                  defaultValue: '20k+ community actions',
                })}
              </span>
            </span>
          </button>
        </div>
      </div>

      {marketplaceAt && (
        <MarketplacePopover
          x={marketplaceAt.x}
          y={marketplaceAt.y}
          onPick={(uses) => {
            onInsertMarketplace(uses);
            setMarketplaceAt(null);
          }}
          onClose={() => setMarketplaceAt(null)}
        />
      )}
    </div>
  );
}
