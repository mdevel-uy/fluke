-- Add skills column to worker_tasks to store selected skills as a JSON array.
-- Uses ALTER TABLE since it is additive and does not require a CHECK constraint change.
ALTER TABLE worker_tasks ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
