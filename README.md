<p align="center"><strong>fluke</strong></p>
<p align="center">Orquestación de agentes de código sobre un tablero kanban, 100% self-hosted.</p>
<p align="center"><a href="https://mkanban.dev">mkanban.dev</a></p>

## Qué es

fluke (antes conocido como mkanban) corre una flota de **workers** — agentes de IA persistentes, con identidad, rol y memoria propia — que toman issues de GitHub, trabajan en workspaces aislados sobre git worktrees, abren pull requests y pasan por un loop de revisión automática antes de que una persona apruebe el merge. Todo corre en infraestructura propia: sin backend en la nube, sin login externo, sin telemetría hacia terceros.

El flujo completo:

1. Los issues del repositorio se sincronizan al **backlog** del sprint board.
2. Se asigna un issue a un worker; el worker abre un workspace (worktree + contenedor) y trabaja con su CLI de agente (Claude Code, Codex, Gemini CLI, etc.).
3. El worker abre un PR. Un **reviewer** automático lo revisa por rondas, con gate de CI: el pipeline del repo es el único punto de verdad para validar el código generado.
4. Con veredicto aprobado y CI verde, una persona hace el merge, en GitHub o con el botón **Mergear** de fluke. El tablero refleja cada estado: backlog → queued → in progress → in review → done / failed.

## Características

- **Sprint board** — kanban por repositorio con asignación de issues a workers, prioridades, épicas, reintento y descarte de tareas fallidas.
- **Workers con roles** — developer, reviewer, analyst y designer; cada uno con memoria persistente entre tareas y habilidades (skills) configurables.
- **Review loop** — rondas de revisión por PR con veredicto (approve / request changes), re-review automático cuando llegan commits nuevos, backoff ante fallas de infraestructura y tope de rondas por PR.
- **Integración GitHub** — sincronización de issues por repo, PRs vinculados a workspaces, autenticación del CLI `gh` por device flow desde Settings.
- **Merge desde la UI** — el botón **Mergear** (vista Plan y panel de merge del dashboard) mergea el PR de una tarea aprobada tras una confirmación. Queda deshabilitado, con el motivo visible, si el PR tiene conflictos o CI roja. El tipo de merge (merge commit por defecto, squash o rebase) y el borrado de la rama salen de Settings. Al terminar, el PR figura merged y la tarea pasa a done sin esperar al siguiente poll; si GitHub rechaza el merge se muestra su mensaje y nada cambia de estado. Lo mismo hace `POST /api/repos/{repo_id}/pull-requests/{number}/merge` (sin body; responde 409 con el motivo si el PR no está abierto, su tarea no está aprobada, o hay conflictos o CI roja), que Fluke solo usa tras confirmación humana (a pedido, «mergeá el PR de #N», o cuando él lo ofrece); si el merge es rechazado, Fluke cuenta el motivo en una línea y no reintenta ni mergea por otro camino.
- **Workspaces** — diffs, logs del agente, editor embebido y terminal, sobre worktrees que se limpian solos al archivar.
- **Panel de analyst** — pedidos ad-hoc a un worker sin pasar por el tablero.
- **Observabilidad** — métricas Prometheus (`fluke_*`), dashboards y reglas de alerta listos en [`ops/observability/`](ops/observability/).

## Instalación on-premises

El deployment soportado para clientes es el bundle de [`ops/onprem/`](ops/onprem/README.md): imagen distribuida por GHCR (`ghcr.io/mdevel-uy/fluke`; `ghcr.io/mdevel-uy/mkanban` se sigue publicando durante una release de transición), configuración por variables `FK_*` en `.env` (las `MK_*` siguen valiendo como fallback), y updates OTA con backup y rollback automático vía `update.sh`. El runbook de operación está en [`ops/onprem/RUNBOOK.md`](ops/onprem/RUNBOOK.md).

Los datos persisten en los volúmenes `fk-repos` (checkouts) y `fk-home` (base SQLite, configuración y credenciales); en una instalación local el data dir es `~/.local/share/fluke` (un data dir heredado `~/.local/share/mkanban` se renombra solo al arrancar).

### Variables de entorno principales

| Variable | Default | Descripción |
|----------|---------|-------------|
| `HOST` | `0.0.0.0` | Dirección de bind del servidor. |
| `PORT` | `3000` | Puerto del servidor. |
| `FK_ALLOWED_ORIGINS` | sin setear | Orígenes permitidos (separados por coma) al servir detrás de un reverse proxy o dominio propio; necesario para evitar 403. `MK_ALLOWED_ORIGINS` (heredado de mkanban) sigue valiendo como fallback. |
| `DISABLE_WORKTREE_CLEANUP` | sin setear | Desactiva la limpieza de worktrees, para debugging. |

## Estructura del repositorio

| Ruta | Contenido |
|------|-----------|
| `crates/` | Backend en Rust: `server` (API axum), `services` (orquestador de workers, review loop), `db` (SQLite + migraciones), `executors` (CLIs de agentes), `review`, licensing y heartbeat, entre otros. |
| `packages/` | Frontend (workspace pnpm): `local-web` (app), `web-core` (features compartidas), `ui` (componentes), `remote-web`. |
| `ops/` | Bundle on-premises, observabilidad (dashboards, alerting, alloy). |
| `docs/` | Documentación de producto (Mintlify). |
| `design/` | Especificaciones y mocks de diseño. |
| `.github/workflows/` | CI de PRs, publicación de imagen a GHCR, deploy, releases de desktop. |

## Desarrollo

Requisitos: Rust (versión fijada en `rust-toolchain.toml`), Node.js y pnpm.

```bash
pnpm install
pnpm run dev      # backend con watch + frontend Vite
pnpm run check    # typecheck de todos los packages + cargo check
pnpm run lint     # lints de frontend y backend
```

También se puede levantar todo en Docker con el `Dockerfile` de la raíz y `docker-compose.local.yml`. El CI de GitHub Actions corre los checks de frontend y backend en cada PR contra `mdev`, y es el gate obligatorio para mergear.

Las convenciones del repositorio — para colaboradores humanos y agentes — están en [`AGENTS.md`](AGENTS.md).

## Soporte

Issues y discusiones en este repositorio. Los clientes on-premises tienen su canal de soporte directo con [mdevel](https://github.com/mdevel-uy).

## Licencia

Apache 2.0 — ver [`LICENSE`](LICENSE). Incluye código derivado de un proyecto open-source discontinuado, bajo la misma licencia.
