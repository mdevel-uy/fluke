-- Cumulative LLM usage rolled up onto the task from every execution process
-- that ran under any workspace/session linked to the task. Accumulates in
-- place (single UPDATE per process close) so retries and follow-ups keep
-- adding to the same total instead of overwriting it. Left outside the
-- WorkerTask struct on purpose to keep the sqlx offline metadata stable.
ALTER TABLE worker_tasks ADD COLUMN input_tokens_total INTEGER DEFAULT NULL;
ALTER TABLE worker_tasks ADD COLUMN output_tokens_total INTEGER DEFAULT NULL;
ALTER TABLE worker_tasks ADD COLUMN cache_creation_tokens_total INTEGER DEFAULT NULL;
ALTER TABLE worker_tasks ADD COLUMN cache_read_tokens_total INTEGER DEFAULT NULL;
ALTER TABLE worker_tasks ADD COLUMN cost_usd_total REAL DEFAULT NULL;
