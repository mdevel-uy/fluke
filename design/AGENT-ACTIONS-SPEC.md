---
scope: Outbox de accionables — los agentes declaran acciones (issues, comentarios, cierres, estados) y el orquestador es el único que las ejecuta contra GitHub y la DB
slug: agent-actions
status: implementado (F1+F2+F3 mergeados, GH_TOKEN purgado del env del agente el 2026-08-10)
approved_by: Dani (chewax) — PR #504 mergeado 2026-08-09
created: 2026-08-09
last_updated: 2026-08-10
version: 1
depends_on: review_rounds + sumisión server-side del verdict (REVIEW-LOOP-SPEC bloques A/A5, ya implementados)
complements: REVIEW-LOOP-SPEC.md (generaliza su principio rector a todos los roles)
---

# Agent Actions — Spec del outbox de accionables (v1)

> **Principio rector (heredado del review loop): el agente produce contenido;
> el sistema produce efectos.** Este spec lo lleva a su forma final: NINGÚN
> agente ejecuta escrituras contra GitHub. El agente termina su corrida
> dejando una lista ordenada de acciones declarativas; el orquestador las
> ejecuta con identidad, retries y registro propios, y sincroniza GitHub y la
> app en el mismo acto. El agente queda contenido al mínimo trabajo posible:
> pensar y producir contenido.

## Diagnóstico que motiva este spec

1. **El verdict server-side ya probó el patrón.** `.vk/review.json` es una
   action request embrionaria: el agente declara, el server ejecuta (submit
   con PAT, commit pinneado, blindaje 422 del PR #482). Desde que existe, la
   clase de fallas "el agente peleándose con gh" desapareció de ese camino.
2. **Donde el agente sigue ejecutando, se siguen quemando rondas y tokens.**
   Incidente 08-ago (PR #481): el submit directo con comments fuera del diff
   devolvió 422 y descartó un request_changes legítimo; el re-review aprobó
   un PR con bug real. Incidente 31-jul (PR #306): el "comentario resumen"
   del agente vivió solo en su chat y el PR quedó como si nada. Cada
   interacción del agente con GitHub es un turno de modelo + un modo de
   falla no registrado.
3. **Los analysts operan GitHub a mano alzada.** Los souls de Bea/Flor/Cami
   instruyen `gh api repos/.../milestones`, `gh issue create`, comentario de
   plan — sin idempotencia (el "no dupliques: revisá con gh antes de crear"
   es un ruego al modelo, no un guard), sin retries clasificados, sin
   registro en DB de qué se creó (la épica vive solo en GitHub).
4. **Estados desincronizados por diseño.** Hoy el efecto en GitHub ocurre
   durante la corrida y el estado en la app lo reconcilia un poll después.
   Todo lo que el sistema hace por sí mismo debería registrarse en DB en el
   instante en que ocurre (principio del bloque C del review loop).

## No-objetivos (v1)

- **No migra `.vk/review.json`.** El verdict tiene semántica propia (rondas,
  cap, SHA pinneado) y ya está blindado; queda como contrato especializado.
  Este spec cubre el resto de las escrituras.
- **No hay ejecución síncrona durante la corrida.** El agente no recibe
  respuesta de sus acciones (ver "Placeholders" para la única necesidad real
  detectada). Un proxy HTTP local síncrono queda anotado como extensión
  futura, solo si un caso concreto lo exige.
- **El merge sigue siendo humano.** Ninguna acción del catálogo puede
  mergear, cerrar PRs ajenos ni tocar ramas protegidas.

## Contrato: `.vk/actions.json`

Al terminar su corrida, el agente escribe un único archivo en la raíz del
repo dentro de su worktree (mismo lugar y mismo fallback de cwd que
`review.json`):

```json
{
  "actions": [
    { "kind": "create_milestone",
      "title": "Épica X", "description": "objetivo y DoD" },
    { "kind": "create_issue",
      "title": "...", "body": "...", "labels": ["P1", "backend"],
      "milestone": "{{action[0].number}}" },
    { "kind": "create_issue",
      "title": "...", "body": "contrato idéntico al de {{action[1].url}}",
      "labels": ["P1", "ui"], "milestone": "{{action[0].number}}" },
    { "kind": "comment_issue",
      "issue": "{{action[1].number}}",
      "body": "Plan de la épica: olas, dependencias, preguntas al PM" },
    { "kind": "comment_pr", "pr": 123, "body": "..." },
    { "kind": "close_issue", "issue": 456, "reason": "completed" }
  ]
}
```

- **Orden = orden de ejecución.** El array es la cola; el orquestador ejecuta
  secuencialmente y corta en el primer fallo definitivo (las siguientes
  quedan `pending`, nunca se saltean — las dependencias son hacia atrás).
- **Placeholders `{{action[N].number}}` / `{{action[N].url}}`**: referencia al
  resultado de una acción ANTERIOR del mismo array. Resuelve la única
  necesidad de feedback intra-corrida detectada (el analyst necesita números
  de issue para referencias cruzadas y contratos textuales). Referencia
  hacia adelante o a acción fallida → la acción queda `failed` con motivo.
- Validación estricta server-side (serde, mismo patrón que el verdict):
  archivo inválido → task `failed` con `failure_reason`, ninguna acción se
  ejecuta. Archivo ausente → corrida sin efectos, perfectamente válida.
- Catálogo v1 (cada kind con schema cerrado): `create_milestone`,
  `create_issue`, `comment_issue`, `comment_pr`, `close_issue`.
  v2 (F3): `resolve_review_thread`, `add_labels`, `update_issue`.
- Estado post-F3 (implementado): los ocho kinds están definidos en
  `AgentActionDeclaration` (`crates/services/src/services/agent_actions_ingest.rs`)
  con su schema serde cerrado, y `GhCliExecutor`
  (`crates/services/src/services/agent_actions_drain.rs`) los ejecuta con la
  identidad del server. `resolve_review_thread.thread_id` es el node ID
  GraphQL opaco del hilo (la REST no expone endpoint para resolver hilos),
  y el kind se trata como idempotente: si el hilo ya estaba resuelto la
  acción cierra `done`. `update_issue` con `title=None` y `body=None` a la
  vez es un fallo definitivo (nunca infra-retry).
- **Cambio post-F3 — un label inexistente se crea, ya no falla.** F3 definía
  `add_labels` sobre un label inexistente como fallo definitivo. Eso vuelve
  imposible arrancar la convención de labels de ejecución
  (`feature:` / `wave:` / `resource:`), donde cada slug de feature y cada
  número de wave es una etiqueta nueva: el primer `add_labels` de cada
  feature moriría. Ahora `ensure_labels_exist` crea en el repo lo que falta
  antes de aplicar, tanto en `add_labels` como en `create_issue` (que además
  no fallaba sino que descartaba los labels desconocidos en silencio). Se
  alinea con `RepoIssuesService::add_label`, el camino de la UI, que ya
  auto-creaba. Nunca usa `--force`, así que jamás repinta un label existente.
  Si la creación falla, la acción falla sólo cuando el label es de la
  convención —el board depende de él—; con cualquier otro se loguea y sigue,
  que es el comportamiento previo.

## Tabla `agent_actions`

```sql
CREATE TABLE agent_actions (
  id              BLOB PRIMARY KEY,
  task_id         BLOB NOT NULL REFERENCES worker_tasks (id) ON DELETE SET NULL,
  repo_id         BLOB NOT NULL REFERENCES repos (id),
  seq             INTEGER NOT NULL,      -- posición en el array del agente
  kind            TEXT NOT NULL,
  payload         TEXT NOT NULL,          -- JSON del action tal como se declaró
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'done', 'failed', 'skipped')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  result_number   INTEGER,               -- issue/milestone/PR creado o tocado
  result_url      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
  UNIQUE (task_id, seq)                  -- clave de idempotencia
);
```

- `UNIQUE (task_id, seq)` es la idempotencia estructural: re-ingerir el
  archivo de una corrida ya ingerida no duplica nada; re-ejecutar solo toca
  filas `pending`/`failed`. (Lección de la FK de `review_rounds`:
  `ON DELETE SET NULL` desde el día uno.)
- El ledger es consultable por PR/issue/task: "qué hizo el sistema y cuándo"
  deja de vivir solo en GitHub.

## Ejecución (on_agent_finished, todos los roles)

1. **Ingesta**: leer y validar `.vk/actions.json`; insertar todas las filas
   `pending` en la MISMA transacción. Recién después se evalúa la transición
   de la task (el archivo se ingiere ANTES de archivar el worktree, como el
   verdict).
2. **Drenaje**: ejecutar en orden de `seq`. Cada acción:
   - resuelve placeholders contra `result_number`/`result_url` de las
     anteriores;
   - ejecuta contra GitHub con la **identidad del server** (PAT del worker si
     tiene; si no, la cuenta global de gh). Los agentes ya NO reciben
     `GH_TOKEN`/`GITHUB_TOKEN` en su env: la purga se completó en el commit
     `8084dcf87` (PR #555, cierre de #548). `crates/local-deployment/src/container.rs`
     dejó de inyectar el token según rol, y `ExecutionEnv::apply_to_command`
     (`crates/executors/src/env.rs`) hace `env_remove` explícito de ambas
     variables antes de aplicar el env del executor — cierra el hueco de
     herencia si el server se lanzó con el token en su propio env. La
     escapatoria queda para callers server-side que reinyecten
     deliberadamente (el mapa `vars` gana sobre el scrub);
   - éxito → `done` + resultado, y si la acción implica estado local (hoy:
     ninguna del catálogo v1; el verdict ya lo hace), se escribe **en la
     misma transacción** — GitHub y la app cambian juntos;
   - fallo → clasificar con la maquinaria existente (`agent_failure_details`
     ya distingue infra de definitivo): infra → retry con el mismo backoff
     exponencial de las rondas; definitivo (404, validación, permisos) →
     `failed` + `last_error`, y corta el drenaje.
3. **Transición de la task**: todas `done` → la task sigue su flujo normal.
   Alguna `failed` → task `failed` con `failure_reason` apuntando a la
   acción (consistente con el precedente del verdict: producir sin poder
   publicar ES un fallo de la corrida).
4. **Retry quirúrgico**: botón "Reintentar acciones" en la card fallida →
   re-drena solo `pending`/`failed`, SIN re-correr el agente. Es la
   diferencia de costo clave contra el modelo actual: un 422 hoy re-corre
   una corrida entera de opus; con el outbox re-ejecuta un POST.

## Qué se poda de los souls/prompts (por rol) — estado post-F3

| Rol | Sale (ya podado) | Queda |
|---|---|---|
| Analyst (Bea/Flor/Cami) | `gh api .../milestones`, `gh issue create`, `gh issue close`, comentario de plan por `gh`, "revisá con gh si ya existe" (idempotencia estructural por `UNIQUE(task_id, seq)`) | Explorar el repo (lectura), redactar milestone/issues/plan como `.vk/actions.json` (kinds `create_milestone`, `create_issue`, `comment_issue`, `close_issue`) |
| Developer | push/PR (del sistema desde antes de este spec); `gh pr comment` para responder review comments (podado en `quick_action_prompts.rs` en PR #552, se emite `comment_pr` en `.vk/actions.json`) | `git commit`; gh de lectura (`gh pr view`, `gh pr checks`, `gh api` GET) |
| Reviewer | verdict server-side (`.vk/review.json`, ya podado desde REVIEW-LOOP-SPEC bloques A/A5); `gh pr review` prohibido explícitamente | gh de lectura para explorar; `.vk/review.json` |
| Designer | (nada que podar: no toca GitHub) | — |

El comentario-resumen post-remediación del bloque B del review loop se
implementa DIRECTO sobre este mecanismo: es un `comment_pr` que emite el
sistema, no el agente (implementado en commit `79b84d211`,
`encolar comment_pr resumen al cerrar remediación`).

**Invariante de CI**: `scripts/factory-guards.sh` (agregado en PR #552)
rechaza cualquier PR que introduzca patrones `gh pr|issue create|close|comment|review`
o `gh api -X POST|PATCH|DELETE` en archivos de prompt del repo. El guard
convierte la regla en verdad verificada, no en promesa de código review.

## Plan de implementación (PRs apilados a mdev)

1. **F1 — Outbox mínimo** ✅ (mergeado 2026-08-09): migración `agent_actions`
   (PR #522), ingesta + drenaje en `on_agent_finished` con kinds `comment_pr`
   + `comment_issue` (PR #525), endpoint POST `/retry-actions` de retry
   quirúrgico (PR #527). Primer consumidor real: el comentario-resumen
   post-remediación (PR #528, cierra la deuda del bloque B con el mecanismo
   nuevo, no con código ad-hoc).
2. **F2 — Analyst por outbox** ✅ (mergeado 2026-08-10): kinds
   `create_milestone` + `create_issue` + `close_issue` con resolución de
   placeholders `{{action[N].number}}`/`{{action[N].url}}` (PR #542,
   fix follow-up PR #546 para permitir placeholder también en
   `comment_issue.issue`/`close_issue.issue`), endpoint GET de acciones + UI
   de estado en la card con botón de retry (PR #545), inyección del
   contrato de `.vk/actions.json` en el prompt del analyst (PR #544).
3. **F3 — Purga total** ✅ (mergeado 2026-08-10): kinds v2
   `resolve_review_thread` + `add_labels` + `update_issue` con sus tests
   unitarios (PR #553); purga de `gh pr comment` en `quick_action_prompts.rs`
   (address-pr-comments ahora emite `comment_pr` por outbox) y agregado del
   factory-guard `gh_writes_in_prompts` que rechaza escrituras `gh` en
   archivos de prompt (PR #552); eliminación de `GH_TOKEN`/`GITHUB_TOKEN` del
   env de todos los agentes con `env_remove` explícito en
   `ExecutionEnv::apply_to_command` (PR #555). Cierre formal de la épica y
   sincronización de este documento con el estado implementado: issue #551.
4. **(futuro, si un caso lo exige) — Proxy síncrono**: endpoint HTTP local
   del server para acciones que necesiten respuesta durante la corrida.
   Hoy ningún caso lo requiere: los placeholders cubren al analyst.

Validación por PR (patrón build-solo-en-docker + CI como punto de verdad):
tests de ingesta/validación/placeholders/idempotencia en `services`, smoke
E2E en la factory: épica → analyst → milestone + issues + plan comment
creados por el orquestador, con retry quirúrgico probado matando la red a
mitad del drenaje.

## Seeds y validación in-vivo de los souls

El único artefacto de seed local es `dev_assets_seed/db.sqlite` (274 KB,
binario), copiado a `dev_assets/` por `scripts/setup-dev-environment.js`
cuando el destino no existe. No hay script separado ni fixture SQL/JSON
editable que genere workers/souls: `dev_assets_seed/config.json` es solo la
config de la app y no menciona `gh`. Los souls productivos viven en la
columna `soul` de la tabla `workers` en la DB de la VPS; su fuente
versionada es `docs/souls/*.md` (aplicada con `PATCH /api/workers/:id`,
ver `docs/souls/README.md`), y su validación in-vivo (que ningún soul
cargado en DB contenga instrucciones `gh` de escritura) queda cubierta por
un issue de validación aparte.
