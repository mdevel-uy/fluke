-- Soft-delete flag for workers. 0 = active (shown in the main workers list),
-- 1 = archived (kept in DB with full task/workspace history but hidden from
-- the active listing and skipped by orchestrator lookups). Purge is a
-- separate hard-delete step performed by DELETE /api/workers/{id}.
ALTER TABLE workers ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
