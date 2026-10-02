---
scope: Fluke como Jarvis (solo desarrollo) — cerebro siempre despierto, conversación permanente con foco, iniciativa por eventos, memoria (Honcho self-hosted), voz (ElevenLabs + app móvil EAS)
slug: fluke-jarvis
status: draft — pendiente de aprobación por Dani
approved_by: (pendiente)
created: 2026-10-02
version: 1
complements: FLUKE-V2-SPEC.md (perfiles, plan por issue, Issues por milestone), REVIEW-LOOP-SPEC.md (merge humano), DESKTOP-SPEC.md
---

# Fluke como Jarvis — Plan de implementación (v1)

> **Principio rector: un solo cerebro, varios canales, cero manos propias.**
> Fluke es el único interlocutor del usuario. Se le habla por chat, por voz
> desde la app o desde el celular, y responde igual por cualquiera. No ejecuta
> nada por sí mismo: todo lo hace por `app_api`, la misma API que usa la UI.
> Esa frontera es lo que permite que el cerebro viva en la PC hoy y, si algún
> día hace falta, en otro lado, sin tocar a los workers.

Fuera de alcance: correo, calendario, agenda, cualquier cosa que no sea
operar fluke. Jarvis "dev wise".

## 1. Qué cambia

| # | Hoy | Nuevo |
|---|-----|-------|
| 1 | Cada mensaje relanza el CLI de Claude (~4 s hasta el primer token) | **Proceso persistente**: el CLI de la conversación de Fluke queda vivo; los mensajes entran por stdin (~1.4 s medido). |
| 2 | Una sesión por misión; sin hilo entre misiones | **Una conversación permanente** con una misión "en foco". Las misiones son ítems dentro de la conversación, no conversaciones aparte. |
| 3 | Fluke solo habla cuando el usuario escribe | **Iniciativa**: los eventos del sistema (tarea terminada o fallida, PR listo, CI en rojo, pregunta de un worker) le llegan a Fluke, que decide si avisar. Notificación nativa con deeplink. |
| 4 | Sin memoria entre sesiones | **Honcho self-hosted**: cada turno se espeja; antes de responder, Fluke recibe lo que Honcho sabe del usuario y del tema. |
| 5 | La regla "confirmá antes de borrar" vive en el prompt | **Confirmaciones en código**: `app_api` sabe qué endpoints son peligrosos y exige confirmación; el modelo no puede saltearla. |
| 6 | Solo texto, solo en la app | **Voz** con ElevenLabs (agente con LLM propio = Fluke) desde la app de escritorio y desde una **app móvil** (Expo + EAS Build, iOS primero). Desde el auto por Bluetooth, sin app de CarPlay. |

## 2. Estado del código que condiciona el plan

Verificado el 02-oct en `main`:

- Director (`crates/services/src/services/director.rs`): misión = sesión en el scratch workspace del repo; MCP propio en `/api/director-mcp/{session_id}` con `list_repos`, `list_workers`, `set_mission`, `upsert_item`, `remove_item`, `get_brief`, `app_api_reference`, `app_api`, `ask_user`. El system prompt se arma por turno con `[DIRECTOR SOUL]` y `[APP CONTEXT]`.
- Cada follow-up de una misión pasa por `POST /sessions/{id}/follow-up` (`crates/server/src/routes/sessions/mod.rs`), que relanza el CLI con `--resume`. El ejecutor de Claude ya habla el protocolo `stream-json` bidireccional (`--input-format=stream-json`, `ProtocolPeer` en `executors/claude/protocol.rs`), así que mantener el proceso vivo es cuestión de ciclo de vida, no de protocolo.
- Medición (02-oct, `claude -p` con sonnet, prompt trivial): primer turno 2.6 s + 1.4 s de arranque; turnos siguientes con el proceso vivo **1.4-1.5 s** al primer token.
- `NotificationService` (`services/notification.rs`) + `PushNotifier` nativo de Tauri (Windows/macOS/Linux, con deeplink) ya existen.
- `missions.status`: `draft → clarifying → brief_ready → equipping → planning → executing → in_review → closed`, `blocked`. `pending_questions` y `ui_context` ya están en la tabla.
- Pregunta de worker al usuario (`ask_user` para coding agents, estado `waiting_user`): issue #662 de fluke v2, aún no implementado. F1.3 depende de eso.

## 3. Decisiones tomadas (02-oct)

1. **Cerebro (D1)**: CLI de Claude Code persistente. Usa la suscripción del usuario y no reescribe nada. El loop sobre Messages API queda como salida de emergencia si el prompt real de Fluke empuja el primer token por arriba de 3 s.
2. **Conversación (D2)**: una sola conversación permanente por instalación, con **foco explícito** en una misión. El código sabe cuál está en foco (herramienta `focus_mission`); las herramientas del brief operan sobre esa. Fluke nombra el tema cuando cambia ("Sobre el bug del login: ..."); si hay ambigüedad, `ask_user` con las misiones candidatas. Para el modelo no es un contexto infinito: cada turno se arma con memoria + snapshot + brief en foco + historial reciente (compactación del CLI).
3. **Canal móvil (D3)**: app móvil propia con Expo + EAS Build (hay cuenta de Apple Developer). Sin app de CarPlay: el audio va por Bluetooth del teléfono.
4. **Memoria (D4)**: Honcho self-hosted (Postgres + Honcho en docker compose local).
5. **Nube**: no por ahora. Los workers necesitan repo, claves y CPU y se quedan en la PC. Si aparece la razón (PC apagada, varios usuarios) se levanta **solo el cerebro**; la PC se conecta saliente como "manos". Ver F5.

## 4. Decisiones pendientes (confirmar antes de la fase correspondiente)

| # | Decisión | Propuesta | Bloquea |
|---|----------|-----------|---------|
| D5 | **Qué se expone y cómo se autentica** para que ElevenLabs y el celular lleguen a Fluke. | Tailscale: el celular entra a la tailnet (nada público). Para ElevenLabs, que necesita URL pública, Tailscale Funnel solo sobre `/api/director/turn` con bearer token generado en Settings. | F3 |
| D6 | **Política de silencio** ante eventos: qué avisa siempre, qué nunca. | Siempre: falla, pregunta de un worker, PR listo para merge, CI en rojo. Nunca: progreso intermedio. Lo demás lo decide Fluke. Configurable después si molesta. | F1 |
| D7 | **Vida del proceso persistente**. | Un solo proceso (la conversación permanente). Se mata tras 30 min sin uso; el próximo mensaje lo levanta con `--resume`, como hoy. | F0 |
| D8 | **Qué guarda Honcho** del lado de Fluke. | Todo el diálogo usuario↔Fluke. No los eventos del sistema ni las respuestas de `app_api` (ruido). | F2 |

## 5. Fases

Orden por dependencias y por valor sin voz: F0 y F1 ya rinden en texto. Tamaños: S (una corrida corta), M (una corrida), L (partir en dos).

### F0 — Cerebro despierto

| Wave | Issue | Tamaño | Notas |
|------|-------|--------|-------|
| 0 | **F0.1 Proceso persistente para la conversación de Fluke** | L | El follow-up de una sesión de Fluke escribe en el stdin del proceso vivo en vez de relanzar. Idle timeout (D7). Los mecanismos de "exit signal" del review loop (PR #501) no aplican a esta sesión. Medir primer token con el prompt real; si >3 s, abrir la salida de emergencia (Messages API). |
| 0 | **F0.2 `status_snapshot`** | M | Una herramienta, una llamada: corriendo, bloqueado, esperando OK del usuario, PRs abiertos y su CI, preguntas pendientes. Reemplaza cadenas de `app_api` para "¿cómo vamos?". |
| 0 | **F0.3 Confirmaciones en código** | M | Lista de endpoints peligrosos (DELETE, archive, merge, approve, send). `app_api` responde `needs_confirmation` + token en vez de ejecutar; `confirm_action` ejecuta con el token. El chat muestra botón; por voz se lee la pregunta. |
| 1 | **F0.4 Conversación permanente con foco** | L | Una conversación de guardia por instalación (sesión fija); las misiones siguen existiendo pero se crean y se enfocan desde adentro (`focus_mission`, `list_missions`). `[APP CONTEXT]` suma `focus`. UI: un chat, chip con la misión en foco, lista lateral de misiones como índice. Migración: las misiones viejas quedan como historial. |
| 1 | **F0.5 Endpoint de turno** `POST /api/director/turn` | M | Entrada única para todos los canales: `{text, channel: chat\|voice}` → stream SSE de texto. Con `channel: voice` el prompt pide respuestas más cortas y `ask_user` sin chips. El chat actual puede seguir por sesiones hasta que F3 lo necesite. |

### F1 — Iniciativa

| Wave | Issue | Tamaño | Notas |
|------|-------|--------|-------|
| 0 | **F1.1 Eventos → Fluke** | M | Tarea done/failed, review escalado, PR listo para merge, CI en rojo. Cada evento entra a la conversación de guardia como mensaje `[EVENT]` con la instrucción: "si vale la pena, decílo en una oración; si no, respondé exactamente SILENT". El código suprime SILENT. Política en D6. |
| 0 | **F1.2 Notificación nativa** | S | Si Fluke habla por un evento y la ventana no está al frente, `NotificationService` con deeplink al chat de Fluke. |
| 1 | **F1.3 Preguntas de workers por Fluke** | M | Depende de #662 (`waiting_user`). La pregunta del worker llega como evento; Fluke la traduce; la respuesta del usuario vuelve al worker por `app_api`. Un solo interlocutor. |

### F2 — Memoria (Honcho self-hosted)

| Wave | Issue | Tamaño | Notas |
|------|-------|--------|-------|
| 0 | **F2.1 Honcho local** | S | `docker compose` con Postgres + Honcho; Settings → Fluke: URL y API key. Si no está configurado, Fluke funciona sin memoria. |
| 1 | **F2.2 Espejo de la conversación** | M | Cada turno usuario↔Fluke se manda a una sesión de Honcho (peers `user` y `fluke`), por REST desde el backend. Qué entra: D8. |
| 1 | **F2.3 Contexto por turno** | M | Antes de cada turno, consulta a Honcho con el mensaje del usuario (API dialéctica / contexto de sesión) → bloque `[MEMORY]` en el system prompt. "Acordate que..." no necesita herramienta: es un mensaje más que Honcho modela. |

### F3 — Voz (ElevenLabs + app móvil)

| Wave | Issue | Tamaño | Notas |
|------|-------|--------|-------|
| 0 | **F3.1 Exposición y auth** | S | Según D5. Token en Settings; el túnel solo ve `/api/director/turn`. Nada más de la API sale de la PC. |
| 0 | **F3.2 Adaptador custom-LLM** | M | Endpoint compatible con chat-completions con streaming que envuelve F0.5: toma el último mensaje del usuario, lo manda al proceso de Fluke, devuelve los deltas. ElevenLabs hace STT, turnos, interrupciones y TTS; solo ve texto. Las herramientas son nuestras. **Acuse inmediato**: emite un "Dale." / "A ver." apenas llega el mensaje, antes del primer token de Fluke, para que el silencio percibido sea ~1 s. |
| 1 | **F3.3 Voz en la app de escritorio** | S | Botón de hablar en el panel de Fluke con el SDK web de ElevenLabs. |
| 1 | **F3.4 App móvil** | L | Expo + EAS Build, iOS primero. Una pantalla: hablar con Fluke (SDK React Native de ElevenLabs) y el transcript. Entra a la PC por Tailscale. CarPlay = Bluetooth del teléfono, sin app propia de CarPlay. |
| 2 | **F3.5 Push al celular** | M | Los eventos de F1 que Fluke decide contar llegan al celular (Expo push) cuando la app de escritorio no está al frente. |

### F4 — Seguimiento hasta el merge

Depende de fluke v2 (plan de fases por issue). Fluke sigue el plan de cada issue y empuja los pasos siguientes; el merge sigue siendo humano (REVIEW-LOOP-SPEC), pero puede ser un "sí" dicho por voz: Fluke pregunta, el usuario confirma (F0.3), Fluke mergea por `app_api`.

### F5 — Nube (solo si aparece la razón)

Levantar únicamente el cerebro (proceso de Fluke + Honcho + adaptador ElevenLabs) en un host siempre encendido; la PC se conecta saliente y expone `app_api` por esa conexión. Costo real: en la nube no corre la suscripción de Claude Code, el cerebro pasa a Messages API por token. No se planifica hasta que haga falta.

## 6. Presupuesto de latencia por voz

Desde que el usuario termina de hablar hasta el primer audio de respuesta (cifras típicas de ElevenLabs Agents; Fish Audio similar en TTS):

| Etapa | Tiempo |
|---|---|
| Detección de fin de turno (VAD) | 0.3–0.6 s |
| ASR: cierre de la transcripción (streaming) | 0.2–0.4 s |
| Red ElevenLabs → túnel → PC → vuelta | 0.2–0.4 s |
| Fluke: primer token (CLI persistente) | 1.5–3 s |
| TTS: primer audio (Flash) + red | 0.2–0.4 s |
| **Total** | **2.5–4.5 s** |

Cada herramienta que Fluke llama antes de contestar suma 1–3 s más; por eso `status_snapshot` (F0.2) y el acuse inmediato (F3.2), que baja el silencio percibido a ~1 s. El TTS no es el término grande: cambiar de proveedor no mueve la aguja; el cerebro sí.

## 7. Riesgos

- **Latencia con el prompt real**: la medición fue con prompt trivial y sin herramientas. F0.1 mide con el prompt de Fluke; el umbral es 3 s al primer token. Si se supera, la salida de emergencia es un modelo rápido por Messages API solo para el canal de voz.
- **SDKs de terceros**: la forma exacta de la API de Honcho (dialéctica, contexto) y del SDK React Native de ElevenLabs (WebRTC) se verifica al implementar F2.2 y F3.4, no antes.
- **Superficie expuesta**: F3.1 es una frontera de confianza. Solo el endpoint de turno, solo con token, y las confirmaciones de F0.3 en código para que una orden mal entendida por voz no borre nada.
- **Confusión de tema** en la conversación permanente: mitigada por foco explícito + nombrar el tema + `ask_user` ante ambigüedad. Si en la práctica no alcanza, el fallback es volver a una conversación por misión con la de guardia solo para eventos.
