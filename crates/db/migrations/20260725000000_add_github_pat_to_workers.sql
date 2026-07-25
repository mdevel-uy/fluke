-- Per-worker GitHub PAT. Optional; when NULL the worker falls back to the
-- global GitHub auth (gh CLI credentials on the machine). Stored write-only:
-- the value is never returned by the API, only a boolean "has_github_pat".
ALTER TABLE workers ADD COLUMN github_pat TEXT NULL;
