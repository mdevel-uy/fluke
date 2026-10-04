//! Issue #774: helpers de remoto y push inicial que usa «Crear repo en GitHub».
//!
//! Contrato esperado en `GitService`:
//! - `add_remote(repo_path, name, url) -> Result<(), GitServiceError>`;
//!   falla con `GitServiceError::RemoteAlreadyExists(name)` si ya existe.
//! - `remove_remote(repo_path, name) -> Result<(), GitServiceError>`.
//! - `push_initial(repo_path, remote_name, token: Option<&str>) -> Result<String, GitServiceError>`;
//!   empuja la rama actual al remoto, deja el upstream configurado y devuelve el
//!   nombre de la rama. Sin commits falla con `GitServiceError::NoCommits` y no
//!   toca el repo. Repetirlo con la rama ya subida es un no-op exitoso (reintento).

use std::path::{Path, PathBuf};

use git::{GitService, GitServiceError};
use git2::Repository;
use tempfile::TempDir;

fn configure_user(repo_path: &Path) {
    let repo = Repository::open(repo_path).unwrap();
    let mut cfg = repo.config().unwrap();
    cfg.set_str("user.name", "Test User").unwrap();
    cfg.set_str("user.email", "test@example.com").unwrap();
}

/// Repo local con un commit en `main`.
fn local_repo_with_commit(root: &TempDir) -> PathBuf {
    let path = root.path().join("local");
    GitService::new()
        .initialize_repo_with_main_branch(&path)
        .unwrap();
    configure_user(&path);
    path
}

/// Repo local recién `git init`, sin ningún commit.
fn local_repo_without_commits(root: &TempDir) -> PathBuf {
    let path = root.path().join("empty");
    Repository::init_opts(
        &path,
        git2::RepositoryInitOptions::new()
            .initial_head("main")
            .mkdir(true),
    )
    .unwrap();
    configure_user(&path);
    path
}

/// Repo bare que hace de «GitHub» (se usa su ruta como URL del remoto).
fn bare_remote(root: &TempDir, name: &str) -> PathBuf {
    let path = root.path().join(name);
    Repository::init_bare(&path).unwrap();
    path
}

fn url_of(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn remote_names(repo_path: &Path) -> Vec<String> {
    let repo = Repository::open(repo_path).unwrap();
    repo.remotes()
        .unwrap()
        .iter()
        .flatten()
        .map(str::to_string)
        .collect()
}

// ---------- add_remote / remove_remote ----------

#[test]
fn add_remote_configures_origin_with_the_given_url() {
    let root = TempDir::new().unwrap();
    let repo = local_repo_with_commit(&root);
    let git = GitService::new();

    git.add_remote(&repo, "origin", "https://github.com/acme/widgets.git")
        .unwrap();

    assert_eq!(remote_names(&repo), vec!["origin".to_string()]);
    assert_eq!(
        git.get_remote_url(&repo, "origin").unwrap(),
        "https://github.com/acme/widgets.git"
    );
}

#[test]
fn add_remote_fails_distinguishably_when_origin_already_exists() {
    let root = TempDir::new().unwrap();
    let repo = local_repo_with_commit(&root);
    let git = GitService::new();
    git.add_remote(&repo, "origin", "https://github.com/acme/first.git")
        .unwrap();

    let err = git
        .add_remote(&repo, "origin", "https://github.com/acme/second.git")
        .unwrap_err();

    assert!(
        matches!(&err, GitServiceError::RemoteAlreadyExists(name) if name == "origin"),
        "se esperaba RemoteAlreadyExists(origin), llegó: {err:?}"
    );
    // El origin existente no se pisa.
    assert_eq!(
        git.get_remote_url(&repo, "origin").unwrap(),
        "https://github.com/acme/first.git"
    );
}

#[test]
fn add_remote_rejects_invalid_remote_name_without_touching_config() {
    let root = TempDir::new().unwrap();
    let repo = local_repo_with_commit(&root);
    let git = GitService::new();

    assert!(
        git.add_remote(&repo, "bad name; rm -rf", "https://github.com/a/b.git")
            .is_err()
    );
    assert!(remote_names(&repo).is_empty());
}

#[test]
fn remove_remote_deletes_it_and_leaves_no_remote_behind() {
    let root = TempDir::new().unwrap();
    let repo = local_repo_with_commit(&root);
    let git = GitService::new();
    git.add_remote(&repo, "origin", "https://github.com/acme/widgets.git")
        .unwrap();

    git.remove_remote(&repo, "origin").unwrap();

    assert!(remote_names(&repo).is_empty());
}

// ---------- push_initial ----------

#[test]
fn push_initial_publishes_current_branch_and_sets_upstream() {
    let root = TempDir::new().unwrap();
    let repo = local_repo_with_commit(&root);
    let remote = bare_remote(&root, "remote.git");
    let git = GitService::new();
    git.add_remote(&repo, "origin", &url_of(&remote)).unwrap();

    let branch = git.push_initial(&repo, "origin", None).unwrap();

    assert_eq!(branch, "main");
    let local = Repository::open(&repo).unwrap();
    let local_oid = local.head().unwrap().target().unwrap();
    let bare = Repository::open_bare(&remote).unwrap();
    let remote_oid = bare
        .find_reference("refs/heads/main")
        .expect("la rama main debe existir en el remoto")
        .target()
        .unwrap();
    assert_eq!(local_oid, remote_oid);

    let main = local.find_branch("main", git2::BranchType::Local).unwrap();
    let upstream = main.upstream().expect("main debe tener upstream");
    assert_eq!(upstream.name().unwrap(), Some("origin/main"));
}

#[test]
fn push_initial_uses_the_checked_out_branch_not_a_hardcoded_main() {
    let root = TempDir::new().unwrap();
    let repo = local_repo_with_commit(&root);
    {
        let r = Repository::open(&repo).unwrap();
        let head = r.head().unwrap().peel_to_commit().unwrap();
        r.branch("develop", &head, false).unwrap();
        r.set_head("refs/heads/develop").unwrap();
    }
    let remote = bare_remote(&root, "remote.git");
    let git = GitService::new();
    git.add_remote(&repo, "origin", &url_of(&remote)).unwrap();

    let branch = git.push_initial(&repo, "origin", None).unwrap();

    assert_eq!(branch, "develop");
    let bare = Repository::open_bare(&remote).unwrap();
    assert!(bare.find_reference("refs/heads/develop").is_ok());
}

#[test]
fn push_initial_is_idempotent_so_a_retry_can_complete_a_pending_push() {
    let root = TempDir::new().unwrap();
    let repo = local_repo_with_commit(&root);
    let remote = bare_remote(&root, "remote.git");
    let git = GitService::new();
    git.add_remote(&repo, "origin", &url_of(&remote)).unwrap();
    git.push_initial(&repo, "origin", None).unwrap();

    let again = git.push_initial(&repo, "origin", None);

    assert!(again.is_ok(), "el reintento no debe fallar: {again:?}");
}

#[test]
fn push_initial_without_commits_fails_distinguishably_and_changes_nothing() {
    let root = TempDir::new().unwrap();
    let repo = local_repo_without_commits(&root);
    let remote = bare_remote(&root, "remote.git");
    let git = GitService::new();
    git.add_remote(&repo, "origin", &url_of(&remote)).unwrap();

    let err = git.push_initial(&repo, "origin", None).unwrap_err();

    assert!(
        matches!(err, GitServiceError::NoCommits),
        "se esperaba NoCommits, llegó: {err:?}"
    );
    let bare = Repository::open_bare(&remote).unwrap();
    assert_eq!(bare.references().unwrap().count(), 0);
}

#[test]
fn push_initial_failure_is_an_error_and_leaves_no_upstream_configured() {
    let root = TempDir::new().unwrap();
    let repo = local_repo_with_commit(&root);
    let git = GitService::new();
    let missing = root.path().join("does-not-exist.git");
    git.add_remote(&repo, "origin", &url_of(&missing)).unwrap();

    let result = git.push_initial(&repo, "origin", None);

    assert!(result.is_err());
    let local = Repository::open(&repo).unwrap();
    let main = local.find_branch("main", git2::BranchType::Local).unwrap();
    assert!(
        main.upstream().is_err(),
        "un push fallido no debe dejar upstream apuntando a la nada"
    );
}

#[test]
fn push_initial_with_unknown_remote_is_an_error() {
    let root = TempDir::new().unwrap();
    let repo = local_repo_with_commit(&root);

    let result = GitService::new().push_initial(&repo, "origin", None);

    assert!(result.is_err());
}
