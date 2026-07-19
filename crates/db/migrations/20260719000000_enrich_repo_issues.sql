-- Add milestone column to repo_issues (additive, non-breaking).
-- Labels column continues to store JSON; shape changes from array-of-strings
-- to array-of-objects ({name, color}) on next sync.
ALTER TABLE repo_issues ADD COLUMN milestone TEXT NULL;
