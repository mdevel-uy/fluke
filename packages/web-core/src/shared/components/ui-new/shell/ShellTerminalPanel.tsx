import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Terminal, X } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { useTerminal } from '@/shared/hooks/useTerminal';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { XTermInstance } from '@/shared/components/XTermInstance';
import { Tooltip } from '@vibe/ui/components/Tooltip';

// SHELL-SPEC R29-R30: global terminal panel living in the shell's main
// column. Tabs are cross-workspace ({branch} labels, per the mock) and
// survive navigation; sessions are only closed explicitly.

export function ShellTerminalPanel() {
  const { t } = useTranslation('common');
  const { workspace, activeWorkspaces, archivedWorkspaces } =
    useWorkspaceContext();
  const { getAllTabs, createTab, closeTab } = useTerminal();
  const setTerminalVisible = useUiPreferencesStore((s) => s.setTerminalVisible);

  const tabs = getAllTabs();

  const branchByWorkspaceId = useMemo(() => {
    const map = new Map<string, string>();
    for (const ws of [...activeWorkspaces, ...archivedWorkspaces]) {
      if (ws.branch) map.set(ws.id, ws.branch);
    }
    return map;
  }, [activeWorkspaces, archivedWorkspaces]);

  // Tab labels: `{branch}` (mock format), numbered when a workspace has
  // more than one terminal.
  const labeledTabs = useMemo(() => {
    const perWorkspaceCount = new Map<string, number>();
    return tabs.map((tab) => {
      const n = (perWorkspaceCount.get(tab.workspaceId) ?? 0) + 1;
      perWorkspaceCount.set(tab.workspaceId, n);
      const base = branchByWorkspaceId.get(tab.workspaceId) ?? tab.title;
      const siblings = tabs.filter(
        (other) => other.workspaceId === tab.workspaceId
      ).length;
      return { ...tab, label: siblings > 1 ? `${base} · ${n}` : base };
    });
  }, [tabs, branchByWorkspaceId]);

  // Global active tab: newest tab wins; repair when the active one closes.
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const prevIdsRef = useRef<string[]>([]);
  useEffect(() => {
    const ids = tabs.map((tab) => tab.id);
    const added = ids.filter((id) => !prevIdsRef.current.includes(id));
    prevIdsRef.current = ids;
    setActiveTabId((current) => {
      if (added.length > 0) return added[added.length - 1];
      if (current && ids.includes(current)) return current;
      return ids[ids.length - 1] ?? null;
    });
  }, [tabs]);

  // First open with a selected workspace and no sessions yet → start one.
  const creatingRef = useRef(false);
  const workspaceId = workspace?.id;
  const containerRef = workspace?.container_ref ?? null;
  useEffect(() => {
    if (
      tabs.length === 0 &&
      workspaceId &&
      containerRef &&
      !creatingRef.current
    ) {
      creatingRef.current = true;
      createTab(workspaceId, containerRef);
    }
    if (tabs.length > 0) creatingRef.current = false;
  }, [tabs.length, workspaceId, containerRef, createTab]);

  const canCreate = !!workspaceId && !!containerRef;

  return (
    <div className="flex h-full min-h-0 flex-col border-t bg-primary">
      <div className="flex h-8 flex-none items-stretch bg-secondary">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
          {labeledTabs.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                'group relative flex items-center gap-1.5 border-r border-border px-3 text-xs whitespace-nowrap cursor-pointer',
                tab.id === activeTabId
                  ? 'bg-primary text-high after:absolute after:inset-x-0 after:top-0 after:h-px after:bg-brand-on-surface'
                  : 'text-low hover:text-normal'
              )}
              onClick={() => setActiveTabId(tab.id)}
            >
              <Terminal size={13} strokeWidth={1.75} className="flex-none" />
              <span className="font-mono text-[11px]">{tab.label}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.workspaceId, tab.id);
                }}
                aria-label={t('shellTerminal.closeTab', {
                  defaultValue: 'Close terminal',
                })}
                className={cn(
                  'flex h-4 w-4 flex-none items-center justify-center rounded-sm text-low',
                  'opacity-0 group-hover:opacity-100 hover:bg-panel hover:text-high cursor-pointer',
                  tab.id === activeTabId && 'opacity-100'
                )}
              >
                <X size={11} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
        <div className="flex flex-none items-center gap-0.5 px-1">
          <Tooltip
            content={
              canCreate
                ? t('shellTerminal.new', { defaultValue: 'New terminal' })
                : t('shellTerminal.newDisabled', {
                    defaultValue: 'Select a workspace to open a terminal',
                  })
            }
            side="top"
          >
            <button
              type="button"
              disabled={!canCreate}
              onClick={() =>
                canCreate && createTab(workspaceId, containerRef)
              }
              aria-label={t('shellTerminal.new', {
                defaultValue: 'New terminal',
              })}
              className="flex h-6 w-6 items-center justify-center rounded-sm text-low hover:bg-panel hover:text-high disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              <Plus size={14} strokeWidth={1.75} />
            </button>
          </Tooltip>
          <button
            type="button"
            onClick={() => setTerminalVisible(false)}
            aria-label={t('shellTerminal.closePanel', {
              defaultValue: 'Close panel',
            })}
            title={t('shellTerminal.closePanel', {
              defaultValue: 'Close panel',
            })}
            className="flex h-6 w-6 items-center justify-center rounded-sm text-low hover:bg-panel hover:text-high cursor-pointer"
          >
            <X size={14} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 border-t">
        {tabs.length === 0 ? (
          <div className="px-3.5 py-3 text-sm text-low">
            {t('shellTerminal.empty', {
              defaultValue:
                'No terminal sessions — select a workspace and press + to open one.',
            })}
          </div>
        ) : (
          tabs.map((tab) => (
            <div
              key={tab.id}
              className={cn('h-full', tab.id !== activeTabId && 'hidden')}
            >
              <XTermInstance
                tabId={tab.id}
                workspaceId={tab.workspaceId}
                isActive={tab.id === activeTabId}
                onClose={() => closeTab(tab.workspaceId, tab.id)}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
