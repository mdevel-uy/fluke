import { useEffect } from 'react';
import { router } from '@web/app/router';

/**
 * Puente entre el service worker de Web Push (issue #533) y el router de
 * la app: cuando el usuario clickea una notificación push, el SW hace
 * `client.focus()` + `postMessage({ type: 'mkanban:push:navigate', path })`.
 * Este listener recibe el mensaje y navega usando el router en memoria —
 * sin recarga, sin history extra.
 *
 * Es tolerante: si el mensaje no viene del formato esperado (u origen
 * distinto) simplemente lo ignora. No hay estado que renderear.
 */
export function PushNavigationBridge() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }

    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type !== 'mkanban:push:navigate') return;
      const path: unknown = data.path;
      if (typeof path !== 'string' || !path.startsWith('/')) return;
      try {
        router.navigate({ to: path as '/' });
      } catch {
        // Ruta desconocida — dejamos el foco donde estaba.
      }
    };

    navigator.serviceWorker.addEventListener('message', handler);
    return () => {
      navigator.serviceWorker.removeEventListener('message', handler);
    };
  }, []);

  return null;
}
