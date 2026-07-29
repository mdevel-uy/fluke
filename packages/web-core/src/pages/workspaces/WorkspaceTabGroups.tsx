import { useCallback, useState, type ReactNode, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MessageSquare,
  FileDiff,
  FileCode,
  ScrollText,
  Globe,
  X,
  Plus,
  Columns2,
  type LucideIcon,
} from 'lucide-react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibe/ui/components/DropdownMenu';
import { Tooltip } from '@vibe/ui/components/Tooltip';
import { cn } from '@/shared/lib/utils';
import {
  activateTab,
  closedTabs,
  closeTab,
  moveTab,
  splitActiveTab,
  isWorkspaceTabId,
  type WorkspaceTabGroup,
  type WorkspaceTabId,
} from '@/shared/lib/workspaceTabGroups';

const DRAG_MIME = 'application/x-vk-workspace-tab';

const TAB_ICONS: Record<WorkspaceTabId, LucideIcon> = {
  chat: MessageSquare,
  changes: FileDiff,
  editor: FileCode,
  logs: ScrollText,
  preview: Globe,
};

// The split sash overlaps the previous group's right border (-ml-1, zero net
// width) so groups touch with a 1px divider and no white gutter, VSCode-style.
const SEPARATOR_CLASS =
  'relative z-20 w-1 -ml-1 bg-transparent hover:bg-brand/50 transition-colors cursor-col-resize';

interface WorkspaceTabGroupsProps {
  groups: WorkspaceTabGroup[];
  onGroupsChange: (groups: WorkspaceTabGroup[]) => void;
  /** Content per tab; a tab with null content renders an empty pane. */
  contents: Record<WorkspaceTabId, ReactNode>;
}

/**
 * VSCode-style editor groups for the workspace detail (SHELL-SPEC R14-R16):
 * drag a tab onto another bar to merge, onto a pane's right edge to split,
 * ✕ to close (chat is uncloseable), + menu to reopen closed views. Open
 * tabs stay mounted (hidden, not unmounted) so chat/websocket state
 * survives tab switches.
 */
export function WorkspaceTabGroups({
  groups,
  onGroupsChange,
  contents,
}: WorkspaceTabGroupsProps) {
  const { t } = useTranslation('common');
  const [dragTab, setDragTab] = useState<WorkspaceTabId | null>(null);
  const [dropHint, setDropHint] = useState<
    { kind: 'bar'; gi: number } | { kind: 'split'; gi: number } | null
  >(null);

  const tabLabel = useCallback(
    (tab: WorkspaceTabId): string =>
      ({
        chat: t('workspaces.tabs.chat', { defaultValue: 'Chat' }),
        changes: t('workspaces.tabs.changes', { defaultValue: 'Changes' }),
        editor: t('workspaces.tabs.editor', { defaultValue: 'Editor' }),
        logs: t('workspaces.tabs.logs', { defaultValue: 'Logs' }),
        preview: t('workspaces.tabs.preview', { defaultValue: 'Preview' }),
      })[tab],
    [t]
  );

  const clearDnd = useCallback(() => {
    setDragTab(null);
    setDropHint(null);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent, gi: number, kind: 'bar' | 'split') => {
      e.preventDefault();
      const raw = e.dataTransfer.getData(DRAG_MIME);
      if (isWorkspaceTabId(raw)) {
        onGroupsChange(
          moveTab(
            groups,
            raw,
            kind === 'bar'
              ? { type: 'group', groupIndex: gi }
              : { type: 'new-after', groupIndex: gi }
          )
        );
      }
      clearDnd();
    },
    [groups, onGroupsChange, clearDnd]
  );

  const closed = closedTabs(groups);

  return (
    <Group orientation="horizontal" className="flex-1 min-w-0 h-full">
      {groups.map((group, gi) => (
        <TabGroupPane
          key={`group-${gi}`}
          panelId={`tab-group-${gi}`}
          group={group}
          gi={gi}
          isLast={gi === groups.length - 1}
          closed={closed}
          dragTab={dragTab}
          dropHint={dropHint}
          tabLabel={tabLabel}
          contents={contents}
          onActivate={(tab) => onGroupsChange(activateTab(groups, gi, tab))}
          onClose={(tab) => onGroupsChange(closeTab(groups, tab))}
          onReopen={(tab) =>
            onGroupsChange(
              moveTab(groups, tab, { type: 'group', groupIndex: gi })
            )
          }
          onSplit={() => onGroupsChange(splitActiveTab(groups, gi))}
          onDragStartTab={(tab) => setDragTab(tab)}
          onDragEnd={clearDnd}
          onHint={(hint) => setDropHint(hint)}
          onDrop={handleDrop}
        />
      ))}
    </Group>
  );
}

function TabGroupPane({
  panelId,
  group,
  gi,
  isLast,
  closed,
  dragTab,
  dropHint,
  tabLabel,
  contents,
  onActivate,
  onClose,
  onReopen,
  onSplit,
  onDragStartTab,
  onDragEnd,
  onHint,
  onDrop,
}: {
  panelId: string;
  group: WorkspaceTabGroup;
  gi: number;
  isLast: boolean;
  closed: WorkspaceTabId[];
  dragTab: WorkspaceTabId | null;
  dropHint: { kind: 'bar' | 'split'; gi: number } | null;
  tabLabel: (tab: WorkspaceTabId) => string;
  contents: Record<WorkspaceTabId, ReactNode>;
  onActivate: (tab: WorkspaceTabId) => void;
  onClose: (tab: WorkspaceTabId) => void;
  onReopen: (tab: WorkspaceTabId) => void;
  onSplit: () => void;
  onDragStartTab: (tab: WorkspaceTabId) => void;
  onDragEnd: () => void;
  onHint: (
    hint: { kind: 'bar' | 'split'; gi: number } | null
  ) => void;
  onDrop: (e: DragEvent, gi: number, kind: 'bar' | 'split') => void;
}) {
  const { t } = useTranslation('common');
  const barHighlight = dropHint?.kind === 'bar' && dropHint.gi === gi;
  const splitHighlight = dropHint?.kind === 'split' && dropHint.gi === gi;

  return (
    <>
      <Panel
        id={panelId}
        minSize="220px"
        className={cn(
          'relative min-w-0 h-full overflow-hidden flex flex-col bg-md-surface-container-lowest',
          !isLast && 'border-r border-md-outline-variant'
        )}
      >
        {/* Tab bar */}
        <div
          className={cn(
            'flex h-8 flex-none items-stretch border-b border-md-outline-variant bg-md-surface-container-low',
            barHighlight && 'bg-sel'
          )}
          onDragOver={(e) => {
            if (!dragTab) return;
            e.preventDefault();
            onHint({ kind: 'bar', gi });
          }}
          onDrop={(e) => onDrop(e, gi, 'bar')}
        >
          {group.tabs.map((tab) => {
            const Icon = TAB_ICONS[tab];
            const isActive = tab === group.active;
            return (
              <div
                key={tab}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_MIME, tab);
                  e.dataTransfer.effectAllowed = 'move';
                  onDragStartTab(tab);
                }}
                onDragEnd={onDragEnd}
                className={cn(
                  'group/tab relative flex cursor-grab items-center gap-1.5 border-r border-md-outline-variant px-3 text-xs',
                  isActive
                    ? 'bg-md-surface-container-lowest text-high after:absolute after:inset-x-0 after:top-0 after:h-px after:bg-brand-on-surface'
                    : 'text-low hover:text-normal'
                )}
              >
                <button
                  type="button"
                  onClick={() => onActivate(tab)}
                  className="flex items-center gap-1.5 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand cursor-pointer"
                >
                  <Icon size={13} strokeWidth={1.75} aria-hidden />
                  {tabLabel(tab)}
                </button>
                {tab !== 'chat' && (
                  <button
                    type="button"
                    onClick={() => onClose(tab)}
                    aria-label={t('workspaces.tabs.close', {
                      defaultValue: 'Close',
                    })}
                    className={cn(
                      'flex h-4 w-4 items-center justify-center rounded-sm text-low hover:bg-md-surface-container-high hover:text-high cursor-pointer -mr-1',
                      isActive
                        ? 'visible'
                        : 'invisible group-hover/tab:visible'
                    )}
                  >
                    <X size={11} strokeWidth={2} />
                  </button>
                )}
              </div>
            );
          })}
          <div className="ml-auto flex items-center gap-0.5 pr-1">
            {closed.length > 0 && (
              <DropdownMenu>
                <Tooltip
                  content={t('workspaces.tabs.reopen', {
                    defaultValue: 'Reopen view…',
                  })}
                >
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('workspaces.tabs.reopen', {
                        defaultValue: 'Reopen view…',
                      })}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-low hover:bg-secondary hover:text-high cursor-pointer"
                    >
                      <Plus size={14} strokeWidth={1.75} />
                    </button>
                  </DropdownMenuTrigger>
                </Tooltip>
                <DropdownMenuContent align="end">
                  {closed.map((tab) => (
                    <DropdownMenuItem key={tab} onClick={() => onReopen(tab)}>
                      {tabLabel(tab)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {group.tabs.length > 1 && (
              <Tooltip
                content={t('workspaces.tabs.split', {
                  defaultValue: 'Split right',
                })}
              >
                <button
                  type="button"
                  onClick={onSplit}
                  aria-label={t('workspaces.tabs.split', {
                    defaultValue: 'Split right',
                  })}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-low hover:bg-secondary hover:text-high cursor-pointer"
                >
                  <Columns2 size={14} strokeWidth={1.75} />
                </button>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Body: keep every open tab mounted; hide the inactive ones. */}
        <div
          className="relative min-h-0 flex-1"
          onDragOver={(e) => {
            if (!dragTab) return;
            const rect = e.currentTarget.getBoundingClientRect();
            if (e.clientX > rect.left + rect.width * 0.6) {
              e.preventDefault();
              onHint({ kind: 'split', gi });
            } else {
              onHint(null);
            }
          }}
          onDrop={(e) => {
            if (splitHighlight) onDrop(e, gi, 'split');
          }}
        >
          {group.tabs.map((tab) => (
            <div
              key={tab}
              className={cn(
                'absolute inset-0 min-h-0 overflow-hidden',
                tab !== group.active && 'hidden'
              )}
            >
              {contents[tab]}
            </div>
          ))}
          {splitHighlight && (
            <div
              className="pointer-events-none absolute inset-y-0 right-0 z-10 w-[40%] border-l-2 border-brand-on-surface bg-brand/10"
              aria-hidden
            />
          )}
        </div>
      </Panel>
      {!isLast && (
        <Separator id={`tab-group-sep-${gi}`} className={SEPARATOR_CLASS} />
      )}
    </>
  );
}
