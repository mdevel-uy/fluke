-- Extend the workers role CHECK to include the 'designer' role introduced in
-- 8a0ec1bbb (feat(workers): agregar rol y template de UI/UX Designer), which
-- whitelisted the role in the API but never widened the DB constraint, so
-- creating a designer worker failed with a CHECK constraint violation.
--
-- SQLite cannot alter a CHECK constraint in place, so we recreate the table.
-- workers is referenced by worker_tasks (ON DELETE CASCADE) and workspaces,
-- so the rebuild runs with foreign keys disabled outside sqlx's implicit
-- transaction (same workaround as 20251209000000_add_project_repositories).

COMMIT;

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE workers_new (
    id           BLOB PRIMARY KEY,
    name         TEXT NOT NULL,
    emoji        TEXT NOT NULL,
    soul         TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    role         TEXT NOT NULL DEFAULT 'developer'
                 CHECK (role IN ('developer', 'analyst', 'reviewer', 'designer')),
    model        TEXT NULL,
    github_pat   TEXT NULL,
    plan_mode    BOOLEAN NULL,
    archived     INTEGER NOT NULL DEFAULT 0,
    github_login TEXT NULL
);

INSERT INTO workers_new
    (id, name, emoji, soul, created_at, role, model, github_pat,
     plan_mode, archived, github_login)
SELECT id, name, emoji, soul, created_at, role, model, github_pat,
       plan_mode, archived, github_login
  FROM workers;

DROP TABLE workers;

ALTER TABLE workers_new RENAME TO workers;

-- Verify foreign key constraints before committing the transaction
PRAGMA foreign_key_check;

COMMIT;

PRAGMA foreign_keys = ON;

-- sqlx workaround due to lack of `-- no-transaction` in sqlx-sqlite.
-- Starts a new empty transaction for sqlx to close successfully.
BEGIN TRANSACTION;
