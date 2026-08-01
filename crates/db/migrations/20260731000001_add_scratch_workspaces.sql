-- Scratch workspaces are ad-hoc, non-task workspaces reused for interactive
-- assistant sessions against a specific repository. One row per repo:
-- opening the ad-hoc panel for a repo returns the existing scratch workspace
-- (if any) or creates a fresh one.

CREATE TABLE scratch_workspaces (
    workspace_id BLOB PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    repo_id      BLOB NOT NULL UNIQUE REFERENCES repos(id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE INDEX idx_scratch_workspaces_repo ON scratch_workspaces(repo_id);
