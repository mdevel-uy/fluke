-- Director: agente orquestador global (en la UI se llama "Fluke").
--
-- Es un worker más con rol 'orchestrator' (soul y modelo editables desde
-- Workers), pero no toma tareas de la cola: conversa con el user en una
-- sesión por misión y arma un brief estructurado que, aprobado, se manda al
-- Analyst Desk como una request normal.
--
-- 1) workers: sumar 'orchestrator' al CHECK de role (SQLite no altera CHECKs,
--    se recrea la tabla igual que en 20260806000000) y garantizar que haya
--    uno solo.

COMMIT;

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE workers_new (
    id           BLOB PRIMARY KEY,
    name         TEXT NOT NULL,
    emoji        TEXT NOT NULL,
    soul         TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    role         TEXT NOT NULL DEFAULT 'developer'
                 CHECK (role IN ('developer', 'analyst', 'reviewer', 'designer',
                                 'orchestrator')),
    model        TEXT NULL,
    github_pat   TEXT NULL,
    plan_mode    BOOLEAN NULL,
    archived     INTEGER NOT NULL DEFAULT 0,
    github_login TEXT NULL
);

INSERT INTO workers_new
    (id, name, emoji, soul, created_at, role, model, github_pat,
     plan_mode, archived, github_login)
SELECT id, name, emoji, soul, created_at, role, model, github_pat,
       plan_mode, archived, github_login
  FROM workers;

DROP TABLE workers;

ALTER TABLE workers_new RENAME TO workers;

CREATE UNIQUE INDEX idx_workers_single_orchestrator
    ON workers (role) WHERE role = 'orchestrator';

PRAGMA foreign_key_check;

COMMIT;

PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;

-- 2) Misiones. Una misión = un pedido del user con su conversación (una
--    sesión del workspace scratch del repo activo al crearla), su brief y,
--    después del traspaso, la request al Analista y los issues que salgan.
--
-- status:
--   draft → clarifying → brief_ready (espera user, G1) → equipping →
--   planning → executing → in_review (espera user, G3) → closed
--   blocked: salida lateral desde planning/executing cuando falta una
--   decisión del user.
-- autonomy: step (confirma plan y asignaciones) | brief_pr (default) |
--   autopilot (además reintenta con otro modelo sin preguntar).
-- pending_questions: JSON [{question, options[]}], máximo 3 (lo impone el
--   código del MCP). Se vacía cuando el user responde.
-- ui_context: dónde está el user en la app ("TallerMecanico › Kanban");
--   va en el system prompt del agente en cada turno.
CREATE TABLE missions (
    id                BLOB PRIMARY KEY,
    title             TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'clarifying', 'brief_ready',
                                        'equipping', 'planning', 'executing',
                                        'in_review', 'closed', 'blocked')),
    autonomy          TEXT NOT NULL DEFAULT 'brief_pr'
                      CHECK (autonomy IN ('step', 'brief_pr', 'autopilot')),
    repo_id           BLOB REFERENCES repos (id) ON DELETE SET NULL,
    session_id        BLOB NOT NULL UNIQUE REFERENCES sessions (id) ON DELETE CASCADE,
    pending_questions TEXT NOT NULL DEFAULT '[]',
    ui_context        TEXT,
    analyst_task_id   BLOB REFERENCES worker_tasks (id) ON DELETE SET NULL,
    cost_cap_usd      REAL,
    created_at        TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

-- Ítems del brief. fields es un objeto JSON {campo: texto}; qué campos son
-- obligatorios por kind lo decide el código (services::director::schema).
-- worker_id / model / route_reason: ruteo de la Fase 2 (sin uso todavía).
CREATE TABLE mission_items (
    id           BLOB PRIMARY KEY,
    mission_id   BLOB NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
    position     INTEGER NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('bug', 'feature', 'design')),
    title        TEXT NOT NULL DEFAULT '',
    fields       TEXT NOT NULL DEFAULT '{}',
    worker_id    BLOB REFERENCES workers (id) ON DELETE SET NULL,
    model        TEXT,
    route_reason TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE INDEX idx_mission_items_mission ON mission_items (mission_id, position);

-- Versiones aprobadas del brief (G1). El brief vive solo acá: no se escribe
-- ningún archivo en el repo de trabajo.
CREATE TABLE mission_briefs (
    mission_id  BLOB NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
    version     INTEGER NOT NULL,
    markdown    TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    PRIMARY KEY (mission_id, version)
);

-- Issues que el Analista creó para la misión (los llena el drain de
-- agent_actions al crear issues de la request de la misión). Base del filtro
-- por misión en Kanban/Dashboard.
CREATE TABLE mission_issues (
    mission_id   BLOB NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
    repo_id      BLOB NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
    issue_number INTEGER NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    PRIMARY KEY (mission_id, repo_id, issue_number)
);
