-- Add "queued" to the execution_processes.status CHECK constraint.
-- SQLite does not support altering a CHECK constraint in place, so we
-- swap the column: create a new one with the wider CHECK, copy values,
-- drop the old column, rename, and re-create the index.

-- 1. New column with the extended CHECK. Includes the pre-existing values
--    plus 'queued' for executions that are waiting for a concurrency slot.
ALTER TABLE execution_processes
  ADD COLUMN status_new TEXT NOT NULL DEFAULT 'running'
    CHECK (status_new IN ('queued',
                          'running',
                          'completed',
                          'failed',
                          'killed'));

-- 2. Copy existing status values across.
UPDATE execution_processes
  SET status_new = status;

-- 3. Drop EVERY index that references the old column (all recreated at the
--    bottom against the new one). SQLite refuses DROP COLUMN while any
--    index still mentions the column — missing the composite one left the
--    deploy in a crash loop ("no such column: status" on the index).
DROP INDEX IF EXISTS idx_execution_processes_status;
DROP INDEX IF EXISTS idx_execution_processes_session_status_run_reason;

-- 4. Remove the old column (requires SQLite 3.35+).
ALTER TABLE execution_processes DROP COLUMN status;

-- 5. Rename the replacement column back to the canonical name.
ALTER TABLE execution_processes
  RENAME COLUMN status_new TO status;

-- 6. Re-create the indexes against the new column.
CREATE INDEX idx_execution_processes_status ON execution_processes(status);
CREATE INDEX idx_execution_processes_session_status_run_reason
        ON execution_processes (session_id, status, run_reason);
