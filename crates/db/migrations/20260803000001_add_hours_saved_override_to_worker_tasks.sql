-- Per-task override for the "hours saved" contribution to the value-generated
-- panel. NULL means "use the caller's default"; a real value pins the task
-- regardless of what the panel's default is set to.
ALTER TABLE worker_tasks ADD COLUMN hours_saved_override REAL DEFAULT NULL;
