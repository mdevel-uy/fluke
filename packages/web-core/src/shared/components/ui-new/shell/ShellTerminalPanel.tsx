import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GitBranch, Plus, Terminal, X } from 'lucide-react';
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

  // VSCode behavior: closing the last session closes the panel too, instead
  // of leaving an empty panel behind. (closeTab dispatches async — check the
  // current tab count, not the store after dispatch.)
  const handleCloseTab = useCallback(
    (tabWorkspaceId: string, tabId: string) => {
      closeTab(tabWorkspaceId, tabId);
      if (tabs.length <= 1) setTerminalVisible(false);
    },
    [closeTab, tabs.length, setTerminalVisible]
  );

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

  // Why the panel is empty: no workspace selected, or the selected workspace
  // has no worktree on disk yet (branches only materialize on create()).
  // null while canCreate — the auto-open effect fills the panel right away.
  const emptyReason: 'no-workspace' | 'no-worktree' | null = !workspaceId
    ? 'no-workspace'
    : !containerRef
      ? 'no-worktree'
      : null;

  // Single-line fallback when the bottom panel is resized too short for the
  // centered empty state.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [isCompact, setIsCompact] = useState(false);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setIsCompact(entry.contentRect.height < 120);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const newTerminalTooltip = canCreate
    ? t('shellTerminal.new', { defaultValue: 'New terminal' })
    : emptyReason === 'no-worktree'
      ? t('shellTerminal.empty.noWorktree.title', {
          defaultValue: 'This workspace has no worktree yet',
        })
      : t('shellTerminal.newDisabled', {
          defaultValue: 'Select a workspace to open a terminal',
        });

  return (
    <div className="flex h-full min-h-0 flex-col border-t bg-primary">
      <div className="flex h-8 flex-none items-stretch bg-md-surface-container-low">
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
                  handleCloseTab(tab.workspaceId, tab.id);
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
          <Tooltip content={newTerminalTooltip} side="top">
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

      <div ref={bodyRef} className="min-h-0 flex-1 border-t">
        {tabs.length === 0 ? (
          emptyReason === null ? null : isCompact ? (
            <div
              role="status"
              className="flex h-full items-center gap-2.5 px-4 text-xs text-low"
            >
              <Terminal size={14} strokeWidth={1.75} className="flex-none" />
              <span>
                <span className="font-medium text-normal">
                  {emptyReason === 'no-workspace'
                    ? t('shellTerminal.empty.noWorkspace.title', {
                        defaultValue: 'No workspace selected',
                      })
                    : t('shellTerminal.empty.noWorktree.titleShort', {
                        defaultValue: 'No worktree yet',
                      })}
                </span>
                {' — '}
                {emptyReason === 'no-workspace'
                  ? t('shellTerminal.empty.noWorkspace.descShort', {
                      defaultValue:
                        'pick one in the sidebar to open a terminal.',
                    })
                  : t('shellTerminal.empty.noWorktree.descShort', {
                      defaultValue:
                        "start the workspace's first session to open a terminal.",
                    })}
              </span>
            </div>
          ) : (
            <div
              role="status"
              className="flex h-full items-center justify-center p-6"
            >
              <div className="flex max-w-md flex-col items-center gap-1.5 text-center">
                {emptyReason === 'no-workspace' ? (
                  <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg border border-dashed border-border text-low">
                    <Terminal size={18} strokeWidth={1.75} />
                  </div>
                ) : (
                  <span className="mb-1 inline-flex items-center gap-1.5 rounded-full border border-border bg-md-surface-container-low px-2.5 py-0.5 font-mono text-[11px] text-normal">
                    <GitBranch
                      size={11}
                      strokeWidth={2}
                      className="text-low"
                    />
                    {workspace?.branch}
                  </span>
                )}
                <p className="text-[13px] font-semibold text-normal">
                  {emptyReason === 'no-workspace'
                    ? t('shellTerminal.empty.noWorkspace.title', {
                        defaultValue: 'No workspace selected',
                      })
                    : t('shellTerminal.empty.noWorktree.title', {
                        defaultValue: 'This workspace has no worktree yet',
                      })}
                </p>
                <p className="text-xs leading-relaxed text-low">
                  {emptyReason === 'no-workspace'
                    ? t('shellTerminal.empty.noWorkspace.desc', {
                        defaultValue:
                          "Terminals open inside a workspace's worktree. Pick a workspace in the sidebar and one will open here automatically.",
                      })
                    : t('shellTerminal.empty.noWorktree.desc', {
                        defaultValue:
                          "The branch hasn't been checked out on disk, so there's nowhere to open a shell. Start the workspace's first session and the terminal will connect here.",
                      })}
                </p>
                {emptyReason === 'no-workspace' && (
                  <span className="mt-2 inline-flex items-center gap-1.5 text-xs text-low">
                    <span className="font-semibold text-brand-on-surface">
                      ←
                    </span>
                    {t('shellTerminal.empty.noWorkspace.hint', {
                      defaultValue: 'Workspaces live in the left sidebar',
                    })}
                  </span>
                )}
              </div>
            </div>
          )
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
                onClose={() => handleCloseTab(tab.workspaceId, tab.id)}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
