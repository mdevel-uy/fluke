-- Origin of a worker task: 'kanban' for board/system-created tasks,
-- 'desk' for ad-hoc requests submitted from the Analyst Desk screen.
ALTER TABLE worker_tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'kanban';
