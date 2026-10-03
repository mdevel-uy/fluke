-- Bus de eventos de dominio (J0.2, #728): todo lo que pasa en la app queda
-- como una fila con nombre, para que Fluke se entere sin preguntar.
--
-- Lo escriben triggers, no el código: cubren cualquier camino que cambie un
-- estado (hay más de 20 UPDATE a worker_tasks repartidos), incluidos los que
-- se agreguen después. Severidad: progress (solo para la UI), info, ask (te
-- espera) y alert (falló o se rompió algo).

CREATE TABLE fluke_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now', 'subsec')),
    kind         TEXT    NOT NULL,
    severity     TEXT    NOT NULL
                 CHECK (severity IN ('progress', 'info', 'ask', 'alert')),
    subject_id   BLOB    NULL,
    repo_id      BLOB    NULL,
    issue_number INTEGER NULL,
    pr_number    INTEGER NULL,
    title        TEXT    NULL,
    detail       TEXT    NULL
);

CREATE INDEX idx_fluke_events_created_at ON fluke_events (created_at);

-- Retención de 30 días, barrida cada 500 eventos.
CREATE TRIGGER fluke_events_retention AFTER INSERT ON fluke_events
WHEN new.id % 500 = 0
BEGIN
    DELETE FROM fluke_events WHERE created_at < datetime('now', '-30 days');
END;

-- Tareas de los perfiles ---------------------------------------------------

CREATE TRIGGER fluke_events_task_insert AFTER INSERT ON worker_tasks
BEGIN
    INSERT INTO fluke_events (kind, severity, subject_id, repo_id, issue_number, title, detail)
    VALUES ('task.' || new.status, 'progress', new.id, new.repo_id, new.issue_number, new.title,
            (SELECT role FROM workers WHERE id = new.worker_id));
END;

CREATE TRIGGER fluke_events_task_status AFTER UPDATE OF status ON worker_tasks
WHEN old.status IS NOT new.status
BEGIN
    INSERT INTO fluke_events (kind, severity, subject_id, repo_id, issue_number, title, detail)
    VALUES (
        'task.' || new.status,
        CASE new.status
            WHEN 'failed' THEN 'alert'
            WHEN 'waiting_user' THEN 'ask'
            WHEN 'queued' THEN 'progress'
            WHEN 'in_progress' THEN 'progress'
            ELSE 'info'
        END,
        new.id, new.repo_id, new.issue_number, new.title,
        trim(
            coalesce((SELECT role FROM workers WHERE id = new.worker_id), '')
            || CASE WHEN new.status = 'failed'
                    THEN ' · ' || coalesce(new.failure_kind, 'error') || ': '
                         || substr(coalesce(new.failure_reason, ''), 1, 300)
                    WHEN new.status = 'waiting_user'
                    THEN ' · ' || substr(coalesce(new.pending_question, ''), 1, 500)
                    ELSE '' END
        )
    );
END;

-- Review loop -------------------------------------------------------------

CREATE TRIGGER fluke_events_review_round AFTER UPDATE OF status ON review_rounds
WHEN old.status IS NOT new.status AND new.status <> 'pending'
BEGIN
    INSERT INTO fluke_events (kind, severity, subject_id, repo_id, pr_number, detail)
    VALUES (
        'review.' || CASE WHEN new.status = 'submitted'
                          THEN coalesce(new.verdict, 'submitted')
                          ELSE new.status END,
        CASE WHEN new.status = 'failed' THEN 'alert'
             WHEN new.status = 'superseded' THEN 'progress'
             ELSE 'info' END,
        new.id, new.repo_id, new.pr_number,
        substr(coalesce(new.reasons, ''), 1, 300)
    );
END;

-- Pull requests y CI ------------------------------------------------------

CREATE TRIGGER fluke_events_pr_insert AFTER INSERT ON pull_requests
BEGIN
    INSERT INTO fluke_events (kind, severity, repo_id, pr_number, detail)
    VALUES ('pr.' || new.pr_status, 'info', new.repo_id, new.pr_number, new.pr_url);
END;

CREATE TRIGGER fluke_events_pr_status AFTER UPDATE OF pr_status ON pull_requests
WHEN old.pr_status IS NOT new.pr_status
BEGIN
    INSERT INTO fluke_events (kind, severity, repo_id, pr_number, detail)
    VALUES ('pr.' || new.pr_status, 'info', new.repo_id, new.pr_number, new.pr_url);
END;

CREATE TRIGGER fluke_events_pr_ci AFTER UPDATE OF pr_ci_status ON pull_requests
WHEN old.pr_ci_status IS NOT new.pr_ci_status AND new.pr_ci_status IN ('passing', 'failing')
BEGIN
    INSERT INTO fluke_events (kind, severity, repo_id, pr_number, detail)
    VALUES ('pr.ci_' || new.pr_ci_status,
            CASE new.pr_ci_status WHEN 'failing' THEN 'alert' ELSE 'info' END,
            new.repo_id, new.pr_number, new.pr_url);
END;

-- Misiones de Fluke -------------------------------------------------------

CREATE TRIGGER fluke_events_mission_status AFTER UPDATE OF status ON missions
WHEN old.status IS NOT new.status
BEGIN
    INSERT INTO fluke_events (kind, severity, subject_id, repo_id, title)
    VALUES ('mission.' || new.status,
            CASE new.status WHEN 'brief_ready' THEN 'ask'
                            WHEN 'blocked' THEN 'alert'
                            WHEN 'clarifying' THEN 'progress'
                            ELSE 'info' END,
            new.id, new.repo_id, new.title);
END;

-- Ejecución por milestone y planes ---------------------------------------

CREATE TRIGGER fluke_events_run_status AFTER UPDATE OF status ON milestone_runs
WHEN old.status IS NOT new.status
BEGIN
    INSERT INTO fluke_events (kind, severity, subject_id, repo_id, title, detail)
    VALUES ('run.' || new.status,
            CASE new.status WHEN 'running' THEN 'progress'
                            WHEN 'done' THEN 'info'
                            ELSE 'ask' END,
            new.id, new.repo_id, new.milestone, new.waiting_reason);
END;

CREATE TRIGGER fluke_events_run_wave AFTER UPDATE OF current_wave ON milestone_runs
WHEN old.current_wave IS NOT new.current_wave
BEGIN
    INSERT INTO fluke_events (kind, severity, subject_id, repo_id, title, detail)
    VALUES ('run.wave', 'progress', new.id, new.repo_id, new.milestone,
            'wave ' || new.current_wave);
END;

CREATE TRIGGER fluke_events_plan_status AFTER UPDATE OF status ON plans
WHEN old.status IS NOT new.status
BEGIN
    INSERT INTO fluke_events (kind, severity, subject_id)
    VALUES ('plan.' || new.status,
            CASE new.status WHEN 'halted' THEN 'ask' ELSE 'progress' END,
            new.workspace_id);
END;

-- Equipo ------------------------------------------------------------------

CREATE TRIGGER fluke_events_profile_insert AFTER INSERT ON workers
BEGIN
    INSERT INTO fluke_events (kind, severity, subject_id, title, detail)
    VALUES ('profile.created', 'info', new.id, new.name, new.role);
END;

CREATE TRIGGER fluke_events_profile_archived AFTER UPDATE OF archived ON workers
WHEN old.archived IS NOT new.archived
BEGIN
    INSERT INTO fluke_events (kind, severity, subject_id, title, detail)
    VALUES (CASE new.archived WHEN 1 THEN 'profile.archived' ELSE 'profile.restored' END,
            'info', new.id, new.name, new.role);
END;
