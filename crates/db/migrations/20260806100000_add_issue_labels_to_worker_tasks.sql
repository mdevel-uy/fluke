-- Add issue_labels column to worker_tasks to store GitHub labels the analyst
-- should apply to every issue created as part of the request. Stored as a
-- JSON array of strings. Additive with a DEFAULT so re-applying is idempotent.
ALTER TABLE worker_tasks ADD COLUMN issue_labels TEXT NOT NULL DEFAULT '[]';
