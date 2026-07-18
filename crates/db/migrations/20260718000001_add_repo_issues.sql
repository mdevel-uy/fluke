-- Re-anchor persisted GitHub issues to repos instead of projects. The
-- previous project_issues table was empty (feature not yet shipped) so
-- we drop it outright and create the equivalent scoped to repo_id.
DROP TABLE IF EXISTS project_issues;

CREATE TABLE repo_issues (
    id           BLOB PRIMARY KEY,
    repo_id      BLOB NOT NULL,
    number       INTEGER NOT NULL,
    title        TEXT NOT NULL,
    body         TEXT,
    state        TEXT NOT NULL,
    labels       TEXT NOT NULL DEFAULT '[]',
    author       TEXT,
    updated_at   TEXT NOT NULL,
    synced_at    TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
    UNIQUE (repo_id, number)
);

CREATE INDEX idx_repo_issues_repo_id ON repo_issues(repo_id);
CREATE INDEX idx_repo_issues_updated_at ON repo_issues(updated_at);
