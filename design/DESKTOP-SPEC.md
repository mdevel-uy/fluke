---
scope: Distribución como app de escritorio descargable (Tauri existente, identidad mdevel)
slug: desktop-release
status: approved
approved_by: Dani (decisiones cerradas vía cuestionario, 27-jul-2026)
created: 2026-07-27
version: 1
base: crates/tauri-app (app madura del upstream) + .github/workflows/pre-release.yml y publish.yml (pipeline de referencia de bloop — NO se toca, se deriva)
related: design/SHELL-SPEC.md (la UI que corre adentro), memoria editor-embebido-openvscode (futuro sidecar)
---

# Desktop Release — Spec (v1)

> **No es construir la app: es re-apuntar una fábrica que ya existe.**
> El upstream dejó todo funcionando para su infra: app Tauri madura (server
> embebido, notificaciones nativas por plataforma con deep-links, updater con
> chequeo horario, splash), CI de 6 targets con firma Apple + Azure, y
> auto-update vía minisign + Cloudflare R2. La migración es identidad, llaves
> y hosting propios, recortado a lo que mdevel necesita hoy.

## Decisiones cerradas (Dani, 27-jul-2026)

1. **Tauri, no Electron.** El wrapper existe y el backend ya es Rust; Electron
   agregaría dos runtimes y ~200 MB para ganar nada. (Discusión 27-jul.)
2. **Audiencia: interna mdevel.** Windows x64 primero; macOS después
   (Dani ya tiene licencia Apple Developer — entra sin costo nuevo);
   Linux fuera del alcance inicial (fallback: browser, como hoy).
3. **Firma:** Windows **sin firmar** por ahora (SmartScreen avisa y deja
   instalar — aceptado para uso interno). macOS **con Developer ID +
   notarización** cuando entre su fase, con la cuenta de Dani.
4. **Hosting de instaladores y updates: GitHub Releases** de
   `mdevel-uy/mkanban`. Verificado: el repo es **público**, así que el
   `latest.json` es accesible para el updater sin auth ni infra nueva.
5. **Identidad propia + telemetría de bloop fuera.** Identifier nuevo y sin
   secrets de Sentry/PostHog. Verificado: la telemetría se inyecta por
   env/`option_env!` en build (`crates/utils/src/sentry.rs:28-33`) — sin los
   secrets queda desactivada sola, no hay que tocar código de telemetría.

## Requerimientos

- **RD1 · Identifier propio**: el identifier del upstream → `uy.mdevel.mkanban`
  en `tauri.conf.json` (evita colisión de instalación/datos con la app
  original si alguien la tiene). `productName` es "fluke".
- **RD2 · Llaves de updater propias**: generar par minisign nuevo
  (`cargo tauri signer generate`). La pubkey reemplaza la de bloop en
  `tauri.conf.json`; la privada va SOLO a GitHub Secrets
  (`TAURI_SIGNING_PRIVATE_KEY` + `_PASSWORD`). **Nunca reusar ni dejar la
  pubkey de upstream**: con ella, nuestros builds aceptarían updates firmados
  por bloop.
- **RD3 · Endpoint del updater**: el placeholder `__TAURI_UPDATE_ENDPOINT__`
  se inyecta en CI (mismo mecanismo del upstream) con
  `https://github.com/mdevel-uy/mkanban/releases/download/desktop-latest/latest.json`
  — un **release rodante `desktop-latest`** (marcado prerelease para no
  ocupar el slot "Latest" del repo) cuyo único asset es el `latest.json`,
  re-subido con `--clobber` en cada release. Se descartó
  `releases/latest/download/…`: apunta al último release *no-prerelease* del
  repo, así que cualquier release futuro del fork estilo upstream (npm/`v*`)
  rompería el endpoint. Los instaladores viven en los releases `desktop-v*`.
- **RD4 · Workflow propio `release-desktop.yml`**: derivado del job
  `build-tauri` de `pre-release.yml` (que no se modifica, para poder seguir
  mergeando upstream). Disparo manual (`workflow_dispatch`) o tag
  `desktop-v*`. Matriz inicial: solo `x86_64-pc-windows-msvc` cross-compilado
  desde ubuntu con cargo-xwin + NSIS — exactamente como lo hace upstream, ya
  probado. Sube al Release: instalador NSIS, artifacts del updater firmados y
  `latest.json`.
- **RD5 · Secrets mínimos fase Windows**: `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`
  y `GITHUB_TOKEN` implícito. Se omiten deliberadamente: `AZURE_*` (firma
  Windows), `SENTRY_*`/`POSTHOG_*` (telemetría), `R2_*` (hosting),
  `VK_SHARED_API_BASE`/relay (nube de bloop).
- **RD6 · Versionado desktop propio**: tags `desktop-v0.X.Y` con bump manual
  de `version` en `tauri.conf.json` dentro del workflow (no atarse al script
  de bump npm del upstream, que orquesta todo su release train).
- **RD7 · macOS (fase 3)**: targets `aarch64-apple-darwin` (+ x64 si alguien
  lo necesita), secrets `APPLE_*` de la cuenta de Dani, firma + notarización
  reusando los steps existentes del upstream (BloopAI/apple-code-sign-action
  o `cargo tauri build` con notarización nativa).
- **RD8 · Build local-only**: la app debe funcionar 100% sin los endpoints
  compartidos de bloop (relay/shared API). Es lo esperado (el modo local ya
  existe), pero se verifica explícitamente (V-D3) antes del primer release.

## Verificaciones (curl/build antes de prometer)

| # | Qué | Cómo |
|---|---|---|
| V-D1 | El job de build corre en el repo mdevel (Actions habilitadas, minutos, cache xwin) | correr `release-desktop.yml` en una branch con `--ci` antes del primer tag |
| V-D2 | Auto-update end-to-end con llaves nuevas | instalar `desktop-v0.1.0`, publicar `0.1.1`, verificar que la app lo detecta (chequeo horario o restart) e instala |
| V-D3 | Funcionalidad completa sin secrets de nube bloop | build sin `VK_SHARED_API_BASE`/relay: proyectos, workspaces, agentes y git operativos en local |
| V-D4 | Notificaciones nativas Windows + deep-links en build sin firma | prueba manual en la máquina de Dani |

## Fases

| Fase | Alcance | Entregable |
|---|---|---|
| **FD1 · Identidad** | RD1–RD3: identifier, par minisign nuevo, endpoint updater; PR chico a mdev | `tauri.conf.json` con identidad mdevel; llaves en Secrets |
| **FD2 · Release Windows** | RD4–RD6 (+V-D1..V-D4): workflow recortado, primer `desktop-v0.1.0` con instalador NSIS + latest.json; probar update a `0.1.1` | app descargable e instalable en Windows con auto-update funcionando |
| **FD3 · macOS firmado** | RD7: targets mac + firma Developer ID + notarización con cuenta de Dani | `.dmg` que abre limpio en las Macs del equipo |
| **FD4 · Futuro** | Linux (AppImage), firma Windows (Azure) si algún día es distribución pública, store(s) | — |

FD1 y FD2 son secuenciales y cortas (FD1 es un PR de configuración; FD2 es
sobre todo cirugía de YAML ya escrito). FD3 es independiente después de FD2.

## Fuera de alcance

Distribución pública, firma de Windows, Linux inicial (fallback browser),
rebranding del producto, tocar `pre-release.yml`/`publish.yml` del upstream
(se derivan, no se editan — minimiza conflictos de merge), y el sidecar de
openvscode-server (spike aparte; cuando llegue, va como descarga on-demand,
no dentro del instalador).
