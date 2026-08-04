-- Distinguish infrastructure failures (API errors: rate limit, model not
-- available, auth) from real agent failures on worker tasks, and allow the
-- orchestrator to dispatch a retry with a different model.
--
-- failure_kind: NULL for non-failed tasks and for genuine agent failures;
--               'infra' when the coding agent never really ran (API 4xx/5xx).
--               Infra-failed reviewer tasks do NOT consume review rounds.
-- model_override: model id the orchestrator forces for this task (fallback
--               after repeated infra failures), overriding the worker's model.
ALTER TABLE worker_tasks ADD COLUMN failure_kind TEXT;
ALTER TABLE worker_tasks ADD COLUMN model_override TEXT;
