# Fluke Jarvis · J0 — Cómo probarlo

Prueba manual de todo J0 junto (#737, #741–#746 y el CLI persistente #727) sobre la app de escritorio. Spec: `design/FLUKE-JARVIS-SPEC.md`.

## 0. Preparar

1. Sin agentes corriendo (si hay workers trabajando, esperar o pausar: reiniciar el server los corta).
2. `git pull` en la instancia y reiniciar el server (o `pnpm run dev` / `tauri:dev`). Al arrancar corren dos migraciones: `fluke_events` y `fluke_guard`.
3. Abrir Fluke (Ctrl+Shift+I o la página /fluke).

Para mirar el bus de eventos en cualquier momento:

```
curl -s "http://127.0.0.1:<puerto>/api/fluke-events?limit=20"
```

(el puerto está en el archivo de puerto del server o en la barra del navegador de la app).

## 1. Conversación de guardia (J0.3)

| Paso | Resultado esperado |
|---|---|
| Esperar unos 10 s después del arranque | Aparece la misión **"Fluke"**, primera en la lista de misiones. |
| Abrirla | En el panel de brief de /fluke dice que es la conversación de guardia y no tiene brief. No hay stepper. |
| Pedirle en la guardia "agregá un bug: …" | Fluke no lo anota ahí: propone abrir una misión nueva (o la abre con app_api). |

## 2. Eventos y aviso (J0.2 + J0.3 + J0.7)

Provocar algo que valga aviso. Lo más fácil: que falle una tarea (por ejemplo, frenar un worker a mano desde su sesión) o que un PR quede con la CI en rojo.

| Paso | Resultado esperado |
|---|---|
| `curl …/api/fluke-events` | Aparece el evento (`task.failed` con severidad `alert`, `pr.ci_failing`, etc.). |
| Esperar hasta un minuto | En la guardia aparece una línea plegada **"N eventos de la app"** y debajo Fluke dice en una o dos frases qué pasó y qué sugiere. |
| Con la ventana de fluke en segundo plano | Llega una notificación nativa **"Fluke"** con lo que dijo; el click abre /fluke. |
| Un evento sin importancia (por ejemplo una tarea que pasa a `done`) | Puede llegar el lote, pero Fluke responde `SILENT`: en el chat solo queda la línea plegada, no hay mensaje ni encabezado de turno, **no hay notificación**. |
| Varios eventos seguidos | Como mucho un lote por minuto; nunca interrumpe a Fluke si está respondiendo. |

Ya no debería aparecer nunca la notificación "Workspace Complete" por un turno de Fluke.

## 3. Estado sin herramientas (J0.4)

| Paso | Resultado esperado |
|---|---|
| Preguntar "¿cómo vamos?" | Responde con lo que corre, lo que espera tu respuesta, lo fallado en 24 h y los PRs abiertos, **sin llamar herramientas** (en el chat no aparecen tool calls). |
| Con workers corriendo, preguntar "¿qué está haciendo el backend?" | Lo sabe por el estado que recibe en cada turno. |

## 4. Fluke opera la app (J0.0 + J0.6)

| Paso | Resultado esperado |
|---|---|
| "¿Qué podés hacer?" | Dice que todo lo que se puede hacer en fluke, con ejemplos; no se describe limitado. |
| "Reasigná la tarea X al perfil Backend" (con el nombre, no el id) | Lo hace con una sola llamada a app_api: el nombre del perfil se resuelve en el backend, sin un GET previo. |
| Con todos los slots ocupados por workers, escribirle a Fluke | Responde enseguida: ya no queda en cola detrás de los workers. |

## 5. Confirmaciones (J0.5)

| Paso | Resultado esperado |
|---|---|
| "Borrá el perfil QA" (o archivar un perfil de prueba) | Fluke **no** lo ejecuta: aparece "¿Confirmás? …" con los chips **"Sí, …"** y **"Cancelar"**. |
| Tocar "Sí, …" | Recién ahí lo ejecuta y confirma en una frase. |
| Repetir y responder otra cosa ("mejor no", o cualquier texto) | Se cancela; si después insiste con el mismo token, falla. |
| Un lote de eventos llega mientras hay una confirmación pendiente | La confirmación sigue pendiente (un lote no es el usuario). |

## 6. CLI persistente (J0.1)

| Paso | Resultado esperado |
|---|---|
| Mandarle dos mensajes seguidos a Fluke | El segundo empieza a responder más rápido que el primero (el primero arranca el CLI). |
| Ver procesos (`tasklist \| findstr claude` en Windows) | Hay **un** proceso de Claude para la sesión de Fluke que no desaparece entre mensajes. |
| Cambiar de pantalla en la app y preguntar "¿qué estoy viendo?" | Responde con la pantalla actual, no la del primer mensaje: el contexto viaja en cada mensaje. |
| Mirar un mensaje tuyo en el chat | No se ve ningún bloque `<fluke-context>`: la UI lo oculta. |
| Frenar a Fluke a mitad de respuesta (Stop) | El turno termina; el siguiente mensaje funciona y reutiliza el mismo CLI. |
| Editar o reintentar un mensaje anterior | Funciona como antes (ese turno arranca un CLI nuevo con la historia recortada). |
| 30 min sin hablarle | El proceso de Claude de Fluke desaparece; el siguiente mensaje lo vuelve a arrancar. |

Para medir la latencia: tiempo desde Enviar hasta la primera palabra, primer mensaje vs segundo. Anotarlo en #727.

## Qué reportar si algo falla

- El paso y lo que se vio.
- `curl …/api/fluke-events?limit=50` en ese momento.
- El log del server alrededor (buscar `Fluke event watcher`, `Fluke's live CLI`).
