---
scope: Refactor estructural del shell (frontend-only; excepción acotada en F7, ver R34–R40)
slug: workbench-shell
status: checkpoint — F1–F7 implementadas (F1–F6 27-jul-2026; F7 source control 29-jul-2026 en vk/tweaks); funcionalidad general alcanzada, quedan detalles menores
approved_by: Dani (iterado y aprobado pieza por pieza, 27-jul-2026; v2 source control de flota aprobado 27-jul-2026)
created: 2026-07-27
version: 2
implementation:
  prs: "#280 (F1) → #281 (F2) → #282 (F3) → #283 (F4) → #284 (F5) → #285 (F6), apilados hacia mdev"
  deferred: "R28 (rutas /hosts quedan como detalle de implementación — decisión 27-jul)"
  pending_minor: "verificación E2E con workspace real (tabs F4, aside F5, terminal F6, V2 contexto %); V1 CI por check (endpoint chico backend, a decidir); rename /sprint→kanban; demolición create-mode sin entry points; F7: botón Fetch all (R37) y chip contador de staged en tab Changes omitidos, aside de source control sin Push/Create PR"
reference: https://claude.ai/code/artifact/02c4f5d8-ac26-4c44-b5c5-bae78e0e0bc4
reference_v2: https://claude.ai/code/artifact/3249d592-6926-412c-b9c8-2a7a1e121c93
mock: design/workbench-shell-mock.html (copia versionada del artifact, fuente de verdad visual)
mock_v2: design/git-fleet-mock.html (fuente de verdad visual de R34–R40)
complements: design/UI-SPEC.md v3 (contrato visual — paleta, tipografía, densidad; este doc NO lo modifica)
---

> **Actualización fluke v2 (03-oct-2026).** Ver `FLUKE-V2-SPEC.md`. El rail cambió respecto de R6 y R34:
>
> - Workspaces y Source control salieron del rail (#689). Sus rutas siguen vigentes para los links directos y el command bar.
> - El badge de conflictos de R34 se quitó junto con el botón (#703).
> - El workspace y el source control de un issue viven en su página (pestañas Código y Sesiones).
> - Analyst Desk se eliminó (#701): todo pedido entra por Fluke.

# Workbench Shell — Spec estructural (v1)

> El contrato visual (Slate & Signal, 13px system font, densidades 22/26/30/36px,
> lucide 16px) ya está aprobado en UI-SPEC v3 y **no cambia**. Este documento
> define la **estructura** del shell al estilo VSCode: qué zona existe, qué
> contiene, y cómo se comporta. La implementación debe quedar **exactamente
> igual al mock** (`design/workbench-shell-mock.html`) — ante cualquier duda,
> el mock gana. Regla operativa de WORKBENCH-GAP-NOTES.md aplica: verificar
> pantalla por pantalla contra el mock, no solo tokens.

## Modelo mental (una línea)

**Sidebar izquierda = master/monitor · Main = inmersión · Aside derecho =
detalle de lo seleccionado · Señales globales = ambiente (rail badges + status
bar)** — la misma semántica que VSCode usa para Explorer / editor / Outline /
status bar.

## Grid del shell

```
┌──────────────────────────────────────────────────────┐
│ R1 · Top bar (h-36px, full width)                    │
├────┬─────────┬───────────────────────────┬───────────┤
│rail│ sidebar │ main                      │ aside     │
│48px│ 280px   │   (tab groups)            │ 300px     │
│    │ resiz.  ├───────────────────────────┤ resiz.    │
│    │         │ terminal (h-220, toggle)  │           │
├────┴─────────┴───────────────────────────┴───────────┤
│ R30 · Status bar (h-22px, full width)                │
└──────────────────────────────────────────────────────┘
```

CSS: `grid-rows-[36px_1fr_22px]` en el shell; la fila del medio es
`grid-cols-[48px_auto_1fr_auto]`. La terminal vive dentro de la columna del
main (default VSCode), **no** debajo de sidebar/aside.

---

## Requerimientos

### R1–R4 · Top bar (full width)

- **R1** El navbar ocupa una fila propia del grid, 100% del ancho. Desaparece
  el "corner spacer" sobre el rail. La drag-region de Tauri
  (`data-tauri-drag-region` + minWidth semáforo macOS) se mueve al propio navbar.
- **R2** Contenido: breadcrumbs a la izquierda (`proyecto › sección › workspace`),
  command bar trigger al centro (⌘K), utilidades a la derecha.
- **R3** Utilidades derecha (en orden): indicador de sync, divider, **tres
  toggles de layout estilo VSCode** (sidebar / terminal / aside, con estado
  pressed visible), divider, toggle de tema.
- **R4** Se **elimina** `NavbarRepoSelector` del navbar (su rol pasa al
  selector de proyecto de la status bar, R25).

### R5–R8 · Activity rail (solo iconos)

- **R5** Rail de 48px, ítems 40×40, **solo iconos con tooltip** (aparición con
  delay ~250ms). Se **elimina por completo el modo expandido** (`w-56` con
  labels) del `AppBar` y su preferencia `isAppBarCollapsed`.
- **R6** Ítems: Dashboard, Workspaces, Sprint, Issues, Workers, Analyst Desk.
  Activo = stripe indigo 2px a la izquierda (patrón existente). Badge numérico
  (contador de running/attention) sobre el ícono cuando aplica.
- **R7** Pie del rail: Notifications y Settings. **Los hosts remotos salen del
  rail** — el host es un atributo del proyecto activo (R25), no un ítem de
  navegación.
- **R8** El rail navega **secciones**, nunca contextos (proyecto/host/branch).

### R9–R12 · Sidebar secundaria contextual (por sección del rail)

- **R9** Cada ítem del rail define el contenido del sidebar (280px, resizable
  220–480, colapsable con toggle del navbar y ⌘B):
  - **Workspaces**: árbol con secciones Needs Attention / Running / Idle /
    **Archived** (headers caps 11px con chevron y contador; filas 22px).
  - **Kanban** (ex-Sprint; el concepto sprint se eliminó — los workers no paran):
    búsqueda + Repository + Worker / Priority / Label / Epic (single-select
    contra los parámetros de URL del board). La sección "Sprints" del mock v1
    quedó obsoleta.
  - **Issues**: filtro + Repository + Views (All open, Assigned, Needs review, Closed).
  - **Workers**: secciones Active / Archived.
  - **Dashboard**: navegación de paneles (Overview, Activity, PRs, Claude limits, Pipeline).
- **R10** Sección **Archived** de workspaces: colapsada por defecto, filas
  atenuadas (`text-low`, dot al 50%), contador en el header. Los archivados no
  aparecen en Recent de la welcome view. Acciones: restaurar / purgar (mismo
  patrón lifecycle que workers, PR #277).
- **R11** Selección en el sidebar = `bg-sel` + stripe indigo 2px (patrón existente).
- **R12** La fila de workspace muestra: dot de estado, nombre, meta derecha
  (`{worker} · {elapsed}` si corre; edad si idle; motivo si attention).

### R13–R17 · Main: welcome view y tab groups

- **R13** **El main nunca queda vacío.** Sin workspace seleccionado se muestra
  la welcome view: título + columnas **Start** (Assign an issue on the board,
  Browse issues, Search ⌘K — **sin "New workspace"**: los workspaces nacen al
  asignar un issue a un worker, nunca se crean a mano) y **Recent** (últimos 5
  workspaces no archivados con dot de estado + branch mono), y fila de atajos.
  Reemplaza los empty states de texto plano (`selectToStart` etc.). Sin
  medallones decorativos (regla UI-SPEC).
- **R14** El detalle de workspace usa **tab groups estilo editor groups de
  VSCode**. Vistas: **Chat, Changes, Logs, Preview**. Estado por workspace:
  `groups: [{ tabs: TabId[], active: TabId }]`, persistido. **Reemplaza y
  elimina `rightMainPanelMode`** de `useUiPreferencesStore`.
- **R15** Interacciones de tabs:
  - Drag de un tab a otra barra → se une a ese grupo (merge).
  - Drag al borde derecho de un panel (hint indigo al 40% del ancho) → split nuevo.
  - Botón split en la barra (visible si el grupo tiene >1 tab) → saca el tab activo a un grupo nuevo.
  - Grupo vacío → se elimina y el split se fusiona automáticamente.
  - Grupos con anchos iguales (`repeat(n, 1fr)`); separadores hairline.
- **R16** Cerrar/reabrir:
  - ✕ en cada tab (visible en hover y en tab activa). **Chat no tiene ✕** — es incerrable.
  - Botón **＋** único en la barra (visible si hay vistas cerradas) → menú "Reopen view" con las cerradas; reabre en ese grupo y activa.
  - Si una vista cerrada tiene actividad (p.ej. Changes con archivos tocados), el ＋ muestra un **dot indigo**.
- **R17** Tab Chat incluye el **composer completo** (paridad con el actual):
  chip "N files changed +A −D", acciones push/review, selector de versión
  "Latest ▾", textarea "Continue working on this task…" con focus ring indigo,
  selector de modelo/effort, adjuntar, botones **Queue** y **Stop** (spinner
  cuando corre). Sobre el composer, indicador vivo: "● {worker} está
  trabajando — {acción}…" con dot pulsante.

### R18–R24 · Aside derecho (master–detail estricto)

- **R18** El aside (300px, resizable, toggle navbar) muestra **solo el detalle
  de la entidad seleccionada**; el título del panel es el nombre de la
  selección. Sin selección → hint discreto. **No hay secciones globales** en el
  aside (decisión explícita: git y changes son por-branch; mezclar scopes está
  prohibido). El monitor global de agentes ES el sidebar de Workspaces.
- **R19** Workspace seleccionado — **card del worker**: dot estado + nombre +
  chip de rol; línea Model (`{modelo} · {effort}` mono); línea Last activity;
  **barra de contexto** con % usado; footer "Working… · {elapsed}" (o "Needs
  attention", borde warning) + botón **Stop** (o **Start task** si idle, en
  card "No agent running").
- **R20** Sección **Issue**: issue vinculado, estado, worker.
- **R21** Sección **Changes**: árbol de archivos tocados con badges M/A/D (solo
  si hay agente/trabajo).
- **R22** Sección **Git**: branch (mono), ahead/behind, last commit + botones
  **Push +N** y **Create pull request** (este último solo si no existe PR).
- **R23** Sección **Pull request** (solo si existe PR): número y estado; línea
  **CI por check** (build/tests/lint con dots semánticos ok/run/err); línea
  **Review** con chip de estado (Approved verde / Changes requested · {quién}
  warning / Review pending neutro); botones **Request review ▾** y **Open in
  GitHub**.
- **R24** Sección **Quick actions**: mensajes preestablecidos al worker —
  *Address PR comments*, *Resolve merge conflicts*, *Fix CI failures*. Al
  clickear: navega al chat del workspace y **precarga el composer** con el
  mensaje (editable antes de enviar — es un borrador, no un comando ciego).

### R25–R28 · Status bar (full width) y proyecto/ambiente

- **R25** **Selector de proyecto/ambiente** junto al chip Vibe (equivalente al
  remote-indicator de VSCode). Proyecto = repo + host donde corre. Menú hacia
  arriba: lista de proyectos con tag de ambiente (`local` neutro; remotos en
  indigo) y check en el activo; separador; **Open project…** y **Pair remote
  host…**. Cambiar de proyecto re-contextualiza todo el shell (sidebar,
  breadcrumbs, workspaces) y resetea la selección. Cierra con clic afuera / Esc.
- **R26** Ítems izquierda: chip brand Vibe, selector de proyecto (R25),
  versión, estado de sync, branch base (mono).
- **R27** Ítems derecha: "● N running · M attention" (dot pulsante; **clic
  navega a Workspaces** y muestra el aside), entrada ⌘K.
- **R28** Las rutas `/hosts/$hostId/...` se re-mapean al modelo proyecto-activo
  (el host deja de ser segmento de navegación visible).

### R29–R30 · Terminal global

- **R29** La terminal sube de `WorkspacesLayout` al **shell**: disponible en
  cualquier vista (toggle navbar y ⌘J), con **tabs por workspace**
  (`{shell} · {branch}`), botón nueva terminal y cerrar panel. Altura
  persistida (split 70/30 por defecto, ya existente).
- **R30** Abarca solo el ancho de la columna del main (default VSCode).

### R31–R33 · Transversales

- **R31** **Naming de workers**: el worker es una identidad con nombre propio
  (Mancho, Turbo, Nina…); el LLM es un **atributo** mostrado en chip/línea de
  modelo. Prohibido usar el nombre del modelo como nombre de worker en UI.
  ("Claude limit" del dashboard es la excepción válida: refiere al plan de la
  API, no a un worker.)
- **R32** Iconos: lucide 16px stroke 1.75 monocromo, exactamente los del mock
  (aprobados explícitamente — no cambiar). Al tocar cada componente, retirar
  `MaterialIcon`/Phosphor legacy.
- **R33** Mobile conserva su patrón actual (drawer + tab strip) — fuera de alcance.

### R34–R40 · Source control de flota (v2 — mock: `design/git-fleet-mock.html`)

> Principio rector: **no reconstruir Sourcetree**. Se construye nativo solo lo
> que ninguna herramienta de git da: la vista multi-worktree de la flota y el
> flujo de revisar/commitear/desbloquear el trabajo de los agentes. Todo lo
> demás se delega (R40).

- **R34** Nueva sección **Source control** en el rail (icono lucide
  `git-branch`, entre Workspaces y Sprint). Badge = nº de branches en
  conflicto. Decisión cerrada: sección propia del rail, como el mock (se
  descartaron las alternativas panel-de-Dashboard y tab-del-workspace).
- **R35** Sidebar de Source control: branches de attempts agrupadas **Needs
  attention / Running / Merged (colapsada) / Base**, con dot de estado, nombre
  mono y ahead/behind (`+A / B`) a la derecha. Selección sincronizada con el
  graph (mismo patrón R11); seleccionar en sidebar o en graph es equivalente.
- **R36** **Fleet graph** (vista principal): grafo de commits con la base
  (`mdev`) como carril neutro + un carril por branch de attempt activa.
  Color del carril por estado: running indigo, review warning, conflicto
  error, merged violeta. Sobre el head de cada rama: chip de branch (mono) +
  etiqueta de estado (`Running · {worker}` / `PR #N · review` / `Rebase
  conflict` / `Merged · PR #N`). Fila de commit: mensaje, refs, autor ·
  tiempo, hash corto. Click en una fila de branch = selección master-detail
  (R18 aplica: el aside muestra esa branch).
- **R37** Tabs del main en Source control (mismo patrón de tabs R14, sin
  drag/split): **Fleet graph** y **Changes · {branch seleccionada}**. En la
  barra de tabs: chip `base {branch}` y botón Fetch all.
- **R38** **Staging selectivo** en Changes: checkbox por archivo y por hunk
  (checkbox del archivo en estado *indeterminate* si tiene hunks mixtos);
  footer sticky con input de mensaje + botón primario **"Commit staged · N
  files (+A −D)"** (disabled si no hay nada staged). Hint permanente: lo no
  marcado queda en el worktree — el worker puede seguir trabajando sobre eso.
- **R39** Aside con branch en conflicto: sección **"Conflicts · {op} onto
  {base}"** con nota de resumen (borde/fondo error suave), archivos
  conflictuados con badge **C**, botones **Continue** / **Abort**, y act-rows
  **Open in editor** y **"Send to {worker}: Resolve merge conflicts"** (misma
  semántica R24: precarga el composer, no ejecuta ciego). Sin conflicto, el
  aside es el master-detail estándar (R18–R24).
- **R40** **Delegación explícita**: stash, rebase interactivo, cherry-pick,
  blame e historial profundo de archivo **no se construyen** — viven en
  lazygit (terminal global R29) o en el editor embebido (openvscode-server,
  decisión 27-jul). Cualquier PR que agregue esas vistas nativas contradice
  este spec.

---

## ¿Frontend-only? — validación

Correcto en lo estructural: **todo el refactor es composición de datos que ya
llegan al cliente.** Zonas, tab groups, welcome view, composer, selector de
proyecto, terminal global: 100% frontend (los providers/stores ya existen:
`TerminalProvider`, `GitPanelContainer`, `FileTreeContainer`,
`ProcessListContainer`, workspaces por host, repos, sync).

Tres puntos a **verificar** al inicio de la implementación (si falta alguno, es
un endpoint chico, no un rediseño — y la lección del Dashboard aplica: curl al
endpoint ANTES de maquetar):

| # | Dato | Estado esperado | Verificar |
|---|---|---|---|
| V1 | CI **por check** (build/tests/lint) y estado de review del PR (approved/changes requested) | El dashboard ya muestra PRs con "checks ✓" — probable que el detalle por check y review state existan o salgan de la API de GitHub ya integrada | endpoint de PRs: granularidad de checks + reviews |
| V2 | **Contexto %** del worker | `latest_context_usage` existe (llegó null alguna vez — gap notes 24-jul) | que el campo llegue poblado en runtime |
| V3 | **Archivar workspaces** (flag + restore/purge) | Workers ya lo tienen (#277); workspaces quizá no tengan el flag | campo/endpoint de archived en workspaces |

**F7 rompe la pureza frontend-only** — es la excepción declarada del spec y es
backend acotado sobre `crates/git` (que ya tiene branch status, fork point,
worktrees, rebase y conflictos):

| # | Dato | Estado esperado | Verificar |
|---|---|---|---|
| V4 | **Log multi-branch para el fleet graph** (commits + parents de base y branches activas) | NO existe — endpoint nuevo chico: revwalk con git2 sobre `get_all_branches` + `get_fork_point` ya existentes | diseñar shape del endpoint antes de maquetar (lección Dashboard: curl primero) |
| V5 | **Staging por hunk** (stage/unstage selectivo + commit de lo staged) | `commit` existe en `crates/git` pero probablemente commitea el worktree entero; stage parcial = manipulación del index con git2 | si `commit` acepta pathspec/index parcial; si no, endpoint nuevo |
| V6 | **Conflictos vía API** (`get_conflicted_files`, `continue_rebase`, `abort_rebase`, `detect_conflict_op`) | Las funciones YA existen en `crates/git` | que estén expuestas como rutas del server y lleguen al cliente |

## Fases de implementación

| Fase | Alcance | Toca | Borra |
|---|---|---|---|
| **F1 · Shell grid** | R1–R4, R26–R27: navbar a fila propia full-width, toggles de layout, status bar items base | `SharedAppLayout.tsx`, `Navbar.tsx`, `NavbarContainer.tsx`, `StatusBar*.tsx` | corner spacer; `NavbarRepoSelector` del navbar |
| **F2 · Rail** | R5–R8: solo iconos + tooltips, badges, Settings/Notifications al pie | `AppBar.tsx`, `useUiPreferencesStore` | modo expandido `w-56`, `isAppBarCollapsed`, sección hosts del rail |
| **F3 · Sidebar contextual** | R9–R12: panel por sección del rail; Archived en workspaces (+V3) | `WorkspacesSidebar*`, nuevos sidebars por feature | — |
| **F4 · Tab groups** | R13–R17: welcome view, modelo `groups`, drag/split/close/reopen, chat como tab con composer | `WorkspacesLayout.tsx`, `useUiPreferencesStore`, nuevos `TabGroup*` | `rightMainPanelMode` y su split fijo 50/50 |
| **F5 · Aside master-detail** | R18–R24 (+V1, V2): worker card, Issue, Changes, Git, PR, Quick actions | `RightSidebar.tsx`, `GitPanelContainer`, nuevos `WorkerDetail*` | secciones no-scoped del aside actual |
| **F6 · Proyecto + terminal global** | R25, R28–R30: selector proyecto/ambiente, re-mapeo de hosts, terminal al shell | `StatusBarContainer`, providers de host/repo, `TerminalPanelContainer`, `SharedAppLayout` | rutas host como navegación visible |
| **F7 · Source control de flota** | R34–R40 (+V4–V6): sección del rail, sidebar de branches, fleet graph, staging selectivo, conflictos en el aside | nuevos `SourceControl*` (frontend); `crates/git` (revwalk multi-branch, stage parcial) + rutas server (backend acotado) | — |

Orden pensado para que cada fase deje la app usable y verificable contra el
mock. F4 es la más grande; F1–F2 son en gran parte **borrado** de código.
F7 va última: depende del shell (rail F2, sidebar F3, aside F5, terminal F6)
y es la única con backend; dentro de F7 el orden interno sugerido es
conflictos (V6, backend ya existe) → fleet graph (V4) → staging (V5).

## Fuera de alcance

Mobile (R33), migración completa de iconos legacy fuera de los componentes
tocados, tabs de editor por-archivo (los tab groups son de *vistas*, no de
documentos), rediseño de Dashboard/Analyst Desk más allá del shell que los
envuelve. Del source control (R40): stash, rebase interactivo, cherry-pick,
blame e historial de archivo — delegados a lazygit / editor embebido, nunca
nativos.
