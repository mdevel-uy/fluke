-- Review-loop foundations (REVIEW-LOOP-SPEC.md, PR 1).
--
-- 1. workers.github_login: the GitHub login the worker's PAT belongs to.
--    Captured server-side when the PAT is validated (never user-supplied).
--    Used by the identity guard: a reviewer whose login matches the PR
--    author cannot submit an actionable review (GitHub rejects
--    self-approval), so dispatch is blocked instead of burning rounds.
ALTER TABLE workers ADD COLUMN github_login TEXT NULL;

-- 2. worker_tasks.failure_reason: human-readable reason recorded when a
--    task transitions to 'failed'. Previously the reason only existed in
--    server logs, making failed cards undiagnosable from the UI.
ALTER TABLE worker_tasks ADD COLUMN failure_reason TEXT NULL;

-- 3. review_rounds: one row per review or remediation round of a PR.
--    Replaces the count-based dispatch guards (reviewer-tasks-done vs
--    fix-tasks-dispatched) with exact idempotency keyed on the PR head SHA
--    and, for reviews, the GitHub review id once submitted.
--
--    status lifecycle:
--      pending    — round dispatched, task not finished yet
--      submitted  — verdict submitted to GitHub (kind=review) or
--                   remediation push completed (kind=remediation);
--                   counts toward the per-PR round budget
--      failed     — task failed or verdict rejected; does NOT count
--      superseded — head moved before the round finished; does NOT count
CREATE TABLE review_rounds (
    id          BLOB PRIMARY KEY,
    repo_id     BLOB NOT NULL REFERENCES repos (id),
    pr_number   INTEGER NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('review', 'remediation')),
    head_sha    TEXT NOT NULL,
    base_sha    TEXT NULL,
    task_id     BLOB NULL REFERENCES worker_tasks (id),
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'submitted', 'failed', 'superseded')),
    verdict     TEXT NULL CHECK (verdict IN ('approve', 'request_changes')),
    review_id   INTEGER NULL,
    reasons     TEXT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE INDEX idx_review_rounds_pr ON review_rounds (repo_id, pr_number);
CREATE INDEX idx_review_rounds_task ON review_rounds (task_id);
