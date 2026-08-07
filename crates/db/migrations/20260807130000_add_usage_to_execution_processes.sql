-- Per-process LLM usage accounting. Populated by the exit monitor from the
-- last TokenUsageInfo emitted through msg_store, plus (when available) the
-- executor's own USD figure (e.g. Claude Code's `total_cost_usd`). Left
-- outside the ExecutionProcess struct on purpose so the sqlx offline
-- metadata stays untouched (see `set_usage` / `find_usage` helpers).
ALTER TABLE execution_processes ADD COLUMN input_tokens INTEGER DEFAULT NULL;
ALTER TABLE execution_processes ADD COLUMN output_tokens INTEGER DEFAULT NULL;
ALTER TABLE execution_processes ADD COLUMN cache_creation_tokens INTEGER DEFAULT NULL;
ALTER TABLE execution_processes ADD COLUMN cache_read_tokens INTEGER DEFAULT NULL;
ALTER TABLE execution_processes ADD COLUMN cost_usd REAL DEFAULT NULL;
ALTER TABLE execution_processes ADD COLUMN model TEXT DEFAULT NULL;
