-- Branch name on the remote that this workspace pushes to, when it differs
-- from the local branch name. NULL means "same as branch" (the historical
-- behaviour). Only workspaces created from an existing PR set this: they get
-- a unique local branch (so their worktree never fights over the checkout
-- with the attempt that owns the PR branch) and push via an explicit
-- local:remote refspec to keep updating the PR's head branch.
ALTER TABLE workspaces ADD COLUMN remote_branch TEXT;
