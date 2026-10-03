-- Conversación de guardia de Fluke (J0.3, #729): una misión fija por
-- instalación donde entran los eventos del bus (fluke_events). Una sola fila.
-- event_cursor = último evento ya procesado; last_delivery_at limita cuántas
-- veces por minuto se despierta a Fluke.

CREATE TABLE fluke_guard (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    mission_id       BLOB    NOT NULL,
    event_cursor     INTEGER NOT NULL DEFAULT 0,
    last_delivery_at TEXT    NULL
);
