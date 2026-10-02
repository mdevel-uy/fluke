-- fluke v2, F2 (#681): los workers con nombre se consolidan en un perfil por
-- rol. Decisiones del PM: los workers de un mismo rol son iguales (se toma
-- uno, D3) y no hay tareas corriendo al migrar (D4).
--
-- Perfil = el worker más antiguo del rol, prefiriendo los activos. Antes de
-- borrar a los demás se re-apunta todo lo que los referencia: worker_tasks
-- tiene ON DELETE CASCADE y se perdería el historial.

ALTER TABLE workers ADD COLUMN migrated_from TEXT;

CREATE TEMP TABLE profile_keep AS
SELECT r.role AS role,
       (SELECT w.id FROM workers w
         WHERE w.role = r.role
         ORDER BY w.archived ASC, w.created_at ASC
         LIMIT 1) AS keep_id
  FROM (SELECT DISTINCT role FROM workers WHERE role <> 'orchestrator') r;

CREATE TEMP TABLE profile_map AS
SELECT w.id AS old_id, k.keep_id AS keep_id
  FROM workers w
  JOIN profile_keep k ON k.role = w.role
 WHERE w.id <> k.keep_id;

-- Si el perfil no tiene PAT y otro worker del rol sí, se queda con ese.
UPDATE workers
   SET github_login = (SELECT w2.github_login FROM workers w2
                        WHERE w2.role = workers.role AND w2.github_pat IS NOT NULL
                        ORDER BY w2.archived ASC, w2.created_at ASC LIMIT 1),
       github_pat   = (SELECT w2.github_pat FROM workers w2
                        WHERE w2.role = workers.role AND w2.github_pat IS NOT NULL
                        ORDER BY w2.archived ASC, w2.created_at ASC LIMIT 1)
 WHERE id IN (SELECT keep_id FROM profile_keep)
   AND github_pat IS NULL;

UPDATE worker_tasks
   SET worker_id = (SELECT keep_id FROM profile_map WHERE old_id = worker_tasks.worker_id)
 WHERE worker_id IN (SELECT old_id FROM profile_map);

UPDATE workspaces
   SET worker_id = (SELECT keep_id FROM profile_map WHERE old_id = workspaces.worker_id)
 WHERE worker_id IN (SELECT old_id FROM profile_map);

UPDATE mission_items
   SET worker_id = (SELECT keep_id FROM profile_map WHERE old_id = mission_items.worker_id)
 WHERE worker_id IN (SELECT old_id FROM profile_map);

UPDATE workers
   SET migrated_from = name,
       name = CASE role
                WHEN 'developer' THEN 'Fullstack'
                WHEN 'analyst'   THEN 'Analyst'
                WHEN 'reviewer'  THEN 'Reviewer'
                WHEN 'designer'  THEN 'Designer'
                ELSE name
              END
 WHERE id IN (SELECT keep_id FROM profile_keep);

DELETE FROM workers WHERE id IN (SELECT old_id FROM profile_map);

DROP TABLE profile_map;
DROP TABLE profile_keep;
