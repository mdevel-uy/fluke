import { Actions } from '@/shared/actions';
import type { ActionDefinition } from '@/shared/types/actions';
import type { StaticPageId, CommandBarPage } from '@/shared/types/commandBar';

export const Pages: Record<StaticPageId, CommandBarPage> = {
  // Root page - shown when opening via CMD+K
  root: {
    id: 'root',
    items: [
      {
        type: 'group',
        label: 'Actions',
        items: [
          { type: 'action', action: Actions.SearchInFiles },
          { type: 'action', action: Actions.CreateWorkspaceFromPR },
          { type: 'action', action: Actions.CreateWorker },
          { type: 'action', action: Actions.OpenInIDE },
          { type: 'action', action: Actions.CopyWorkspacePath },
          { type: 'action', action: Actions.CopyRawLogs },
          { type: 'action', action: Actions.ToggleDevServer },

          { type: 'childPages', id: 'workspaceActions' },
          { type: 'childPages', id: 'repoActions' },
          { type: 'childPages', id: 'issueActions' },
          { type: 'childPages', id: 'sprintActions' },
        ],
      },
      {
        type: 'group',
        label: 'View',
        items: [
          { type: 'childPages', id: 'viewOptions' },
          { type: 'childPages', id: 'diffOptions' },
        ],
      },
      {
        type: 'group',
        label: 'Navigate',
        items: [
          { type: 'action', action: Actions.GoToWorkspaces },
          { type: 'action', action: Actions.GoToSourceControl },
          { type: 'action', action: Actions.GoToSprint },
          { type: 'action', action: Actions.GoToIssues },
          { type: 'action', action: Actions.GoToDashboard },
          { type: 'action', action: Actions.GoToPilotReport },
          { type: 'action', action: Actions.GoToWorkers },
        ],
      },
      {
        type: 'group',
        label: 'General',
        items: [
          { type: 'action', action: Actions.Feedback },
          { type: 'action', action: Actions.WorkspacesGuide },
          { type: 'action', action: Actions.ProjectsGuide },
          { type: 'action', action: Actions.ProjectSettings },
          { type: 'action', action: Actions.Settings },
        ],
      },
    ],
  },

  // Workspace actions page - shown when clicking three-dots on a workspace
  workspaceActions: {
    id: 'workspace-actions',
    title: 'Workspace Actions',
    parent: 'root',
    isVisible: (ctx) => ctx.hasWorkspace,
    items: [
      {
        type: 'group',
        label: 'Workspace',
        items: [
          { type: 'action', action: Actions.StartReview },
          { type: 'action', action: Actions.RenameWorkspace },
          { type: 'action', action: Actions.PinWorkspace },
          { type: 'action', action: Actions.ArchiveWorkspace },
          { type: 'action', action: Actions.DeleteWorkspace },
        ],
      },
      {
        type: 'group',
        label: 'Scripts',
        items: [
          { type: 'action', action: Actions.RunSetupScript },
          { type: 'action', action: Actions.RunCleanupScript },
          { type: 'action', action: Actions.RunArchiveScript },
        ],
      },
    ],
  },

  // Diff options page - shown when changes panel is visible
  diffOptions: {
    id: 'diff-options',
    title: 'Diff Options',
    parent: 'root',
    isVisible: (ctx) => ctx.activeViewTabs.includes('changes'),
    items: [
      {
        type: 'group',
        label: 'Display',
        items: [
          { type: 'action', action: Actions.ToggleDiffViewMode },
          { type: 'action', action: Actions.ToggleWrapLines },
          { type: 'action', action: Actions.ToggleIgnoreWhitespace },
          { type: 'action', action: Actions.ToggleAllDiffs },
        ],
      },
    ],
  },

  // View options page - layout panel controls
  viewOptions: {
    id: 'view-options',
    title: 'View Options',
    parent: 'root',
    isVisible: (ctx) => ctx.layoutMode === 'workspaces',
    items: [
      {
        type: 'group',
        label: 'Panels',
        items: [
          { type: 'action', action: Actions.ToggleLeftSidebar },
          { type: 'action', action: Actions.ToggleLeftMainPanel },
          { type: 'action', action: Actions.ToggleRightSidebar },
          { type: 'action', action: Actions.ToggleChangesMode },
          { type: 'action', action: Actions.ToggleEditorMode },
          { type: 'action', action: Actions.ToggleLogsMode },
          { type: 'action', action: Actions.TogglePreviewMode },
          { type: 'action', action: Actions.ToggleTerminal },
        ],
      },
    ],
  },

  // Repository actions page - shown when clicking "..." on a repo card or via CMD+K
  repoActions: {
    id: 'repo-actions',
    title: 'Repository Actions',
    parent: 'root',
    isVisible: (ctx) => ctx.hasWorkspace && ctx.hasGitRepos,
    items: [
      {
        type: 'group',
        label: 'Actions',
        items: [
          { type: 'action', action: Actions.RepoCopyPath },
          { type: 'action', action: Actions.RepoOpenInIDE },
          { type: 'action', action: Actions.RepoSettings },
          { type: 'action', action: Actions.GitCreatePR },
          { type: 'action', action: Actions.GitLinkPR },
          { type: 'action', action: Actions.GitMerge },
          { type: 'action', action: Actions.GitPush },
          { type: 'action', action: Actions.GitRebase },
          { type: 'action', action: Actions.GitChangeTarget },
        ],
      },
    ],
  },

  // Quick Open page - VSCode-style "Go to Page" navigator (CMD+P)
  goToPage: {
    id: 'go-to-page',
    title: 'Go to Page',
    items: [
      {
        type: 'group',
        label: 'Pages',
        items: [
          { type: 'action', action: Actions.GoToWorkspaces },
          { type: 'action', action: Actions.GoToSourceControl },
          { type: 'action', action: Actions.GoToSprint },
          { type: 'action', action: Actions.GoToIssues },
          { type: 'action', action: Actions.GoToDashboard },
          { type: 'action', action: Actions.GoToPilotReport },
          { type: 'action', action: Actions.GoToWorkers },
        ],
      },
    ],
  },

  // Sprint actions page - shown only in the Sprint view
  sprintActions: {
    id: 'sprint-actions',
    title: 'Sprint Actions',
    parent: 'root',
    isVisible: (ctx) => ctx.currentView === 'sprint',
    items: [
      {
        type: 'group',
        label: 'Actions',
        items: [{ type: 'action', action: Actions.SyncSprint }],
      },
    ],
  },

  // Issue actions page - shown in kanban mode
  issueActions: {
    id: 'issue-actions',
    title: 'Issue Actions',
    parent: 'root',
    isVisible: (ctx) => ctx.layoutMode === 'kanban',
    items: [
      {
        type: 'group',
        label: 'Actions',
        items: [
          { type: 'action', action: Actions.CreateIssue },
          { type: 'action', action: Actions.ChangeIssueStatus },
          { type: 'action', action: Actions.ChangeNewIssueStatus },
          { type: 'action', action: Actions.ChangePriority },
          { type: 'action', action: Actions.ChangeNewIssuePriority },
          { type: 'action', action: Actions.ChangeAssignees },
          { type: 'action', action: Actions.ChangeNewIssueAssignees },
          { type: 'action', action: Actions.MakeSubIssueOf },
          { type: 'action', action: Actions.AddSubIssue },
          { type: 'action', action: Actions.RemoveParentIssue },
          { type: 'action', action: Actions.LinkWorkspace },
          { type: 'action', action: Actions.MarkBlocking },
          { type: 'action', action: Actions.MarkBlockedBy },
          { type: 'action', action: Actions.MarkRelated },
          { type: 'action', action: Actions.MarkDuplicateOf },
          { type: 'action', action: Actions.DuplicateIssue },
          { type: 'action', action: Actions.DeleteIssue },
        ],
      },
    ],
  },
};

// Get all actions from a specific page
export function getPageActions(pageId: StaticPageId): ActionDefinition[] {
  const page = Pages[pageId];
  const actions: ActionDefinition[] = [];

  for (const group of page.items) {
    for (const item of group.items) {
      if (item.type === 'action') {
        actions.push(item.action);
      }
    }
  }

  return actions;
}
