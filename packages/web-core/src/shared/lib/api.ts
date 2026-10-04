// Import all necessary types from shared types

import {
  ApprovalStatus,
  ApiResponse,
  Config,
  CreateFollowUpAttempt,
  ResetProcessRequest,
  EditorType,
  CreatePrApiRequest,
  CreateCiPipelinePrRequest,
  CreateCiPipelinePrResponse,
  CreateTag,
  DirectoryListResponse,
  DirectoryEntry,
  ExecutionProcess,
  ExecutionProcessRepoState,
  GitBranch,
  StartSessionRequest,
  StartSessionResponse,
  WorkspaceContext,
  Repo,
  RepoWithTargetBranch,
  UpdateRepo,
  SearchMode,
  SearchResult,
  Tag,
  TagSearchParams,
  UpdateTag,
  UserSystemInfo,
  McpServerQuery,
  UpdateMcpServersBody,
  GetMcpServerResponse,
  AttachmentResponse,
  GitOperationError,
  ApprovalResponse,
  RebaseWorkspaceRequest,
  ChangeTargetBranchRequest,
  ChangeTargetBranchResponse,
  RenameBranchRequest,
  RenameBranchResponse,
  CheckEditorAvailabilityResponse,
  AvailabilityInfo,
  BaseCodingAgent,
  ExecutorConfig,
  DraftFollowUpData,
  AgentPresetOptionsQuery,
  AgentGuidelines,
  SaveAgentGuidelinesRequest,
  RunAgentSetupRequest,
  RunAgentSetupResponse,
  GhCliSetupError,
  GithubLoginResponse,
  GithubCliInstallResponse,
  PlanSnapshot,
  GithubStatusResponse,
  RunScriptError,
  StatusResponse,
  CreateOrganizationRequest,
  CreateOrganizationResponse,
  ListOrganizationsResponse,
  OrganizationMemberWithProfile,
  ListMembersResponse,
  CreateInvitationRequest,
  CreateInvitationResponse,
  RevokeInvitationRequest,
  UpdateMemberRoleRequest,
  UpdateMemberRoleResponse,
  Invitation,
  ListInvitationsResponse,
  OpenEditorResponse,
  OpenEditorRequest,
  PrError,
  Scratch,
  ScratchType,
  CreateScratch,
  UpdateScratch,
  PushError,
  TokenResponse,
  CurrentUserResponse,
  QueueStatus,
  PrCommentsResponse,
  MergeWorkspaceRequest,
  PushWorkspaceRequest,
  RepoBranchStatus,
  AbortConflictsRequest,
  ContinueRebaseRequest,
  Session,
  Workspace,
  StartReviewRequest,
  ReviewError,
  GitRemote,
  ListPrsError,
  PullRequestDetail,
  LinkPrToIssueRequest,
  AttachExistingPrRequest,
  AttachPrResponse,
  CreateWorkspaceFromPrBody,
  CreateWorkspaceFromPrResponse,
  CreateFromPrError,
  CreateAndStartWorkspaceRequest,
  CreateAndStartWorkspaceResponse,
  RelayPairedClient,
  ListRelayPairedClientsResponse,
  RemoveRelayPairedClientResponse,
  PairRelayHostRequest,
  PairRelayHostResponse,
  RelayPairedHost,
  ListRelayPairedHostsResponse,
  RemoveRelayPairedHostResponse,
  OpenRemoteWorkspaceInEditorRequest,
  OpenRemoteEditorResponse,
  ProfileResponse,
  GitHubRepoSummary,
  CloneRepoRequest,
  CloneRepoResponse,
  WorkerResponse,
  WorkerTaskResponse,
  CreateWorkerTaskRequest,
  UpdateWorkerTaskRequest,
  CreateDesignHandoffRequest,
  DesignArtifactsResponse,
  MissionDetail,
  MissionSummary,
  UpdateMissionRequest,
  MilestoneRun,
  IssueBlockerEntry,
  UnstickRequest,
  IssuePlanResponse,
  GithubMilestone,
} from 'shared/types';
import type { Project as RemoteProject } from 'shared/remote-types';
import type { RepoIssue } from '@/features/issues/types';
import type { WorkspaceWithSession } from '@/shared/types/attempt';
import { createWorkspaceWithSession } from '@/shared/types/attempt';
import { resolveHostRequestScope } from '@/shared/lib/hostRequestScope';
import { makeRequest as makeRemoteRequest } from '@/shared/lib/remoteApi';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';

/** Info about an existing active worker task for a given issue. */
export interface ActiveIssueTaskInfo {
  task_id: string;
  worker_id: string;
  worker_name: string;
  worker_emoji: string;
  status: string;
}

export class ApiError<E = unknown> extends Error {
  public status?: number;
  public error_data?: E;

  constructor(
    message: string,
    public statusCode?: number,
    public response?: Response,
    error_data?: E
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = statusCode;
    this.error_data = error_data;
  }
}

const makeRequest = async (url: string, options: RequestInit = {}) => {
  const headers = new Headers(options.headers ?? {});
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return makeLocalApiRequest(url, {
    ...options,
    headers,
  });
};

const makeScopedRequest = async (
  url: string,
  hostId: string | null,
  options: RequestInit = {}
) => {
  const headers = new Headers(options.headers ?? {});
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return makeLocalApiRequest(url, {
    ...options,
    headers,
    hostScope: 'explicit',
    hostId,
  });
};

const makeHostAwareRequest = async (
  url: string,
  hostId: string | null | undefined,
  options: RequestInit = {}
) => {
  const scope = resolveHostRequestScope(hostId);

  if (scope.kind === 'current') {
    return makeRequest(url, options);
  }

  return makeScopedRequest(
    url,
    scope.kind === 'host' ? scope.hostId : null,
    options
  );
};

export type Ok<T> = { success: true; data: T };
export type Err<E> = { success: false; error: E | undefined; message?: string };

// Result type for endpoints that need typed errors
export type Result<T, E> = Ok<T> | Err<E>;

// Local shims for the quick-action endpoint typed errors.
// Mirror ResolveMergeConflictsError / AddressPrCommentsError / FixCiError in
// crates/server/src/routes/workspaces/pr.rs and will be replaced by the
// generated types when infra runs `pnpm run generate-types`.
export type ResolveMergeConflictsError =
  | { type: 'no_pr_attached' }
  | { type: 'no_agent_session' };

export type AddressPrCommentsError =
  | { type: 'no_pr_attached' }
  | { type: 'no_agent_session' };

export type FixCiError =
  | { type: 'no_pr_attached' }
  | { type: 'no_agent_session' };

type ListRemoteProjectsResponse = {
  projects: RemoteProject[];
};

export type OrganizationBillingStatus =
  | 'free'
  | 'active'
  | 'past_due'
  | 'cancelled'
  | 'requires_subscription';

export interface OrganizationBillingStatusResponse {
  status: OrganizationBillingStatus;
  billing_enabled: boolean;
  can_manage_billing: boolean;
  seat_info: {
    current_members: number;
    free_seats: number;
    requires_subscription: boolean;
    subscription: {
      status: string;
      current_period_end: string;
      cancel_at_period_end: boolean;
      quantity: number;
      unit_amount: number;
    } | null;
  } | null;
}

// Special handler for Result-returning endpoints
const handleApiResponseAsResult = async <T, E>(
  response: Response
): Promise<Result<T, E>> => {
  if (!response.ok) {
    // HTTP error - no structured error data
    let errorMessage = `Request failed with status ${response.status}`;

    try {
      const errorData = await response.json();
      if (errorData.message) {
        errorMessage = errorData.message;
      }
    } catch {
      errorMessage = response.statusText || errorMessage;
    }

    return {
      success: false,
      error: undefined,
      message: errorMessage,
    };
  }

  const result: ApiResponse<T, E> = await response.json();

  if (!result.success) {
    return {
      success: false,
      error: result.error_data || undefined,
      message: result.message || undefined,
    };
  }

  return { success: true, data: result.data as T };
};

export const handleApiResponse = async <T, E = T>(
  response: Response
): Promise<T> => {
  if (!response.ok) {
    let errorMessage = `Request failed with status ${response.status}`;
    let structuredError: E | undefined;

    try {
      const errorData = await response.json();
      if (errorData.message) {
        errorMessage = errorData.message;
      }
      // Backend can pair a non-2xx status with a structured `error_data`
      // payload (e.g. 409 DeleteRepoConflict). Forward it so callers can
      // render it — matching the ok-path branch below.
      if (errorData.error_data != null) {
        structuredError = errorData.error_data as E;
      }
    } catch {
      // Fallback to status text if JSON parsing fails
      errorMessage = response.statusText || errorMessage;
    }

    console.error('[API Error]', {
      message: errorMessage,
      status: response.status,
      response,
      endpoint: response.url,
      timestamp: new Date().toISOString(),
    });
    throw new ApiError<E>(
      errorMessage,
      response.status,
      response,
      structuredError
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const result: ApiResponse<T, E> = await response.json();

  if (!result.success) {
    // Check for error_data first (structured errors), then fall back to message
    if (result.error_data) {
      console.error('[API Error with data]', {
        error_data: result.error_data,
        message: result.message,
        status: response.status,
        response,
        endpoint: response.url,
        timestamp: new Date().toISOString(),
      });
      // Throw a properly typed error with the error data
      throw new ApiError<E>(
        result.message || 'API request failed',
        response.status,
        response,
        result.error_data
      );
    }

    console.error('[API Error]', {
      message: result.message || 'API request failed',
      status: response.status,
      response,
      endpoint: response.url,
      timestamp: new Date().toISOString(),
    });
    throw new ApiError<E>(
      result.message || 'API request failed',
      response.status,
      response
    );
  }

  return result.data as T;
};

// Sessions API
export const sessionsApi = {
  getByWorkspace: async (workspaceId: string): Promise<Session[]> => {
    const response = await makeRequest(
      `/api/sessions?workspace_id=${workspaceId}`
    );
    return handleApiResponse<Session[]>(response);
  },

  getById: async (sessionId: string): Promise<Session> => {
    const response = await makeRequest(`/api/sessions/${sessionId}`);
    return handleApiResponse<Session>(response);
  },

  create: async (data: {
    workspace_id: string;
    executor?: string;
    name?: string;
  }): Promise<Session> => {
    const response = await makeRequest('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<Session>(response);
  },

  followUp: async (
    sessionId: string,
    data: CreateFollowUpAttempt
  ): Promise<ExecutionProcess> => {
    const response = await makeRequest(`/api/sessions/${sessionId}/follow-up`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<ExecutionProcess>(response);
  },

  startReview: async (
    sessionId: string,
    data: StartReviewRequest
  ): Promise<ExecutionProcess> => {
    const response = await makeRequest(`/api/sessions/${sessionId}/review`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<ExecutionProcess, ReviewError>(response);
  },

  reset: async (
    sessionId: string,
    data: ResetProcessRequest
  ): Promise<void> => {
    const response = await makeRequest(`/api/sessions/${sessionId}/reset`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<void>(response);
  },

  runSetupScript: async (
    sessionId: string
  ): Promise<Result<ExecutionProcess, RunScriptError>> => {
    const response = await makeRequest(`/api/sessions/${sessionId}/setup`, {
      method: 'POST',
    });
    return handleApiResponseAsResult<ExecutionProcess, RunScriptError>(
      response
    );
  },

  update: async (
    sessionId: string,
    data: { name?: string }
  ): Promise<Session> => {
    const response = await makeRequest(`/api/sessions/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return handleApiResponse<Session>(response);
  },

  start: async (
    sessionId: string,
    data: StartSessionRequest
  ): Promise<StartSessionResponse> => {
    const response = await makeRequest(`/api/sessions/${sessionId}/start`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<StartSessionResponse>(response);
  },
};

// Workspace APIs
export const workspacesApi = {
  createAndStart: async (
    data: CreateAndStartWorkspaceRequest
  ): Promise<CreateAndStartWorkspaceResponse> => {
    const response = await makeRequest(`/api/workspaces/start`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<CreateAndStartWorkspaceResponse>(response);
  },

  getAll: async (taskId: string): Promise<Workspace[]> => {
    const response = await makeRequest(`/api/workspaces?task_id=${taskId}`);
    return handleApiResponse<Workspace[]>(response);
  },

  /** Get all workspaces across all tasks (newest first) */
  getAllWorkspaces: async (): Promise<Workspace[]> => {
    const response = await makeRequest('/api/workspaces');
    return handleApiResponse<Workspace[]>(response);
  },

  get: async (workspaceId: string): Promise<Workspace> => {
    const response = await makeRequest(`/api/workspaces/${workspaceId}`);
    return handleApiResponse<Workspace>(response);
  },

  update: async (
    workspaceId: string,
    data: { archived?: boolean; pinned?: boolean; name?: string }
  ): Promise<Workspace> => {
    const response = await makeRequest(`/api/workspaces/${workspaceId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return handleApiResponse<Workspace>(response);
  },

  /** Get workspace with latest session */
  getWithSession: async (
    workspaceId: string
  ): Promise<WorkspaceWithSession> => {
    const [workspace, sessions] = await Promise.all([
      workspacesApi.get(workspaceId),
      sessionsApi.getByWorkspace(workspaceId),
    ]);
    return createWorkspaceWithSession(workspace, sessions[0]);
  },

  stop: async (workspaceId: string): Promise<void> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/execution/stop`,
      {
        method: 'POST',
      }
    );
    return handleApiResponse<void>(response);
  },

  delete: async (
    workspaceId: string,
    deleteBranches?: boolean
  ): Promise<void> => {
    const params = new URLSearchParams();
    if (deleteBranches) {
      params.set('delete_branches', 'true');
    }
    const queryString = params.toString();
    const url = `/api/workspaces/${workspaceId}${queryString ? `?${queryString}` : ''}`;
    const response = await makeRequest(url, {
      method: 'DELETE',
    });
    return handleApiResponse<void>(response);
  },

  /**
   * Bulk-purge every archived workspace. Workspaces with processes still
   * running are skipped, not failed. Branches are kept unless
   * `deleteBranches` is true.
   */
  deleteAllArchived: async (
    deleteBranches?: boolean
  ): Promise<{
    deleted: number;
    skipped: number;
  }> => {
    const url = deleteBranches
      ? '/api/workspaces/archived?delete_branches=true'
      : '/api/workspaces/archived';
    const response = await makeRequest(url, {
      method: 'DELETE',
    });
    return handleApiResponse<{ deleted: number; skipped: number }>(response);
  },

  linkToIssue: async (
    workspaceId: string,
    projectId: string,
    issueId: string
  ): Promise<void> => {
    const response = await makeRequest(`/api/workspaces/${workspaceId}/links`, {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId, issue_id: issueId }),
    });
    return handleApiResponse<void>(response);
  },

  unlinkFromIssue: async (workspaceId: string): Promise<void> => {
    const response = await makeRequest(`/api/workspaces/${workspaceId}/links`, {
      method: 'DELETE',
    });
    return handleApiResponse<void>(response);
  },

  runAgentSetup: async (
    workspaceId: string,
    data: RunAgentSetupRequest
  ): Promise<RunAgentSetupResponse> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/integration/agent/setup`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<RunAgentSetupResponse>(response);
  },

  openEditor: async (
    workspaceId: string,
    data: OpenEditorRequest
  ): Promise<OpenEditorResponse> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/integration/editor/open`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<OpenEditorResponse>(response);
  },

  getEditorPath: async (
    workspaceId: string
  ): Promise<{ workspace_path: string }> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/integration/editor/path`
    );
    return handleApiResponse<{ workspace_path: string }>(response);
  },

  /** Read a text file for the embedded editor. */
  readEditorFile: async (path: string): Promise<{ content: string }> => {
    const response = await makeRequest(
      `/api/editor/file?path=${encodeURIComponent(path)}`
    );
    return handleApiResponse<{ content: string }>(response);
  },

  /** Save a text file edited in the embedded editor. */
  saveEditorFile: async (path: string, content: string): Promise<void> => {
    const response = await makeRequest('/api/editor/file', {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    });
    return handleApiResponse<void>(response);
  },

  createEditorEntry: async (
    path: string,
    isDirectory: boolean
  ): Promise<void> => {
    const response = await makeRequest('/api/editor/create', {
      method: 'POST',
      body: JSON.stringify({ path, is_directory: isDirectory }),
    });
    return handleApiResponse<void>(response);
  },

  renameEditorEntry: async (path: string, newPath: string): Promise<void> => {
    const response = await makeRequest('/api/editor/rename', {
      method: 'POST',
      body: JSON.stringify({ path, new_path: newPath }),
    });
    return handleApiResponse<void>(response);
  },

  deleteEditorEntry: async (path: string): Promise<void> => {
    const response = await makeRequest('/api/editor/delete', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
    return handleApiResponse<void>(response);
  },

  /** Case-insensitive content search under a root directory. */
  searchEditorContent: async (
    root: string,
    q: string
  ): Promise<{ path: string; line: number; preview: string }[]> => {
    const response = await makeRequest(
      `/api/editor/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}`
    );
    return handleApiResponse<{ path: string; line: number; preview: string }[]>(
      response
    );
  },

  getBranchStatus: async (workspaceId: string): Promise<RepoBranchStatus[]> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/status`
    );
    return handleApiResponse<RepoBranchStatus[]>(response);
  },

  // Selective staging (SHELL-SPEC V5/R38). Types mirror crates/git
  // StagingState inline (like the editor endpoints — no generate_types).
  getStagingState: async (
    workspaceId: string,
    repoId: string
  ): Promise<{
    files: Array<{
      path: string;
      status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
      is_binary: boolean;
      staged_hunks: Array<{
        header: string;
        lines: string[];
        patch: string;
        added: number;
        removed: number;
      }>;
      unstaged_hunks: Array<{
        header: string;
        lines: string[];
        patch: string;
        added: number;
        removed: number;
      }>;
      has_staged_changes: boolean;
      has_unstaged_changes: boolean;
    }>;
  }> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/staging?repo_id=${encodeURIComponent(repoId)}`
    );
    return handleApiResponse(response);
  },

  stageChanges: async (
    workspaceId: string,
    data: { repo_id: string; path?: string; patch?: string }
  ): Promise<void> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/staging/stage`,
      { method: 'POST', body: JSON.stringify(data) }
    );
    return handleApiResponse<void>(response);
  },

  unstageChanges: async (
    workspaceId: string,
    data: { repo_id: string; path?: string; patch?: string }
  ): Promise<void> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/staging/unstage`,
      { method: 'POST', body: JSON.stringify(data) }
    );
    return handleApiResponse<void>(response);
  },

  commitStaged: async (
    workspaceId: string,
    data: { repo_id: string; message: string }
  ): Promise<{ head_oid: string }> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/staging/commit`,
      { method: 'POST', body: JSON.stringify(data) }
    );
    return handleApiResponse<{ head_oid: string }>(response);
  },

  getRepos: async (workspaceId: string): Promise<RepoWithTargetBranch[]> => {
    const response = await makeRequest(`/api/workspaces/${workspaceId}/repos`);
    return handleApiResponse<RepoWithTargetBranch[]>(response);
  },

  getFirstUserMessage: async (workspaceId: string): Promise<string | null> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/messages/first`
    );
    return handleApiResponse<string | null>(response);
  },

  merge: async (
    workspaceId: string,
    data: MergeWorkspaceRequest
  ): Promise<void> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/merge`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<void>(response);
  },

  push: async (
    workspaceId: string,
    data: PushWorkspaceRequest
  ): Promise<Result<void, PushError>> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/push`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponseAsResult<void, PushError>(response);
  },

  forcePush: async (
    workspaceId: string,
    data: PushWorkspaceRequest
  ): Promise<Result<void, PushError>> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/push/force`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponseAsResult<void, PushError>(response);
  },

  rebase: async (
    workspaceId: string,
    data: RebaseWorkspaceRequest
  ): Promise<Result<void, GitOperationError>> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/rebase`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponseAsResult<void, GitOperationError>(response);
  },

  change_target_branch: async (
    workspaceId: string,
    data: ChangeTargetBranchRequest
  ): Promise<ChangeTargetBranchResponse> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/target-branch`,
      {
        method: 'PUT',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<ChangeTargetBranchResponse>(response);
  },

  renameBranch: async (
    workspaceId: string,
    newBranchName: string
  ): Promise<RenameBranchResponse> => {
    const payload: RenameBranchRequest = {
      new_branch_name: newBranchName,
    };
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/branch`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      }
    );
    return handleApiResponse<RenameBranchResponse>(response);
  },

  abortConflicts: async (
    workspaceId: string,
    data: AbortConflictsRequest
  ): Promise<void> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/conflicts/abort`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<void>(response);
  },

  continueRebase: async (
    workspaceId: string,
    data: ContinueRebaseRequest
  ): Promise<void> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/rebase/continue`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<void>(response);
  },

  createPR: async (
    workspaceId: string,
    data: CreatePrApiRequest
  ): Promise<Result<string, PrError>> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/pull-requests`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponseAsResult<string, PrError>(response);
  },

  resolveMergeConflicts: async (
    workspaceId: string
  ): Promise<Result<void, ResolveMergeConflictsError>> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/pull-requests/resolve-merge-conflicts`,
      { method: 'POST' }
    );
    return handleApiResponseAsResult<void, ResolveMergeConflictsError>(
      response
    );
  },

  addressPrComments: async (
    workspaceId: string
  ): Promise<Result<void, AddressPrCommentsError>> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/pull-requests/address-pr-comments`,
      { method: 'POST' }
    );
    return handleApiResponseAsResult<void, AddressPrCommentsError>(response);
  },

  fixCi: async (workspaceId: string): Promise<Result<void, FixCiError>> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/pull-requests/fix-ci`,
      { method: 'POST' }
    );
    return handleApiResponseAsResult<void, FixCiError>(response);
  },

  /** Try to auto-attach a PR by matching the workspace branch */
  attachPr: async (
    workspaceId: string,
    data: AttachExistingPrRequest
  ): Promise<Result<AttachPrResponse, PrError>> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/pull-requests/attach`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponseAsResult<AttachPrResponse, PrError>(response);
  },

  startDevServer: async (workspaceId: string): Promise<ExecutionProcess[]> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/execution/dev-server/start`,
      {
        method: 'POST',
      }
    );
    return handleApiResponse<ExecutionProcess[]>(response);
  },

  setupGhCli: async (workspaceId: string): Promise<ExecutionProcess> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/integration/github/cli/setup`,
      {
        method: 'POST',
      }
    );
    return handleApiResponse<ExecutionProcess, GhCliSetupError>(response);
  },

  runSetupScript: async (
    workspaceId: string
  ): Promise<Result<ExecutionProcess, RunScriptError>> => {
    const sessions = await sessionsApi.getByWorkspace(workspaceId);
    const session =
      sessions[0] ??
      (await sessionsApi.create({
        workspace_id: workspaceId,
      }));

    return sessionsApi.runSetupScript(session.id);
  },

  runCleanupScript: async (
    workspaceId: string
  ): Promise<Result<ExecutionProcess, RunScriptError>> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/execution/cleanup`,
      {
        method: 'POST',
      }
    );
    return handleApiResponseAsResult<ExecutionProcess, RunScriptError>(
      response
    );
  },

  runArchiveScript: async (
    workspaceId: string
  ): Promise<Result<ExecutionProcess, RunScriptError>> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/execution/archive`,
      {
        method: 'POST',
      }
    );
    return handleApiResponseAsResult<ExecutionProcess, RunScriptError>(
      response
    );
  },

  getPrComments: async (
    workspaceId: string,
    repoId: string
  ): Promise<PrCommentsResponse> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/pull-requests/comments?repo_id=${encodeURIComponent(repoId)}`
    );
    return handleApiResponse<PrCommentsResponse>(response);
  },

  /** Mark all coding agent turns for a workspace as seen */
  markSeen: async (workspaceId: string): Promise<void> => {
    const response = await makeRequest(`/api/workspaces/${workspaceId}/seen`, {
      method: 'PUT',
    });
    return handleApiResponse<void>(response);
  },

  /** Create a workspace directly from a pull request */
  createFromPr: async (
    data: CreateWorkspaceFromPrBody
  ): Promise<Result<CreateWorkspaceFromPrResponse, CreateFromPrError>> => {
    const response = await makeRequest('/api/workspaces/from-pr', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponseAsResult<
      CreateWorkspaceFromPrResponse,
      CreateFromPrError
    >(response);
  },
};

// Execution Process APIs
export const executionProcessesApi = {
  getDetails: async (processId: string): Promise<ExecutionProcess> => {
    const response = await makeRequest(`/api/execution-processes/${processId}`);
    return handleApiResponse<ExecutionProcess>(response);
  },

  getRepoStates: async (
    processId: string
  ): Promise<ExecutionProcessRepoState[]> => {
    const response = await makeRequest(
      `/api/execution-processes/${processId}/repo-states`
    );
    return handleApiResponse<ExecutionProcessRepoState[]>(response);
  },

  stopExecutionProcess: async (processId: string): Promise<void> => {
    const response = await makeRequest(
      `/api/execution-processes/${processId}/stop`,
      {
        method: 'POST',
      }
    );
    return handleApiResponse<void>(response);
  },

  getConcurrencyStatus: async (): Promise<ConcurrencyStatus> => {
    const response = await makeRequest(
      '/api/execution-processes/concurrency-status'
    );
    return handleApiResponse<ConcurrencyStatus>(response);
  },
};

// Concurrency semaphore status snapshot. Declared inline so this branch
// does not require regenerating shared/types.ts; the backend types (see
// crates/server/src/routes/execution_processes.rs) already emit these
// via ts-rs and infrastructure will replace this block on the next
// generate-types run.
export interface QueuedExecutionSummary {
  id: string;
  session_id: string;
  workspace_id: string;
  /** 1-based FIFO position (1 = next to run). */
  position: number;
}

export interface ConcurrencyStatus {
  /** Configured limit. `0` means unlimited — UI should hide the indicator. */
  limit: number;
  /** Number of coding-agent processes currently holding a slot. */
  used: number;
  queued: QueuedExecutionSummary[];
}

// File System APIs
export const fileSystemApi = {
  list: async (path?: string): Promise<DirectoryListResponse> => {
    const queryParam = path ? `?path=${encodeURIComponent(path)}` : '';
    const response = await makeRequest(
      `/api/filesystem/directory${queryParam}`
    );
    return handleApiResponse<DirectoryListResponse>(response);
  },

  listGitRepos: async (path?: string): Promise<DirectoryEntry[]> => {
    const queryParam = path ? `?path=${encodeURIComponent(path)}` : '';
    const response = await makeRequest(
      `/api/filesystem/git-repos${queryParam}`
    );
    return handleApiResponse<DirectoryEntry[]>(response);
  },
};

// CI Pipeline Studio APIs
export const ciStudioApi = {
  /** Commit compiled workflow files to a fresh branch and open a PR. */
  compilePr: async (
    request: CreateCiPipelinePrRequest
  ): Promise<CreateCiPipelinePrResponse> => {
    const response = await makeRequest('/api/ci-studio/compile-pr', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    return handleApiResponse<CreateCiPipelinePrResponse>(response);
  },
};

// Repo APIs
export const repoApi = {
  list: async (hostId?: string | null): Promise<Repo[]> => {
    const response = await makeHostAwareRequest('/api/repos', hostId);
    return handleApiResponse<Repo[]>(response);
  },

  listRecent: async (): Promise<Repo[]> => {
    const response = await makeRequest('/api/repos/recent');
    return handleApiResponse<Repo[]>(response);
  },

  getById: async (repoId: string, hostId?: string | null): Promise<Repo> => {
    const response = await makeHostAwareRequest(`/api/repos/${repoId}`, hostId);
    return handleApiResponse<Repo>(response);
  },

  update: async (
    repoId: string,
    data: UpdateRepo,
    hostId?: string | null
  ): Promise<Repo> => {
    const response = await makeHostAwareRequest(
      `/api/repos/${repoId}`,
      hostId,
      {
        method: 'PUT',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<Repo>(response);
  },

  delete: async (repoId: string, hostId?: string | null): Promise<void> => {
    const response = await makeHostAwareRequest(
      `/api/repos/${repoId}`,
      hostId,
      {
        method: 'DELETE',
      }
    );
    return handleApiResponse<void>(response);
  },

  register: async (
    data: {
      path: string;
      display_name?: string;
    },
    hostId?: string | null
  ): Promise<Repo> => {
    const response = await makeHostAwareRequest('/api/repos', hostId, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<Repo>(response);
  },

  getBranches: async (
    repoId: string,
    hostId?: string | null
  ): Promise<GitBranch[]> => {
    const response = await makeHostAwareRequest(
      `/api/repos/${repoId}/branches`,
      hostId
    );
    return handleApiResponse<GitBranch[]>(response);
  },

  /** Tags with their target commit (plain `git tag` order). */
  getTags: async (
    repoId: string
  ): Promise<{ name: string; target_oid: string }[]> => {
    const response = await makeRequest(`/api/repos/${repoId}/tags`);
    return handleApiResponse<{ name: string; target_oid: string }[]>(response);
  },

  /** Directory listing at a commit (editor snapshot tree). */
  getCommitTree: async (
    repoId: string,
    oid: string,
    path = ''
  ): Promise<{ name: string; is_directory: boolean }[]> => {
    const response = await makeRequest(
      `/api/repos/${repoId}/commits/${encodeURIComponent(oid)}/tree?path=${encodeURIComponent(path)}`
    );
    return handleApiResponse<{ name: string; is_directory: boolean }[]>(
      response
    );
  },

  /** Unified diff of one file in a commit (editor diff tabs). */
  getCommitFileDiff: async (
    repoId: string,
    oid: string,
    path: string
  ): Promise<{ patch: string }> => {
    const response = await makeRequest(
      `/api/repos/${repoId}/commits/${encodeURIComponent(oid)}/file-diff?path=${encodeURIComponent(path)}`
    );
    return handleApiResponse<{ patch: string }>(response);
  },

  /** Read-only file content at a commit (editor snapshots). */
  getCommitFile: async (
    repoId: string,
    oid: string,
    path: string
  ): Promise<{ content: string }> => {
    const response = await makeRequest(
      `/api/repos/${repoId}/commits/${encodeURIComponent(oid)}/file?path=${encodeURIComponent(path)}`
    );
    return handleApiResponse<{ content: string }>(response);
  },

  /** Full detail of one commit (message, identity, per-file line stats). */
  getCommit: async (
    repoId: string,
    oid: string
  ): Promise<{
    oid: string;
    short_oid: string;
    message: string;
    author: string;
    author_email: string;
    committed_at: string;
    parent_oids: string[];
    files: Array<{
      path: string;
      status: 'added' | 'deleted' | 'modified' | 'renamed';
      additions: number;
      deletions: number;
    }>;
    additions: number;
    deletions: number;
  }> => {
    const response = await makeRequest(
      `/api/repos/${repoId}/commits/${encodeURIComponent(oid)}`
    );
    return handleApiResponse(response);
  },

  /** Index of a commit within the fleet-graph ordering (null = not there). */
  locateGraphCommit: async (
    repoId: string,
    base: string,
    tips: string[],
    oid: string
  ): Promise<{ index: number | null }> => {
    const params = new URLSearchParams({ base, tips: tips.join(','), oid });
    const response = await makeRequest(
      `/api/repos/${repoId}/graph/locate?${params}`
    );
    return handleApiResponse<{ index: number | null }>(response);
  },

  // Fleet graph (SHELL-SPEC V4). Types mirror crates/git FleetGraph inline
  // (like the editor endpoints — not part of generate_types).
  getGraph: async (
    repoId: string,
    base: string,
    tips: string[],
    limit = 100,
    offset = 0
  ): Promise<{
    base_branch: string;
    commits: Array<{
      oid: string;
      short_oid: string;
      parent_oids: string[];
      summary: string;
      author: string;
      committed_at: string;
      branch: string | null;
      tip_of: string[];
    }>;
    tips: Array<{
      branch: string;
      oid: string;
      ahead_from_base: number;
      behind_from_base: number;
    }>;
    has_more: boolean;
  }> => {
    const params = new URLSearchParams({
      base,
      tips: tips.join(','),
      limit: String(limit),
      offset: String(offset),
    });
    const response = await makeRequest(`/api/repos/${repoId}/graph?${params}`);
    return handleApiResponse(response);
  },

  init: async (
    data: {
      parent_path: string;
      folder_name: string;
    },
    hostId?: string | null
  ): Promise<Repo> => {
    const response = await makeHostAwareRequest('/api/repos/init', hostId, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<Repo>(response);
  },

  getBatch: async (ids: string[]): Promise<Repo[]> => {
    const response = await makeRequest('/api/repos/batch', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
    return handleApiResponse<Repo[]>(response);
  },

  openEditor: async (
    repoId: string,
    data: OpenEditorRequest
  ): Promise<OpenEditorResponse> => {
    const response = await makeRequest(`/api/repos/${repoId}/open-editor`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<OpenEditorResponse>(response);
  },

  searchFiles: async (
    repoId: string,
    query: string,
    mode?: SearchMode,
    options?: RequestInit
  ): Promise<SearchResult[]> => {
    const modeParam = mode ? `&mode=${encodeURIComponent(mode)}` : '';
    const response = await makeRequest(
      `/api/repos/${repoId}/search?q=${encodeURIComponent(query)}${modeParam}`,
      options
    );
    return handleApiResponse<SearchResult[]>(response);
  },

  listOpenPrs: async (
    repoId: string,
    remoteName?: string
  ): Promise<Result<PullRequestDetail[], ListPrsError>> => {
    const params = remoteName
      ? `?remote=${encodeURIComponent(remoteName)}`
      : '';
    const response = await makeRequest(`/api/repos/${repoId}/prs${params}`);
    return handleApiResponseAsResult<PullRequestDetail[], ListPrsError>(
      response
    );
  },

  listRemotes: async (repoId: string): Promise<GitRemote[]> => {
    const response = await makeRequest(`/api/repos/${repoId}/remotes`);
    return handleApiResponse<GitRemote[]>(response);
  },

  /** Create a local branch at a commit (fleet graph inline action). */
  createBranchAt: async (
    repoId: string,
    name: string,
    atOid: string
  ): Promise<void> => {
    const response = await makeRequest(`/api/repos/${repoId}/branches`, {
      method: 'POST',
      body: JSON.stringify({ name, at_oid: atOid }),
    });
    return handleApiResponse<void>(response);
  },
};

// Issue PR linking APIs
export const issuePrsApi = {
  getPrInfo: async (
    url: string
  ): Promise<Result<PullRequestDetail, ListPrsError>> => {
    const response = await makeRequest(
      `/api/repos/pr-info?url=${encodeURIComponent(url)}`
    );
    return handleApiResponseAsResult<PullRequestDetail, ListPrsError>(response);
  },

  linkToIssue: async (data: LinkPrToIssueRequest): Promise<void> => {
    const response = await makeRequest('/api/remote/pull-requests/link', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    await handleApiResponse<void>(response);
  },
};

// Config APIs (backwards compatible)
export const configApi = {
  getConfig: async (hostId?: string | null): Promise<UserSystemInfo> => {
    const response = await makeHostAwareRequest('/api/info', hostId, {
      cache: 'no-store',
    });
    return handleApiResponse<UserSystemInfo>(response);
  },
  saveConfig: async (
    config: Config,
    hostId?: string | null
  ): Promise<Config> => {
    const response = await makeHostAwareRequest('/api/config', hostId, {
      method: 'PUT',
      body: JSON.stringify(config),
    });
    return handleApiResponse<Config>(response);
  },
  checkEditorAvailability: async (
    editorType: EditorType
  ): Promise<CheckEditorAvailabilityResponse> => {
    const response = await makeRequest(
      `/api/editors/check-availability?editor_type=${encodeURIComponent(editorType)}`
    );
    return handleApiResponse<CheckEditorAvailabilityResponse>(response);
  },
  checkAgentAvailability: async (
    agent: BaseCodingAgent
  ): Promise<AvailabilityInfo> => {
    const response = await makeRequest(
      `/api/agents/check-availability?executor=${encodeURIComponent(agent)}`
    );
    return handleApiResponse<AvailabilityInfo>(response);
  },
};

// Task Tags APIs (all tags are global)
export const tagsApi = {
  list: async (params?: TagSearchParams): Promise<Tag[]> => {
    const queryParam = params?.search
      ? `?search=${encodeURIComponent(params.search)}`
      : '';
    const response = await makeRequest(`/api/tags${queryParam}`);
    return handleApiResponse<Tag[]>(response);
  },

  create: async (data: CreateTag): Promise<Tag> => {
    const response = await makeRequest('/api/tags', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<Tag>(response);
  },

  update: async (tagId: string, data: UpdateTag): Promise<Tag> => {
    const response = await makeRequest(`/api/tags/${tagId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return handleApiResponse<Tag>(response);
  },

  delete: async (tagId: string): Promise<void> => {
    const response = await makeRequest(`/api/tags/${tagId}`, {
      method: 'DELETE',
    });
    return handleApiResponse<void>(response);
  },
};

// MCP Servers APIs
export const mcpServersApi = {
  load: async (
    query: McpServerQuery,
    hostId?: string | null
  ): Promise<GetMcpServerResponse> => {
    const params = new URLSearchParams(query);
    const response = await makeHostAwareRequest(
      `/api/mcp-config?${params.toString()}`,
      hostId
    );
    return handleApiResponse<GetMcpServerResponse>(response);
  },
  save: async (
    query: McpServerQuery,
    data: UpdateMcpServersBody,
    hostId?: string | null
  ): Promise<void> => {
    const params = new URLSearchParams(query);
    // params.set('profile', profile);
    const response = await makeHostAwareRequest(
      `/api/mcp-config?${params.toString()}`,
      hostId,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    if (!response.ok) {
      const errorData = await response.json();
      console.error('[API Error] Failed to save MCP servers', {
        message: errorData.message,
        status: response.status,
        response,
        timestamp: new Date().toISOString(),
      });
      throw new ApiError(
        errorData.message || 'Failed to save MCP servers',
        response.status,
        response
      );
    }
  },
};

// Profiles API
export const profilesApi = {
  load: async (
    hostId?: string | null
  ): Promise<{ content: string; path: string }> => {
    const response = await makeHostAwareRequest('/api/profiles', hostId);
    return handleApiResponse<{ content: string; path: string }>(response);
  },
  save: async (content: string, hostId?: string | null): Promise<string> => {
    const response = await makeHostAwareRequest('/api/profiles', hostId, {
      method: 'PUT',
      body: content,
      headers: {
        'Content-Type': 'application/json',
      },
    });
    return handleApiResponse<string>(response);
  },
};

// Workspace attachments API
export const attachmentsApi = {
  upload: async (attachment: File): Promise<AttachmentResponse> => {
    const formData = new FormData();
    formData.append('image', attachment);

    const response = await makeLocalApiRequest('/api/attachments/upload', {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new ApiError(
        `Failed to upload attachment: ${errorText}`,
        response.status,
        response
      );
    }

    return handleApiResponse<AttachmentResponse>(response);
  },

  uploadForTask: async (
    taskId: string,
    attachment: File
  ): Promise<AttachmentResponse> => {
    const formData = new FormData();
    formData.append('image', attachment);

    const response = await makeLocalApiRequest(
      `/api/attachments/task/${taskId}/upload`,
      {
        method: 'POST',
        body: formData,
        credentials: 'include',
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new ApiError(
        `Failed to upload attachment: ${errorText}`,
        response.status,
        response
      );
    }

    return handleApiResponse<AttachmentResponse>(response);
  },

  uploadForAttempt: async (
    workspaceId: string,
    sessionId: string,
    attachment: File
  ): Promise<AttachmentResponse> => {
    const formData = new FormData();
    formData.append('image', attachment);

    const response = await makeLocalApiRequest(
      `/api/workspaces/${workspaceId}/attachments/upload?session_id=${sessionId}`,
      {
        method: 'POST',
        body: formData,
        credentials: 'include',
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new ApiError(
        `Failed to upload attachment: ${errorText}`,
        response.status,
        response
      );
    }

    return handleApiResponse<AttachmentResponse>(response);
  },

  delete: async (attachmentId: string): Promise<void> => {
    const response = await makeRequest(`/api/attachments/${attachmentId}`, {
      method: 'DELETE',
    });
    return handleApiResponse<void>(response);
  },

  getTaskAttachments: async (taskId: string): Promise<AttachmentResponse[]> => {
    const response = await makeRequest(`/api/attachments/task/${taskId}`);
    return handleApiResponse<AttachmentResponse[]>(response);
  },

  getAttachmentUrl: (attachmentId: string): string => {
    return `/api/attachments/${attachmentId}/file`;
  },
};

// Approval API
export const approvalsApi = {
  respond: async (
    approvalId: string,
    payload: ApprovalResponse,
    signal?: AbortSignal
  ): Promise<ApprovalStatus> => {
    const res = await makeRequest(`/api/approvals/${approvalId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    return handleApiResponse<ApprovalStatus>(res);
  },
};

// OAuth API
export type AuthMethodsResponse = {
  local_auth_enabled: boolean;
  oauth_providers: string[];
};

export const oauthApi = {
  authMethods: async (): Promise<AuthMethodsResponse> => {
    const response = await makeRequest('/api/auth/methods', {
      cache: 'no-store',
    });
    return handleApiResponse<AuthMethodsResponse>(response);
  },

  handoffInit: async (
    provider: string,
    returnTo: string
  ): Promise<{ handoff_id: string; authorize_url: string }> => {
    const response = await makeRequest('/api/auth/handoff/init', {
      method: 'POST',
      body: JSON.stringify({ provider, return_to: returnTo }),
    });
    return handleApiResponse<{ handoff_id: string; authorize_url: string }>(
      response
    );
  },

  status: async (): Promise<StatusResponse> => {
    const response = await makeRequest('/api/auth/status', {
      cache: 'no-store',
    });
    return handleApiResponse<StatusResponse>(response);
  },

  localLogin: async (
    email: string,
    password: string
  ): Promise<ProfileResponse> => {
    const response = await makeRequest('/api/auth/local/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    return handleApiResponse<ProfileResponse>(response);
  },

  logout: async (): Promise<void> => {
    const response = await makeRequest('/api/auth/logout', {
      method: 'POST',
    });
    if (!response.ok) {
      throw new ApiError(
        `Logout failed with status ${response.status}`,
        response.status,
        response
      );
    }
  },

  /** Returns the current access token for the remote server (auto-refreshes if needed) */
  getToken: async (): Promise<TokenResponse> => {
    const response = await makeRequest('/api/auth/token');
    if (response.status === 401) {
      throw new ApiError('Unauthorized', 401, response);
    }
    return handleApiResponse<TokenResponse>(response);
  },

  /** Returns the user ID of the currently authenticated user */
  getCurrentUser: async (): Promise<CurrentUserResponse> => {
    const response = await makeRequest('/api/auth/user');
    return handleApiResponse<CurrentUserResponse>(response);
  },
};

/**
 * @deprecated Use `tokenManager.getToken()` from
 * `@/shared/lib/auth/tokenManager` instead.
 * This function does not handle 401 responses or token refresh coordination.
 */
export async function getCachedToken(): Promise<string | null> {
  const { tokenManager } = await import('@/shared/lib/auth/tokenManager');
  return tokenManager.getToken();
}

const handleRemoteResponse = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    let errorMessage = `Request failed with status ${response.status}`;

    try {
      const body = (await response.json()) as {
        error?: string;
        message?: string;
      };
      errorMessage = body.error || body.message || errorMessage;
    } catch {
      errorMessage = response.statusText || errorMessage;
    }

    throw new ApiError(errorMessage, response.status, response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
};

// Organizations API
export const organizationsApi = {
  getMembers: async (
    orgId: string
  ): Promise<OrganizationMemberWithProfile[]> => {
    const response = await makeRemoteRequest(
      `/v1/organizations/${orgId}/members`
    );
    const result = await handleRemoteResponse<ListMembersResponse>(response);
    return result.members;
  },

  getUserOrganizations: async (): Promise<ListOrganizationsResponse> => {
    const response = await makeRemoteRequest('/v1/organizations');
    return handleRemoteResponse<ListOrganizationsResponse>(response);
  },

  createOrganization: async (
    data: CreateOrganizationRequest
  ): Promise<CreateOrganizationResponse> => {
    const response = await makeRemoteRequest('/v1/organizations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleRemoteResponse<CreateOrganizationResponse>(response);
  },

  createInvitation: async (
    orgId: string,
    data: CreateInvitationRequest
  ): Promise<CreateInvitationResponse> => {
    const response = await makeRemoteRequest(
      `/v1/organizations/${orgId}/invitations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }
    );
    return handleRemoteResponse<CreateInvitationResponse>(response);
  },

  removeMember: async (orgId: string, userId: string): Promise<void> => {
    const response = await makeRemoteRequest(
      `/v1/organizations/${orgId}/members/${userId}`,
      {
        method: 'DELETE',
      }
    );
    return handleRemoteResponse<void>(response);
  },

  updateMemberRole: async (
    orgId: string,
    userId: string,
    data: UpdateMemberRoleRequest
  ): Promise<UpdateMemberRoleResponse> => {
    const response = await makeRemoteRequest(
      `/v1/organizations/${orgId}/members/${userId}/role`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }
    );
    return handleRemoteResponse<UpdateMemberRoleResponse>(response);
  },

  listInvitations: async (orgId: string): Promise<Invitation[]> => {
    const response = await makeRemoteRequest(
      `/v1/organizations/${orgId}/invitations`
    );
    const result =
      await handleRemoteResponse<ListInvitationsResponse>(response);
    return result.invitations;
  },

  revokeInvitation: async (
    orgId: string,
    invitationId: string
  ): Promise<void> => {
    const body: RevokeInvitationRequest = { invitation_id: invitationId };
    const response = await makeRemoteRequest(
      `/v1/organizations/${orgId}/invitations/revoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    return handleRemoteResponse<void>(response);
  },

  getBillingStatus: async (
    orgId: string
  ): Promise<OrganizationBillingStatusResponse> => {
    const response = await makeRemoteRequest(
      `/v1/organizations/${orgId}/billing`
    );
    return handleRemoteResponse<OrganizationBillingStatusResponse>(response);
  },

  createPortalSession: async (
    orgId: string,
    returnUrl: string
  ): Promise<{ url: string }> => {
    const response = await makeRemoteRequest(
      `/v1/organizations/${orgId}/billing/portal`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          return_url: returnUrl,
        }),
      }
    );
    return handleRemoteResponse<{ url: string }>(response);
  },

  deleteOrganization: async (orgId: string): Promise<void> => {
    const response = await makeRemoteRequest(`/v1/organizations/${orgId}`, {
      method: 'DELETE',
    });
    return handleRemoteResponse<void>(response);
  },
};

export const remoteProjectsApi = {
  listByOrganization: async (
    organizationId: string
  ): Promise<RemoteProject[]> => {
    const response = await makeRequest(
      `/api/remote/projects?organization_id=${encodeURIComponent(organizationId)}`
    );
    const result =
      await handleApiResponse<ListRemoteProjectsResponse>(response);
    return result.projects;
  },
};

// Repo Issues API
export const repoIssuesApi = {
  list: async (repoId: string): Promise<RepoIssue[]> => {
    const response = await makeRequest(
      `/api/repos/${encodeURIComponent(repoId)}/issues`
    );
    return handleApiResponse<RepoIssue[]>(response);
  },
  sync: async (repoId: string): Promise<RepoIssue[]> => {
    const response = await makeRequest(
      `/api/repos/${encodeURIComponent(repoId)}/issues/sync`,
      { method: 'POST' }
    );
    return handleApiResponse<RepoIssue[]>(response);
  },
  setPriority: async (
    repoId: string,
    issueNumber: number,
    priority: import('@/features/issues/types').IssuePriority | null
  ): Promise<RepoIssue> => {
    const response = await makeRequest(
      `/api/repos/${encodeURIComponent(repoId)}/issues/${issueNumber}/priority`,
      { method: 'PUT', body: JSON.stringify({ priority }) }
    );
    return handleApiResponse<RepoIssue>(response);
  },
  addLabel: async (
    repoId: string,
    issueNumber: number,
    label: string,
    color?: string
  ): Promise<RepoIssue> => {
    const response = await makeRequest(
      `/api/repos/${encodeURIComponent(repoId)}/issues/${issueNumber}/labels`,
      { method: 'POST', body: JSON.stringify({ label, color }) }
    );
    return handleApiResponse<RepoIssue>(response);
  },
  removeLabel: async (
    repoId: string,
    issueNumber: number,
    labelName: string
  ): Promise<RepoIssue> => {
    const response = await makeRequest(
      `/api/repos/${encodeURIComponent(repoId)}/issues/${issueNumber}/labels/${encodeURIComponent(labelName)}`,
      { method: 'DELETE' }
    );
    return handleApiResponse<RepoIssue>(response);
  },
  closeIssue: async (
    repoId: string,
    issueNumber: number
  ): Promise<RepoIssue> => {
    const response = await makeRequest(
      `/api/repos/${encodeURIComponent(repoId)}/issues/${issueNumber}/close`,
      { method: 'POST' }
    );
    return handleApiResponse<RepoIssue>(response);
  },
  listMilestones: async (repoId: string): Promise<GithubMilestone[]> => {
    const response = await makeRequest(
      `/api/repos/${encodeURIComponent(repoId)}/milestones`
    );
    return handleApiResponse<GithubMilestone[]>(response);
  },
  /** Archive (`open: false`) or restore a milestone on GitHub. */
  setMilestoneOpen: async (
    repoId: string,
    number: number,
    open: boolean
  ): Promise<GithubMilestone> => {
    const response = await makeRequest(
      `/api/repos/${encodeURIComponent(repoId)}/milestones/${number}/state`,
      { method: 'PUT', body: JSON.stringify({ open }) }
    );
    return handleApiResponse<GithubMilestone>(response);
  },
  comment: async (
    repoId: string,
    issueNumber: number,
    body: string
  ): Promise<void> => {
    const response = await makeRequest(
      `/api/repos/${encodeURIComponent(repoId)}/issues/${issueNumber}/comments`,
      { method: 'POST', body: JSON.stringify({ body }) }
    );
    return handleApiResponse<void>(response);
  },
};

// Scratch API
export const scratchApi = {
  create: async (
    scratchType: ScratchType,
    id: string,
    data: CreateScratch
  ): Promise<Scratch> => {
    const response = await makeRequest(`/api/scratch/${scratchType}/${id}`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<Scratch>(response);
  },

  get: async (scratchType: ScratchType, id: string): Promise<Scratch> => {
    const response = await makeRequest(`/api/scratch/${scratchType}/${id}`);
    return handleApiResponse<Scratch>(response);
  },

  update: async (
    scratchType: ScratchType,
    id: string,
    data: UpdateScratch
  ): Promise<void> => {
    const response = await makeRequest(`/api/scratch/${scratchType}/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return handleApiResponse<void>(response);
  },

  delete: async (scratchType: ScratchType, id: string): Promise<void> => {
    const response = await makeRequest(`/api/scratch/${scratchType}/${id}`, {
      method: 'DELETE',
    });
    return handleApiResponse<void>(response);
  },

  getStreamUrl: (scratchType: ScratchType, id: string): string =>
    `/api/scratch/${scratchType}/${id}/stream/ws`,
};

// Agents API
export const agentsApi = {
  getDiscoveredOptionsStreamUrl: (
    agent: BaseCodingAgent,
    opts?: { workspaceId?: string; sessionId?: string; repoId?: string }
  ): string => {
    const params = new URLSearchParams();
    params.set('executor', agent);
    if (opts?.workspaceId) params.set('workspace_id', opts.workspaceId);
    if (opts?.sessionId) params.set('session_id', opts.sessionId);
    if (opts?.repoId) params.set('repo_id', opts.repoId);

    return `/api/agents/discovered-options/ws?${params.toString()}`;
  },

  getPresetOptions: async (
    query: AgentPresetOptionsQuery
  ): Promise<ExecutorConfig> => {
    const params = new URLSearchParams();
    params.set('executor', query.executor);
    if (query.variant) params.set('variant', query.variant);
    const response = await makeRequest(
      `/api/agents/preset-options?${params.toString()}`
    );
    return handleApiResponse<ExecutorConfig>(response);
  },

  getGuidelines: async (): Promise<AgentGuidelines> => {
    const response = await makeRequest('/api/agents/guidelines');
    return handleApiResponse<AgentGuidelines>(response);
  },

  saveGuidelines: async (
    data: SaveAgentGuidelinesRequest
  ): Promise<AgentGuidelines> => {
    const response = await makeRequest('/api/agents/guidelines', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleApiResponse<AgentGuidelines>(response);
  },
};

// Queue API for session follow-up messages
export const queueApi = {
  /**
   * Queue a follow-up message to be executed when current execution finishes
   */
  queue: async (
    sessionId: string,
    data: DraftFollowUpData
  ): Promise<QueueStatus> => {
    const response = await makeRequest(`/api/sessions/${sessionId}/queue`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<QueueStatus>(response);
  },

  /**
   * Cancel a queued follow-up message
   */
  cancel: async (sessionId: string): Promise<QueueStatus> => {
    const response = await makeRequest(`/api/sessions/${sessionId}/queue`, {
      method: 'DELETE',
    });
    return handleApiResponse<QueueStatus>(response);
  },

  /**
   * Get the current queue status for a session
   */
  getStatus: async (sessionId: string): Promise<QueueStatus> => {
    const response = await makeRequest(`/api/sessions/${sessionId}/queue`);
    return handleApiResponse<QueueStatus>(response);
  },
};

// Relay API
export const relayApi = {
  getEnrollmentCode: async (): Promise<{ enrollment_code: string }> => {
    const response = await makeRequest(
      '/api/relay-auth/server/enrollment-code',
      {
        method: 'POST',
      }
    );
    return handleApiResponse<{ enrollment_code: string }>(response);
  },

  listPairedClients: async (): Promise<RelayPairedClient[]> => {
    const response = await makeRequest('/api/relay-auth/server/clients');
    const body =
      await handleApiResponse<ListRelayPairedClientsResponse>(response);
    return body.clients;
  },

  removePairedClient: async (
    clientId: string
  ): Promise<RemoveRelayPairedClientResponse> => {
    const response = await makeRequest(
      `/api/relay-auth/server/clients/${encodeURIComponent(clientId)}`,
      {
        method: 'DELETE',
      }
    );
    return handleApiResponse<RemoveRelayPairedClientResponse>(response);
  },

  pairRelayHost: async (
    payload: PairRelayHostRequest
  ): Promise<PairRelayHostResponse> => {
    const response = await makeRequest('/api/relay-auth/client/pair', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return handleApiResponse<PairRelayHostResponse>(response);
  },

  listPairedRelayHosts: async (): Promise<RelayPairedHost[]> => {
    const response = await makeRequest('/api/relay-auth/client/hosts');
    const body =
      await handleApiResponse<ListRelayPairedHostsResponse>(response);
    return body.hosts;
  },

  removePairedRelayHost: async (
    hostId: string
  ): Promise<RemoveRelayPairedHostResponse> => {
    const response = await makeRequest(
      `/api/relay-auth/client/hosts/${encodeURIComponent(hostId)}`,
      {
        method: 'DELETE',
      }
    );
    return handleApiResponse<RemoveRelayPairedHostResponse>(response);
  },

  openRemoteWorkspaceInEditor: async (
    payload: OpenRemoteWorkspaceInEditorRequest
  ): Promise<OpenRemoteEditorResponse> => {
    const response = await makeRequest('/api/open-remote-editor/workspace', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return handleApiResponse<OpenRemoteEditorResponse>(response);
  },
};

/**
 * Which credential the current authenticated GitHub session is using.
 * Kept local until `shared/types.ts` is regenerated from the backend.
 */
export type GithubAuthMethod = 'pat' | 'gh_cli';

/**
 * Extension of the generated `GithubStatusResponse` with the PAT-related
 * fields added by the PAT auth work. Once `shared/types.ts` is
 * regenerated these fields will move onto the base type and this alias
 * can be dropped.
 */
export type GithubStatusResponseWithPat = GithubStatusResponse & {
  has_pat: boolean;
  auth_method: GithubAuthMethod | null;
};

export interface GithubPatLoginResponse {
  username: string;
}

// GitHub API (local `gh` CLI-backed, with optional PAT fallback for hosts
// where `gh` isn't installed).
export const githubApi = {
  getStatus: async (): Promise<GithubStatusResponseWithPat> => {
    const response = await makeRequest('/api/github/status');
    return handleApiResponse<GithubStatusResponseWithPat>(response);
  },

  login: async (): Promise<GithubLoginResponse> => {
    const response = await makeRequest('/api/github/login', {
      method: 'POST',
    });
    return handleApiResponse<GithubLoginResponse>(response);
  },

  loginWithPat: async (pat: string): Promise<GithubPatLoginResponse> => {
    const response = await makeRequest('/api/github/login/pat', {
      method: 'POST',
      body: JSON.stringify({ pat }),
    });
    return handleApiResponse<GithubPatLoginResponse>(response);
  },

  disconnectPat: async (): Promise<void> => {
    const response = await makeRequest('/api/github/pat', {
      method: 'DELETE',
    });
    await handleApiResponse<void>(response);
  },

  logout: async (): Promise<void> => {
    const response = await makeRequest('/api/github/logout', {
      method: 'POST',
    });
    await handleApiResponse<void>(response);
  },

  installCli: async (): Promise<GithubCliInstallResponse> => {
    const response = await makeRequest('/api/github/cli/install', {
      method: 'POST',
    });
    return handleApiResponse<GithubCliInstallResponse>(response);
  },

  listRepos: async (): Promise<GitHubRepoSummary[]> => {
    const response = await makeRequest('/api/github/repos');
    return handleApiResponse<GitHubRepoSummary[]>(response);
  },

  clone: async (data: CloneRepoRequest): Promise<CloneRepoResponse> => {
    const response = await makeRequest('/api/github/clone', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<CloneRepoResponse>(response);
  },
};

// Misiones del Director (en la UI, "Fluke").
export const missionsApi = {
  list: async (): Promise<MissionSummary[]> => {
    const response = await makeRequest('/api/missions');
    return handleApiResponse<MissionSummary[]>(response);
  },
  get: async (id: string): Promise<MissionDetail> => {
    const response = await makeRequest(`/api/missions/${id}`);
    return handleApiResponse<MissionDetail>(response);
  },
  create: async (repoId: string): Promise<MissionDetail> => {
    const response = await makeRequest('/api/missions', {
      method: 'POST',
      body: JSON.stringify({ repo_id: repoId }),
    });
    return handleApiResponse<MissionDetail>(response);
  },
  update: async (
    id: string,
    data: Partial<UpdateMissionRequest>
  ): Promise<MissionDetail> => {
    const response = await makeRequest(`/api/missions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
    return handleApiResponse<MissionDetail>(response);
  },
  approve: async (
    id: string,
    analystWorkerId?: string
  ): Promise<MissionDetail> => {
    const response = await makeRequest(`/api/missions/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ analyst_worker_id: analystWorkerId ?? null }),
    });
    return handleApiResponse<MissionDetail>(response);
  },
  getWorkspace: async (id: string): Promise<WorkspaceContext> => {
    const response = await makeRequest(`/api/missions/${id}/workspace`);
    return handleApiResponse<WorkspaceContext>(response);
  },
  /** One thread (J1.2): what the user writes next is about this mission. */
  focus: async (id: string): Promise<void> => {
    const response = await makeRequest(`/api/missions/${id}/focus`, {
      method: 'POST',
    });
    return handleApiResponse<void>(response);
  },
  /** The turns of Fluke's thread that had this mission in focus (J1.2). */
  turns: async (id: string): Promise<string[]> => {
    const response = await makeRequest(`/api/missions/${id}/turns`);
    return handleApiResponse<string[]>(response);
  },
  /** Brief items of mission `id`: create one (no item_id) or update it.
   * Fields are merged; an empty string clears one (UpsertMissionItemRequest). */
  upsertItem: async (
    id: string,
    data: {
      item_id?: string | null;
      kind: string;
      title?: string | null;
      fields?: { [key: string]: string };
    }
  ): Promise<MissionDetail> => {
    const response = await makeRequest(`/api/missions/${id}/items`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<MissionDetail>(response);
  },
  /** Remove a brief item of mission `id`. */
  removeItem: async (id: string, itemId: string): Promise<MissionDetail> => {
    const response = await makeRequest(`/api/missions/${id}/items/${itemId}`, {
      method: 'DELETE',
    });
    return handleApiResponse<MissionDetail>(response);
  },
};

// Plan de trabajo del agente (grafo + control de ejecución).
const planPost = async (url: string, body?: unknown): Promise<void> => {
  const response = await makeRequest(url, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleApiResponse<void>(response);
};

export const planApi = {
  get: async (workspaceId: string): Promise<PlanSnapshot | null> => {
    const response = await makeRequest(`/api/plan/${workspaceId}`);
    return handleApiResponse<PlanSnapshot | null>(response);
  },
  getStreamUrl: (workspaceId: string): string =>
    `/api/plan/${workspaceId}/stream/ws`,
  pause: (workspaceId: string, on: boolean) =>
    planPost(`/api/plan/${workspaceId}/pause`, { on }),
  stop: (workspaceId: string) => planPost(`/api/plan/${workspaceId}/stop`),
  play: (workspaceId: string) => planPost(`/api/plan/${workspaceId}/play`),
  // Pregunta de ask_user que espera respuesta (argumentos de la llamada) o null.
  pendingQuestion: async (workspaceId: string): Promise<unknown> => {
    const response = await makeRequest(`/api/plan/${workspaceId}/question`);
    return handleApiResponse<unknown>(response);
  },
  // Respuesta a la pregunta de ask_user: clave de una opción o texto libre.
  // `question` es la pregunta respondida; si ya no es la pendiente, 409.
  answer: (workspaceId: string, question: unknown, answer: string) =>
    planPost(`/api/plan/${workspaceId}/answer`, { question, answer }),
  revert: (workspaceId: string, n: number) =>
    planPost(`/api/plan/${workspaceId}/steps/${n}/revert`),
  cut: (workspaceId: string, n: number, cut: boolean) =>
    planPost(`/api/plan/${workspaceId}/steps/${n}/cut`, { cut }),
  requestRevision: async (
    workspaceId: string,
    n: number,
    request: string
  ): Promise<string> => {
    const response = await makeRequest(
      `/api/plan/${workspaceId}/steps/${n}/revisions`,
      { method: 'POST', body: JSON.stringify({ request }) }
    );
    return handleApiResponse<string>(response);
  },
  acceptRevision: (revisionId: string) =>
    planPost(`/api/plan/revisions/${revisionId}/accept`),
  discardRevision: (revisionId: string) =>
    planPost(`/api/plan/revisions/${revisionId}/discard`),
};

// ============================================================================
// Agent auth (Codex + Gemini + Claude Code connect/disconnect from Settings)
// ============================================================================
//
// These types mirror the ts-rs–exported ones in
// `crates/server/src/routes/agent_auth.rs`. They live here (not in
// `shared/types.ts`) until infrastructure regenerates the shared types file;
// the pattern is the same as `GithubStatusResponseWithPat` above.

export type AgentAuthProvider = 'codex' | 'gemini' | 'claude_code';

export type AgentLoginState = 'pending' | 'completed' | 'failed';

export interface AgentLoginProgress {
  state: AgentLoginState;
  verification_uri: string | null;
  user_code: string | null;
  error: string | null;
}

export interface AgentAuthProviderStatus {
  provider: AgentAuthProvider;
  cli_available: boolean;
  connected: boolean;
  last_auth_at: number | null;
  login: AgentLoginProgress | null;
}

export interface AgentAuthStatusResponse {
  providers: AgentAuthProviderStatus[];
}

export interface AgentLoginRequest {
  api_key?: string | null;
}

export interface AgentLoginSubmitRequest {
  code: string;
}

export interface AgentLoginResponse {
  verification_uri: string | null;
  user_code: string | null;
  completed: boolean;
}

export const agentAuthApi = {
  getStatus: async (): Promise<AgentAuthStatusResponse> => {
    const response = await makeRequest('/api/agents/auth');
    return handleApiResponse<AgentAuthStatusResponse>(response);
  },

  login: async (
    provider: AgentAuthProvider,
    body: AgentLoginRequest = {}
  ): Promise<AgentLoginResponse> => {
    const response = await makeRequest(`/api/agents/auth/${provider}/login`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return handleApiResponse<AgentLoginResponse>(response);
  },

  submitCode: async (
    provider: AgentAuthProvider,
    body: AgentLoginSubmitRequest
  ): Promise<void> => {
    const response = await makeRequest(
      `/api/agents/auth/${provider}/login/submit`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    );
    await handleApiResponse<void>(response);
  },

  cancelLogin: async (provider: AgentAuthProvider): Promise<void> => {
    const response = await makeRequest(
      `/api/agents/auth/${provider}/login/cancel`,
      { method: 'POST' }
    );
    await handleApiResponse<void>(response);
  },

  logout: async (provider: AgentAuthProvider): Promise<void> => {
    const response = await makeRequest(`/api/agents/auth/${provider}/logout`, {
      method: 'POST',
    });
    await handleApiResponse<void>(response);
  },
};

// ============================================================================
// Setup status (onboarding wizard checklist)
// ============================================================================
//
// Mirrors `SetupStatusResponse` in `crates/server/src/routes/setup_status.rs`.
// Declared locally until `shared/types.ts` is regenerated by infrastructure —
// same pattern as `GithubStatusResponseWithPat` and `AgentAuthStatusResponse`
// above.

export interface SetupStatusResponse {
  github_connected: boolean;
  repo_added: boolean;
  agent_connected: boolean;
  task_created: boolean;
  is_complete: boolean;
}

export const setupStatusApi = {
  get: async (): Promise<SetupStatusResponse> => {
    const response = await makeRequest('/api/setup-status');
    return handleApiResponse<SetupStatusResponse>(response);
  },
};

// Workers API
export interface StartAllWorkersItemResponse {
  worker_id: string;
  worker_name: string;
  started: boolean;
  task_title: string | null;
  reason: string | null;
}

export interface StartAllWorkersResponse {
  results: StartAllWorkersItemResponse[];
}

export interface CreateWorkerRequest {
  name: string;
  emoji: string;
  soul: string;
  role?: string;
  /** Coding agent; `null` follows the global default agent. */
  executor?: BaseCodingAgent | null;
  model?: string | null;
  /**
   * Optional per-worker GitHub PAT. Sent write-only; the server never
   * returns it. Empty string or `null` means "no override" — the worker
   * falls back to the machine's global gh credentials.
   */
  github_pat?: string | null;
  /**
   * Per-worker plan mode override. `null` or omitted → follow the global
   * executor profile; `true` → force plan mode on; `false` → force plan
   * mode off for this worker.
   */
  plan_mode?: boolean | null;
}

export type UpdateWorkerRequest = Partial<CreateWorkerRequest>;

export interface ValidateGithubPatResponse {
  /** GitHub login the token belongs to (e.g. "chewax"). */
  login: string;
}

/**
 * Body for POST /workers/{worker_id}/tasks/{task_id}/reassign.
 * Kept locally until `shared/types.ts` is regenerated so the frontend
 * compiles independently of the backend regen step.
 */
export interface ReassignWorkerTaskRequest {
  target_worker_id: string;
}

export const workersApi = {
  list: async (): Promise<WorkerResponse[]> => {
    const response = await makeRequest('/api/workers');
    return handleApiResponse<WorkerResponse[]>(response);
  },

  create: async (data: CreateWorkerRequest): Promise<WorkerResponse> => {
    const response = await makeRequest('/api/workers', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<WorkerResponse>(response);
  },

  update: async (
    workerId: string,
    data: UpdateWorkerRequest
  ): Promise<WorkerResponse> => {
    const response = await makeRequest(`/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
    return handleApiResponse<WorkerResponse>(response);
  },

  delete: async (workerId: string): Promise<void> => {
    const response = await makeRequest(`/api/workers/${workerId}`, {
      method: 'DELETE',
    });
    return handleApiResponse<void>(response);
  },

  archive: async (workerId: string): Promise<WorkerResponse> => {
    const response = await makeRequest(`/api/workers/${workerId}/archive`, {
      method: 'POST',
    });
    return handleApiResponse<WorkerResponse>(response);
  },

  unarchive: async (workerId: string): Promise<WorkerResponse> => {
    const response = await makeRequest(`/api/workers/${workerId}/unarchive`, {
      method: 'POST',
    });
    return handleApiResponse<WorkerResponse>(response);
  },

  listArchived: async (): Promise<WorkerResponse[]> => {
    const response = await makeRequest('/api/workers/archived');
    return handleApiResponse<WorkerResponse[]>(response);
  },

  deleteAllArchived: async (): Promise<{ deleted: number }> => {
    const response = await makeRequest('/api/workers/archived', {
      method: 'DELETE',
    });
    return handleApiResponse<{ deleted: number }>(response);
  },

  /**
   * Bulk-prune every failed worker task. `failed` is terminal (retries spawn
   * fresh tasks), so these cards are history; their archived workspaces are
   * kept, same as the per-card delete.
   */
  deleteAllFailedTasks: async (): Promise<{ deleted: number }> => {
    const response = await makeRequest('/api/workers/failed-tasks', {
      method: 'DELETE',
    });
    return handleApiResponse<{ deleted: number }>(response);
  },

  duplicate: async (workerId: string): Promise<WorkerResponse> => {
    const response = await makeRequest(`/api/workers/${workerId}/duplicate`, {
      method: 'POST',
    });
    return handleApiResponse<WorkerResponse>(response);
  },

  /**
   * Probe a GitHub PAT against `/user`. Returns the token's login on
   * success; throws with the server's rejection reason on failure. The
   * token is not stored — this is a pre-save validation for the form.
   */
  validateGithubPat: async (
    token: string
  ): Promise<ValidateGithubPatResponse> => {
    const response = await makeRequest('/api/workers/validate-github-pat', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    return handleApiResponse<ValidateGithubPatResponse>(response);
  },

  listTasks: async (workerId: string): Promise<WorkerTaskResponse[]> => {
    const response = await makeRequest(`/api/workers/${workerId}/tasks`);
    return handleApiResponse<WorkerTaskResponse[]>(response);
  },

  /**
   * Hand a finished designer deliverable to an analyst. The prompt is
   * composed server-side; the caller only picks the destination and may add
   * a PM note on top. 409 = the design was already handed off.
   */
  createDesignHandoff: async (
    data: CreateDesignHandoffRequest
  ): Promise<WorkerTaskResponse> => {
    const response = await makeRequest('/api/workers/design-handoffs', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<WorkerTaskResponse>(response);
  },

  checkActiveIssueTask: async (
    repoId: string,
    issueNumber: number
  ): Promise<ActiveIssueTaskInfo | null> => {
    const response = await makeRequest(
      `/api/workers/active-issue-task?repo_id=${encodeURIComponent(repoId)}&issue_number=${issueNumber}`
    );
    return handleApiResponse<ActiveIssueTaskInfo | null>(response);
  },

  createTask: async (
    workerId: string,
    data: CreateWorkerTaskRequest & {
      skills?: string[];
      force_duplicate?: boolean;
      source?: string;
    }
  ): Promise<WorkerTaskResponse & { skills: string[] }> => {
    const response = await makeRequest(`/api/workers/${workerId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<WorkerTaskResponse & { skills: string[] }>(
      response
    );
  },

  updateTask: async (
    workerId: string,
    taskId: string,
    data: UpdateWorkerTaskRequest
  ): Promise<WorkerTaskResponse> => {
    const response = await makeRequest(
      `/api/workers/${workerId}/tasks/${taskId}`,
      {
        method: 'PATCH',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<WorkerTaskResponse>(response);
  },

  deleteTask: async (workerId: string, taskId: string): Promise<void> => {
    const response = await makeRequest(
      `/api/workers/${workerId}/tasks/${taskId}`,
      {
        method: 'DELETE',
      }
    );
    return handleApiResponse<void>(response);
  },

  cancelTask: async (workerId: string, taskId: string): Promise<void> => {
    const response = await makeRequest(
      `/api/workers/${workerId}/tasks/${taskId}/cancel`,
      {
        method: 'POST',
      }
    );
    return handleApiResponse<void>(response);
  },

  listDesignArtifacts: async (
    workerId: string,
    taskId: string
  ): Promise<DesignArtifactsResponse> => {
    const response = await makeRequest(
      `/api/workers/${workerId}/tasks/${taskId}/design-artifacts`
    );
    return handleApiResponse<DesignArtifactsResponse>(response);
  },

  approveDesign: async (
    workerId: string,
    taskId: string
  ): Promise<WorkerTaskResponse> => {
    const response = await makeRequest(
      `/api/workers/${workerId}/tasks/${taskId}/approve-design`,
      {
        method: 'POST',
      }
    );
    return handleApiResponse<WorkerTaskResponse>(response);
  },

  getRemediationPrompt: async (
    workerId: string,
    taskId: string
  ): Promise<string> => {
    const response = await makeRequest(
      `/api/workers/${workerId}/tasks/${taskId}/remediation-prompt`
    );
    return handleApiResponse<string>(response);
  },

  reRequestReview: async (workerId: string, taskId: string): Promise<void> => {
    const response = await makeRequest(
      `/api/workers/${workerId}/tasks/${taskId}/re-request-review`,
      {
        method: 'POST',
      }
    );
    return handleApiResponse<void>(response);
  },

  listTaskActions: async <T = unknown>(
    workerId: string,
    taskId: string
  ): Promise<T> => {
    const response = await makeRequest(
      `/api/workers/${workerId}/tasks/${taskId}/actions`
    );
    return handleApiResponse<T>(response);
  },

  retryTaskActions: async <T = unknown>(
    workerId: string,
    taskId: string
  ): Promise<T> => {
    const response = await makeRequest(
      `/api/workers/${workerId}/tasks/${taskId}/retry-actions`,
      {
        method: 'POST',
      }
    );
    return handleApiResponse<T>(response);
  },

  reassignTask: async (
    workerId: string,
    taskId: string,
    targetWorkerId: string
  ): Promise<WorkerTaskResponse> => {
    const response = await makeRequest(
      `/api/workers/${workerId}/tasks/${taskId}/reassign`,
      {
        method: 'POST',
        body: JSON.stringify({
          target_worker_id: targetWorkerId,
        } satisfies ReassignWorkerTaskRequest),
      }
    );
    return handleApiResponse<WorkerTaskResponse>(response);
  },

  startNext: async (workerId: string): Promise<WorkerTaskResponse> => {
    const response = await makeRequest(`/api/workers/${workerId}/start`, {
      method: 'POST',
    });
    return handleApiResponse<WorkerTaskResponse>(response);
  },

  startAll: async (): Promise<StartAllWorkersResponse> => {
    const response = await makeRequest('/api/workers/start-all', {
      method: 'POST',
    });
    return handleApiResponse<StartAllWorkersResponse>(response);
  },
};

export const systemApi = {
  getBaseInstructions: async (): Promise<string> => {
    const response = await makeRequest('/api/system/base-instructions');
    const data = await handleApiResponse<{ content: string }>(response);
    return data.content;
  },

  // Fire-and-forget: wakes the pr_monitor for an immediate full cycle
  // instead of waiting out its 60s interval.
  triggerPrPoll: async (): Promise<void> => {
    const response = await makeRequest('/api/system/pr-poll', {
      method: 'POST',
    });
    return handleApiResponse<void>(response);
  },
};

// Plan limits API — concurrent-agents cap, upsell CTA, cap-hit counters.
// Types mirror `PlanLimitsResponse` in
// `crates/server/src/routes/metrics.rs`; they live here (not in
// `shared/types.ts`) until infrastructure regenerates the shared types file,
// same pattern as the agent-auth shims above.
export interface PlanUpgradeCta {
  label: string;
  url: string;
}

export interface PlanLimitsResponse {
  concurrent_agents_limit: number;
  upgrade_cta: PlanUpgradeCta | null;
  cap_hits_today: number;
  cap_hits_total: number;
}

export const planLimitsApi = {
  get: async (): Promise<PlanLimitsResponse> => {
    const response = await makeRequest('/api/plan-limits');
    return handleApiResponse<PlanLimitsResponse>(response);
  },
};

// License status — drives the licensing banner. Mirrors `LicenseStatusResponse`
// in `crates/server/src/routes/metrics.rs`. `enforced` is false on builds with
// no embedded public key (dev, current fleet); there the status is always
// "valid" and the banner never shows.
export interface LicenseStatusResponse {
  status: 'valid' | 'grace' | 'suspended';
  days_remaining: number | null;
  reason: string | null;
  enforced: boolean;
}

export const licenseApi = {
  get: async (): Promise<LicenseStatusResponse> => {
    const response = await makeRequest('/api/license');
    return handleApiResponse<LicenseStatusResponse>(response);
  },
};

// Skills API — manages ~/.claude/skills on the container
export interface SkillInfo {
  name: string;
  description: string;
}

export const skillsApi = {
  list: async (): Promise<SkillInfo[]> => {
    const response = await makeRequest('/api/skills');
    return handleApiResponse<SkillInfo[]>(response);
  },

  install: async (url: string): Promise<SkillInfo> => {
    const response = await makeRequest('/api/skills', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
    return handleApiResponse<SkillInfo>(response);
  },

  delete: async (name: string): Promise<void> => {
    const response = await makeRequest(
      `/api/skills/${encodeURIComponent(name)}`,
      { method: 'DELETE' }
    );
    return handleApiResponse<void>(response);
  },
};

// Search API (multi-repo file search)
export const searchApi = {
  searchFiles: async (
    repoIds: string[],
    query: string,
    mode?: SearchMode,
    options?: RequestInit
  ): Promise<SearchResult[]> => {
    const repoIdsParam = repoIds.join(',');
    const modeParam = mode ? `&mode=${encodeURIComponent(mode)}` : '';
    const response = await makeRequest(
      `/api/search?q=${encodeURIComponent(query)}&repo_ids=${encodeURIComponent(repoIdsParam)}${modeParam}`,
      options
    );
    return handleApiResponse<SearchResult[]>(response);
  },
};

// Play por milestone (fluke v2, #666).
export const milestoneRunsApi = {
  list: async (repoId: string): Promise<MilestoneRun[]> => {
    const response = await makeRequest(
      `/api/repos/${encodeURIComponent(repoId)}/milestone-runs`
    );
    return handleApiResponse<MilestoneRun[]>(response);
  },
  play: async (
    repoId: string,
    milestone: string,
    stepMode: boolean
  ): Promise<MilestoneRun> => {
    const response = await makeRequest(
      `/api/repos/${encodeURIComponent(repoId)}/milestone-runs/play`,
      {
        method: 'POST',
        body: JSON.stringify({ milestone, step_mode: stepMode }),
      }
    );
    return handleApiResponse<MilestoneRun>(response);
  },
  playAll: async (
    repoId: string,
    milestones: string[],
    stepMode: boolean
  ): Promise<MilestoneRun[]> => {
    const response = await makeRequest(
      `/api/repos/${encodeURIComponent(repoId)}/milestone-runs/play-all`,
      {
        method: 'POST',
        body: JSON.stringify({ milestones, step_mode: stepMode }),
      }
    );
    return handleApiResponse<MilestoneRun[]>(response);
  },
  pause: async (repoId: string, milestone: string): Promise<void> => {
    const response = await makeRequest(
      `/api/repos/${encodeURIComponent(repoId)}/milestone-runs/pause`,
      { method: 'POST', body: JSON.stringify({ milestone }) }
    );
    await handleApiResponse<void>(response);
  },
  reset: async (repoId: string, milestone: string): Promise<void> => {
    const response = await makeRequest(
      `/api/repos/${encodeURIComponent(repoId)}/milestone-runs/reset`,
      { method: 'POST', body: JSON.stringify({ milestone }) }
    );
    await handleApiResponse<void>(response);
  },
  setStepMode: async (repoId: string, stepMode: boolean): Promise<void> => {
    const response = await makeRequest(
      `/api/repos/${encodeURIComponent(repoId)}/milestone-runs/step-mode`,
      { method: 'POST', body: JSON.stringify({ step_mode: stepMode }) }
    );
    await handleApiResponse<void>(response);
  },
};

// Plan de fases del issue (fluke v2, #686).
export const issuePhasesApi = {
  get: async (
    repoId: string,
    issueNumber: number
  ): Promise<IssuePlanResponse> => {
    const response = await makeRequest(
      `/api/repos/${encodeURIComponent(repoId)}/issues/${issueNumber}/phases`
    );
    return handleApiResponse<IssuePlanResponse>(response);
  },
  /** Open issues of the repo that need a person (#694). */
  blockers: async (repoId: string): Promise<IssueBlockerEntry[]> => {
    const response = await makeRequest(
      `/api/repos/${encodeURIComponent(repoId)}/issues/blockers`
    );
    return handleApiResponse<IssueBlockerEntry[]>(response);
  },
  /** An exit of the Destrabar drawer other than answering (#696). */
  unstick: async (
    repoId: string,
    issueNumber: number,
    body: UnstickRequest
  ): Promise<void> => {
    const response = await makeRequest(
      `/api/repos/${encodeURIComponent(repoId)}/issues/${issueNumber}/unstick`,
      { method: 'POST', body: JSON.stringify(body) }
    );
    await handleApiResponse<void>(response);
  },
};
