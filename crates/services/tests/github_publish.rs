//! Issue #774: crear en GitHub el repo de un repo local ya registrado
//! (owner, visibilidad, origin y push inicial). GitHub se sustituye por un
//! `GithubRepoCreator` falso; el remoto «remoto» es un repo bare local.
//!
//! Contrato esperado en `services::services::repo`:
//!
//! ```ignore
//! pub enum RepoVisibility { Public, Private }
//! pub struct GithubRepoInfo { owner, name, html_url, clone_url: String, is_empty: bool }
//! #[derive(Debug, Clone)]
//! pub enum GithubCreateError { NoSession, NameTaken, PermissionDenied(String), Other(String) }
//! pub trait GithubRepoCreator {
//!     /// Owners permitidos para la sesión actual (usuario + organizaciones).
//!     /// Sin sesión: Err(NoSession).
//!     fn list_owners(&self) -> Result<Vec<String>, GithubCreateError>;
//!     fn create_repo(&self, owner: &str, name: &str, visibility: RepoVisibility)
//!         -> Result<GithubRepoInfo, GithubCreateError>;
//!     fn find_repo(&self, owner: &str, name: &str)
//!         -> Result<Option<GithubRepoInfo>, GithubCreateError>;
//! }
//! pub struct PublishToGithubRequest { owner, name: String, visibility: RepoVisibility, token: Option<String> }
//! pub struct PublishedRepo { owner, name, html_url, branch: String }
//! RepoService::publish_to_github(&self, git: &GitService, creator: &dyn GithubRepoCreator,
//!     repo_path: &Path, req: &PublishToGithubRequest) -> Result<PublishedRepo, RepoError>
//! ```
//!
//! Variantes nuevas de `RepoError`: `GithubSessionRequired`,
//! `GithubRepoNameTaken { owner, name }`, `GithubOwnerForbidden { owner, .. }`,
//! `GithubOwnerNotAvailable(owner)`, `InvalidGithubRepoName(name)`,
//! `NoCommits`, `OriginAlreadyConfigured { url }` y
//! `GithubPublishIncomplete { html_url, message }`.
//!
//! Reglas: todas las precondiciones se validan ANTES de crear nada en GitHub;
//! si lo creado en GitHub no se puede enlazar (remoto/push), el error informa la
//! URL y el repo local queda sin `origin` roto; el reintento reutiliza el repo
//! de GitHub recién creado (existe y está vacío) en vez de fallar por «ya existe».

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

use git::{
    GitService,
    git2::{self, Repository},
};
use services::services::repo::{
    GithubCreateError, GithubRepoCreator, GithubRepoInfo, PublishToGithubRequest, RepoError,
    RepoService, RepoVisibility,
};
use tempfile::TempDir;

// ---------- fakes y helpers ----------

#[derive(Debug, Clone, PartialEq)]
enum Call {
    ListOwners,
    Create {
        owner: String,
        name: String,
        public: bool,
    },
    Find {
        owner: String,
        name: String,
    },
}

struct FakeGithub {
    owners: Result<Vec<String>, GithubCreateError>,
    /// Si es `Some`, `create_repo` falla con ese error.
    create_error: Option<GithubCreateError>,
    /// URL (ruta) que el «GitHub» falso entrega como clone_url.
    clone_url: String,
    /// Repo ya creado en esta instancia (para simular el reintento).
    created: Mutex<Option<GithubRepoInfo>>,
    calls: Mutex<Vec<Call>>,
}

impl FakeGithub {
    fn new(clone_url: &Path) -> Self {
        Self {
            owners: Ok(vec!["octocat".to_string(), "acme".to_string()]),
            create_error: None,
            clone_url: clone_url.to_string_lossy().to_string(),
            created: Mutex::new(None),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }

    fn creates(&self) -> Vec<Call> {
        self.calls()
            .into_iter()
            .filter(|c| matches!(c, Call::Create { .. }))
            .collect()
    }
}

impl GithubRepoCreator for FakeGithub {
    fn list_owners(&self) -> Result<Vec<String>, GithubCreateError> {
        self.calls.lock().unwrap().push(Call::ListOwners);
        self.owners.clone()
    }

    fn create_repo(
        &self,
        owner: &str,
        name: &str,
        visibility: RepoVisibility,
    ) -> Result<GithubRepoInfo, GithubCreateError> {
        self.calls.lock().unwrap().push(Call::Create {
            owner: owner.to_string(),
            name: name.to_string(),
            public: matches!(visibility, RepoVisibility::Public),
        });
        if let Some(err) = &self.create_error {
            return Err(err.clone());
        }
        let mut created = self.created.lock().unwrap();
        if created.is_some() {
            return Err(GithubCreateError::NameTaken);
        }
        let info = GithubRepoInfo {
            owner: owner.to_string(),
            name: name.to_string(),
            html_url: format!("https://github.com/{owner}/{name}"),
            clone_url: self.clone_url.clone(),
            is_empty: true,
        };
        *created = Some(info.clone());
        Ok(info)
    }

    fn find_repo(
        &self,
        owner: &str,
        name: &str,
    ) -> Result<Option<GithubRepoInfo>, GithubCreateError> {
        self.calls.lock().unwrap().push(Call::Find {
            owner: owner.to_string(),
            name: name.to_string(),
        });
        Ok(self.created.lock().unwrap().clone())
    }
}

fn local_repo_with_commit(root: &TempDir) -> PathBuf {
    let path = root.path().join("local");
    GitService::new()
        .initialize_repo_with_main_branch(&path)
        .unwrap();
    let repo = Repository::open(&path).unwrap();
    let mut cfg = repo.config().unwrap();
    cfg.set_str("user.name", "Test User").unwrap();
    cfg.set_str("user.email", "test@example.com").unwrap();
    path
}

fn local_repo_without_commits(root: &TempDir) -> PathBuf {
    let path = root.path().join("empty");
    Repository::init_opts(
        &path,
        git2::RepositoryInitOptions::new()
            .initial_head("main")
            .mkdir(true),
    )
    .unwrap();
    path
}

fn bare_remote(root: &TempDir) -> PathBuf {
    let path = root.path().join("github-remote.git");
    Repository::init_bare(&path).unwrap();
    path
}

fn request(owner: &str, name: &str, visibility: RepoVisibility) -> PublishToGithubRequest {
    PublishToGithubRequest {
        owner: owner.to_string(),
        name: name.to_string(),
        visibility,
        token: None,
    }
}

fn remote_names(repo_path: &Path) -> Vec<String> {
    Repository::open(repo_path)
        .unwrap()
        .remotes()
        .unwrap()
        .iter()
        .flatten()
        .map(str::to_string)
        .collect()
}

fn publish(
    repo: &Path,
    fake: &FakeGithub,
    req: &PublishToGithubRequest,
) -> Result<services::services::repo::PublishedRepo, RepoError> {
    RepoService::new().publish_to_github(&GitService::new(), fake, repo, req)
}

// ---------- camino feliz ----------

#[test]
fn publish_creates_repo_with_exact_owner_and_visibility_and_pushes() {
    let root = TempDir::new().unwrap();
    let repo = local_repo_with_commit(&root);
    let remote = bare_remote(&root);
    let fake = FakeGithub::new(&remote);

    let published = publish(&repo, &fake, &request("acme", "widgets", RepoVisibility::Private))
        .expect("publicar debe funcionar");

    assert_eq!(
        fake.creates(),
        vec![Call::Create {
            owner: "acme".into(),
            name: "widgets".into(),
            public: false,
        }]
    );
    assert_eq!(published.html_url, "https://github.com/acme/widgets");
    assert_eq!(published.owner, "acme");
    assert_eq!(published.name, "widgets");
    assert_eq!(published.branch, "main");

    assert_eq!(remote_names(&repo), vec!["origin".to_string()]);
    let local_oid = Repository::open(&repo)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap();
    let remote_oid = Repository::open_bare(&remote)
        .unwrap()
        .find_reference("refs/heads/main")
        .expect("push inicial hecho")
        .target()
        .unwrap();
    assert_eq!(local_oid, remote_oid);
}

#[test]
fn publish_passes_public_visibility_through() {
    let root = TempDir::new().unwrap();
    let repo = local_repo_with_commit(&root);
    let remote = bare_remote(&root);
    let fake = FakeGithub::new(&remote);

    publish(&repo, &fake, &request("octocat", "demo", RepoVisibility::Public)).unwrap();

    assert_eq!(
        fake.creates(),
        vec![Call::Create {
            owner: "octocat".into(),
            name: "demo".into(),
            public: true,
        }]
    );
}

// ---------- precondiciones: no se crea ni modifica nada ----------

#[test]
fn without_github_session_fails_clearly_and_changes_nothing() {
    let root = TempDir::new().unwrap();
    let repo = local_repo_with_commit(&root);
    let remote = bare_remote(&root);
    let mut fake = FakeGithub::new(&remote);
    fake.owners = Err(GithubCreateError::NoSession);

    let err = publish(&repo, &fake, &request("acme", "widgets", RepoVisibility::Private))
        .unwrap_err();

    assert!(matches!(err, RepoError::GithubSessionRequired), "{err:?}");
    assert!(fake.creates().is_empty(), "no debe crear nada en GitHub");
    assert!(remote_names(&repo).is_empty(), "no debe tocar el repo local");
}

#[test]
fn repo_without_commits_is_rejected_before_creating_anything() {
    let root = TempDir::new().unwrap();
    let repo = local_repo_without_commits(&root);
    let remote = bare_remote(&root);
    let fake = FakeGithub::new(&remote);

    let err = publish(&repo, &fake, &request("acme", "widgets", RepoVisibility::Private))
        .unwrap_err();

    assert!(matches!(err, RepoError::NoCommits), "{err:?}");
    assert!(fake.creates().is_empty());
    assert!(remote_names(&repo).is_empty());
}

#[test]
fn existing_origin_is_rejected_before_creating_anything() {
    let root = TempDir::new().unwrap();
    let repo = local_repo_with_commit(&root);
    GitService::new()
        .add_remote(&repo, "origin", "https://github.com/someone/else.git")
        .unwrap();
    let remote = bare_remote(&root);
    let fake = FakeGithub::new(&remote);

    let err = publish(&repo, &fake, &request("acme", "widgets", RepoVisibility::Private))
        .unwrap_err();

    assert!(
        matches!(&err, RepoError::OriginAlreadyConfigured { url } if url.contains("someone/else")),
        "{err:?}"
    );
    assert!(fake.creates().is_empty());
    assert_eq!(
        GitService::new().get_remote_url(&repo, "origin").unwrap(),
        "https://github.com/someone/else.git"
    );
}

#[test]
fn owner_not_in_available_owners_is_rejected_before_creating_anything() {
    let root = TempDir::new().unwrap();
    let repo = local_repo_with_commit(&root);
    let remote = bare_remote(&root);
    let fake = FakeGithub::new(&remote);

    let err = publish(&repo, &fake, &request("not-mine", "widgets", RepoVisibility::Private))
        .unwrap_err();

    assert!(
        matches!(&err, RepoError::GithubOwnerNotAvailable(o) if o == "not-mine"),
        "{err:?}"
    );
    assert!(fake.creates().is_empty());
    assert!(remote_names(&repo).is_empty());
}

#[test]
fn invalid_repo_names_are_rejected_before_creating_anything() {
    for bad in ["", "   ", "with space", "a/b", "../evil", "semi;colon"] {
        let root = TempDir::new().unwrap();
        let repo = local_repo_with_commit(&root);
        let remote = bare_remote(&root);
        let fake = FakeGithub::new(&remote);

        let err = publish(&repo, &fake, &request("acme", bad, RepoVisibility::Private))
            .unwrap_err();

        assert!(
            matches!(err, RepoError::InvalidGithubRepoName(_)),
            "nombre {bad:?}: {err:?}"
        );
        assert!(fake.creates().is_empty(), "nombre {bad:?}");
    }
}

#[test]
fn path_that_is_not_a_git_repo_is_rejected() {
    let root = TempDir::new().unwrap();
    let plain = root.path().join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    let remote = bare_remote(&root);
    let fake = FakeGithub::new(&remote);

    let err = publish(&plain, &fake, &request("acme", "widgets", RepoVisibility::Private))
        .unwrap_err();

    assert!(matches!(err, RepoError::NotGitRepository(_)), "{err:?}");
    assert!(fake.creates().is_empty());
}

// ---------- errores de GitHub distinguibles ----------

#[test]
fn name_already_taken_maps_to_distinguishable_error_and_leaves_local_untouched() {
    let root = TempDir::new().unwrap();
    let repo = local_repo_with_commit(&root);
    let remote = bare_remote(&root);
    let mut fake = FakeGithub::new(&remote);
    fake.create_error = Some(GithubCreateError::NameTaken);

    let err = publish(&repo, &fake, &request("acme", "widgets", RepoVisibility::Private))
        .unwrap_err();

    assert!(
        matches!(&err, RepoError::GithubRepoNameTaken { owner, name } if owner == "acme" && name == "widgets"),
        "{err:?}"
    );
    assert!(remote_names(&repo).is_empty());
}

#[test]
fn existing_non_empty_github_repo_is_not_adopted_on_name_clash() {
    // El nombre está tomado por un repo con contenido que NO creamos nosotros:
    // no se le hace push ni se enlaza.
    let root = TempDir::new().unwrap();
    let repo = local_repo_with_commit(&root);
    let remote = bare_remote(&root);
    let fake = FakeGithub::new(&remote);
    *fake.created.lock().unwrap() = Some(GithubRepoInfo {
        owner: "acme".into(),
        name: "widgets".into(),
        html_url: "https://github.com/acme/widgets".into(),
        clone_url: remote.to_string_lossy().to_string(),
        is_empty: false,
    });

    let err = publish(&repo, &fake, &request("acme", "widgets", RepoVisibility::Private))
        .unwrap_err();

    assert!(matches!(err, RepoError::GithubRepoNameTaken { .. }), "{err:?}");
    assert!(remote_names(&repo).is_empty());
    assert_eq!(
        Repository::open_bare(&remote)
            .unwrap()
            .references()
            .unwrap()
            .count(),
        0,
        "no se debe empujar a un repo ajeno con contenido"
    );
}

#[test]
fn org_permission_denied_maps_to_distinguishable_error() {
    let root = TempDir::new().unwrap();
    let repo = local_repo_with_commit(&root);
    let remote = bare_remote(&root);
    let mut fake = FakeGithub::new(&remote);
    fake.create_error = Some(GithubCreateError::PermissionDenied(
        "acme does not have the correct permissions".into(),
    ));

    let err = publish(&repo, &fake, &request("acme", "widgets", RepoVisibility::Private))
        .unwrap_err();

    assert!(
        matches!(&err, RepoError::GithubOwnerForbidden { owner, .. } if owner == "acme"),
        "{err:?}"
    );
    assert!(remote_names(&repo).is_empty());
}

#[test]
fn session_lost_during_creation_maps_to_session_required() {
    let root = TempDir::new().unwrap();
    let repo = local_repo_with_commit(&root);
    let remote = bare_remote(&root);
    let mut fake = FakeGithub::new(&remote);
    fake.create_error = Some(GithubCreateError::NoSession);

    let err = publish(&repo, &fake, &request("acme", "widgets", RepoVisibility::Private))
        .unwrap_err();

    assert!(matches!(err, RepoError::GithubSessionRequired), "{err:?}");
}

// ---------- sad path: falla a mitad de camino ----------

#[test]
fn push_failure_after_creation_reports_url_leaves_no_broken_origin_and_retry_completes() {
    let root = TempDir::new().unwrap();
    let repo = local_repo_with_commit(&root);
    // El clone_url apunta a una ruta que todavía no existe: el push falla.
    let remote = root.path().join("late-remote.git");
    let fake = FakeGithub::new(&remote);
    let req = request("acme", "widgets", RepoVisibility::Private);

    let err = publish(&repo, &fake, &req).unwrap_err();

    match &err {
        RepoError::GithubPublishIncomplete { html_url, message } => {
            assert_eq!(html_url, "https://github.com/acme/widgets");
            assert!(!message.is_empty(), "debe explicar el estado local");
        }
        other => panic!("se esperaba GithubPublishIncomplete, llegó {other:?}"),
    }
    assert!(
        remote_names(&repo).is_empty(),
        "no debe quedar un origin roto en el repo local"
    );

    // El remoto pasa a estar disponible y se reintenta lo mismo.
    Repository::init_bare(&remote).unwrap();
    let published = publish(&repo, &fake, &req)
        .expect("el reintento no puede fallar por «ya existe»: debe completar el push");

    assert_eq!(published.html_url, "https://github.com/acme/widgets");
    assert_eq!(remote_names(&repo), vec!["origin".to_string()]);
    assert!(
        Repository::open_bare(&remote)
            .unwrap()
            .find_reference("refs/heads/main")
            .is_ok()
    );
}

// ---------- repos ya registrados sin remoto ----------

#[test]
fn works_on_an_already_registered_repo_with_extra_commits_and_no_remote() {
    let root = TempDir::new().unwrap();
    let repo = local_repo_with_commit(&root);
    std::fs::write(repo.join("README.md"), "hola\n").unwrap();
    assert!(GitService::new().commit(&repo, "add readme").unwrap());
    let remote = bare_remote(&root);
    let fake = FakeGithub::new(&remote);

    publish(&repo, &fake, &request("octocat", "demo", RepoVisibility::Public)).unwrap();

    let local_oid = Repository::open(&repo)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap();
    let remote_oid = Repository::open_bare(&remote)
        .unwrap()
        .find_reference("refs/heads/main")
        .unwrap()
        .target()
        .unwrap();
    assert_eq!(local_oid, remote_oid, "se publica el HEAD actual, no el commit inicial");
}
