-- Estado más reciente conocido de cada instancia de la flota.
CREATE TABLE instances (
    instance_id                TEXT PRIMARY KEY,
    cliente                    TEXT NOT NULL,
    version                    TEXT NOT NULL,
    first_seen                 TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    last_seen                  TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    tickets_done_total         INTEGER NOT NULL DEFAULT 0,
    tickets_done_current_month INTEGER NOT NULL DEFAULT 0,
    snapshot_at                TEXT,
    -- Flag operativo de pago, seteado por un operador desde la superficie admin
    -- (fase 2). Gobierna si el heartbeat renueva la licencia. Default 1 (al día)
    -- para que un alta nueva funcione hasta que se decida lo contrario.
    paid                       INTEGER NOT NULL DEFAULT 1
);

-- Historia append-only de heartbeats: base para calcular el consumo del período
-- (delta entre snapshots) y para auditoría. Los contadores son acumulativos, así
-- que el consumo de un mes es la diferencia entre el último snapshot del mes y el
-- del mes anterior — robusto ante cortes de conectividad.
CREATE TABLE heartbeats (
    id                         INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id                TEXT NOT NULL,
    version                    TEXT NOT NULL,
    tickets_done_total         INTEGER NOT NULL,
    tickets_done_current_month INTEGER NOT NULL,
    snapshot_at                TEXT NOT NULL,
    received_at                TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE INDEX idx_heartbeats_instance ON heartbeats(instance_id, received_at);
