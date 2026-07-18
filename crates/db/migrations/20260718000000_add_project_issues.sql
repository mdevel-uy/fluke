-- Persist GitHub issues per project so they can be listed offline
-- and refreshed on demand.
CREATE TABLE project_issues (
    id           BLOB PRIMARY KEY,
    project_id   BLOB NOT NULL,
    number       INTEGER NOT NULL,
    title        TEXT NOT NULL,
    body         TEXT,
    state        TEXT NOT NULL,
    labels       TEXT NOT NULL DEFAULT '[]',
    author       TEXT,
    updated_at   TEXT NOT NULL,
    synced_at    TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    UNIQUE (project_id, number)
);

CREATE INDEX idx_project_issues_project_id ON project_issues(project_id);
CREATE INDEX idx_project_issues_updated_at ON project_issues(updated_at);
