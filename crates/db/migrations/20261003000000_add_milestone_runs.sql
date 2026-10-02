-- Play por milestone (fluke v2, #666): un run por milestone de GitHub que
-- despacha los issues wave por wave. Una fila por (repo, milestone); Reiniciar
-- la borra. `waiting_reason` explica por qué está detenido
-- ('decision:<n>' o 'failed:<n>'); `step_mode` pausa al terminar cada wave.
CREATE TABLE milestone_runs (
    id             BLOB PRIMARY KEY,
    repo_id        BLOB NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
    milestone      TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running', 'paused', 'waiting', 'done')),
    step_mode      INTEGER NOT NULL DEFAULT 0,
    current_wave   INTEGER,
    waiting_reason TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    UNIQUE (repo_id, milestone)
);
