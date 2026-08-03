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

-- 3. Drop the old status index (recreated at the bottom against the new column).
DROP INDEX IF EXISTS idx_execution_processes_status;

-- 4. Remove the old column (requires SQLite 3.35+).
ALTER TABLE execution_processes DROP COLUMN status;

-- 5. Rename the replacement column back to the canonical name.
ALTER TABLE execution_processes
  RENAME COLUMN status_new TO status;

-- 6. Re-create the status index.
CREATE INDEX idx_execution_processes_status ON execution_processes(status);
