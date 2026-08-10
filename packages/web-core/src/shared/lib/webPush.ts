// Web Push (issue #533) — helpers de suscripción del navegador.
//
// El toggle "Push (navegador cerrado)" en Settings llama a
// `enableBrowserPushSubscription()`: pide permiso, registra el service
// worker, arma la suscripción contra el push service del vendor y persiste
// las claves en el backend (`POST /api/push/subscribe`). Apagar el toggle
// llama a `disableBrowserPushSubscription()` que da de baja tanto en el
// navegador como en el server.
//
// Feature detection: los push subscriptions requieren HTTPS/localhost
// (secure context), soporte de Service Worker y PushManager. En Tauri no
// aplica — la app desktop usa notificaciones nativas por invoke().

const SERVICE_WORKER_URL = '/service-worker.js';

export function isBrowserPushSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext === false) return false;
  if (!('serviceWorker' in navigator)) return false;
  if (!('PushManager' in window)) return false;
  if (!('Notification' in window)) return false;
  return true;
}

/**
 * Base64URL (sin padding) → Uint8Array. El backend entrega la public VAPID
 * key en este formato — `PushManager.subscribe` la consume como
 * `Uint8Array`.
 */
function base64UrlToBytes(input: string): Uint8Array {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4);
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * ArrayBuffer → base64url (sin padding). El servidor lee las claves p256dh
 * y auth en este formato — es el que devuelve `getKey()` del navegador tal
 * cual, sin decodificar.
 */
function bytesToBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return '';
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface ApiEnvelope<T> {
  success: boolean;
  data: T | null;
  error_data: unknown;
  message: string | null;
}

async function fetchVapidPublicKey(): Promise<string | null> {
  try {
    const res = await fetch('/api/push/vapid-key');
    if (!res.ok) return null;
    const body = (await res.json()) as ApiEnvelope<{ public_key: string }>;
    if (!body.success || !body.data) return null;
    return body.data.public_key;
  } catch {
    return null;
  }
}

async function postSubscription(
  endpoint: string,
  p256dh: string,
  auth: string
): Promise<boolean> {
  try {
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint,
        p256dh,
        auth,
        user_agent:
          typeof navigator !== 'undefined' ? navigator.userAgent : null,
      }),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as ApiEnvelope<{ ok: boolean }>;
    return body.success && !!body.data?.ok;
  } catch {
    return false;
  }
}

async function postUnsubscribe(endpoint: string): Promise<void> {
  try {
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    // Best-effort: si el server no responde, el sender igual borrará la
    // fila con el próximo 404/410. No propagamos el error.
  }
}

async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    // `scope: '/'` para que capture toda la app. El SW no cachea nada —
    // no interfiere con la carga.
    return await navigator.serviceWorker.register(SERVICE_WORKER_URL, {
      scope: '/',
    });
  } catch (err) {
    console.warn('Web Push: failed to register service worker', err);
    return null;
  }
}

/**
 * Habilita las notificaciones push por navegador cerrado. Idempotente:
 * llamar dos veces con la misma clave del server no crea suscripciones
 * duplicadas (el backend hace UPSERT por endpoint).
 *
 * @returns `true` si el registro completo salió bien.
 */
export async function enableBrowserPushSubscription(): Promise<boolean> {
  if (!isBrowserPushSupported()) return false;
  if (Notification.permission !== 'granted') {
    // El caller debería haber pedido permiso antes. Sin él la sub no se
    // puede crear en Chrome/Firefox (throwea InvalidStateError).
    return false;
  }

  const publicKey = await fetchVapidPublicKey();
  if (!publicKey) {
    console.warn('Web Push: server did not return a VAPID public key');
    return false;
  }

  const registration = await registerServiceWorker();
  if (!registration) return false;

  let subscription: PushSubscription;
  try {
    // Reusar sub existente si ya la había creada este browser — el
    // navegador retorna la misma instance si el applicationServerKey
    // coincide.
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      subscription = existing;
    } else {
      // `applicationServerKey` acepta BufferSource; el tipo estricto exige
      // `ArrayBuffer` (no `SharedArrayBuffer`). Le pasamos el buffer plano
      // que envuelve el `Uint8Array` para que TS lo acepte sin cast wide.
      const keyBytes = base64UrlToBytes(publicKey);
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes.buffer as ArrayBuffer,
      });
    }
  } catch (err) {
    console.warn('Web Push: pushManager.subscribe failed', err);
    return false;
  }

  const p256dh = bytesToBase64Url(subscription.getKey('p256dh'));
  const auth = bytesToBase64Url(subscription.getKey('auth'));
  if (!p256dh || !auth) {
    console.warn('Web Push: subscription is missing p256dh/auth keys');
    return false;
  }

  return postSubscription(subscription.endpoint, p256dh, auth);
}

/**
 * Da de baja la suscripción actual (si existe) y le avisa al server.
 * Best-effort: si el server no responde, el sender limpia el registro con
 * el próximo 404/410.
 */
export async function disableBrowserPushSubscription(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration('/');
    if (!registration) return;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    const endpoint = subscription.endpoint;
    try {
      await subscription.unsubscribe();
    } catch {
      // El navegador ya la había limpiado — seguimos borrando del server.
    }
    await postUnsubscribe(endpoint);
  } catch (err) {
    console.warn('Web Push: failed to disable subscription', err);
  }
}

/**
 * ¿Hay una suscripción activa registrada en este browser? Se usa para
 * hidratar el estado inicial del toggle en Settings.
 */
export async function getBrowserPushSubscriptionState(): Promise<boolean> {
  if (!isBrowserPushSupported()) return false;
  if (Notification.permission !== 'granted') return false;
  try {
    const registration = await navigator.serviceWorker.getRegistration('/');
    if (!registration) return false;
    const subscription = await registration.pushManager.getSubscription();
    return !!subscription;
  } catch {
    return false;
  }
}
