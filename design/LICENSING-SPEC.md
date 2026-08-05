# LICENSING-SPEC v1 — licencia firmada y kill-switch

Estado: **borrador, requiere decisiones de Dani** (marcadas 🔸).
Contexto: fase 5a del plan comercial on-premises. Convierte mkanban de
"instalable" en "cobrable": sin esto no hay forma de suspender el servicio a un
cliente que deja de pagar.

Deliberadamente **sin servidor**: la licencia es un archivo firmado que se entrega
por fuera de banda (email, o el instalador la deja en su lugar). La fase 5b
(heartbeat) automatiza la renovación reusando exactamente este formato — el
binario no cambia, solo aparece quién le acerca el archivo.

## Principios

1. **Los datos del cliente nunca se bloquean.** La degradación afecta la
   ejecución de agentes nuevos; el tablero, el historial, los repos y el export
   siguen accesibles siempre. Esto está comprometido en los T&C publicados
   (cláusula 9) y es innegociable.
2. **Kill-switch pasivo.** No hay un comando remoto de apagado: la licencia
   simplemente vence. Dejar de firmar la renovación es la acción de corte.
   Menos superficie de ataque y menos riesgo de apagar a un cliente por error.
3. **Fallo hacia el aviso, no hacia el bloqueo.** Un archivo corrupto, ilegible o
   ausente degrada con banner primero; nunca deja al cliente sin acceso de golpe.

## Formato de la licencia

Archivo `license.json` en el data dir (`~/.local/share/mkanban/`), montado en el
volumen `mk-home` del bundle. Sobrevive updates y restauraciones de backup.

```json
{
  "payload": {
    "v": 1,
    "cliente": "acme",
    "instance_id": "01J...",
    "issued_at": "2026-08-04T00:00:00Z",
    "expires_at": "2026-09-18T00:00:00Z",
    "modalidad": "onprem"
  },
  "signature": "base64(ed25519(canonical_json(payload)))"
}
```

- **ed25519** vía `ed25519-dalek` 2.2.0, ya presente en el workspace
  (`relay-client`, `local-deployment`, `embedded-ssh`); el patrón de firma/verificación
  a copiar está en `crates/relay-control/src/signing.rs`.
- **Clave pública embebida** en el binario como constante. La privada nunca sale
  de la máquina de mdevel.
- **Canonicalización**: el payload se serializa con claves ordenadas antes de
  firmar, para que la verificación no dependa del formateo del archivo.
- **`instance_id`**: se genera en el primer arranque y se persiste. Ata la
  licencia a una instalación — copiar el archivo a otro servidor no la habilita.
  🔸 ¿Enforcement duro (rechazar si no coincide) o solo advertencia? Duro es más
  estricto pero rompe restauraciones legítimas de backup a un servidor nuevo.
  Propuesta: advertir en logs y en el panel, no bloquear.

## Estados y degradación

Se evalúa al arrancar y una vez por hora (no solo al arranque: una instancia
puede correr meses sin reiniciar).

| Estado | Condición | Efecto |
|---|---|---|
| `valid` | firma ok y `now < expires_at` | operación normal |
| `grace` | vencida hace < 7 días 🔸 | banner persistente en la UI; todo funciona |
| `suspended` | vencida hace ≥ 7 días 🔸 | **no arrancan agentes nuevos**; los en curso terminan; UI, historial y export intactos |
| `missing` / `invalid` | sin archivo, ilegible o firma inválida | igual que `grace` (banner), escalando a `suspended` a los 7 días |

- 🔸 **Período de gracia**: 7 días es lo que dicen los T&C ("no menor a 7 días
  desde el aviso"). Se puede alargar, no acortar sin cambiar el documento.
- **Reloj retrocedido**: se persiste el instante máximo observado
  (`last_seen_at`). Si el reloj del sistema aparece antes de ese valor, se usa
  el máximo — no se puede revivir una licencia atrasando la fecha del servidor.
- **Sin caps de plan**: la licencia porta identidad y expiración, nada más.
  El modelo de cobro es % del ahorro sin límite de agentes (decisión 04-ago).

## Puntos de integración en el código

- `crates/services/src/services/licensing.rs` (nuevo): parseo, verificación,
  máquina de estados, cache del estado vigente.
- **Gate de ejecución**: `worker_orchestrator`, en el mismo punto donde hoy se
  evalúa `max_in_review_from_env` — si el estado es `suspended`, no se
  materializa el agente y se registra el motivo.
- **Endpoint** `GET /api/license`: estado, `expires_at`, días restantes. Lo
  consume el banner de la UI. No expone la firma.
- **Métrica** `mkanban_license_state{state="valid|grace|suspended"} 1` +
  `mkanban_license_days_remaining`, para alertar en la flota propia antes de que
  un cliente se entere.
- **UI**: banner en `grace` (tono warning, con fecha) y en `suspended` (tono
  destructive, explicando que los datos siguen disponibles y a quién escribir).

## Herramienta de firma

`crates/mkanban-license` (bin, no se distribuye al cliente):

```
mkanban-license new --cliente acme --instance 01J... --dias 45 > license.json
mkanban-license inspect license.json     # verifica y muestra el payload
```

🔸 **Custodia de la clave privada**: hoy no hay un lugar definido. Mínimo
aceptable: fuera del repo, en un gestor de contraseñas con backup. Si se pierde,
ninguna instancia puede renovar; si se filtra, cualquiera puede auto-licenciarse.

## Qué NO incluye esta fase

- Heartbeat y renovación automática (5b).
- Contadores de uso para facturación (5b) — hoy ya existen en la DB, falta
  transportarlos.
- Panel de control de la flota (fase 2).

## Plan de implementación

1. Crate de licencias + tests de verificación (firma válida/inválida/expirada/
   reloj retrocedido).
2. Herramienta de firma + generación del par de claves.
3. Gate en el orquestador + endpoint + métricas.
4. Banner en la UI (dos estados).
5. Prueba E2E: instalar con licencia de 2 días, adelantar el reloj del
   contenedor, verificar banner → suspensión → restauración al renovar.
