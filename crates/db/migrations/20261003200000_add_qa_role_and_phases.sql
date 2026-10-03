-- fluke v2, F3 (#687): fases de QA (Tests primero y Testing).
--
-- 1) workers: sumar 'qa' al CHECK de role (SQLite no altera CHECKs: se recrea
--    la tabla, mismo patrón que 20261001120000) y crear el perfil QA.
-- 2) worker_tasks: start_ref (rama desde la que arranca la tarea: el dev de un
--    issue con TDD parte de la rama con los tests del QA), qa_head_sha y
--    qa_verdict (resultado de la fase Testing sobre un commit del PR).

COMMIT;

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE workers_new (
    id            BLOB PRIMARY KEY,
    name          TEXT NOT NULL,
    emoji         TEXT NOT NULL,
    soul          TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    role          TEXT NOT NULL DEFAULT 'developer'
                  CHECK (role IN ('developer', 'analyst', 'reviewer', 'designer',
                                  'orchestrator', 'qa')),
    model         TEXT NULL,
    github_pat    TEXT NULL,
    plan_mode     BOOLEAN NULL,
    archived      INTEGER NOT NULL DEFAULT 0,
    github_login  TEXT NULL,
    executor      TEXT,
    migrated_from TEXT
);

INSERT INTO workers_new
    (id, name, emoji, soul, created_at, role, model, github_pat,
     plan_mode, archived, github_login, executor, migrated_from)
SELECT id, name, emoji, soul, created_at, role, model, github_pat,
       plan_mode, archived, github_login, executor, migrated_from
  FROM workers;

DROP TABLE workers;

ALTER TABLE workers_new RENAME TO workers;

CREATE UNIQUE INDEX idx_workers_single_orchestrator
    ON workers (role) WHERE role = 'orchestrator';

PRAGMA foreign_key_check;

COMMIT;

PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;

INSERT INTO workers (id, name, emoji, soul, role)
SELECT randomblob(16), 'QA', '',
'Sos QA de esta fábrica de software. Trabajás en dos fases del ciclo de un issue:

## Tests primero
Escribís los tests que prueban los criterios de aceptación del issue ANTES de que exista el código. Los tests tienen que fallar por la razón correcta (lo que todavía no está implementado), no por errores de compilación evitables. No implementás la funcionalidad. Commiteás solo los tests.

## Testing
Validás el PR del issue: corrés los checks del repo (tests, typecheck, lint) y hacés un smoke de lo que el issue promete. No modificás código. Tu veredicto va en el archivo que te indica la tarea: pass si todo cumple, fail con los motivos concretos si no.',
'qa'
WHERE NOT EXISTS (SELECT 1 FROM workers WHERE role = 'qa');

ALTER TABLE worker_tasks ADD COLUMN start_ref TEXT;
ALTER TABLE worker_tasks ADD COLUMN qa_head_sha TEXT;
ALTER TABLE worker_tasks ADD COLUMN qa_verdict TEXT;
