-- Flujo configurable: cada perfil declara en qué punto del flujo de un issue
-- entra (antes del desarrollo, implementación o compuerta antes del review),
-- si entra siempre o solo cuando el plan lo pide, su orden dentro de la etapa
-- y cuándo lo ofrece Fluke en el brief. El slug es el nombre con el que lo
-- cita el bloque fluke:plan: se fija la primera vez y no cambia al renombrar.

ALTER TABLE workers ADD COLUMN flow_slug TEXT;
ALTER TABLE workers ADD COLUMN flow_stage TEXT
    CHECK (flow_stage IN ('pre_dev', 'implement', 'gate'));
ALTER TABLE workers ADD COLUMN flow_always INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workers ADD COLUMN flow_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workers ADD COLUMN flow_offer_when TEXT;

CREATE UNIQUE INDEX idx_workers_flow_slug ON workers (flow_slug) WHERE flow_slug IS NOT NULL;

-- Los especialistas de hoy quedan en el flujo como estaban: el primero de cada
-- rol, con el slug que ya usan los bloques fluke:plan existentes.
UPDATE workers
   SET flow_slug = 'architect', flow_stage = 'pre_dev', flow_order = 10,
       flow_offer_when = 'un módulo o servicio nuevo, un cambio de capas o del modelo de datos, un proyecto desde cero'
 WHERE id = (SELECT id FROM workers WHERE role = 'architect' AND archived = 0
              ORDER BY created_at LIMIT 1);

UPDATE workers
   SET flow_slug = 'devops', flow_stage = 'implement', flow_order = 10,
       flow_offer_when = 'CI/CD, infraestructura, deploy o integraciones con la nube'
 WHERE id = (SELECT id FROM workers WHERE role = 'devops' AND archived = 0
              ORDER BY created_at LIMIT 1);

UPDATE workers
   SET flow_slug = 'quality', flow_stage = 'gate', flow_order = 10,
       flow_offer_when = 'agrega o reestructura módulos, capas o abstracciones'
 WHERE id = (SELECT id FROM workers WHERE role = 'quality' AND archived = 0
              ORDER BY created_at LIMIT 1);

UPDATE workers
   SET flow_slug = 'security', flow_stage = 'gate', flow_order = 20,
       flow_offer_when = 'toca autenticación, permisos, datos sensibles, entradas externas, secretos o dependencias'
 WHERE id = (SELECT id FROM workers WHERE role = 'security' AND archived = 0
              ORDER BY created_at LIMIT 1);
