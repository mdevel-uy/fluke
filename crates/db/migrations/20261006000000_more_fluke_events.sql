-- Eventos en tiempo real (J6.1): lo que la UI de Fluke consultaba cada 2 s
-- ahora también es un evento, así se actualiza sola. Todos son `progress`:
-- la UI los usa, a Fluke no se le mandan.

-- El brief cambia (ítems).
CREATE TRIGGER fluke_events_mission_item_insert AFTER INSERT ON mission_items
BEGIN
    INSERT INTO fluke_events (kind, severity, subject_id) VALUES ('mission.updated', 'progress', new.mission_id);
END;

CREATE TRIGGER fluke_events_mission_item_update AFTER UPDATE ON mission_items
BEGIN
    INSERT INTO fluke_events (kind, severity, subject_id) VALUES ('mission.updated', 'progress', new.mission_id);
END;

CREATE TRIGGER fluke_events_mission_item_delete AFTER DELETE ON mission_items
BEGIN
    INSERT INTO fluke_events (kind, severity, subject_id) VALUES ('mission.updated', 'progress', old.mission_id);
END;

-- Título, repo o preguntas pendientes de la misión (no el contexto de
-- pantalla, que cambia en cada navegación).
CREATE TRIGGER fluke_events_mission_fields AFTER UPDATE OF title, repo_id, pending_questions ON missions
WHEN old.title IS NOT new.title
  OR old.repo_id IS NOT new.repo_id
  OR old.pending_questions IS NOT new.pending_questions
BEGIN
    INSERT INTO fluke_events (kind, severity, subject_id, title)
    VALUES ('mission.updated', 'progress', new.id, new.title);
END;

-- Fluke empieza o termina de responder en una misión (también despierta a
-- la guardia cuando termina su turno).
CREATE TRIGGER fluke_events_mission_agent_insert AFTER INSERT ON execution_processes
WHEN EXISTS (SELECT 1 FROM missions WHERE session_id = new.session_id)
BEGIN
    INSERT INTO fluke_events (kind, severity, subject_id)
    SELECT 'mission.agent_' || new.status, 'progress', id FROM missions WHERE session_id = new.session_id;
END;

CREATE TRIGGER fluke_events_mission_agent_status AFTER UPDATE OF status ON execution_processes
WHEN old.status IS NOT new.status
 AND EXISTS (SELECT 1 FROM missions WHERE session_id = new.session_id)
BEGIN
    INSERT INTO fluke_events (kind, severity, subject_id)
    SELECT 'mission.agent_' || new.status, 'progress', id FROM missions WHERE session_id = new.session_id;
END;

-- Issues del repo (el despiece del Analyst, cierres).
CREATE TRIGGER fluke_events_issue_insert AFTER INSERT ON repo_issues
BEGIN
    INSERT INTO fluke_events (kind, severity, repo_id, issue_number, title)
    VALUES ('issue.' || new.state, 'progress', new.repo_id, new.number, new.title);
END;

CREATE TRIGGER fluke_events_issue_state AFTER UPDATE OF state ON repo_issues
WHEN old.state IS NOT new.state
BEGIN
    INSERT INTO fluke_events (kind, severity, repo_id, issue_number, title)
    VALUES ('issue.' || new.state, 'progress', new.repo_id, new.number, new.title);
END;
