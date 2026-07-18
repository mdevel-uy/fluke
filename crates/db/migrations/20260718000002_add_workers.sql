-- Persistent workers with an identity, plus a per-worker queue of tasks.
-- Orchestration is not implemented yet: this migration only introduces
-- the data model that the API surface exposes.

CREATE TABLE workers (
    id         BLOB PRIMARY KEY,
    name       TEXT NOT NULL,
    emoji      TEXT NOT NULL,
    soul       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE TABLE worker_tasks (
    id           BLOB PRIMARY KEY,
    worker_id    BLOB NOT NULL,
    repo_id      BLOB NOT NULL,
    position     INTEGER NOT NULL,
    title        TEXT NOT NULL,
    prompt       TEXT NOT NULL,
    issue_number INTEGER,
    status       TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'in_progress', 'done', 'failed')),
    workspace_id BLOB,
    created_at   TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE,
    FOREIGN KEY (repo_id) REFERENCES repos(id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
);

CREATE INDEX idx_worker_tasks_worker_id ON worker_tasks(worker_id);
CREATE INDEX idx_worker_tasks_worker_id_position
    ON worker_tasks(worker_id, position);
CREATE INDEX idx_worker_tasks_repo_id ON worker_tasks(repo_id);

-- Track which worker owns a workspace so we can surface the active
-- workspace for a worker. Default NULL is required by SQLite when
-- adding a column with a REFERENCES clause.
ALTER TABLE workspaces ADD COLUMN worker_id BLOB DEFAULT NULL
    REFERENCES workers(id);

CREATE INDEX idx_workspaces_worker_id
    ON workspaces(worker_id) WHERE worker_id IS NOT NULL;
