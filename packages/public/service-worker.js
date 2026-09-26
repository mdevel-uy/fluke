/* fluke service worker (issue #533 — Web Push).
 *
 * Deliberadamente mínimo: solo maneja `push` y `notificationclick`. NO
 * cachea nada — no queremos interferir con la carga normal de la app, y
 * el modelo de datos (WS, SQLite en el server) no encaja bien con
 * offline. Cualquier request pasa por la red como si el SW no estuviera.
 *
 * Deduplicación con la fase 1 (issue #532):
 *   Antes de mostrar la notificación, consultamos `clients.matchAll` con
 *   `type: 'window'`. Si alguna ventana está visible (visibilityState
 *   'visible' o 'focused'), es prácticamente seguro que `LocalTaskNotifications.tsx`
 *   ya disparó la alerta nativa por el mismo evento — el `tag` compartido
 *   ('local-task-<evento>-<ws_id>') además la coalesce a nivel navegador.
 *   Skippeamos entonces el SW para no mostrar dos popups del mismo evento.
 */

self.addEventListener('install', (event) => {
  // No hay recursos que precachear — pasamos directo a activo.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  // Tomar control de páginas ya cargadas en el próximo tick.
  event.waitUntil(self.clients.claim());
});

/**
 * Devuelve `true` si hay al menos una ventana de fluke abierta y visible
 * en este dispositivo. En ese caso la fase 1 ya mostró la alerta.
 */
async function anyVisibleClient() {
  try {
    const list = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    return list.some((c) => c.visibilityState === 'visible' || c.focused);
  } catch {
    return false;
  }
}

self.addEventListener('push', (event) => {
  // Toda notificación fluke trae JSON en el body (ver
  // `web_push::PushEventPayload`). Sin body — evento vacío del vendor —
  // no mostramos nada.
  if (!event.data) return;

  event.waitUntil(
    (async () => {
      let payload;
      try {
        payload = event.data.json();
      } catch {
        // Body malformado: sigue siendo mejor mostrar algo genérico que
        // silenciar por completo — el evento del server sí llegó.
        payload = {
          title: 'fluke',
          body: 'Nueva actualización',
          tag: 'fluke-generic',
        };
      }

      // Si ya hay una pestaña visible, no mostrar — la fase 1 (in-app
      // notifications) cubre este camino. Un evento que llega con TODAS las
      // ventanas ocultas SÍ se muestra: el usuario está en otro tab / app.
      if (await anyVisibleClient()) {
        return;
      }

      const title = payload.title || 'fluke';
      const options = {
        body: payload.body || '',
        tag: payload.tag || 'fluke-generic',
        renotify: false,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: {
          deeplinkPath: payload.deeplink_path || null,
        },
      };
      await self.registration.showNotification(title, options);
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const deeplink = event.notification.data && event.notification.data.deeplinkPath;

  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      // Preferimos enfocar una pestaña ya abierta antes que crear una
      // nueva. Si viene deeplink, se lo posteamos por postMessage para que
      // el router del cliente navegue sin recargar.
      for (const client of list) {
        try {
          await client.focus();
          if (deeplink) {
            client.postMessage({
              type: 'fluke:push:navigate',
              path: deeplink,
            });
          }
          return;
        } catch {
          // seguimos con la siguiente pestaña
        }
      }

      // No hay ventana abierta: abrir una nueva en el deeplink (o home).
      const target = deeplink || '/';
      try {
        await self.clients.openWindow(target);
      } catch {
        // openWindow puede fallar en contextos restringidos (ej.
        // iframe/origin distinto); no hay más recurso.
      }
    })()
  );
});
