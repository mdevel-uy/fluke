-- Per-worker coding agent (issue #614). NULL = follow the global default
-- agent. `model` is only meaningful for this agent. Existing workers that
-- pinned a model are backfilled at startup with the default agent from
-- config (it lives in config.json, not in the DB).
ALTER TABLE workers ADD COLUMN executor TEXT;
