import { router } from "@remote/app/router";
import type { FileRouteTypes } from "@remote/routeTree.gen";
import {
  type AppDestination,
  type AppNavigation,
  type NavigationTransition,
} from "@/shared/lib/routes/appNavigation";

type RemoteRouteId = FileRouteTypes["id"];

function getPathParam(
  routeParams: Record<string, string>,
  key: string,
): string | null {
  const value = routeParams[key];
  return value ? value : null;
}

export function resolveRemoteDestinationFromPath(
  path: string,
): AppDestination | null {
  const { pathname } = new URL(path, "http://localhost");
  const { foundRoute, routeParams } = router.getMatchedRoutes(pathname);

  if (!foundRoute) {
    return null;
  }

  switch (foundRoute.id as RemoteRouteId) {
    case "/":
      return { kind: "root" };
    case "/export":
      return { kind: "export" };
    case "/hosts/$hostId/workspaces": {
      const hostId = getPathParam(routeParams, "hostId");
      return hostId ? { kind: "workspaces", hostId } : null;
    }
    case "/hosts/$hostId/workspaces_/$workspaceId": {
      const hostId = getPathParam(routeParams, "hostId");
      const workspaceId = getPathParam(routeParams, "workspaceId");
      return hostId && workspaceId
        ? { kind: "workspace", hostId, workspaceId }
        : null;
    }
    case "/hosts/$hostId/workspaces/$workspaceId/vscode": {
      const hostId = getPathParam(routeParams, "hostId");
      const workspaceId = getPathParam(routeParams, "workspaceId");
      return hostId && workspaceId
        ? { kind: "workspace-vscode", hostId, workspaceId }
        : null;
    }
    case "/projects/$projectId": {
      const projectId = getPathParam(routeParams, "projectId");
      return projectId ? { kind: "project", projectId } : null;
    }
    case "/projects/$projectId_/issues/$issueId": {
      const projectId = getPathParam(routeParams, "projectId");
      const issueId = getPathParam(routeParams, "issueId");
      return projectId && issueId
        ? { kind: "project-issue", projectId, issueId }
        : null;
    }
    case "/projects/$projectId_/issues/$issueId_/hosts/$hostId/workspaces/$workspaceId": {
      const projectId = getPathParam(routeParams, "projectId");
      const issueId = getPathParam(routeParams, "issueId");
      const hostId = getPathParam(routeParams, "hostId");
      const workspaceId = getPathParam(routeParams, "workspaceId");
      return projectId && issueId && hostId && workspaceId
        ? {
            kind: "project-issue-workspace",
            projectId,
            issueId,
            hostId,
            workspaceId,
          }
        : null;
    }
    case "/projects/$projectId_/issues/$issueId_/hosts/$hostId/workspaces/create/$draftId": {
      const projectId = getPathParam(routeParams, "projectId");
      const issueId = getPathParam(routeParams, "issueId");
      const hostId = getPathParam(routeParams, "hostId");
      const draftId = getPathParam(routeParams, "draftId");
      return projectId && issueId && hostId && draftId
        ? {
            kind: "project-issue-workspace-create",
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

function destinationToRemoteTarget(
  destination: AppDestination,
  options: { currentHostId: string | null },
) {
  const destinationHostId =
    "hostId" in destination ? (destination.hostId ?? null) : null;
  const effectiveHostId = destinationHostId ?? options.currentHostId;

  switch (destination.kind) {
    case "root":
      return { to: "/" } as const;
    case "onboarding":
      return { to: "/" } as const;
    case "onboarding-sign-in":
      return { to: "/" } as const;
    case "workspaces":
      if (effectiveHostId) {
        return {
          to: "/hosts/$hostId/workspaces",
          params: { hostId: effectiveHostId },
        } as const;
      }
      return { to: "/" } as const;
    case "workspace":
      if (effectiveHostId) {
        return {
          to: "/hosts/$hostId/workspaces/$workspaceId",
          params: {
            hostId: effectiveHostId,
            workspaceId: destination.workspaceId,
          },
        } as const;
      }
      return { to: "/" } as const;
    case "workspace-vscode":
      if (effectiveHostId) {
        return {
          to: "/hosts/$hostId/workspaces/$workspaceId/vscode",
          params: {
            hostId: effectiveHostId,
            workspaceId: destination.workspaceId,
          },
        } as const;
      }
      return { to: "/" } as const;
    case "export":
      return { to: "/export" } as const;
    case "issues":
      // No dedicated issues route on the remote web; fall back to root.
      return { to: "/" } as const;
    case "workers":
      // No dedicated workers route on the remote web; fall back to root.
      return { to: "/" } as const;
    case "dashboard":
      // No dedicated dashboard route on the remote web; fall back to root.
      return { to: "/" } as const;
    case "pilot-report":
      // No dedicated pilot-report route on the remote web; fall back to root.
      return { to: "/" } as const;
    case "source-control":
      // No dedicated source control route on the remote web; fall back to root.
      return { to: "/" } as const;
    case "analyst-desk":
      // No dedicated analyst desk route on the remote web; fall back to root.
      return { to: "/" } as const;
    case "ci-pipelines":
      // No dedicated CI pipelines route on the remote web; fall back to root.
      return { to: "/" } as const;
    case "sprint":
      // No dedicated sprint route on the remote web; fall back to root.
      return { to: "/" } as const;
    case "project":
      return {
        to: "/projects/$projectId",
        params: { projectId: destination.projectId },
      } as const;
    case "project-issue":
      return {
        to: "/projects/$projectId/issues/$issueId",
        params: {
          projectId: destination.projectId,
          issueId: destination.issueId,
        },
      } as const;
    case "project-issue-workspace":
      return {
        to: "/projects/$projectId/issues/$issueId/hosts/$hostId/workspaces/$workspaceId",
        params: {
          projectId: destination.projectId,
          issueId: destination.issueId,
          hostId: destination.hostId,
          workspaceId: destination.workspaceId,
        },
      } as const;
    case "project-issue-workspace-create":
      return {
        to: "/projects/$projectId/issues/$issueId/hosts/$hostId/workspaces/create/$draftId",
        params: {
          projectId: destination.projectId,
          issueId: destination.issueId,
          hostId: destination.hostId,
          draftId: destination.draftId,
        },
      } as const;
  }
}

export function createRemoteHostAppNavigation(hostId: string): AppNavigation {
  const navigateTo = (
    destination: AppDestination,
    transition?: NavigationTransition,
  ) => {
    void router.navigate({
      ...destinationToRemoteTarget(destination, {
        currentHostId: hostId,
      }),
      ...(transition?.replace !== undefined
        ? { replace: transition.replace }
        : {}),
    });
  };

  const navigation: AppNavigation = {
    resolveFromPath: (path) => resolveRemoteDestinationFromPath(path),
    goToRoot: (transition) => navigateTo({ kind: "root" }, transition),
    goToOnboarding: (transition) =>
      navigateTo({ kind: "onboarding" }, transition),
    goToOnboardingSignIn: (transition) =>
      navigateTo({ kind: "onboarding-sign-in" }, transition),
    goToWorkspaces: (transition) =>
      navigateTo({ kind: "workspaces", hostId }, transition),
    goToWorkspace: (workspaceId, transition) =>
      navigateTo({ kind: "workspace", hostId, workspaceId }, transition),
    goToWorkspaceVsCode: (workspaceId, transition) =>
      navigateTo({ kind: "workspace-vscode", hostId, workspaceId }, transition),
    goToExport: (transition) => navigateTo({ kind: "export" }, transition),
    goToDashboard: (transition) =>
      navigateTo({ kind: "dashboard" }, transition),
    goToPilotReport: (transition) =>
      navigateTo({ kind: "pilot-report" }, transition),
    goToSourceControl: (transition) =>
      navigateTo({ kind: "source-control" }, transition),
    goToIssues: (repoId, transition) =>
      navigateTo({ kind: "issues", ...(repoId ? { repoId } : {}) }, transition),
    goToWorkers: (transition) => navigateTo({ kind: "workers" }, transition),
    goToAnalystDesk: (transition) =>
      navigateTo({ kind: "analyst-desk" }, transition),
    goToCiPipelines: (transition) =>
      navigateTo({ kind: "ci-pipelines" }, transition),
    goToSprint: (repoId, transition) =>
      navigateTo({ kind: "sprint", ...(repoId ? { repoId } : {}) }, transition),
    goToProject: (projectId, transition) =>
      navigateTo({ kind: "project", projectId }, transition),
    goToProjectIssue: (projectId, issueId, transition) =>
      navigateTo({ kind: "project-issue", projectId, issueId }, transition),
    goToProjectIssueWorkspace: (projectId, issueId, workspaceId, transition) =>
      navigateTo(
        {
          kind: "project-issue-workspace",
          hostId,
          projectId,
          issueId,
          workspaceId,
        },
        transition,
      ),
    goToProjectIssueWorkspaceCreate: (
      projectId,
      issueId,
      draftId,
      transition,
    ) =>
      navigateTo(
        {
          kind: "project-issue-workspace-create",
          hostId,
          projectId,
          issueId,
          draftId,
        },
        transition,
      ),
  };

  return navigation;
}

function createRemoteFallbackAppNavigation(): AppNavigation {
  const navigateTo = (
    destination: AppDestination,
    transition?: NavigationTransition,
  ) => {
    void router.navigate({
      ...destinationToRemoteTarget(destination, {
        currentHostId: null,
      }),
      ...(transition?.replace !== undefined
        ? { replace: transition.replace }
        : {}),
    });
  };

  const navigation: AppNavigation = {
    resolveFromPath: (path) => resolveRemoteDestinationFromPath(path),
    goToRoot: (transition) => navigateTo({ kind: "root" }, transition),
    goToOnboarding: (transition) =>
      navigateTo({ kind: "onboarding" }, transition),
    goToOnboardingSignIn: (transition) =>
      navigateTo({ kind: "onboarding-sign-in" }, transition),
    goToWorkspaces: (transition) =>
      navigateTo({ kind: "workspaces" }, transition),
    goToWorkspace: (workspaceId, transition) =>
      navigateTo({ kind: "workspace", workspaceId }, transition),
    goToWorkspaceVsCode: (workspaceId, transition) =>
      navigateTo({ kind: "workspace-vscode", workspaceId }, transition),
    goToExport: (transition) => navigateTo({ kind: "export" }, transition),
    goToDashboard: (transition) =>
      navigateTo({ kind: "dashboard" }, transition),
    goToPilotReport: (transition) =>
      navigateTo({ kind: "pilot-report" }, transition),
    goToSourceControl: (transition) =>
      navigateTo({ kind: "source-control" }, transition),
    goToIssues: (repoId, transition) =>
      navigateTo({ kind: "issues", ...(repoId ? { repoId } : {}) }, transition),
    goToWorkers: (transition) => navigateTo({ kind: "workers" }, transition),
    goToAnalystDesk: (transition) =>
      navigateTo({ kind: "analyst-desk" }, transition),
    goToCiPipelines: (transition) =>
      navigateTo({ kind: "ci-pipelines" }, transition),
    goToSprint: (repoId, transition) =>
      navigateTo({ kind: "sprint", ...(repoId ? { repoId } : {}) }, transition),
    goToProject: (projectId, transition) =>
      navigateTo({ kind: "project", projectId }, transition),
    goToProjectIssue: (projectId, issueId, transition) =>
      navigateTo({ kind: "project-issue", projectId, issueId }, transition),
    goToProjectIssueWorkspace: (projectId, issueId, workspaceId, transition) =>
      navigateTo(
        { kind: "project-issue-workspace", projectId, issueId, workspaceId },
        transition,
      ),
    goToProjectIssueWorkspaceCreate: (
      projectId,
      issueId,
      draftId,
      transition,
    ) =>
      navigateTo(
        { kind: "project-issue-workspace-create", projectId, issueId, draftId },
        transition,
      ),
  };

  return navigation;
}

export const remoteFallbackAppNavigation = createRemoteFallbackAppNavigation();
