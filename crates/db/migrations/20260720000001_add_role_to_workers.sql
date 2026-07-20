-- Add role column to workers table.
-- Possible values: 'developer' (default), 'analyst', 'reviewer'.
-- Existing rows default to 'developer' so the migration is additive and
-- backward-compatible.
ALTER TABLE workers
  ADD COLUMN role TEXT NOT NULL DEFAULT 'developer'
    CHECK (role IN ('developer', 'analyst', 'reviewer'));
