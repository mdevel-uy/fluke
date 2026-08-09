-- review_rounds.task_id referenced worker_tasks(id) with no ON DELETE
-- action, so deleting a worker task that has a round row violates the FK.
-- In practice: cancel_worker_task (try_stop + DELETE) returned 500 for any
-- reviewer task with a dispatched round — the agent process got killed but
-- the task survived in_progress (incidente 09-ago: el cancel de la UI sobre
-- la task colgada de Chewax falló y la card quedó "stalled" hasta que el
-- sweep de huérfanos la levantó). Same failure applies to any path that
-- deletes worker_tasks rows, e.g. the round-reset operativa of deleting old
-- reviewer tasks.
--
-- The round ledger is keyed per (repo_id, pr_number) and must survive task
-- deletion — it drives the per-PR round budget — so the right action is
-- SET NULL, not CASCADE. task_id is already nullable; readers treat a NULL
-- backlink as "task gone".
--
-- SQLite cannot add an ON DELETE action in place, so we recreate the table
-- (same pattern as 20260808000000_add_approved_to_worker_tasks.sql).
--
-- sqlx workaround: end the auto-transaction so the PRAGMA can take effect
-- (https://github.com/launchbadge/sqlx/issues/2085#issuecomment-1499859906).

COMMIT;

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE review_rounds_new (
    id          BLOB PRIMARY KEY,
    repo_id     BLOB NOT NULL REFERENCES repos (id),
    pr_number   INTEGER NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('review', 'remediation')),
    head_sha    TEXT NOT NULL,
    base_sha    TEXT NULL,
    task_id     BLOB NULL REFERENCES worker_tasks (id) ON DELETE SET NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'submitted', 'failed', 'superseded')),
    verdict     TEXT NULL CHECK (verdict IN ('approve', 'request_changes')),
    review_id   INTEGER NULL,
    reasons     TEXT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

INSERT INTO review_rounds_new
    (id, repo_id, pr_number, kind, head_sha, base_sha, task_id, status,
     verdict, review_id, reasons, created_at, updated_at)
SELECT id, repo_id, pr_number, kind, head_sha, base_sha, task_id, status,
       verdict, review_id, reasons, created_at, updated_at
  FROM review_rounds;

DROP TABLE review_rounds;

ALTER TABLE review_rounds_new RENAME TO review_rounds;

CREATE INDEX idx_review_rounds_pr ON review_rounds (repo_id, pr_number);
CREATE INDEX idx_review_rounds_task ON review_rounds (task_id);

-- Rows whose task was already deleted before this migration would fail the
-- integrity check below — detach them the same way the new FK would have.
UPDATE review_rounds
   SET task_id = NULL
 WHERE task_id IS NOT NULL
   AND task_id NOT IN (SELECT id FROM worker_tasks);

-- Verify foreign key integrity before committing.
PRAGMA foreign_key_check;

COMMIT;

PRAGMA foreign_keys = ON;

-- sqlx workaround: start an empty transaction for sqlx to close gracefully.
BEGIN TRANSACTION;
