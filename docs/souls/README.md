# Souls (worker personalities) — fuente versionada

Los "souls" son el texto de personalidad/instrucciones que se inyecta a cada
worker de la fábrica (columna `soul` de la tabla `workers`, campo `soul` de
`PATCH /api/workers/:id`).

Este directorio guarda la **fuente versionada** de los souls activos: hasta
issue #371 los textos vivían sólo en la DB de la VPS y drifteaban en silencio
(nombres cambiados por copy-paste, instrucciones contradictorias con la
orquestación actual, etc.). Cualquier cambio de soul debe hacerse acá primero
y aplicarse a la DB con `PATCH /api/workers/:id`.

## Estructura

Un soul se compone de dos capas:

1. **System base instructions** — cargadas por el orquestador desde
   [`crates/services/src/services/base_instructions.md`](../../crates/services/src/services/base_instructions.md).
   Tienen precedencia sobre el soul en cualquier conflicto y ya cubren:
   Definition of Done, file territory, `shared/types.ts`, `Cargo.lock`,
   multi-step safety, build/typecheck, y CI. **No repetir esto en el soul.**
2. **Soul** — juicio y contexto específicos del rol/persona: cómo pensar el
   trabajo, cómo entregar, qué chequear, qué evitar. Es lo que vive en la DB.

Al despachar una tarea, el orquestador arma el prompt así
(`build_worker_prompt` en `crates/services/src/services/worker_orchestrator.rs`):

```
[SYSTEM BASE INSTRUCTIONS]
{base_instructions}
---
[WORKER SOUL]
{soul}
---
{task_prompt}
---
{final_instruction}   ← depende del rol (developer / analyst / reviewer / designer)
```

## Souls por rol

- [`developer.md`](developer.md) — Dani, Gasty, Mancho, Seba, Neo, Trinity (y
  cualquier developer nuevo).
- [`reviewer.md`](reviewer.md) — Atlas, Chewax.
- [`analyst.md`](analyst.md) — Bea, Cami, Flor.

Cada archivo trae el texto base con placeholder `{name}` — al aplicarlo a un
worker concreto, sustituir `{name}` por el nombre de ese worker (así el agente
sabe cómo se llama en la primera línea).

El rol **designer** (Morpheus) no está incluido acá porque su soul actual no
viola ninguno de los criterios de #371 — cuando haya que tocarlo, agregar
`designer.md` siguiendo el mismo esquema.

## Qué NO poner en un soul

Redundancias que ya viven en otros lados (drift asegurado):

- **Definition of Done, push, PR creation** — el orquestador es quien pushea
  la rama y abre el PR después de que la corrida termina (`build_worker_prompt`
  + `on_developer_agent_finished`). El soul no debe pedirle al agente que
  pushee ni que verifique con `git log origin/<rama>` (imposible: la rama se
  pushea después) ni que use un "botón Create PR de la app" (no existe para
  el worker).
- **CI verde, base correcta, migraciones, `shared/types.ts`, `Cargo.lock`** —
  cubiertos por el gate de CI (#367) y los factory-guards (#369). El reviewer
  no chequea nada de esto en su checklist propio.
- **Cap de rondas de review** — vive en `resolve_max_review_rounds` /
  `WORKER_REVIEW_MAX_ROUNDS` del orquestador. Duplicarlo en el soul del
  reviewer arma doble contabilidad.
- **`gh pr view/diff/checkout/review`** — el sistema posiciona el worktree
  del reviewer sobre el commit exacto del PR (#366) y toma el veredicto de
  `.vk/review.json`; el reviewer no toca la red.
- **Descubrimiento de `owner/repo`** — desde #368, todo prompt de tarea lleva
  el `owner/repo` real ya resuelto. El analyst no necesita instrucciones para
  encontrarlo.

## Cómo aplicar cambios

Los archivos de este directorio son la **fuente**; la DB es un caché aplicado.
Después de editar un soul acá, sincronizarlo así:

```bash
# Reemplazar {name} y aplicarlo a un worker
SOUL=$(sed "s/{name}/Gasty/g" docs/souls/developer.md | jq -Rs .)
curl -X PATCH http://localhost:3000/api/workers/<worker-id> \
  -H 'Content-Type: application/json' \
  -d "{\"soul\": $SOUL}"
```

Y verificar con `GET /api/workers` que quedó aplicado.
