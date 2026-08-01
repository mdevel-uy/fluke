import { router } from '@web/app/router';
import type { FileRouteTypes } from '@web/routeTree.gen';
import {
  type AppDestination,
  type AppNavigation,
  type NavigationTransition,
} from '@/shared/lib/routes/appNavigation';

type LocalRouteId = FileRouteTypes['id'];

function getPathParam(
  routeParams: Record<string, string>,
  key: string
): string | null {
  const value = routeParams[key];
  return value ? value : null;
}

function parseLocalHostIdFromPathname(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean);
  const hostsIndex = segments.indexOf('hosts');
  if (hostsIndex === -1) {
    return null;
  }
  return segments[hostsIndex + 1] ?? null;
}

function resolveLocalDestinationFromPath(path: string): AppDestination | null {
  const { pathname } = new URL(path, 'http://localhost');
  const { foundRoute, routeParams } = router.getMatchedRoutes(pathname);

  if (!foundRoute) {
    return null;
  }

  switch (foundRoute.id as LocalRouteId) {
    case '/':
      return { kind: 'root' };
    case '/onboarding':
      return { kind: 'onboarding' };
    case '/onboarding_/sign-in':
      return { kind: 'onboarding-sign-in' };
    case '/_app/workspaces':
      return { kind: 'workspaces' };
    case '/_app/export':
      return { kind: 'export' };
    case '/_app/issues': {
      const params = new URLSearchParams(
        new URL(path, 'http://localhost').search
      );
      const repoId = params.get('repo');
      return { kind: 'issues', ...(repoId ? { repoId } : {}) };
    }
    case '/_app/workers':
      return { kind: 'workers' };
    case '/_app/dashboard':
      return { kind: 'dashboard' };
    case '/_app/source-control':
      return { kind: 'source-control' };
    case '/_app/analyst-desk':
      return { kind: 'analyst-desk' };
    case '/_app/ci-pipelines':
      return { kind: 'ci-pipelines' };
    case '/_app/sprint': {
      const params = new URLSearchParams(
        new URL(path, 'http://localhost').search
      );
      const repoId = params.get('repo');
      return { kind: 'sprint', ...(repoId ? { repoId } : {}) };
    }
    case '/_app/hosts/$hostId/workspaces': {
      const hostId = getPathParam(routeParams, 'hostId');
      return hostId ? { kind: 'workspaces', hostId } : null;
    }
    case '/_app/workspaces_/$workspaceId': {
      const workspaceId = getPathParam(routeParams, 'workspaceId');
      return workspaceId ? { kind: 'workspace', workspaceId } : null;
    }
    case '/_app/hosts/$hostId/workspaces_/$workspaceId': {
      const hostId = getPathParam(routeParams, 'hostId');
      const workspaceId = getPathParam(routeParams, 'workspaceId');
      return hostId && workspaceId
        ? { kind: 'workspace', hostId, workspaceId }
        : null;
    }
    case '/workspaces/$workspaceId/vscode': {
      const workspaceId = getPathParam(routeParams, 'workspaceId');
      return workspaceId ? { kind: 'workspace-vscode', workspaceId } : null;
    }
    case '/hosts/$hostId/workspaces/$workspaceId/vscode': {
      const hostId = getPathParam(routeParams, 'hostId');
      const workspaceId = getPathParam(routeParams, 'workspaceId');
      return hostId && workspaceId
        ? { kind: 'workspace-vscode', hostId, workspaceId }
        : null;
    }
    case '/_app/projects/$projectId': {
      const projectId = getPathParam(routeParams, 'projectId');
      return projectId ? { kind: 'project', projectId } : null;
    }
    case '/_app/projects/$projectId_/issues/$issueId': {
      const projectId = getPathParam(routeParams, 'projectId');
      const issueId = getPathParam(routeParams, 'issueId');
      return projectId && issueId
        ? { kind: 'project-issue', projectId, issueId }
        : null;
    }
    case '/_app/projects/$projectId_/issues/$issueId_/workspaces/$workspaceId': {
      const projectId = getPathParam(routeParams, 'projectId');
      const issueId = getPathParam(routeParams, 'issueId');
      const workspaceId = getPathParam(routeParams, 'workspaceId');
      return projectId && issueId && workspaceId
        ? {
            kind: 'project-issue-workspace',
            projectId,
            issueId,
            workspaceId,
          }
        : null;
    }
    case '/_app/projects/$projectId_/issues/$issueId_/hosts/$hostId/workspaces/$workspaceId': {
      const projectId = getPathParam(routeParams, 'projectId');
      const issueId = getPathParam(routeParams, 'issueId');
      const hostId = getPathParam(routeParams, 'hostId');
      const workspaceId = getPathParam(routeParams, 'workspaceId');
      return projectId && issueId && hostId && workspaceId
        ? {
            kind: 'project-issue-workspace',
            projectId,
            issueId,
            hostId,
            workspaceId,
          }
        : null;
    }
    case '/_app/projects/$projectId_/issues/$issueId_/workspaces/create/$draftId': {
      const projectId = getPathParam(routeParams, 'projectId');
      const issueId = getPathParam(routeParams, 'issueId');
      const draftId = getPathParam(routeParams, 'draftId');
      return projectId && issueId && draftId
        ? {
            kind: 'project-issue-workspace-create',
            projectId,
            issueId,
            draftId,
          }
        : null;
    }
    case '/_app/projects/$projectId_/issues/$issueId_/hosts/$hostId/workspaces/create/$draftId': {
      const projectId = getPathParam(routeParams, 'projectId');
      const issueId = getPathParam(routeParams, 'issueId');
      const hostId = getPathParam(routeParams, 'hostId');
      const draftId = getPathParam(routeParams, 'draftId');
      return projectId && issueId && hostId && draftId
        ? {
            kind: 'project-issue-workspace-create',
            projectId,
            issueId,
            hostId,
            draftId,
          }
        : null;
    }
    default:
      return null;
  }
}

function destinationToLocalTarget(
  destination: AppDestination,
  options: { currentHostId: string | null }
) {
  const destinationHostId =
    'hostId' in destination ? (destination.hostId ?? null) : null;
  const effectiveHostId = destinationHostId ?? options.currentHostId;

  switch (destination.kind) {
    case 'root':
      return { to: '/' } as const;
    case 'onboarding':
      return { to: '/onboarding' } as const;
    case 'onboarding-sign-in':
      return { to: '/onboarding/sign-in' } as const;
    case 'workspaces':
      if (effectiveHostId) {
        return {
          to: '/hosts/$hostId/workspaces',
          params: { hostId: effectiveHostId },
        } as const;
      }
      return { to: '/workspaces' } as const;
    case 'workspace':
      if (effectiveHostId) {
        return {
          to: '/hosts/$hostId/workspaces/$workspaceId',
          params: {
            hostId: effectiveHostId,
            workspaceId: destination.workspaceId,
          },
        } as const;
      }
      return {
        to: '/workspaces/$workspaceId',
        params: { workspaceId: destination.workspaceId },
      } as const;
    case 'workspace-vscode':
      if (effectiveHostId) {
        return {
          to: '/hosts/$hostId/workspaces/$workspaceId/vscode',
          params: {
            hostId: effectiveHostId,
            workspaceId: destination.workspaceId,
          },
        } as const;
      }
      return {
        to: '/workspaces/$workspaceId/vscode',
        params: { workspaceId: destination.workspaceId },
      } as const;
    case 'export':
      return { to: '/export' } as const;
    case 'issues':
      return {
        to: '/issues',
        search: destination.repoId ? { repo: destination.repoId } : {},
      } as const;
    case 'workers':
      return { to: '/workers' } as const;
    case 'dashboard':
      return { to: '/dashboard' } as const;
    case 'source-control':
      return { to: '/source-control' } as const;
    case 'analyst-desk':
      return { to: '/analyst-desk' } as const;
    case 'ci-pipelines':
      return { to: '/ci-pipelines' } as const;
    case 'sprint':
      return {
        to: '/sprint',
        search: destination.repoId ? { repo: destination.repoId } : {},
      } as const;
    case 'project':
      return {
        to: '/projects/$projectId',
        params: { projectId: destination.projectId },
      } as const;
    case 'project-issue':
      return {
        to: '/projects/$projectId/issues/$issueId',
        params: {
          projectId: destination.projectId,
          issueId: destination.issueId,
        },
      } as const;
    case 'project-issue-workspace':
      if (effectiveHostId) {
        return {
          to: '/projects/$projectId/issues/$issueId/hosts/$hostId/workspaces/$workspaceId',
          params: {
            projectId: destination.projectId,
            issueId: destination.issueId,
            hostId: effectiveHostId,
            workspaceId: destination.workspaceId,
          },
        } as const;
      }
      return {
        to: '/projects/$projectId/issues/$issueId/workspaces/$workspaceId',
        params: {
          projectId: destination.projectId,
          issueId: destination.issueId,
          workspaceId: destination.workspaceId,
        },
      } as const;
    case 'project-issue-workspace-create':
      if (effectiveHostId) {
        return {
          to: '/projects/$projectId/issues/$issueId/hosts/$hostId/workspaces/create/$draftId',
          params: {
            projectId: destination.projectId,
            issueId: destination.issueId,
            hostId: effectiveHostId,
            draftId: destination.draftId,
          },
        } as const;
      }
      return {
        to: '/projects/$projectId/issues/$issueId/workspaces/create/$draftId',
        params: {
          projectId: destination.projectId,
          issueId: destination.issueId,
          draftId: destination.draftId,
        },
      } as const;
  }
}

export function createLocalAppNavigation(): AppNavigation {
  const navigateTo = (
    destination: AppDestination,
    transition?: NavigationTransition
  ) => {
    const currentHostId =
      typeof window === 'undefined'
        ? null
        : parseLocalHostIdFromPathname(window.location.pathname);

    void router.navigate({
      ...destinationToLocalTarget(destination, { currentHostId }),
      ...(transition?.replace !== undefined
        ? { replace: transition.replace }
        : {}),
    });
  };

  const navigation: AppNavigation = {
    resolveFromPath: (path) => resolveLocalDestinationFromPath(path),
    goToRoot: (transition) => navigateTo({ kind: 'root' }, transition),
    goToOnboarding: (transition) =>
      navigateTo({ kind: 'onboarding' }, transition),
    goToOnboardingSignIn: (transition) =>
      navigateTo({ kind: 'onboarding-sign-in' }, transition),
    goToWorkspaces: (transition) =>
      navigateTo({ kind: 'workspaces' }, transition),
    goToWorkspace: (workspaceId, transition) =>
      navigateTo({ kind: 'workspace', workspaceId }, transition),
    goToWorkspaceVsCode: (workspaceId, transition) =>
      navigateTo({ kind: 'workspace-vscode', workspaceId }, transition),
    goToExport: (transition) => navigateTo({ kind: 'export' }, transition),
    goToDashboard: (transition) =>
      navigateTo({ kind: 'dashboard' }, transition),
    goToSourceControl: (transition) =>
      navigateTo({ kind: 'source-control' }, transition),
    goToIssues: (repoId, transition) =>
      navigateTo({ kind: 'issues', ...(repoId ? { repoId } : {}) }, transition),
    goToWorkers: (transition) => navigateTo({ kind: 'workers' }, transition),
    goToAnalystDesk: (transition) =>
      navigateTo({ kind: 'analyst-desk' }, transition),
    goToCiPipelines: (transition) =>
      navigateTo({ kind: 'ci-pipelines' }, transition),
    goToSprint: (repoId, transition) =>
      navigateTo({ kind: 'sprint', ...(repoId ? { repoId } : {}) }, transition),
    goToProject: (projectId, transition) =>
      navigateTo({ kind: 'project', projectId }, transition),
    goToProjectIssue: (projectId, issueId, transition) =>
      navigateTo({ kind: 'project-issue', projectId, issueId }, transition),
    goToProjectIssueWorkspace: (projectId, issueId, workspaceId, transition) =>
      navigateTo(
        { kind: 'project-issue-workspace', projectId, issueId, workspaceId },
        transition
      ),
    goToProjectIssueWorkspaceCreate: (
      projectId,
      issueId,
      draftId,
      transition
    ) =>
      navigateTo(
        { kind: 'project-issue-workspace-create', projectId, issueId, draftId },
        transition
      ),
  };

  return navigation;
}

export const localAppNavigation = createLocalAppNavigation();
