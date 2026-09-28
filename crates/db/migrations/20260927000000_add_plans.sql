-- Plan de trabajo estructurado de un agente, por workspace.
--
-- El agente lo declara por el MCP de plan (submit_plan) y lo recorre con
-- start_step / complete_step. fluke lo muestra como grafo, lo deja editar y
-- controla la ejecución (pausa al terminar el paso, stop, revertir).
--
-- plans.status:
--   running  — sin intervención pendiente
--   paused   — el agente cerró el turno en un borde de paso por pedido del user
--   halted   — el user detuvo al agente (stop) o revirtió un paso
-- Mientras el plan está paused/halted, el fin del proceso del agente no
-- dispara la finalización del worker (push/PR/fallo).
CREATE TABLE plans (
    workspace_id     BLOB PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
    status           TEXT NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running', 'paused', 'halted')),
    pause_requested  INTEGER NOT NULL DEFAULT 0,
    -- Aviso de una sola vez para el próximo play (ej. "se revirtió el paso 2").
    resume_note      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

-- files y depends_on son arrays JSON. checkpoint es un objeto JSON
-- {repo_name: sha} con el snapshot del worktree al iniciar el paso.
CREATE TABLE plan_steps (
    id           BLOB PRIMARY KEY,
    workspace_id BLOB NOT NULL REFERENCES plans (workspace_id) ON DELETE CASCADE,
    n            INTEGER NOT NULL,
    title        TEXT NOT NULL,
    summary      TEXT NOT NULL DEFAULT '',
    files        TEXT NOT NULL DEFAULT '[]',
    verify       TEXT,
    depends_on   TEXT NOT NULL DEFAULT '[]',
    state        TEXT NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending', 'active', 'done', 'cut')),
    version      INTEGER NOT NULL DEFAULT 1,
    checkpoint   TEXT,
    started_at   TEXT,
    finished_at  TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    UNIQUE (workspace_id, n)
);

-- Ciclo de revisión de un paso: el user pide un cambio, un revisor (fork de
-- la sesión del agente, solo lectura) propone la versión nueva, el user la
-- acepta, pide otro cambio (nueva fila con round+1) o la descarta.
--   requested → proposed → accepted | discarded ; failed si el revisor falla
--   accepted → delivered (le llegó al agente) → acked (el agente la usó)
-- target_n es el paso que lleva el cambio: el mismo, o un paso de
-- corrección nuevo cuando el original ya estaba hecho.
CREATE TABLE plan_step_revisions (
    id           BLOB PRIMARY KEY,
    workspace_id BLOB NOT NULL REFERENCES plans (workspace_id) ON DELETE CASCADE,
    n            INTEGER NOT NULL,
    round        INTEGER NOT NULL DEFAULT 1,
    request      TEXT NOT NULL,
    proposal     TEXT,
    status       TEXT NOT NULL DEFAULT 'requested'
                 CHECK (status IN ('requested', 'proposed', 'accepted', 'discarded',
                                   'delivered', 'acked', 'failed')),
    error        TEXT,
    target_n     INTEGER,
    created_at   TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE INDEX idx_plan_step_revisions_ws ON plan_step_revisions (workspace_id, n);
