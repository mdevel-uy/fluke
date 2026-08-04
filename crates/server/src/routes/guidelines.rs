use std::path::{Path, PathBuf};

use axum::{Json, Router, response::Json as ResponseJson, routing::get};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utils::response::ApiResponse;

use crate::{DeploymentImpl, error::ApiError};

// Global behavioural guidelines every factory agent loads at session start:
// the server user's `~/.claude/CLAUDE.md` (the Claude Code CLI picks it up on
// its own in every session — interactive and headless). This module only
// reads/writes that file; no executor changes are involved.

/// Hard cap for saves: the file is context injected into every agent session,
/// not documentation.
const MAX_GUIDELINES_BYTES: usize = 32 * 1024;

const DEFAULT_GUIDELINES: &str = r#"# Lineamientos para agentes de la fábrica

Sos un agente de la flota de vibe-kanban. Estas reglas aplican a todos los agentes — workers de la flota y sesiones ad-hoc — en cualquier repo. Las instrucciones del repo (CLAUDE.md / AGENTS.md del proyecto) tienen precedencia para lo específico de ese repo.

## Idioma y comunicación
- Comunicate en español. Código, identificadores y comentarios técnicos en inglés, salvo que el repo indique otra cosa.
- Commits: conventional commits con descripción en español (`fix(scope): descripción`).
- Reportá resultados fielmente: si algo falló o quedó sin verificar, decilo tal cual. Nunca marques como hecho lo que no comprobaste.

## Git y PRs
- Trabajá SOLO en tu worktree (tu directorio de trabajo). No toques los clones base en `/repos/`, otros worktrees, ni ramas que no creaste.
- Prohibido: push directo a `mdev`/`main`, force-push, rebase de ramas compartidas, borrar ramas ajenas.
- Flujo: cambios en tu rama → PR contra `mdev` con `gh`. No mergees PRs salvo que la tarea lo pida explícitamente.
- Antes de commitear revisá `git status`: nada de secretos, artefactos de build ni archivos temporales.

## Seguridad y recursos compartidos
- `gh` ya está autenticado. No imprimas ni persistas tokens o credenciales en ningún archivo.
- Nada destructivo fuera de tu worktree: ni `rm -rf`, ni `git clean`, ni matar procesos que no lanzaste vos.
- La base de datos, la config de la plataforma y los archivos de otros agentes no se tocan.

## Método de trabajo
- No asumas toolchains disponibles (cargo, pnpm, etc.): verificá con `which` antes. Si no podés compilar/testear acá, validá lo que puedas y dejá explícito qué quedó sin validar.
- Preferí cambios chicos y verificables por sobre refactors amplios que nadie pidió.
- Si te trabás con permisos o falta de acceso, reportalo como bloqueo en lugar de buscar la vuelta.

## Memoria
- Tenés memoria persistente automática por proyecto (MEMORY.md + archivos). Usala: guardá gotchas del repo, decisiones tomadas y convenciones descubiertas, con el porqué.
- No guardes en memoria: secretos, cosas que ya están en el código o en este archivo, ni detalles de una sola conversación.
"#;

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct AgentGuidelines {
    pub content: String,
    /// RFC3339 mtime of the file; `None` when the file doesn't exist yet.
    /// Echoed back on save for optimistic concurrency.
    pub modified_at: Option<String>,
    pub exists: bool,
    /// Template offered by "restore defaults" in the UI.
    pub default_content: String,
}

#[derive(Debug, Deserialize, TS)]
#[ts(export)]
pub struct SaveAgentGuidelinesRequest {
    pub content: String,
    /// `modified_at` from the last read. Save is rejected with 409 when the
    /// file changed since (concurrent edit over SSH or another client).
    pub expected_modified_at: Option<String>,
}

fn guidelines_path() -> Result<PathBuf, ApiError> {
    dirs::home_dir()
        .map(|home| home.join(".claude").join("CLAUDE.md"))
        .ok_or_else(|| ApiError::BadRequest("Cannot resolve the home directory".to_string()))
}

fn file_modified_at(path: &Path) -> Option<String> {
    let mtime = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(DateTime::<Utc>::from(mtime).to_rfc3339())
}

fn read_state(path: &Path) -> Result<AgentGuidelines, ApiError> {
    let (content, exists) = match std::fs::read_to_string(path) {
        Ok(content) => (content, true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => (String::new(), false),
        Err(err) => return Err(ApiError::Io(err)),
    };

    Ok(AgentGuidelines {
        content,
        modified_at: if exists { file_modified_at(path) } else { None },
        exists,
        default_content: DEFAULT_GUIDELINES.to_string(),
    })
}

pub async fn get_guidelines() -> Result<ResponseJson<ApiResponse<AgentGuidelines>>, ApiError> {
    let path = guidelines_path()?;
    Ok(ResponseJson(ApiResponse::success(read_state(&path)?)))
}

pub async fn save_guidelines(
    Json(payload): Json<SaveAgentGuidelinesRequest>,
) -> Result<ResponseJson<ApiResponse<AgentGuidelines>>, ApiError> {
    if payload.content.len() > MAX_GUIDELINES_BYTES {
        return Err(ApiError::BadRequest(format!(
            "Guidelines exceed the {} KB limit — this file is loaded into every agent session, keep it short",
            MAX_GUIDELINES_BYTES / 1024
        )));
    }

    let path = guidelines_path()?;

    // Optimistic concurrency: the file may be edited over SSH or by an agent
    // between the UI's read and this save.
    let current_modified_at = file_modified_at(&path);
    if current_modified_at != payload.expected_modified_at {
        return Err(ApiError::Conflict(
            "The guidelines file changed since it was loaded — reload the section and reapply your edits".to_string(),
        ));
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(ApiError::Io)?;
    }

    // Keep a cheap undo before overwriting.
    if path.exists() {
        let backup = path.with_extension("md.bak");
        if let Err(err) = std::fs::copy(&path, &backup) {
            tracing::warn!("Failed to write guidelines backup {:?}: {}", backup, err);
        }
    }

    // Atomic-ish write: temp file in the same directory, then rename, so an
    // agent session starting mid-save never reads a truncated file.
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, &payload.content).map_err(ApiError::Io)?;
    std::fs::rename(&tmp, &path).map_err(ApiError::Io)?;

    Ok(ResponseJson(ApiResponse::success(read_state(&path)?)))
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new().route(
        "/agents/guidelines",
        get(get_guidelines).put(save_guidelines),
    )
}
