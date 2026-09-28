// SHELL-SPEC R14-R16: VSCode-style editor groups for the workspace detail.
// Pure operations over the groups model; the ui-preferences store owns the
// per-workspace record and persistence.

export const WORKSPACE_TAB_IDS = [
  'chat',
  'changes',
  'editor',
  'logs',
  'preview',
  'plan',
] as const;

export type WorkspaceTabId = (typeof WORKSPACE_TAB_IDS)[number];

export type WorkspaceTabGroup = {
  tabs: WorkspaceTabId[];
  active: WorkspaceTabId;
};

export type MoveTarget =
  | { type: 'group'; groupIndex: number }
  | { type: 'new-after'; groupIndex: number };

/**
 * Default: chat only — the extra views (changes/logs/preview) start closed
 * and are reopened from the + menu or their shortcuts (decisión Dani 27-jul).
 */
export function defaultTabGroups(): WorkspaceTabGroup[] {
  return [{ tabs: ['chat'], active: 'chat' }];
}

/** Tabs not present in any group (closed — reopenable via the + menu). */
export function closedTabs(groups: WorkspaceTabGroup[]): WorkspaceTabId[] {
  const open = new Set(groups.flatMap((g) => g.tabs));
  return WORKSPACE_TAB_IDS.filter((t) => !open.has(t));
}

/**
 * Drop empty groups, dedupe tabs across groups (first occurrence wins), fix
 * dangling actives. Guarantees chat is open somewhere (R16: chat is
 * uncloseable) and that at least one group exists.
 */
export function normalizeGroups(
  groups: WorkspaceTabGroup[]
): WorkspaceTabGroup[] {
  const seen = new Set<WorkspaceTabId>();
  const cleaned = groups
    .map((g) => {
      const tabs = g.tabs.filter((t) => {
        if (seen.has(t)) return false;
        seen.add(t);
        return true;
      });
      return {
        tabs,
        active: tabs.includes(g.active) ? g.active : tabs[0],
      };
    })
    .filter((g) => g.tabs.length > 0);

  if (!seen.has('chat')) {
    if (cleaned.length === 0) return [{ tabs: ['chat'], active: 'chat' }];
    cleaned[0] = {
      tabs: ['chat', ...cleaned[0].tabs],
      active: cleaned[0].active,
    };
  }
  return cleaned;
}

export function activateTab(
  groups: WorkspaceTabGroup[],
  groupIndex: number,
  tab: WorkspaceTabId
): WorkspaceTabGroup[] {
  return groups.map((g, i) =>
    i === groupIndex && g.tabs.includes(tab) ? { ...g, active: tab } : g
  );
}

/** Close a tab (chat refuses). Empty groups merge away via normalize. */
export function closeTab(
  groups: WorkspaceTabGroup[],
  tab: WorkspaceTabId
): WorkspaceTabGroup[] {
  if (tab === 'chat') return groups;
  return normalizeGroups(
    groups.map((g) => ({ ...g, tabs: g.tabs.filter((t) => t !== tab) }))
  );
}

/**
 * Ensure a tab is open and active: activates it where it lives, or reopens
 * it in the given group (defaults to the last group).
 */
export function openTab(
  groups: WorkspaceTabGroup[],
  tab: WorkspaceTabId,
  groupIndex?: number
): WorkspaceTabGroup[] {
  const holder = groups.findIndex((g) => g.tabs.includes(tab));
  if (holder >= 0) return activateTab(groups, holder, tab);
  const gi = Math.min(groupIndex ?? groups.length - 1, groups.length - 1);
  return normalizeGroups(
    groups.map((g, i) =>
      i === gi ? { tabs: [...g.tabs, tab], active: tab } : g
    )
  );
}

/** VSCode-style toggle used by shortcuts: active → close, else open+activate. */
export function toggleTab(
  groups: WorkspaceTabGroup[],
  tab: WorkspaceTabId
): WorkspaceTabGroup[] {
  const holder = groups.find((g) => g.tabs.includes(tab));
  if (holder && holder.active === tab) return closeTab(groups, tab);
  return openTab(groups, tab);
}

/** Move a tab into another group or into a fresh split after a group. */
export function moveTab(
  groups: WorkspaceTabGroup[],
  tab: WorkspaceTabId,
  target: MoveTarget
): WorkspaceTabGroup[] {
  const without = groups.map((g) => ({
    ...g,
    tabs: g.tabs.filter((t) => t !== tab),
  }));

  if (target.type === 'group') {
    const result = without.map((g, i) =>
      i === target.groupIndex ? { tabs: [...g.tabs, tab], active: tab } : g
    );
    return normalizeGroups(result);
  }

  const result = [...without];
  result.splice(target.groupIndex + 1, 0, { tabs: [tab], active: tab });
  return normalizeGroups(result);
}

/** Split-right button: move the group's active tab into a new group. */
export function splitActiveTab(
  groups: WorkspaceTabGroup[],
  groupIndex: number
): WorkspaceTabGroup[] {
  const group = groups[groupIndex];
  if (!group || group.tabs.length < 2) return groups;
  return moveTab(groups, group.active, {
    type: 'new-after',
    groupIndex,
  });
}

export function isWorkspaceTabId(value: string): value is WorkspaceTabId {
  return (WORKSPACE_TAB_IDS as readonly string[]).includes(value);
}
