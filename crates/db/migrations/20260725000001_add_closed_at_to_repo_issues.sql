-- Record *when* an issue was closed, not just that it is closed.
--
-- `state` alone cannot answer "how many issues were closed on day X", which the
-- dashboard impact chart needs. GitHub exposes `closedAt` on `gh issue list`, so
-- the next sync backfills this column for every issue it fetches -- no separate
-- data migration is required. Existing rows stay NULL until then.
ALTER TABLE repo_issues ADD COLUMN closed_at TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_repo_issues_closed_at ON repo_issues(closed_at);
