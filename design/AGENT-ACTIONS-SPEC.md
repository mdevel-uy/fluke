---
scope: Outbox de accionables — los agentes declaran acciones (issues, comentarios, cierres, estados) y el orquestador es el único que las ejecuta contra GitHub y la DB
slug: agent-actions
status: draft — pendiente de aprobación por Dani
approved_by: (pendiente)
created: 2026-08-09
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
     tiene; si no, la cuenta global de gh — los agentes dejan de necesitar
     `GH_TOKEN` en su env, F3);
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

## Qué se poda de los souls/prompts (por rol)

| Rol | Sale | Queda |
|---|---|---|
| Analyst (Bea/Flor/Cami) | `gh api .../milestones`, `gh issue create`, comentario de plan, "revisá con gh si ya existe" | Explorar el repo (lectura), redactar milestone/issues/plan como actions |
| Developer | (ya podado: push y PR son del sistema) | `git commit`; gh de lectura |
| Reviewer | (ya podado: verdict server-side) | gh de lectura para explorar; `.vk/review.json` |
| Designer | (nada que podar: no toca GitHub) | — |

El comentario-resumen post-remediación del bloque B del review loop (hoy
pendiente del PR 3) se implementa DIRECTO sobre este mecanismo: es un
`comment_pr` que emite el sistema, no el agente.

## Plan de implementación (PRs apilados a mdev)

1. **F1 — Outbox mínimo**: migración `agent_actions`, ingesta + drenaje en
   `on_agent_finished`, kinds `comment_pr` + `comment_issue`, retry
   quirúrgico por API. Primer consumidor: el comentario-resumen post-
   remediación (cierra la deuda del bloque B con el mecanismo nuevo, no con
   código ad-hoc).
2. **F2 — Analyst por outbox**: kinds `create_milestone` + `create_issue` +
   `close_issue`, placeholders, prompts nuevos de los analysts (el soul
   declara actions, no ejecuta gh), UI mínima: estado de acciones en la card
   (N pendientes / fallo en acción K) + botón de retry.
3. **F3 — Purga total**: `resolve_review_thread` y kinds v2, sacar
   `GH_TOKEN`/instrucciones gh de escritura de TODOS los souls y prompts,
   lint de factory-guard que rechace souls con `gh pr create|gh issue
   create|gh api -X POST` (el guard convierte la regla en invariante, como
   pidió la regla de "gates de calidad = CI").
4. **(futuro, si un caso lo exige) — Proxy síncrono**: endpoint HTTP local
   del server para acciones que necesiten respuesta durante la corrida.
   Hoy ningún caso lo requiere: los placeholders cubren al analyst.

Validación por PR (patrón build-solo-en-docker + CI como punto de verdad):
tests de ingesta/validación/placeholders/idempotencia en `services`, smoke
E2E en la factory: épica → analyst → milestone + issues + plan comment
creados por el orquestador, con retry quirúrgico probado matando la red a
mitad del drenaje.
