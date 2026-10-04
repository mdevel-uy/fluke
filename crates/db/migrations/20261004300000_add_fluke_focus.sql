-- Un solo hilo con Fluke y misión en foco (J1.2, #750; decisión A).
--
-- La guardia pasa a ser LA conversación con Fluke. El código guarda qué
-- misión está en foco (las herramientas del brief operan sobre esa) y marca
-- cada turno del hilo con el foco que tenía, así abrir una misión muestra
-- sus turnos.

ALTER TABLE fluke_guard ADD COLUMN focus_mission_id BLOB NULL;

CREATE TABLE fluke_turn_focus (
    execution_process_id BLOB PRIMARY KEY,
    mission_id           BLOB NOT NULL,
    created_at           TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE INDEX idx_fluke_turn_focus_mission ON fluke_turn_focus (mission_id);
