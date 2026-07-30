-- Scratch workspaces host ad-hoc interactive sessions (chat panel with a
-- coding agent). They are per-repo and are not part of the regular workspace
-- listing shown to users. Existing rows are non-scratch by default.
ALTER TABLE workspaces ADD COLUMN is_scratch BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_workspaces_scratch
    ON workspaces(is_scratch)
    WHERE is_scratch = TRUE;
