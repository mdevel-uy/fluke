use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use fs2::FileExt;
use serde::{Deserialize, Serialize};

use crate::config::AgentConfig;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Pending,
    Running,
    Interrupted,
    AwaitingReview,
}

impl Status {
    pub fn label(self) -> &'static str {
        match self {
            Self::Pending => "EN COLA",
            Self::Running => "EN CURSO",
            Self::Interrupted => "INTERRUMPIDA",
            Self::AwaitingReview => "PARA REVISAR",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub repo: PathBuf,
    pub title: String,
    pub acceptance: String,
    pub status: Status,
    pub worktree: Option<PathBuf>,
    pub branch: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Decision {
    pub repo: PathBuf,
    pub question: String,
    pub answer: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct State {
    pub version: u32,
    pub max_workers: usize,
    pub projects: Vec<PathBuf>,
    pub tasks: Vec<Task>,
    pub decisions: Vec<Decision>,
    #[serde(default)]
    pub orchestrator: Option<AgentConfig>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            version: 1,
            max_workers: 2,
            projects: Vec::new(),
            tasks: Vec::new(),
            decisions: Vec::new(),
            orchestrator: None,
        }
    }
}

impl State {
    pub fn recover(&mut self) -> usize {
        let mut count = 0;
        for task in &mut self.tasks {
            if task.status == Status::Running {
                task.status = Status::Interrupted;
                task.note =
                    "La ejecución anterior terminó. Revisar cambios antes de reiniciar.".into();
                count += 1;
            }
        }
        count
    }

    pub fn add_task(&mut self, repo: PathBuf, title: &str, acceptance: &str) -> io::Result<String> {
        if title.trim().is_empty() || acceptance.trim().is_empty() {
            return Err(io::Error::other(
                "Indicá título y criterio: :task título | aceptación",
            ));
        }
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos();
        let id = format!("t{stamp:x}");
        self.tasks.push(Task {
            branch: format!("codex/fluke/{id}"),
            id: id.clone(),
            repo,
            title: title.trim().into(),
            acceptance: acceptance.trim().into(),
            status: Status::Pending,
            worktree: None,
            note: String::new(),
        });
        Ok(id)
    }
}

pub struct Store {
    pub directory: PathBuf,
    _lock: File,
}

impl Store {
    pub fn open(directory: PathBuf) -> io::Result<(Self, State)> {
        fs::create_dir_all(&directory)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(directory.join("console.lock"))?;
        lock.try_lock_exclusive()
            .map_err(|_| io::Error::other("Ya hay una consola usando este estado."))?;
        let path = directory.join("state.json");
        let state: State = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
                io::Error::other(format!(
                    "Estado inválido; se conserva {}: {error}",
                    path.display()
                ))
            })?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => State::default(),
            Err(error) => return Err(error),
        };
        if state.version != 1 || state.max_workers == 0 {
            return Err(io::Error::other(
                "Versión o límite de workers inválido; estado conservado.",
            ));
        }
        if let Some(config) = &state.orchestrator {
            config.validate()?;
        }
        let mut ids = std::collections::HashSet::new();
        for task in &state.tasks {
            if !task.id.starts_with('t')
                || task.id.len() < 2
                || !task.id[1..].bytes().all(|c| c.is_ascii_hexdigit())
                || !ids.insert(&task.id)
                || task.branch != format!("codex/fluke/{}", task.id)
                || !task.repo.is_absolute()
                || !state.projects.contains(&task.repo)
                || task.worktree.as_ref().is_some_and(|p| !p.is_absolute())
            {
                return Err(io::Error::other(
                    "Tarea inválida en state.json; el archivo se conserva.",
                ));
            }
        }
        Ok((
            Self {
                directory,
                _lock: lock,
            },
            state,
        ))
    }

    pub fn save(&self, state: &State) -> io::Result<()> {
        atomic_write(
            &self.directory.join("state.json"),
            &serde_json::to_vec_pretty(state).map_err(io::Error::other)?,
        )
    }
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("Ruta sin directorio"))?;
    fs::create_dir_all(parent)?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|error| error.error)?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interrupted_execution_is_not_success_and_preserves_checkout() {
        let mut state = State::default();
        state
            .add_task(PathBuf::from("repo"), "Exportar", "JSON válido")
            .unwrap();
        state.tasks[0].status = Status::Running;
        state.tasks[0].worktree = Some(PathBuf::from("checkout"));
        assert_eq!(state.recover(), 1);
        assert_eq!(state.tasks[0].status, Status::Interrupted);
        assert_eq!(
            state.tasks[0].worktree.as_deref(),
            Some(Path::new("checkout"))
        );
    }

    #[test]
    fn corrupt_state_is_not_replaced_and_lock_is_exclusive() {
        let directory = tempfile::tempdir().unwrap();
        let (store, state) = Store::open(directory.path().into()).unwrap();
        store.save(&state).unwrap();
        assert!(Store::open(directory.path().into()).is_err());
        drop(store);
        fs::write(directory.path().join("state.json"), b"broken").unwrap();
        assert!(Store::open(directory.path().into()).is_err());
        assert_eq!(
            fs::read(directory.path().join("state.json")).unwrap(),
            b"broken"
        );
    }
}
