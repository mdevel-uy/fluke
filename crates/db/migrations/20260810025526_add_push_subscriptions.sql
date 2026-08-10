-- Web Push subscriptions (issue #533, fase 2 de alertas de escritorio).
--
-- Cada fila es la suscripción de un navegador contra el push service del
-- vendor (FCM, autopush.mozilla, WNS). El endpoint es único por navegador y
-- por origin — lo tratamos como clave estable: si el mismo endpoint se
-- reinscribe (rotación de auth/p256dh), sobreescribimos las claves en vez
-- de duplicar la fila (UPSERT desde el frontend).
--
-- Baja: el sender elimina la fila cuando el push service responde 404/410
-- ("endpoint unknown / gone"), que es la única señal fiable de que el
-- navegador desinstaló la suscripción. Otros errores (5xx, red caída) se
-- reintentan en el próximo evento — no borran la fila.
CREATE TABLE push_subscriptions (
    id             BLOB PRIMARY KEY,
    endpoint       TEXT NOT NULL UNIQUE,
    p256dh         TEXT NOT NULL,
    auth           TEXT NOT NULL,
    user_agent     TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE INDEX idx_push_subscriptions_endpoint ON push_subscriptions (endpoint);
