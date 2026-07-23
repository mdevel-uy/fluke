-- Store the TL's review verdict on the developer's worker task so the
-- Kanban board can surface it without querying GitHub at render time.
-- Values: 'approved' | 'changes_requested' | NULL (not yet reviewed).
ALTER TABLE worker_tasks ADD COLUMN review_result TEXT DEFAULT NULL;
