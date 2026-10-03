---
scope: Fluke como Jarvis (solo desarrollo) — cerebro siempre despierto, conversación permanente con foco, iniciativa por eventos, memoria (Honcho central nuestro), voz (ElevenLabs + app móvil EAS); Claude BYOK, el resto servicio nuestro
slug: fluke-jarvis
status: draft — pendiente de aprobación por Dani
approved_by: (pendiente)
created: 2026-10-02
version: 1
complements: FLUKE-V2-SPEC.md (perfiles, plan por issue, Issues por milestone), REVIEW-LOOP-SPEC.md (merge humano), DESKTOP-SPEC.md
mockups: https://claude.ai/artifact/La7VehB55E3HgdPzKJHzez (canvas "Fluke Jarvis", en curso) — fuentes en design/mockups/fluke-jarvis/
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
| 4 | Sin memoria entre sesiones | **Honcho** (central, nuestro): cada turno se espeja; antes de responder, Fluke recibe lo que Honcho sabe del usuario y del tema. |
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
3. **Canal móvil (D3)**: app móvil propia con Expo + EAS Build (hay cuenta de Apple Developer). **CarPlay nativo**: desde iOS 26.4 existe la categoría "conversación por voz" (plantilla de solo voz, entitlement aprobado app por app; es la que usan ChatGPT y Claude). Se pide el entitlement apenas exista el bundle, porque la aprobación es incierta y lenta. Respaldo mientras no llegue (y para autos sin CarPlay): la misma app con audio por Bluetooth del teléfono. **Sin número de teléfono** (descartado 03-oct: no gusta la experiencia de llamada y el alta con KYC por cliente no cierra).
4. **Memoria (D4)**: Honcho self-hosted **por nosotros**, central: un Honcho en nuestro VPS, un workspace por cliente, con nuestra API key. El cliente no instala nada.
5. **Nube**: el cerebro y los workers se quedan en la PC del cliente (necesitan repo, claves, CPU y la suscripción de Claude). Lo que vive en nuestro lado es un **control plane liviano**: relay, Honcho, tokens efímeros de ElevenLabs, topes y cobro. Ver F5.
6. **Modelo de negocio (03-oct)**: **Claude es BYOK** (la suscripción es personal; revenderla viola los términos de Anthropic y pagar los tokens de los workers por API es la variante "IA incluida" ya descartada). **Todo lo demás es servicio nuestro**: voz (una cuenta de ElevenLabs nuestra, un agente por cliente), memoria (Honcho central), celular (una app nuestra en App Store). Se cobra como add-on fijo por tiers (minutos de voz incluidos), nunca pass-through de uso: "sin sorpresas" para el cliente y tope conocido para nosotros. El margen del pasamanos es simbólico; el valor es que el cliente no abre tres cuentas. Puede ser el centro del modelo comercial; ver sección 7.
7. **Acceso remoto (ex D5, 03-oct)**: **relay nuestro**, sin Tailscale. La PC abre un WebSocket saliente al control plane con su licencia y lo mantiene vivo; el celular y ElevenLabs hablan con el control plane, que reenvía por ese socket. Por el relay pasa solo texto (los turnos de Fluke); el audio va directo celular↔ElevenLabs por WebRTC. La PC no expone nada. PC apagada → el relay responde que está apagada.
8. **Identidad del celular (03-oct)**: **emparejamiento**, no cuenta. La licencia de la instalación ya es la identidad. Settings → Fluke → "Vincular celular" muestra un QR (token de un solo uso emitido por el control plane); la app lo escanea y recibe un token de dispositivo de larga duración atado a esa instalación. Dispositivos vinculados visibles y revocables desde la PC. Sin usuario ni contraseña; Sign in with Apple no aplica.

## 4. Decisiones pendientes (confirmar antes de la fase correspondiente)

| # | Decisión | Propuesta | Bloquea |
|---|----------|-----------|---------|
| ~~D5~~ | ~~Qué se expone y cómo se autentica~~ | Resuelta: relay nuestro (decisión 7). | — |
| D6 | **Política de silencio** ante eventos: qué avisa siempre, qué nunca. | Siempre: falla, pregunta de un worker, PR listo para merge, CI en rojo. Nunca: progreso intermedio. Lo demás lo decide Fluke. Configurable después si molesta. | F1 |
| D7 | **Vida del proceso persistente**. | Un solo proceso (la conversación permanente). Se mata tras 30 min sin uso; el próximo mensaje lo levanta con `--resume`, como hoy. | F0 |
| D8 | **Qué guarda Honcho** del lado de Fluke. | Todo el diálogo usuario↔Fluke. No los eventos del sistema ni las respuestas de `app_api` (ruido). Nota: el diálogo del cliente pasa por nuestro VPS; va en los términos. | F2 |
| D9 | **Tiers del add-on Jarvis**: cuántos minutos de voz y a qué precio. | Un tier chico y uno grande, precio redondo por encima del peor caso (todos los minutos usados). Se fija con los costos reales de ElevenLabs al momento de F3. | F3 |
| D10 | **Cuenta con email** (varias personas por licencia, recuperación sin la PC). | No por ahora: el emparejamiento por QR cubre un usuario por instalación. Si hace falta, magic link al email del cliente de Stripe; nunca contraseña. | — |

## 5. Fases

Orden por dependencias y por valor sin voz: F0 y F1 ya rinden en texto. Tamaños: S (una corrida corta), M (una corrida), L (partir en dos).

### F0 — Cerebro despierto

| Wave | Issue | Tamaño | Notas |
|------|-------|--------|-------|
| 0 | **F0.1 Proceso persistente para la conversación de Fluke** | L | El follow-up de una sesión de Fluke escribe en el stdin del proceso vivo en vez de relanzar. Idle timeout (D7). Los mecanismos de "exit signal" del review loop (PR #501) no aplican a esta sesión. Medir primer token con el prompt real; si >3 s, abrir la salida de emergencia (Messages API). |
| 0 | **F0.2 Estado precargado** | M | El código arma un resumen (corriendo, bloqueado, esperando OK del usuario, PRs abiertos y su CI, preguntas pendientes) y lo inyecta en cada turno como bloque `[STATUS]`, igual que `[APP CONTEXT]`. "¿Cómo vamos?" pasa a cero herramientas. La misma función queda expuesta como herramienta `status_snapshot` para cuando Fluke quiera refrescarlo. |
| 0 | **F0.3 Confirmaciones en código** | M | Lista de endpoints peligrosos (DELETE, archive, merge, approve, send). `app_api` responde `needs_confirmation` + token en vez de ejecutar; `confirm_action` ejecuta con el token. El chat muestra botón; por voz se lee la pregunta. |
| 0 | **F0.4 Menos round trips** | S | `app_api` acepta nombres donde la UI usa ids (`worker`, `repo`, `profile`) y los resuelve en el backend: le saca un GET a casi toda orden. Fluke corre en un directorio vacío, no en el scratch del repo: no carga AGENTS.md ni nada del repo (no edita código). |
| 1 | **F0.5 Conversación permanente con foco** | L | Una conversación de guardia por instalación (sesión fija); las misiones siguen existiendo pero se crean y se enfocan desde adentro (`focus_mission`, `list_missions`). `[APP CONTEXT]` suma `focus`. UI: un chat, chip con la misión en foco, lista lateral de misiones como índice. Migración: las misiones viejas quedan como historial. |
| 1 | **F0.6 Endpoint de turno** `POST /api/director/turn` | M | Entrada única para todos los canales: `{text, channel: chat\|voice}` → stream SSE de texto. Con `channel: voice` el prompt pide respuestas más cortas, `ask_user` sin chips, y la regla **anunciar, hacer, confirmar**: para una orden, primero una frase con lo que va a hacer, después la herramienta, después "Listo". La espera por la herramienta queda tapada por audio. El chat actual puede seguir por sesiones hasta que F3 lo necesite. |

### F1 — Iniciativa

| Wave | Issue | Tamaño | Notas |
|------|-------|--------|-------|
| 0 | **F1.1 Eventos → Fluke** | M | Tarea done/failed, review escalado, PR listo para merge, CI en rojo. Cada evento entra a la conversación de guardia como mensaje `[EVENT]` con la instrucción: "si vale la pena, decílo en una oración; si no, respondé exactamente SILENT". El código suprime SILENT. Política en D6. |
| 0 | **F1.2 Notificación nativa** | S | Si Fluke habla por un evento y la ventana no está al frente, `NotificationService` con deeplink al chat de Fluke. |
| 1 | **F1.3 Preguntas de workers por Fluke** | M | Depende de #662 (`waiting_user`). La pregunta del worker llega como evento; Fluke la traduce; la respuesta del usuario vuelve al worker por `app_api`. Un solo interlocutor. |

### F2 — Memoria (Honcho central) y control plane

| Wave | Issue | Tamaño | Notas |
|------|-------|--------|-------|
| 0 | **F2.1 Control plane mínimo** | M | Servicio nuestro en el VPS, sobre la licencia + heartbeat ya planeados (LICENSING-SPEC): la app se autentica con su licencia y recibe lo que necesita (URL y credencial de Honcho, más adelante tokens efímeros de ElevenLabs). Topes por cliente viven acá. Nuestras keys nunca viajan en la app. |
| 0 | **F2.2 Relay** | M | En el control plane: la PC mantiene un WebSocket saliente autenticado con su licencia; `POST /relay/{instalación}/turn` (auth: token de dispositivo o secreto del agente de ElevenLabs) se reenvía por ese socket al endpoint de turno de la PC (F0.6) y streamea la respuesta de vuelta. Solo texto. PC desconectada → 503 con mensaje "la PC está apagada". Cuando entra, el chat de la PC sigue sin relay. |
| 0 | **F2.3 Honcho central** | S | Un Honcho (Postgres + Honcho) en nuestro VPS, con nuestra API key de Anthropic; un workspace por cliente, provisionado por el control plane. Sin licencia activa, Fluke funciona sin memoria. |
| 1 | **F2.4 Espejo de la conversación** | M | Cada turno usuario↔Fluke se manda a una sesión de Honcho (peers `user` y `fluke`), por REST desde el backend de la app. Qué entra: D8. |
| 1 | **F2.5 Contexto por turno** | M | Antes de cada turno, consulta a Honcho con el mensaje del usuario (API dialéctica / contexto de sesión) → bloque `[MEMORY]` en el system prompt. "Acordate que..." no necesita herramienta: es un mensaje más que Honcho modela. |

### F3 — Voz (ElevenLabs + app móvil)

| Wave | Issue | Tamaño | Notas |
|------|-------|--------|-------|
| 0 | **F3.0 Entitlement de CarPlay** | S | Crear el bundle de la app móvil y pedir a Apple el entitlement de la categoría de conversación por voz. Sin código: es un trámite que tarda, y bloquea F3.5 solo en su parte de CarPlay. |
| 0 | **F3.1 Emparejamiento del celular** | M | Settings → Fluke → "Vincular celular": QR con token de un solo uso del control plane; la app móvil lo canjea por un token de dispositivo atado a la instalación. Lista de dispositivos vinculados con revocar. Es la única identidad del celular (decisión 8). |
| 0 | **F3.2 Agente por cliente** | M | El control plane crea el agente en nuestra cuenta de ElevenLabs (API de agentes, custom LLM = `relay/{instalación}/turn` con su secreto) y le entrega a la app tokens efímeros de conversación. Contador de minutos y tope por tier (D9): al llegar, Fluke avisa y la voz se pausa. |
| 0 | **F3.3 Adaptador custom-LLM** | M | Endpoint compatible con chat-completions con streaming que envuelve F0.5: toma el último mensaje del usuario, lo manda al proceso de Fluke, devuelve los deltas. ElevenLabs hace STT, turnos, interrupciones y TTS; solo ve texto. Las herramientas son nuestras. **Acuse inmediato**: emite un "Dale." / "A ver." apenas llega el mensaje, antes del primer token de Fluke, para que el silencio percibido sea ~1 s. |
| 1 | **F3.4 Voz en la app de escritorio** | S | Botón de hablar en el panel de Fluke con el SDK web de ElevenLabs. |
| 1 | **F3.5 App móvil** | L | Expo + EAS Build, iOS primero; una app nuestra en App Store para todos los clientes. Una pantalla: hablar con Fluke (SDK React Native de ElevenLabs) y el transcript (texto por el relay). Primer uso: escanear el QR (F3.1). **CarPlay** con la plantilla de voz de Apple (`react-native-carplay` + config plugin de EAS): un botón para hablar, sin texto en pantalla, se inicia con el auto detenido; requiere F3.0 aprobado. Hasta entonces, audio por Bluetooth del teléfono, con un atajo de Siri ("hablá con Fluke") para arrancar sin tocar la pantalla. |
| 2 | **F3.6 Push al celular** | M | Los eventos de F1 que Fluke decide contar llegan al celular (Expo push) cuando la app de escritorio no está al frente. |

### F4 — Seguimiento hasta el merge

Depende de fluke v2 (plan de fases por issue). Fluke sigue el plan de cada issue y empuja los pasos siguientes; el merge sigue siendo humano (REVIEW-LOOP-SPEC), pero puede ser un "sí" dicho por voz: Fluke pregunta, el usuario confirma (F0.3), Fluke mergea por `app_api`.

### F5 — Cerebro en la nube (solo si aparece la razón)

El control plane de F2 ya es "nube". Lo que **no** se mueve es el cerebro ni los workers: viven en la PC del cliente, con su suscripción de Claude. Mover el cerebro a un host siempre encendido (para que Fluke conteste con la PC apagada) obligaría a Messages API por token, pagado por alguien. No se planifica hasta que haga falta.

## 6b. Diseño (estudio en curso)

Canvas: https://claude.ai/artifact/La7VehB55E3HgdPzKJHzez. Las fuentes de cada artboard (`.dc.html`) están copiadas en `design/mockups/fluke-jarvis/`; el canvas es la fuente de verdad mientras el estudio siga abierto, y al cerrarse se implementa tal cual (regla de los mockups de v2).

**Lenguaje**: los artboards A–C exploran un HUD navy (`#0C121F` con grilla); **la realidad de fluke es UI-SPEC v3 (zinc + índigo, dark `#09090B` / `#18181B` / bordes `#3F3F46`, 13px sistema, bordes sobre ornamento)** y el artboard D ya está en esos tokens: A–C se adaptan a ellos en la próxima iteración, conservando lo que sí es de Fluke: acento índigo (`#818CF8` / `#6366F1`), ámbar `#FBBF24` solo para "lo espera", verde `#4ADE80` para activos, etiquetas monospace para estados; el **núcleo de anillos** es el estado de Fluke y aparece en todas las presentaciones, del tamaño que haga falta: reposo (anillo lento), escuchando (pulso + micrófono), pensando (arcos rápidos + onda), hablando (logo + onda), lo espera (ámbar + contador).

| Artboard | Qué muestra | Fase / issue que lo implementa |
|---|---|---|
| **A · Puente de mando** (1440×900, página) | Pestañas de misiones arriba (la activa = foco), columna izquierda con Misiones, Equipo y "Fluke está viendo", centro con las 4 fases de la misión, el núcleo, la conversación, la pregunta de Fluke con chips y el input con micrófono; derecha el brief con checklist y la compuerta "Aprobar brief". | F0.5 (conversación permanente: pestañas = misiones, "Misiones" = índice), F0.2 (Equipo y "Fluke está viendo" son `[STATUS]` y `[APP CONTEXT]` hechos visibles), F0.3 (compuerta de aprobación), F0.6 (input de texto + hablar en el mismo lugar). |
| **B1 · Panel: escuchando / B2 · Panel: Fluke responde** (380×640) | Panel compacto centrado en la voz: misión en foco con progreso del brief, núcleo grande, transcripción en vivo, última pregunta de Fluke, botón central (detener / interrumpir), cambiar a texto, cancelar o silenciar. | F3.4 (voz en escritorio); base visual de F3.5 (móvil, mismo panel a 390×844). B2 muestra "anunciar, hacer, confirmar" (F0.6) y la acción "Enviar al Analista" como chip. |
| **D · Compuertas en texto y en voz** (1480×1540) | Las tres compuertas del flujo real, cada una en el panel de 380×640 en modo texto y en modo voz, con los **tokens dark reales** (zinc + índigo de UI-SPEC v3, 13px, bordes sobre ornamento): (1) pregunta de Fluke = `ask_user` (hasta 3 preguntas, 4 opciones, chips + "otra respuesta"); (2) aprobar el brief = `brief_ready` (tarjeta con ítem, plantilla, equipo; "Aprobar y enviar al Analista" / "Ver brief" / "Pedir cambios"); (3) decisión a media ejecución = `fluke:decision` o `ask_user` de un worker (opciones como tarjetas, recomendada marcada con porqué, "Usar la recomendada" / "Otra respuesta" / "Devolver al Analyst"). En voz: mismo panel y misma conversación; Fluke lee la compuerta, recomendación primero, y escucha; los chips quedan como atajo; aprobar exige un "sí" explícito. | F0.3 (confirmación en código), F0.6 (canal voz), F1.3 (preguntas de workers por Fluke), F3.4. Es el artboard de referencia para la adaptación de A, B y C a los tokens reales. |
| **C · Estados del núcleo (burbuja)** (1100×420) | La burbuja flotante en 4 estados: reposo, escuchando sin abrir el panel (se estira y transcribe), trabajando (píldora con la misión en ejecución y segmentos por issue), lo espera (ámbar + contador + tarjeta con la compuerta). | F0.1 (siempre despierto), F1 (lo espera = eventos y preguntas pendientes, con la tarjeta como notificación in-app), F4 (trabajando sigue el plan por issue). |

**Lo que el diseño pide y el plan todavía no tiene** (se resuelven antes de la fase correspondiente):

| # | Decisión | Propuesta | Bloquea |
|---|----------|-----------|---------|
| D11 | **Wake word "Fluke" en escritorio** (burbuja 01 dice "Diga Fluke"). Implica micrófono siempre abierto y detección local. | Primero Espacio mantenido y Ctrl+Shift+I (ya en el mockup). Wake word después, con detección local (openWakeWord o Porcupine), opt-in en Settings. | F3.4 |
| ~~D12~~ | ~~Fases de la misión del mockup~~ | Resuelta por D15: las 5 fases reales. | — |
| D13 | **Panel y vista expandida** son dos presentaciones de la misma conversación (D2), no dos conversaciones. | Sí: mismo hilo, mismo foco; el panel muestra el último intercambio y la vista expandida el historial. "Expandir" y "Volver al panel" alternan sin perder nada. | F0.5 |
| D14 | **Texto y voz son dos modos del mismo panel**, no dos pantallas (artboard D). | Un toggle en el header (micrófono ↔ teclado). Toda compuerta tiene las dos formas: tarjeta con chips en texto; lectura en voz alta + escucha en voz, con los chips como atajo. En voz Fluke dice la recomendación primero y las demás opciones solo si se las piden. Lo peligroso (aprobar, mergear, borrar) exige un "sí" explícito en los dos modos (F0.3). | F0.3, F0.6 |
| D15 | **Fases visibles**: el mockup A muestra 4 (BRIEF → SPEC → PLAN → TAREAS); el código tiene 5 (Entender → Brief → Despiece → Plan → Ejecución, `missionSteps.ts`). | Usar las 5 reales en A; D12 queda resuelta por esto. | F0.5 |

**Pantallas que faltan en el estudio** (próximas iteraciones): A, B y C adaptados a los tokens reales y a las 5 fases (siguiendo D); móvil 390×844 (panel + emparejamiento por QR + estado "la PC está apagada"), plantilla de CarPlay (solo voz), Settings → Fluke (login de Claude Code, licencia, celulares vinculados), confirmación de acción peligrosa (F0.3) en chat y por voz, notificación nativa con deeplink (F1.2), y la burbuja en estado "error" (relay caído, agente desconectado).

## 7. Cuentas y costos

Regla: **Claude BYOK; el resto es servicio nuestro**, cobrado como add-on fijo por tiers.

| Servicio | Quién paga | Cómo entra |
|---|---|---|
| Claude Code (cerebro de Fluke y workers) | El cliente, su suscripción | Ya existe: Settings → Agentes |
| Honcho + su LLM | Nosotros (VPS + API key de Anthropic) | Control plane, invisible para el cliente |
| ElevenLabs (ASR, turnos, TTS) | Nosotros, una cuenta Business; un agente por cliente | Control plane entrega tokens efímeros; minutos incluidos por tier |
| App móvil | Nosotros (Apple Developer, EAS Build) | Una app en App Store, cero costo por cliente |
| Relay | Nosotros (parte del control plane; solo texto, un VPS chico alcanza) | Invisible: la PC se conecta sola |
| Push al celular | Gratis (Expo push) | — |

El cliente no instala nada más que fluke y la app móvil. Settings → Fluke muestra tres cosas: su login de Claude Code, su licencia de fluke y los celulares vinculados. Nada más. Si no tiene licencia activa, Fluke anda por texto sin memoria ni voz, y Fluke mismo le dice qué le falta.

Para nosotros: topes por cliente en el control plane (minutos de voz, llamadas de Honcho) porque absorbemos la varianza; precio de tier por encima del peor caso; cobro con suscripción fija (Stripe), nunca por uso.

## 8. Presupuesto de latencia por voz

Desde que el usuario termina de hablar hasta el primer audio de respuesta (cifras típicas de ElevenLabs Agents; Fish Audio similar en TTS):

| Etapa | Tiempo |
|---|---|
| Detección de fin de turno (VAD) | 0.3–0.6 s |
| ASR: cierre de la transcripción (streaming) | 0.2–0.4 s |
| Red ElevenLabs → relay → PC → vuelta | 0.2–0.4 s (relay al lado de ElevenLabs: neutro) |
| Fluke: primer token (CLI persistente) | 1.5–3 s |
| TTS: primer audio (Flash) + red | 0.2–0.4 s |
| **Total** | **2.5–4.5 s** |

Cada herramienta que Fluke llama antes de contestar suma 1–3 s más; por eso el estado precargado (F0.2), los nombres en `app_api` y el directorio vacío (F0.4), la regla anunciar-hacer-confirmar (F0.6) y el acuse inmediato (F3.3), que bajan el silencio percibido a ~1 s. El TTS no es el término grande: cambiar de proveedor no mueve la aguja; el cerebro sí. Piso con todo eso y CLI persistente: ~2–3 s reales; con Messages API + prompt caching: ~1.5–2 s.

## 9. Riesgos

- **Latencia con el prompt real**: la medición fue con prompt trivial y sin herramientas. F0.1 mide con el prompt de Fluke; el umbral es 3 s al primer token. Si se supera, la salida de emergencia es un modelo rápido por Messages API solo para el canal de voz.
- **SDKs de terceros**: la forma exacta de la API de Honcho (dialéctica, contexto) y del SDK React Native de ElevenLabs (WebRTC) se verifica al implementar F2.2 y F3.4, no antes.
- **Superficie expuesta**: el relay (F2.2) es una frontera de confianza. La PC no abre puertos; el relay solo reenvía al endpoint de turno, solo con token de dispositivo o secreto del agente, y las confirmaciones de F0.3 en código para que una orden mal entendida por voz no borre nada. Nuestra disponibilidad pasa a ser dependencia de la voz y el celular; el chat en la PC no depende del relay.
- **Confusión de tema** en la conversación permanente: mitigada por foco explícito + nombrar el tema + `ask_user` ante ambigüedad. Si en la práctica no alcanza, el fallback es volver a una conversación por misión con la de guardia solo para eventos.
