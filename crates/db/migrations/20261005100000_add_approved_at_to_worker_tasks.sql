-- When the reviewer approved the task's PR (status 'approved'). The dashboard
-- counts an approved task as completed on this date and keeps the date once
-- the PR merges (approved -> done), so the merge does not move the ticket to
-- another day. Any other transition (changes requested, failure, re-queue)
-- clears it: the task is no longer approved.
--
-- Migrations that recreate worker_tasks must recreate these triggers, like
-- worker_tasks_set_completed_at.
ALTER TABLE worker_tasks ADD COLUMN approved_at TEXT DEFAULT NULL;

CREATE TRIGGER worker_tasks_set_approved_at
AFTER UPDATE OF status ON worker_tasks
WHEN NEW.status = 'approved' AND OLD.status <> 'approved'
BEGIN
    UPDATE worker_tasks
    SET approved_at = datetime('now', 'subsec')
    WHERE id = NEW.id;
END;

CREATE TRIGGER worker_tasks_clear_approved_at
AFTER UPDATE OF status ON worker_tasks
WHEN NEW.status NOT IN ('approved', 'done') AND NEW.approved_at IS NOT NULL
BEGIN
    UPDATE worker_tasks
    SET approved_at = NULL
    WHERE id = NEW.id;
END;

-- Tasks approved today: the latest approving review submitted on their PR.
-- Tasks already merged keep their completion date.
UPDATE worker_tasks
   SET approved_at = (
       SELECT MAX(rr.updated_at)
         FROM review_rounds rr
         JOIN pull_requests pr
           ON pr.repo_id = rr.repo_id AND pr.pr_number = rr.pr_number
        WHERE pr.workspace_id = worker_tasks.workspace_id
          AND rr.kind = 'review'
          AND rr.status = 'submitted'
          AND rr.verdict = 'approve'
   )
 WHERE status = 'approved';
