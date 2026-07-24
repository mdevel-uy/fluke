ALTER TABLE worker_tasks ADD COLUMN completed_at TEXT DEFAULT NULL;

-- Stamp completion time when a task first reaches a terminal status. A
-- trigger (instead of app code) keeps every status-update call site honest
-- without touching their queries.
CREATE TRIGGER worker_tasks_set_completed_at
AFTER UPDATE OF status ON worker_tasks
WHEN NEW.status IN ('done', 'failed') AND OLD.status NOT IN ('done', 'failed')
BEGIN
    UPDATE worker_tasks
    SET completed_at = datetime('now', 'subsec')
    WHERE id = NEW.id;
END;
