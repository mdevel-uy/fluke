---
scope: Loop dev ↔ reviewer blindado — verdict estructurado server-side, remediación automática (review/CI/conflictos), frescura de badges
slug: review-loop
status: draft — pendiente de aprobación por Dani
approved_by: (pendiente)
created: 2026-07-31
version: 1
depends_on: PAT de GitHub de una cuenta DISTINTA a la del autor de los PRs para el worker reviewer (requisito operativo, ver R0)
complements: SHELL-SPEC.md (F7 source control), memoria git-fleet-source-control
---

# Review Loop — Spec de blindaje (v1)

> **Principio rector: el agente produce contenido; el sistema produce efectos.**
> Toda interacción con GitHub (someter reviews, leer comentarios, checkout de
> branches, push) sale de los prompts/souls y pasa al orquestador. Lo que el
> sistema hace por sí mismo se registra en DB en el instante en que ocurre; el
> polling queda solo para hechos externos (CI, merges humanos, pushes ajenos).
> **El merge es siempre decisión humana** — el loop termina en un PR aprobado
> con verdict visible, nunca en un merge automático.

## Diagnóstico que motiva este spec (31-jul-2026, verificado en vivo)

1. **Ningún worker tiene PAT.** El reviewer "Chewax" opera con la cuenta global
   del contenedor (`chewax`), la misma que crea los PRs. GitHub prohíbe
   approve/request-changes del autor → todas las reviews de los PRs #304/306/307
   quedaron en estado `COMMENTED` → `reviewDecision` vacío → `review_result`
   NULL para siempre → sin badge, y `should_dispatch_review` sigue viendo "no
   hay review" y despachando rondas hasta quemar el cap. **La causa raíz de
   "los badges no aparecen" no es (principalmente) frescura: es que nunca
   existe un verdict accionable.**
2. **Red intermitente del contenedor hacia `api.github.com`** (dial a IP de
   Azure con `connection refused` / TLS timeout en ráfagas). Cada llamada
   fallida tarda ~90s; un ciclo de poll puede estirarse a 5+ min. Además, si
   `get_pr_status` falla, `check_open_pr` aborta y ese ciclo no reconcilia
   review/mergeable/CI de ese PR.
3. El verdict viaja hoy por prompt (`gh pr review ...` ejecutado por el agente):
   no verificable, no atómico, quema tokens, y depende del PAT en el env del
   agente.

## R0 — Requisito operativo (sin código)

- El worker reviewer DEBE tener un `github_pat` de una cuenta de GitHub
  **distinta** de la que crea los PRs, con acceso de colaborador al repo.
  Sin esto el loop es estructuralmente imposible (GitHub rechaza
  self-approval). La UI de workers ya soporta cargar el PAT (Settings del
  worker); falta cargarlo.
- Deuda de red: investigar el DNS de `api.github.com` dentro del contenedor
  (resuelve a IP de Azure que rechaza conexiones en ráfagas). No bloquea el
  spec pero degrada la latencia del loop.

## Bloque A — Verdict estructurado + sumisión server-side

### A1. Contrato del verdict (`.vk/review.json`)

El agente reviewer escribe un único archivo en la raíz de su worktree:

```json
{
  "verdict": "approve" | "request_changes",
  "summary": "resumen en 2-5 líneas para el body de la review",
  "items": [
    {
      "path": "crates/services/src/foo.rs",
      "line": 42,
      "severity": "blocker" | "major" | "minor" | "nit",
      "comment": "texto del comentario"
    }
  ]
}
```

- `items` es opcional con `approve`; obligatorio (≥1) con `request_changes`.
- `path`/`line` opcionales por item (sin ellos el comentario va al body).
- Validación estricta server-side (serde). Archivo ausente o inválido →
  task del reviewer `failed` con `failure_reason` — **la ronda no cuenta**.

### A2. Preparación del workspace del reviewer (dispatch)

`dispatch_review_task` pasa a:
1. Resolver el head SHA del PR en ese instante → **SHA pinneado** de la ronda.
2. Crear el workspace del reviewer con el branch del PR ya checkouteado en ese
   SHA (WorktreeManager ya reusa branches existentes). El agente NO hace
   `gh pr checkout` ni fetch: todo local.
3. Insertar la fila de ronda en `review_rounds` (ver A5) con status `pending`.
4. Prompt nuevo (reemplaza `format_review_pr_prompt`): "Revisá el diff local
   (`git diff <base>...HEAD`) según tu checklist. Escribí tu veredicto en
   `.vk/review.json` con este schema: …. No uses gh ni toques la red."
   Se le inyecta además el estado de CI conocido y el resumen de rondas
   previas (qué pidió antes, qué respondió el autor).

### A3. Sumisión (on_agent_finished, rol reviewer)

1. Leer y validar `.vk/review.json`.
2. Válido → el **server** somete la review vía API GitHub con el PAT del
   reviewer: `event = APPROVE | REQUEST_CHANGES`, `commit_id` = SHA pinneado,
   `body` = summary, `comments[]` = items con path/line (comentarios inline
   reales, cosa que el one-liner de gh no podía).
3. Éxito → guardar `review_id` + verdict en la ronda (status `submitted`),
   `review_result` en la task del dev **en ese instante** (sin esperar poll),
   task reviewer `done`.
4. Falla de API (red, 422, PAT revocado) → reintento acotado; si no sale:
   task `failed` + `failure_reason` legible, ronda status `failed` (no cuenta
   para el cap), badge de error en el worker.
5. Si verdict = `request_changes` → despachar remediación al autor
   **inmediatamente** (Bloque B), con los items inlineados en el prompt.

El PAT deja de inyectarse como `GH_TOKEN` en el env del agente reviewer:
solo lo usa el server. (Para devs, el push ya es server-side desde antes;
se mantiene igual.)

### A4. Identidad

- Al guardar un PAT (`validate_github_pat` ya devuelve el login) → persistir
  `github_login` junto al token (columna nueva en `workers`).
- En el dispatch de review: si `reviewer.github_login` == autor del PR (el
  `author` que reporta la API) o el reviewer no tiene PAT → **no despachar**,
  marcar estado `misconfigured` visible en la UI del worker (no quemar rondas,
  no loguear-y-seguir).

### A5. Tabla `review_rounds`

```sql
CREATE TABLE review_rounds (
  id           BLOB PRIMARY KEY,
  repo_id      BLOB NOT NULL,
  pr_number    INTEGER NOT NULL,
  kind         TEXT NOT NULL,          -- 'review' | 'remediation'
  head_sha     TEXT NOT NULL,          -- SHA pinneado de la ronda
  base_sha     TEXT,                   -- para remediación por conflictos
  task_id      BLOB,                   -- worker_task asociada
  status       TEXT NOT NULL,          -- pending | submitted | failed | superseded
  verdict      TEXT,                   -- approve | request_changes (kind=review)
  review_id    INTEGER,               -- id de la review en GitHub
  reasons      TEXT,                   -- JSON: {conflicts, ci_failing, changes_requested} (kind=remediation)
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
```

Reemplaza TODOS los heurísticos de conteo (`count_reviewer_tasks_for_pr`,
`count_all_author_fix_tasks_for_pr`, `dispatched_fixes >= completed_reviews`):
- ¿Ya hay ronda activa para este PR? → lookup por (pr, status pending).
- ¿Ya remedié este estado? → lookup por (pr, head_sha, kind).
- Cap de rondas → COUNT de status `submitted` (los `failed` no queman).
- `worker_tasks` gana columna `failure_reason TEXT` (deuda ya anotada).

## Bloque B — Reconciliador de salud del PR (auto-dispatch total)

Un único punto de decisión por PR y por ciclo (o por evento propio), que
computa el estado observado sobre el head actual:

```
estado = { conflicts: pr_mergeable == 'conflicting',
           ci_failing: pr_ci_status == 'failing',
           changes_requested: última review accionable == CHANGES_REQUESTED
                              && cubre el head actual }
```

Reglas, en orden:

1. **Una sola task activa (review o remediación) por PR.** Si hay algo
   corriendo para este PR, no se despacha nada más hasta que termine.
2. Si `estado` tiene algún problema → despachar **una task de remediación
   consolidada** al worker autor, que agrupa todo lo pendiente en un prompt:
   conflictos (pasos de rebase local), CI rojo (inyectando el log de los
   checks fallidos leído server-side vía API — el agente no fetchea), y/o
   items del reviewer (inyectados desde `review_rounds`, no "leé los
   comentarios con gh"). Un push que arregla todo = una sola re-review.
   - Idempotencia: clave (pr, head_sha [, base_sha para conflictos]). Ya
     existe ronda de remediación para ese estado → no repetir. Push nuevo
     → SHA nuevo → elegible otra vez.
   - Los prompts quick-action existentes (`RESOLVE_MERGE_CONFLICTS_PROMPT`,
     `FIX_CI_PROMPT`, `ADDRESS_PR_COMMENTS_PROMPT`) se funden en el prompt
     consolidado; las quick actions manuales de la UI quedan como atajos que
     llaman al mismo dispatcher.
3. Si `estado` está limpio y el head no tiene review que lo cubra → despachar
   review (Bloque A). **La remediación siempre precede a la review**: no se
   gastan tokens del reviewer en un PR que va a cambiar sí o sí.
4. Si verdict `approve` cubre el head y CI verde → estado terminal del loop:
   task dev queda `in_review` + `review_result=approved`, badge verde.
   **El merge lo hacés vos.** `on_pr_merged` sigue cerrando el ciclo.
5. Caps: presupuesto único de rondas por PR (`max_review_rounds` cuenta
   rondas `submitted` de ambos kinds). Agotado → estado `escalated`
   **persistido** en la task/PR (no solo un log), badge en el sidebar (junto
   a Failed) y en la card del kanban. Sticky hasta acción humana (botón
   "reanudar loop" que resetea el presupuesto).

## Bloque C — Frescura de estado (badges "en tiempo y forma")

1. **Eventos propios escriben directo**: verdict sometido → `review_result` +
   ronda en DB en el acto; remediación despachada → ídem; push del autor
   (server-side) → tick inmediato del monitor vía `sync_notify` (ya existe,
   casi sin uso) en vez de esperar hasta 60s.
2. **Poll resiliente por PR**: en `check_open_pr`, el fallo de un check
   individual (status, review, mergeable, CI) no aborta los demás —
   hoy un error en `get_pr_status` saltea toda la reconciliación del PR.
   Cada sub-check es independiente y no-fatal.
3. **Push al frontend**: al escribir cualquier campo de PR (status, mergeable,
   ci, review_result), el server emite por el stream de workspaces existente
   (WebSocket) una señal de invalidación (o los campos mismos) para que
   sidebar/kanban refresquen al toque, sin depender del refetch de 15–30s.
4. Los intervalos actuales (poll 60s backend, 15s summaries, 30s tasks) se
   mantienen como red de seguridad, no como mecanismo primario.

## Qué se poda de los prompts/souls

- Reviewer: fuera `gh pr view/diff/checkout/review`. Queda: criterio de
  review + schema del verdict.
- Dev (remediación): fuera `gh pr checkout`, `gh pr view --comments`,
  `gh pr checks`, `git push`. Queda: los problemas concretos inyectados y
  "commiteá; el sistema pushea".
- `GH_TOKEN` fuera del env de agentes reviewer (los agentes no necesitan
  identidad GitHub; el server la tiene).

## Plan de implementación (PRs apilados a mdev)

1. **PR 1 — Fundaciones**: migraciones (`review_rounds`,
   `workers.github_login`, `worker_tasks.failure_reason`), persistir login al
   validar PAT, guard de identidad en dispatch (estado `misconfigured`).
2. **PR 2 — Verdict server-side**: workspace pinneado + prompt nuevo +
   parseo/validación de `.vk/review.json` + sumisión por API con inline
   comments + escritura inmediata de `review_result` + dispatch inmediato de
   remediación en `request_changes`. Sacar `GH_TOKEN` del env del reviewer.
3. **PR 3 — Reconciliador**: estado de salud por PR, task de remediación
   consolidada idempotente por SHA, fusión de los 3 prompts, presupuesto
   único de rondas + `escalated` persistido con UI.
4. **PR 4 — Frescura**: sub-checks independientes en `check_open_pr`,
   `sync_notify` tras acciones propias, invalidación push por WebSocket,
   badges de `misconfigured`/`escalated`/`failure_reason` en sidebar y kanban.

Validación (patrón build-solo-en-docker): `docker compose build` por PR,
tipos TS a mano si toca `shared/types.ts`, smoke E2E con un PR real:
dev push → review request_changes → remediación consolidada → re-review →
approve → badge verde → merge humano → done.
