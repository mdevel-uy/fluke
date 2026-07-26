-- Per-worker override for plan mode. NULL means "use the global setting"
-- (executor_profile.permission_policy from Settings). TRUE forces plan
-- mode on for this worker regardless of the global; FALSE forces it off.
ALTER TABLE workers ADD COLUMN plan_mode BOOLEAN NULL;
