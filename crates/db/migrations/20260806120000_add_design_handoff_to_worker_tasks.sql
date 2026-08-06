-- Designer handoff: a designer's deliverable survives its workspace and can
-- be handed to an analyst as the input of a new task.
--
--   * result_summary: the agent's final message, captured by the orchestrator
--     when a non-developer task finishes OK. It is the human-readable abstract
--     of the deliverable (shown on the done card, embedded in handoff prompts).
--   * deliverable_ref: remote branch (design/<n>-<slug>) the orchestrator
--     pushed the designer's workspace branch to before archiving the
--     worktree. NULL when the run produced no commits.
--   * source_task_id: on a handoff task (kind = 'design_handoff'), the
--     designer task whose deliverable this task consumes. Its existence is
--     the "already handed off" guard for the source task.

ALTER TABLE worker_tasks ADD COLUMN result_summary TEXT;
ALTER TABLE worker_tasks ADD COLUMN deliverable_ref TEXT;
ALTER TABLE worker_tasks ADD COLUMN source_task_id BLOB DEFAULT NULL
    REFERENCES worker_tasks(id);

CREATE INDEX idx_worker_tasks_source_task_id
    ON worker_tasks(source_task_id) WHERE source_task_id IS NOT NULL;
