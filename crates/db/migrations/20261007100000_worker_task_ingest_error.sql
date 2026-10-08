-- Error de ingest de .vk/actions.json (archivo ilegible / JSON inválido).
-- Distinto de failure_reason: la tarea NO falla, el error sólo se muestra.
ALTER TABLE worker_tasks ADD COLUMN ingest_error TEXT;
