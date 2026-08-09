-- Agent Actions outbox (AGENT-ACTIONS-SPEC.md, F1).
--
-- Ledger of the declarative actions each agent leaves in `.vk/actions.json`.
-- The orchestrator is the sole executor: agents produce content, the system
-- produces effects. The table is the idempotency substrate — re-ingesting
-- the same `(task_id, seq)` is a no-op via UNIQUE, and re-execution touches
-- only `pending`/`failed` rows.
--
-- status lifecycle:
--   pending  — inserted at ingest time, not yet drained
--   done     — action executed successfully against GitHub
--   failed   — definitive failure (validation, 404, permission); halts drain
--   skipped  — reserved for future use (e.g. actions bypassed after halt)
--
-- Note on task_id: the spec text says `NOT NULL ... ON DELETE SET NULL`,
-- which SQLite/SQL reject as contradictory. Implemented as nullable so the
-- SET NULL clause is actually honoured — same shape as
-- `review_rounds.task_id` after the FK cleanup.
CREATE TABLE agent_actions (
    id             BLOB PRIMARY KEY,
    task_id        BLOB REFERENCES worker_tasks (id) ON DELETE SET NULL,
    repo_id        BLOB NOT NULL REFERENCES repos (id),
    seq            INTEGER NOT NULL,
    kind           TEXT NOT NULL,
    payload        TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'done', 'failed', 'skipped')),
    attempts       INTEGER NOT NULL DEFAULT 0,
    last_error     TEXT,
    result_number  INTEGER,
    result_url     TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    UNIQUE (task_id, seq)
);

CREATE INDEX idx_agent_actions_task_id ON agent_actions (task_id);
CREATE INDEX idx_agent_actions_repo_status ON agent_actions (repo_id, status);
