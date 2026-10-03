-- Add the 'waiting_user' status (issue #662): the coding agent asked the user
-- an explicit question with the plan MCP's ask_user tool and the task waits
-- for the answer. `pending_question` holds that question as JSON (NULL when
-- nothing is pending).
--
-- SQLite cannot alter a CHECK constraint in place, so we recreate the table
-- (same recipe as 20260808000000_add_approved_to_worker_tasks.sql). Foreign
-- keys must be disabled during the swap because other tables point at
-- worker_tasks(id).
--
-- sqlx workaround: end the auto-transaction so the PRAGMA can take effect
-- (https://github.com/launchbadge/sqlx/issues/2085#issuecomment-1499859906).

COMMIT;

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE worker_tasks_new (
    id                          BLOB PRIMARY KEY,
    worker_id                   BLOB NOT NULL,
    repo_id                     BLOB NOT NULL,
    position                    INTEGER NOT NULL,
    title                       TEXT NOT NULL,
    prompt                      TEXT NOT NULL,
    issue_number                INTEGER,
    status                      TEXT NOT NULL DEFAULT 'queued'
                                CHECK (status IN ('queued', 'in_progress',
                                                  'waiting_user', 'in_review',
                                                  'approved', 'done', 'failed')),
    workspace_id                BLOB,
    created_at                  TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    skills                      TEXT NOT NULL DEFAULT '[]',
    review_result               TEXT DEFAULT NULL,
    source                      TEXT NOT NULL DEFAULT 'kanban',
    completed_at                TEXT DEFAULT NULL,
    failure_reason              TEXT,
    failure_kind                TEXT,
    model_override              TEXT,
    kind                        TEXT,
    hours_saved_override        REAL DEFAULT NULL,
    issue_labels                TEXT NOT NULL DEFAULT '[]',
    result_summary              TEXT,
    deliverable_ref             TEXT,
    source_task_id              BLOB DEFAULT NULL REFERENCES worker_tasks(id),
    input_tokens_total          INTEGER DEFAULT NULL,
    output_tokens_total         INTEGER DEFAULT NULL,
    cache_creation_tokens_total INTEGER DEFAULT NULL,
    cache_read_tokens_total     INTEGER DEFAULT NULL,
    cost_usd_total              REAL DEFAULT NULL,
    territory_globs             TEXT DEFAULT NULL,
    pending_question            TEXT DEFAULT NULL,
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE,
    FOREIGN KEY (repo_id) REFERENCES repos(id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
);

INSERT INTO worker_tasks_new
    (id, worker_id, repo_id, position, title, prompt, issue_number,
     status, workspace_id, created_at, skills, review_result, source,
     completed_at, failure_reason, failure_kind, model_override, kind,
     hours_saved_override, issue_labels, result_summary, deliverable_ref,
     source_task_id, input_tokens_total, output_tokens_total,
     cache_creation_tokens_total, cache_read_tokens_total, cost_usd_total,
     territory_globs)
SELECT id, worker_id, repo_id, position, title, prompt, issue_number,
       status, workspace_id, created_at, skills, review_result, source,
       completed_at, failure_reason, failure_kind, model_override, kind,
       hours_saved_override, issue_labels, result_summary, deliverable_ref,
       source_task_id, input_tokens_total, output_tokens_total,
       cache_creation_tokens_total, cache_read_tokens_total, cost_usd_total,
       territory_globs
  FROM worker_tasks;

DROP TABLE worker_tasks;

ALTER TABLE worker_tasks_new RENAME TO worker_tasks;

CREATE INDEX idx_worker_tasks_worker_id ON worker_tasks(worker_id);
CREATE INDEX idx_worker_tasks_worker_id_position
    ON worker_tasks(worker_id, position);
CREATE INDEX idx_worker_tasks_repo_id ON worker_tasks(repo_id);
CREATE INDEX idx_worker_tasks_source_task_id
    ON worker_tasks(source_task_id) WHERE source_task_id IS NOT NULL;

-- Recreate the completion-timestamp trigger dropped along with the old table
-- (introduced in 20260724000001_add_completed_at_to_worker_tasks.sql).
CREATE TRIGGER worker_tasks_set_completed_at
AFTER UPDATE OF status ON worker_tasks
WHEN NEW.status IN ('done', 'failed') AND OLD.status NOT IN ('done', 'failed')
BEGIN
    UPDATE worker_tasks
    SET completed_at = datetime('now', 'subsec')
    WHERE id = NEW.id;
END;

-- Verify foreign key integrity before committing.
PRAGMA foreign_key_check;

COMMIT;

PRAGMA foreign_keys = ON;

-- sqlx workaround: start an empty transaction for sqlx to close gracefully.
BEGIN TRANSACTION;
