-- N:M link between workspaces and pull_requests.
--
-- `pull_requests.pr_url` is UNIQUE and its `workspace_id` keeps the FIRST
-- owner (COALESCE upsert), so any follow-up task running in a fresh
-- workspace (fix CI, resolve conflicts, attend review) could never see the
-- PR it was working on: everything that renders the PR reference resolves
-- "PRs of the current workspace". This table lets every workspace that
-- touched a PR keep a reference to it; `pull_requests.workspace_id` stays
-- as the legacy "first owner" used by remote sync.
CREATE TABLE workspace_pull_requests (
    workspace_id    BLOB NOT NULL,
    pull_request_id TEXT NOT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (workspace_id, pull_request_id)
);

CREATE INDEX idx_workspace_pull_requests_pr_id
    ON workspace_pull_requests(pull_request_id);

-- Backfill from the legacy 1:1 column.
INSERT OR IGNORE INTO workspace_pull_requests (workspace_id, pull_request_id, created_at)
SELECT workspace_id, id, created_at
FROM pull_requests
WHERE workspace_id IS NOT NULL;
