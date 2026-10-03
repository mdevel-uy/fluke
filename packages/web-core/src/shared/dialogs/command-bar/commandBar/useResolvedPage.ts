import { useMemo } from 'react';
import {
  StackIcon,
  SlidersIcon,
  SquaresFourIcon,
  GitBranchIcon,
  KanbanIcon,
  LightningIcon,
  HashIcon,
} from '@phosphor-icons/react';
import type { Workspace } from 'shared/types';
import { Pages } from '@/shared/command-bar/actions/pages';
import type {
  PageId,
  StaticPageId,
  CommandBarGroupItem,
  ResolvedGroup,
  ResolvedGroupItem,
} from '@/shared/types/commandBar';
import {
  ActionTargetType,
  isActionVisible,
  type ActionVisibilityContext,
  type GlobalActionDefinition,
} from '@/shared/types/actions';
import { isPageVisible } from '@/shared/command-bar/actions/useActionVisibility';
import { injectSearchMatches } from './injectSearchMatches';

export interface ResolvedCommandBarPage {
  id: string;
  title?: string;
  groups: ResolvedGroup[];
}

const PAGE_ICONS = {
  root: SquaresFourIcon,
  workspaceActions: StackIcon,
  diffOptions: SlidersIcon,
  viewOptions: SquaresFourIcon,
  repoActions: GitBranchIcon,
  issueActions: KanbanIcon,
  sprintActions: LightningIcon,
  goToPage: SquaresFourIcon,
} as const satisfies Record<StaticPageId, typeof StackIcon>;

function expandGroupItems(
  items: CommandBarGroupItem[],
  ctx: ActionVisibilityContext
): ResolvedGroupItem[] {
  return items.flatMap((item) => {
    if (item.type === 'childPages') {
      const page = Pages[item.id as StaticPageId];
      if (!isPageVisible(page, ctx)) return [];
      return [
        {
          type: 'page' as const,
          pageId: item.id,
          label: page.title ?? item.id,
          icon: PAGE_ICONS[item.id as StaticPageId],
        },
      ];
    }
    if (item.type === 'action') {
      if (!isActionVisible(item.action, ctx)) return [];
    }
    return [item];
  });
}

function buildPageGroups(
  pageId: StaticPageId,
  ctx: ActionVisibilityContext
): ResolvedGroup[] {
  return Pages[pageId].items
    .map((group) => {
      const items = expandGroupItems(group.items, ctx);
      return items.length ? { label: group.label, items } : null;
    })
    .filter((g): g is ResolvedGroup => g !== null);
}

// Typing an issue number ("657" or "#657") offers to open that issue (#667).
function issueJumpAction(search: string): ResolvedGroupItem | null {
  const match = /^#?(\d+)$/.exec(search.trim());
  if (!match) return null;
  const issueNumber = Number(match[1]);
  const action: GlobalActionDefinition = {
    id: `go-to-issue-${issueNumber}`,
    label: `Issue #${issueNumber}`,
    icon: HashIcon,
    requiresTarget: ActionTargetType.NONE,
    execute: (ctx) => {
      ctx.appNavigation.goToIssue(issueNumber);
    },
  };
  return { type: 'action', action };
}

export function useResolvedPage(
  pageId: PageId,
  search: string,
  ctx: ActionVisibilityContext,
  workspace: Workspace | undefined
): ResolvedCommandBarPage {
  return useMemo(() => {
    const groups = buildPageGroups(pageId, ctx);
    if (pageId === 'root' && search.trim()) {
      const issue = issueJumpAction(search);
      if (issue) groups.unshift({ label: 'Issues', items: [issue] });
      groups.push(...injectSearchMatches(search, ctx, workspace));
    }

    return {
      id: Pages[pageId].id,
      title: Pages[pageId].title,
      groups,
    };
  }, [pageId, search, ctx, workspace]);
}
