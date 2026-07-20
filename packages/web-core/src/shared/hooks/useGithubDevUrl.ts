import { useMemo } from 'react';
import { useBranchStatus } from '@/shared/hooks/useBranchStatus';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';

function parseGithubOwnerRepo(url: string): string | null {
  const match = url.match(/github\.com\/([^/]+\/[^/?#]+)/);
  return match ? match[1] : null;
}

export function useGithubDevUrl(workspaceId?: string): {
  githubDevUrl: string | null;
  isBranchPushed: boolean;
} {
  const { workspace } = useWorkspaceContext();
  const { data: branchStatus } = useBranchStatus(workspaceId);

  return useMemo(() => {
    if (!workspace || !branchStatus) {
      return { githubDevUrl: null, isBranchPushed: false };
    }

    const isBranchPushed = branchStatus.some(
      (s) => s.remote_commits_ahead !== null
    );

    // Find first PR URL from merges to extract owner/repo
    let prUrl: string | null = null;
    outer: for (const status of branchStatus) {
      for (const merge of status.merges) {
        if (merge.type === 'pr') {
          prUrl = merge.pr_info.url;
          break outer;
        }
      }
    }

    if (!prUrl) {
      return { githubDevUrl: null, isBranchPushed };
    }

    const ownerRepo = parseGithubOwnerRepo(prUrl);
    if (!ownerRepo) {
      return { githubDevUrl: null, isBranchPushed };
    }

    return {
      githubDevUrl: `https://github.dev/${ownerRepo}/tree/${workspace.branch}`,
      isBranchPushed,
    };
  }, [workspace, branchStatus]);
}
