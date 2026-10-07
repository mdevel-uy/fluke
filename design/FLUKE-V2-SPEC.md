---
scope: Transformación de fluke — perfiles en vez de workers, plan de fases por issue, Issues centrado en milestones con play, Fluke como única entrada, destrabe asistido
slug: fluke-v2
status: draft — pendiente de aprobación por Dani
approved_by: (pendiente)
created: 2026-10-02
version: 1
mockups: design/mockups/fluke-v2/pantallas.html (todas las pantallas) · design/mockups/fluke-v2/issues-plan.html (Issues interactivo) — copias de https://claude.ai/artifact/4x2yVfyrAQHZr562Nz4Roo y https://claude.ai/artifact/EsVzj4kZcUyLUegyQ7BMP5
complements: REVIEW-LOOP-SPEC.md (loop dev↔reviewer), AGENT-ACTIONS-SPEC.md (outbox), SHELL-SPEC.md
---

# fluke v2 — Plan de implementación (v1)

> **Principio rector: el usuario habla con Fluke; Fluke organiza; los perfiles ejecutan.**
> Nadie pide cosas a un agente con nombre. El trabajo se ve por issue y por
> milestone, nunca por agente. Cada fase de un issue la toma una instancia
> efímera de un perfil, trabaja sobre el workspace del issue y se descarta.
> Lo que necesita una persona (decidir, destrabar, aprobar un merge) se
> muestra como compuerta visible, nunca queda escondido en una sesión.

## 1. Qué cambia (resumen de lo acordado el 02-oct)

| # | Hoy | Nuevo |
|---|-----|-------|
| 1 | Workers con nombre, cola propia, soul y PAT cada uno | **Perfiles** (Fullstack, Backend, Frontend, Analyst, Reviewer, QA, Designer): plantillas. Instancias efímeras por fase. PAT por perfil, o el del usuario por defecto. Solo slots globales, ajustables en Settings. |
| 2 | Plan de pasos atado al workspace del agente (`plans.workspace_id`) | **Plan de fases por issue**: TDD → desarrollo → testing → review → vueltas → merge. Tres niveles: Fluke elige la plantilla (¿diseño? ¿TDD?), el Analyst arma el flujo entre issues (waves), el dev arma el plan interno de su fase. |
| 3 | Tabla de issues con agrupado opcional | **Issues centrado en milestones**: una banda por milestone con play, waves en columnas, compuertas `pm:decision`, drawer para decidir. |
| 4 | `/analyst-desk`: pedidos directos al analista | **Solo Fluke**. Conversa, pregunta, arma el brief; con el brief aprobado encarga el despiece al perfil Analyst. |
| 5 | Pantallas Workspaces y Source control | **Un workspace por issue**, compartido por todas las fases. Se ve en las pestañas Código y Sesiones del issue. El rail queda en Fluke, Issues, Perfiles, Settings. |
| 6 | Una fase que se tranca queda en la sesión | **Trancado visible**: card roja + contador global + banner en el issue + drawer "Destrabar" con la explicación de Fluke, lo intentado, la pregunta del agente y salidas alternativas. |

## 2. Estado del código que condiciona el plan

Verificado el 02-oct en `main`:

- `workers.role` ∈ {developer, analyst, reviewer, designer, orchestrator} con CHECK en SQL; un solo orchestrator (Fluke). Cada `worker_task` tiene `worker_id`: la cola es por worker. LRU solo para reviewers (`select_lru_reviewer`, con busy-skip).
- Estados de tarea: `queued | in_progress | in_review | approved | done | failed` (strings validados, no enum). Kinds: `review_fix`, `design_handoff`. `failure_kind = infra` ya existe con backoff.
- Plan de pasos: `plans(workspace_id PK, status running|paused|halted)`, `plan_steps(n, title, files, depends_on, state pending|active|done|cut, checkpoint)`, `plan_step_revisions`. Lo crea el agente vía MCP (`submit_plan`, `start_step`, `complete_step`).
- Director: `missions` (status `draft → clarifying → brief_ready → equipping → planning → executing → in_review → closed`, `blocked`), `mission_items`, `mission_briefs`, `mission_issues`. `approve_brief` ya crea una tarea `source=desk` para el analista y pasa a `planning`. Fluke ya tiene la herramienta `ask_user` y `pending_questions`.
- Slots: `ConcurrencySemaphore` lee `Config.agent_concurrency_limit`. **Falta solo la UI** (issue #626).
- Labels de ejecución: `feature:<slug>`, `wave:<n>`, `resource:<slug>` (frontend `executionLabels.ts`, Rust `execution_labels.rs`). `buildExecutionPlan` + `ExecutionPlanView` ya agrupan feature → wave. Contrato `pm:decision` en el soul del analista: sección `## Decisión pendiente del PM` en markdown (formato libre).
- Review loop: `review_rounds`, cap `WORKER_REVIEW_MAX_ROUNDS=3`, request_changes encola `review_fix` al frente de la cola del autor. **El merge es decisión humana** (principio de REVIEW-LOOP-SPEC).

## 3. Decisiones tomadas

1. **GitHub**: cada perfil puede tener PAT; si no, usa el del usuario. Todas las instancias del perfil comparten ese PAT. Se mantiene la regla R0 del review loop: el PAT del Reviewer debe ser de otra cuenta que el del autor.
2. **Concurrencia**: solo slots globales, sin máximo por perfil. Ajustables desde Settings → General.
3. **Plan en tres niveles**: Fluke elige la plantilla; el Analyst arma el flujo entre issues; el dev arma el plan interno de cada fase de desarrollo.
4. **TDD**: no se aplica si no tiene sentido para el tipo de ítem (diseño, bug que no se reproduce). Si tiene sentido, Fluke pregunta al usuario con `ask_user`.
5. **Migración de workers**: un referente por rol → su soul y configuración pasan a ser la plantilla del perfil; los workers se borran.
6. **Merge (ex D1, 02-oct)**: siempre humano. La fase Merge es una compuerta tuya (botón Mergear en la card y en el issue), sin excepción por nivel de autonomía.
7. **Milestone (ex D2, 02-oct)**: una sola fuente, el milestone de GitHub. El Analyst crea el milestone y se lo asigna a los issues; la banda agrupa por milestone. El label `feature:` deja de hacer falta cuando F1.1 agrupa por milestone; hasta entonces se sigue poniendo para que la vista actual funcione.
8. **Referente (ex D3, 03-oct)**: los workers de un mismo rol son iguales; la migración (#681) toma el más antiguo del rol, prefiriendo los activos, hereda un PAT del rol si no tiene, re-apunta tareas, workspaces e ítems de misión, guarda su nombre en `migrated_from` y borra el resto.
9. **Tareas en vuelo (ex D4, 03-oct)**: no va a haber nada corriendo al migrar; la migración es SQL directa, sin chequeo previo.

## 4. Decisiones pendientes (confirmar antes de la fase correspondiente)

| # | Decisión | Propuesta | Bloquea |
|---|----------|-----------|---------|
| D5 | **Reviewer sobre el mismo workspace**: hoy el reviewer hace checkout en su propio worktree. | Las fases son secuenciales, así que el Reviewer lee el worktree del issue. Si hace falta aislar, un worktree de solo lectura por fase de review. | F3 |

## 5. Fases

Orden elegido por dependencias y por mantener la app usable en cada paso (es la instancia de desarrollo diaria). Cada fase es un milestone con waves, así se puede ejecutar con la propia vista Plan a partir de F1. Tamaños: S (una corrida corta), M (una corrida), L (partir en dos).

### F0 — Fundaciones (sin cambiar el modelo de datos visible)

Pequeñas, independientes, desbloquean todo lo demás.

| Wave | Issue | Tamaño | Notas |
|------|-------|--------|-------|
| 0 | **F0.1 Slots ajustables en Settings → General** · #626 | S | Wiring de `agent_concurrency_limit` a Settings; el semáforo ya lo lee. |
| 0 | **F0.2 Contrato estructurado de `pm:decision`** · #661 | M | El analista agrega al body, además del markdown, un bloque `<!-- fluke:decision {json} -->` con preguntas, opciones, recomendación, porqué y condiciones. Parser puro en el frontend (`features/issues/lib/decisionBlock.ts`) + soul del analista. Sin bloque → el drawer muestra el markdown. |
| 0 | **F0.3 `ask_user` para coding agents** · #662 | M | Nueva herramienta en el plan MCP (misma forma que la de Fluke). Estado de tarea `waiting_user` con la pregunta en JSON, endpoint para responder a la misma sesión, entrada destacada en la conversación del workspace. Base del "trancado". |
| — | ~~F0.4 Endpoint "decidir"~~ | — | Ya resuelto por #655 / PR #660 (`repoIssuesApi.comment` + quitar label). El drawer lo reusa. |

### F1 — Issues centrado en milestones (el mockup aprobado)

Valor visible de inmediato; funciona con los workers actuales, el "worker" de la card pasa a ser el perfil en F2.

Las cards de Plan y las filas de Lista/grupos ofrecen acceso visible al workspace de la tarea activa cuando tiene `workspace_id`, sin seleccionar la issue ni modificar la lista lateral de Workspaces (#830).

| Wave | Issue | Tamaño | Notas |
|------|-------|--------|-------|
| 0 | **F1.1 Vista Plan: bandas por milestone** · #663 | L | Reemplaza `ExecutionPlanView` y pasa a ser el modo por defecto de `IssuesPage`. Agrupa por milestone de GitHub (decisión 7) y `wave:`; columnas, cards con estado, flechas, cajón sin milestone/wave. Absorbe el alcance de #652. |
| 1 | **F1.2 Milestone colapsable con resumen** · #664 | M | Chevron, Colapsar/Expandir todas, resumen colapsado (mini mapa de waves, conteos, avatares, "Decidir #n"). |
| 1 | **F1.3 Drawer de decisión** · #665 | M | Lee el bloque de F0.2; opciones como tarjetas, recomendada marcada, condicionales, "Otra respuesta", preview, "Usar recomendaciones", "Devolver al analista", "Cerrar sin hacer". Reusa la publicación de #660. Requiere F0 mergeado. |
| 2 | **F1.4 Play por milestone (orquestador)** · #666 | L | Tabla `milestone_runs`. Play encola la wave actual sin `pm:decision`; avanza cuando todos los de la wave están `done` (PR mergeado, merge humano); frena en `pm:decision` y en fallas; step mode; pausa; Reiniciar; Ejecutar todas; slots en cabecera; actualización en vivo. Hasta F2 asigna al developer con la cola más corta. |
| 2 | **F1.5 Abrir el issue** · #667 | S | Ruta `/issues/$issueNumber` con cabecera y breadcrumb del mockup y el workspace de la tarea; card clickeable; "Abrir issue →" en el drawer; Ctrl+K por número. |

### F2 — Perfiles en vez de workers

| Wave | Issue | Tamaño | Notas |
|------|-------|--------|-------|
| 0 | **F2.1 Modelo de perfiles** | L | Tabla `profiles(id, name, role, soul, executor, model, github_pat, github_login, plan_mode, archived)`. `worker_tasks.profile_id` + `instance_id` (identificador efímero `perfil·xxx`); `worker_id` pasa a nullable y se deja de escribir. Cola única global: `try_take_next` toma la siguiente tarea `queued` que tenga slot, sin cola por worker. LRU de reviewers se elimina; queda solo la regla PAT reviewer ≠ autor. `WORKER_MAX_IN_REVIEW` deja de aplicar por worker. |
| 1 | **F2.2 Migración de workers** | M | Comando/migración guiada: referente por rol (D3), crea perfiles, reasigna `queued`, se niega con tareas en vuelo (D4), archiva los workers. Pantalla de confirmación con la elección del referente. |
| 1 | **F2.3 Pantalla Perfiles** | M | Reemplaza `/workers` (se eliminan `WorkersPage`, `WorkerCard`, `WorkerFormDialog`, `WorkerTaskList`, `ArchivedWorkersSection`). Cards: soul, agente/modelo, "PAT propio / del usuario", "Migrado de", instancias ahora. Banner con slots y link a Settings. |
| 2 | **F2.4 Director usa perfiles** | S | `approve_brief` encarga al perfil Analyst (no a un worker). `analyst_worker_id` → `analyst_profile_id`. |

### F3 — Plan de fases por issue (ciclo de vida)

La fase más grande. Reusa el review loop actual: una ronda de review es una fase; `review_fix` es la vuelta a desarrollo.

| Wave | Issue | Tamaño | Notas |
|------|-------|--------|-------|
| 0 | **F3.1 Modelo de fases** | L | `issue_plans(repo_id, issue_number, template, tdd, design, created_by)` y `issue_phases(id, plan_id, n, kind tdd|design|dev|test|review|merge|decision, round, state pending|active|waiting_user|changes|done|stuck|cut, profile_id, instance_id, task_id, started_at, finished_at, cost_usd)`. `plans.workspace_id` → `plans.phase_id` (el plan interno del dev cuelga de su fase). Un workspace por issue: `workspaces.issue_number` único por repo; las fases reusan la rama y el worktree. |
| 0 | **F3.2 Plantillas** | S | Con TDD / Sin TDD / Con diseño / Bug / Con decisión, definidas en código (no en DB) como lista de kinds. |
| 1 | **F3.3 Motor de fases** | L | En el orquestador: al terminar una fase crea la siguiente según plantilla y encola una tarea con el perfil del kind (tdd y test → QA, dev → Frontend/Backend/Fullstack según territorio, review → Reviewer, design → Designer). `request_changes` crea fase `dev` ronda+1 en la misma rama. Cap de rondas → fase `stuck`. Fase `merge` = compuerta humana (decisión 6): nunca mergea sola. Soul por fase: el prompt de la tarea lleva el kind, la salida de la fase anterior y los tests que debe hacer pasar. |
| 1 | **F3.4 Fluke elige plantilla y pregunta TDD** | M | En el brief: por tipo de ítem decide diseño sí/no y si TDD aplica; si aplica, `ask_user`. Guarda en `mission_items.fields`. El Analyst recibe la plantilla en el encargo y la escribe en cada issue (bloque `<!-- fluke:plan {json} -->`); al crearse el issue se materializa `issue_plans`. |
| 2 | **F3.5 Pantalla del issue: Plan** | L | Grafo de fases horizontal (reusar `plan-graph/layout.ts` y `runState.ts`), arcos de vuelta de review, selección de fase con detalle (perfil, instancia, duración, costo, salida, "Ver sesión"), línea de origen (plantilla por Fluke, flujo por Analyst, pasos por dev), card de plantillas. |
| 2 | **F3.6 Pantalla del issue: Código y Sesiones** | L | Código = el workbench actual (diff, editor CodeMirror, terminal) apuntado al workspace del issue, con árbol "por fase". Sesiones = una por fase, en vivo para la activa, solo lectura para las terminadas. Click en una fase del grafo abre su sesión. |
| 3 | **F3.7 Rail reducido** | S | Workspaces y Source control salen del rail; las rutas quedan para deep links y para el workspace de Fluke. Rail: Fluke, Issues, Perfiles, Settings. |

### F4 — Trancado y destrabe

| Wave | Issue | Tamaño | Notas |
|------|-------|--------|-------|
| 0 | **F4.1 Detección** | M | Cinco causas → `issue_phases.state = stuck` con `stuck_reason`: (a) `ask_user` del agente (F0.3); (b) misma falla N veces (tests/CI en rojo); (c) rondas de review agotadas; (d) sin progreso T minutos (watchdog sobre eventos de la sesión); (e) credencial o permiso faltante (403/401 conocidos). Las fallas de infraestructura siguen el camino actual (backoff, no escalan). La instancia **no se descarta** mientras espera. |
| 0 | **F4.2 Resumen de Fluke** | M | Al trancarse, Fluke genera "qué pasó" en lenguaje llano y "lo intentado" a partir de la sesión (una llamada corta al modelo, sin herramientas). Se guarda en la fase. |
| 1 | **F4.3 UI de trancado** | L | Issues: card roja con motivo y botón Destrabar; banda "#n necesita tu ayuda · el resto sigue"; resumen colapsado con botón; contador global. Issue: banner, fase en rojo en el grafo, sesión marcada "esperando tu respuesta". |
| 1 | **F4.4 Drawer Destrabar** | L | Qué pasó (Fluke), lo intentado, la pregunta del agente con opciones y recomendación, contexto extra, y salidas: hablarlo con Fluke (abre misión con el contexto), escribirle al agente (sesión viva), tomar el control (pausa la instancia, abre Código; luego "seguir desde acá"), reintentar con otro perfil/modelo, volver a una fase anterior, cancelar el issue. "Responder y seguir" entrega la respuesta a la misma sesión. |
| 2 | **F4.5 Aviso** | S | Push (ya existe `push_subscriptions`) y globito de Fluke: "#658 necesita tu ayuda". |

### F5 — Fluke única entrada, cierre

| Wave | Issue | Tamaño | Notas |
|------|-------|--------|-------|
| 0 | **F5.1 Stepper y cierre de misión** | M | Pasos: Entender → Brief + plantilla → Despiece → Ejecución. Al terminar el despiece, Fluke muestra la propuesta de waves y los botones "Ver milestone" / "Ejecutar ahora" (dispara F1.4). |
| 0 | **F5.2 Eliminar analyst desk** | S | Borrar `features/analyst-desk`, la ruta `/analyst-desk` y `SOURCE_DESK` (las tareas del analista nacen con `source = mission`). |
| 1 | **F5.3 Fluke como canal de destrabe** | M | "Hablarlo con Fluke" abre la misión del issue con el resumen de la traba; Fluke traduce la respuesta del usuario al agente (`ask_user` respondido en su nombre). |
| 1 | **F5.4 Limpieza** | M | Quitar código de colas por worker, LRU, `WORKER_MAX_IN_REVIEW`, pantallas Workspaces/Source control del rail, i18n huérfano, docs. Actualizar REVIEW-LOOP-SPEC y SHELL-SPEC con referencias a este spec. |

## 6. Dependencias entre fases

```
F0.1 ─────────────────────────────────────────────────┐
F0.2 ────────→ F1.3                                     │
F0.3 ──────────────────────────────→ F4.1              │
F1.1 → F1.2/F1.3 → F1.4/F1.5                           │
F2.1 → F2.2 → F2.3 → F2.4 ─┐                           │
                            ├→ F3.1 → F3.3 → F3.5/F3.6 → F3.7
F3.2 ───────────────────────┘      ↘ F3.4
F3.3 + F0.3 → F4.1 → F4.2 → F4.3/F4.4 → F4.5
F3.4 + F2.4 → F5.1 → F5.2 → F5.3 → F5.4
```

F1 y F2 son independientes entre sí y pueden ir en paralelo. F3 necesita las dos. F4 y F5 necesitan F3.

## 7. Los mockups son el contrato de UI

Los mockups aprobados por Dani el 02-oct están en `design/mockups/fluke-v2/` y se abren directo desde el disco. **Se implementan tal cual: layout, jerarquía, textos, estados, colores y comportamiento.** Nada se simplifica, reinterpreta ni "mejora" sin aprobación explícita; si algo del mockup no se puede hacer, el issue lo dice y se detiene en `pm:decision`.

| Pantalla del mockup | Dónde está | Issues que la implementan |
|---------------------|------------|---------------------------|
| Issues por milestone: bandas, play, waves, colapsado con resumen, slots, drawer de decisión, estado trancado | `issues-plan.html` (también pestaña "2 · Issues" de `pantallas.html`) | F1.1, F1.2, F1.3, F1.4, F1.5, F4.3, F4.4 |
| Fluke: chat con quick replies, pregunta de TDD, stepper de misión, propuesta del Analyst | `pantallas.html` → "1 · Fluke" | F3.4, F5.1 |
| Issue: cabecera, línea de origen, pestañas Plan / Código / Sesiones, grafo de fases con arco de vuelta, detalle de fase, plantillas | `pantallas.html` → "3 · Issue #657" | F3.5, F3.6 |
| Issue trancado (#658): banner, fase en rojo, sesión "esperando tu respuesta", card "Cuándo se tranca", drawer Destrabar | `pantallas.html` → abrir #658 desde Issues, o botón Destrabar | F4.3, F4.4 |
| Perfiles: cards, PAT propio/del usuario, "Migrado de", instancias, banner de slots | `pantallas.html` → "4 · Perfiles" | F2.3 |
| Rail reducido (Workspaces, Source control, Workers y Analyst desk tachados) | `pantallas.html`, barra izquierda | F3.7, F5.2 |

Los datos del mockup (nombres de bots, referentes, textos de ejemplo de #657/#658) son de muestra; la estructura y los estados no.

## 8. Reglas transversales

- **Cada issue es vertical** (migración + endpoint + tipos + UI), según el contrato del analista. Los "L" se parten por valor, no por capa.
- **i18n**: toda cadena nueva en los 7 locales.
- **sqlx**: migraciones nuevas con el cache actualizado (ver memoria "cache de sqlx").
- **CI es el único gate** (memoria "Gates de calidad = CI").
- **Sin emojis** en UI, issues ni docs.
- **La app sigue andando en cada wave**: nada se borra hasta que lo nuevo lo reemplaza (por eso analyst desk y workers se eliminan al final de su fase, no al principio).
- **Instancia de desarrollo**: editar `crates/` reinicia el server y corta agentes en vuelo; coordinar las fases de backend con momentos sin tareas corriendo.

## 9. Qué NO entra en esta versión

- Máximo de instancias por perfil (decidido: solo slots globales).
- Plantillas de fases editables desde la UI (van en código).
- Grafo de dependencias finas entre issues (las flechas siguen siendo orden de waves).
- Perfiles nuevos sugeridos (Mobile, DevOps, Docs): solo el botón "Nuevo perfil" con el formulario actual.
- Voz / CarPlay de Fluke (memoria "Fluke = mayordomo"): fuera de alcance.

## 10. Cómo arrancar

1. D1 y D2 resueltas el 02-oct (decisiones 6 y 7).
2. F0 y F1 ya están creados como milestones de GitHub con sus issues (F0: #626, #661, #662 · F1: #663 a #667), con `feature:` y `wave:` para que la vista actual los muestre.
3. Con F1.1 mergeado, el resto del plan se ejecuta desde la vista Plan.
