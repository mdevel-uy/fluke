//! Localización de los deliverables HTML de una task de designer leyendo
//! refs de git (nunca el worktree), de modo que funcione igual con el
//! workspace archivado. Compartido entre las rutas `design-artifacts` del
//! server y la documentación del deliverable que se postea en el issue al
//! aprobar el diseño.

use db::models::{
    repo::Repo, worker_task::WorkerTask, workspace::Workspace, workspace_repo::WorkspaceRepo,
};
use git::GitService;
use sqlx::SqlitePool;

/// Un path repo-relativo es artefacto de diseño si vive bajo `design/`, no
/// escapa del árbol y es un HTML.
pub fn is_design_artifact_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    path.starts_with("design/")
        && !path.split('/').any(|part| part == ".." || part.is_empty())
        && (lower.ends_with(".html") || lower.ends_with(".htm"))
}

/// Refs que pueden contener el deliverable, de más fresco a más durable: la
/// rama del workspace (incluye follow-ups) y luego el ref `origin/design/*`
/// pusheado — que sobrevive al archivado del workspace e incluso al borrado
/// de la rama local.
pub async fn candidate_refs(
    pool: &SqlitePool,
    task: &WorkerTask,
) -> Result<Vec<String>, sqlx::Error> {
    let mut refs: Vec<String> = Vec::new();
    if let Some(workspace_id) = task.workspace_id
        && let Some(workspace) = Workspace::find_by_id(pool, workspace_id).await?
    {
        refs.push(workspace.branch);
    }
    if let Some(deliverable_ref) = &task.deliverable_ref {
        refs.push(format!("origin/{deliverable_ref}"));
    }
    Ok(refs)
}

/// Rama de la que se bifurcó el workspace del designer: es la base del diff
/// que separa los artefactos propios de la task de los archivos `design/`
/// heredados con la historia. La target branch registrada del workspace si
/// existe, si no la default del repo.
pub async fn base_branch(
    pool: &SqlitePool,
    task: &WorkerTask,
    repo: &Repo,
) -> Result<Option<String>, sqlx::Error> {
    if let Some(workspace_id) = task.workspace_id {
        let target = WorkspaceRepo::find_by_workspace_id(pool, workspace_id)
            .await?
            .into_iter()
            .find(|wr| wr.repo_id == repo.id)
            .map(|wr| wr.target_branch);
        if target.is_some() {
            return Ok(target);
        }
    }
    Ok(repo.default_target_branch.clone())
}

/// Lista los artefactos HTML del deliverable: recorre los refs candidatos y
/// devuelve `(oid, paths)` del primero que tenga artefactos, para que el
/// caller pueda leer los contenidos del mismo commit. `None` si ningún ref
/// resuelve o ninguno contiene artefactos.
pub async fn list_artifacts(
    pool: &SqlitePool,
    git: &GitService,
    repo: &Repo,
    task: &WorkerTask,
) -> Result<Option<(String, Vec<String>)>, sqlx::Error> {
    let candidates = candidate_refs(pool, task).await?;
    // La historia `design/` propia del repo (specs aprobadas, mocks viejos)
    // viene con toda rama que el designer bifurca; listar el árbol completo
    // mostraría deliverables de tasks pasadas. El diff contra la merge base
    // con la target branch deja sólo lo que esta task agregó o tocó.
    let base_oid = match base_branch(pool, task, repo).await? {
        Some(branch) => git.get_branch_oid(&repo.path, &branch).ok(),
        None => None,
    };
    for candidate in &candidates {
        let Ok(oid) = git.get_branch_oid(&repo.path, candidate) else {
            continue;
        };
        let scoped = base_oid
            .as_deref()
            .and_then(|base| git.get_files_changed_from_base(&repo.path, base, &oid).ok());
        let mut files: Vec<String> = match scoped {
            Some(changed) => changed
                .into_iter()
                .filter(|p| is_design_artifact_path(p))
                .collect(),
            // Sin base usable (rama ausente, historias sin ancestro común):
            // caer al listado completo de `design/` antes que no mostrar nada.
            None => {
                // Que `design/` no exista en el árbol es un miss normal.
                let Ok(entries) = git.get_commit_tree(&repo.path, &oid, "design") else {
                    continue;
                };
                entries
                    .into_iter()
                    .filter(|e| !e.is_directory)
                    .map(|e| format!("design/{}", e.name))
                    .filter(|p| is_design_artifact_path(p))
                    .collect()
            }
        };
        if !files.is_empty() {
            files.sort();
            return Ok(Some((oid, files)));
        }
    }
    Ok(None)
}

/// Lee un artefacto puntual probando los refs candidatos en orden. `None`
/// si ningún ref lo contiene.
pub async fn read_artifact(
    pool: &SqlitePool,
    git: &GitService,
    repo: &Repo,
    task: &WorkerTask,
    path: &str,
) -> Result<Option<String>, sqlx::Error> {
    let candidates = candidate_refs(pool, task).await?;
    for candidate in &candidates {
        let Ok(oid) = git.get_branch_oid(&repo.path, candidate) else {
            continue;
        };
        if let Ok(content) = git.get_commit_file(&repo.path, &oid, path) {
            return Ok(Some(content));
        }
    }
    Ok(None)
}
