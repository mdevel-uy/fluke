-- Vuelve un chat por misión (corrige J1.2, #750): sin foco ni marcas de
-- turno. Fluke conoce todas las misiones desde cualquier chat ([MISSIONS]) y
-- actúa sobre cualquiera con mission_id.

DROP TABLE fluke_turn_focus;
ALTER TABLE fluke_guard DROP COLUMN focus_mission_id;
