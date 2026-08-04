-- Extend the worker_tasks status CHECK to include the 'in_review' state used by
-- the worker orchestrator when a PR is open for the worker's active workspace.
--
-- SQLite cannot alter a CHECK constraint in place, so we recreate the table.

CREATE TABLE worker_tasks_new (
    id           BLOB PRIMARY KEY,
    worker_id    BLOB NOT NULL,
    repo_id      BLOB NOT NULL,
    position     INTEGER NOT NULL,
    title        TEXT NOT NULL,
    prompt       TEXT NOT NULL,
    issue_number INTEGER,
    status       TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'in_progress', 'in_review', 'done', 'failed')),
    workspace_id BLOB,
    created_at   TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE,
    FOREIGN KEY (repo_id) REFERENCES repos(id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
);

INSERT INTO worker_tasks_new
    (id, worker_id, repo_id, position, title, prompt, issue_number,
     status, workspace_id, created_at)
SELECT id, worker_id, repo_id, position, title, prompt, issue_number,
       status, workspace_id, created_at
  FROM worker_tasks;

DROP TABLE worker_tasks;

ALTER TABLE worker_tasks_new RENAME TO worker_tasks;

CREATE INDEX idx_worker_tasks_worker_id ON worker_tasks(worker_id);
CREATE INDEX idx_worker_tasks_worker_id_position
    ON worker_tasks(worker_id, position);
CREATE INDEX idx_worker_tasks_repo_id ON worker_tasks(repo_id);
