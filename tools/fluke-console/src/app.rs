use std::{
    io,
    path::{Path, PathBuf},
    process::Command,
    sync::mpsc::{self, Receiver},
    thread,
};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::{
    config::{ConfigDraft, Provider},
    model::{Decision, State, Status, Store, Task, atomic_write},
    session::Session,
};

pub struct App {
    pub state: State,
    pub repo: PathBuf,
    pub view: usize,
    pub selected: usize,
    pub input: String,
    pub notice: String,
    pub sessions: Vec<Session>,
    pub direct: bool,
    pub quitting: bool,
    pub busy: bool,
    pub settings: Option<ConfigDraft>,
    launching_worker: bool,
    store: Store,
    launch: Option<Receiver<io::Result<(Option<Task>, Session)>>>,
}

impl App {
    pub fn new(repo: PathBuf, directory: PathBuf) -> io::Result<Self> {
        let repo = repository(&repo)?;
        let directory = dunce::canonicalize(directory)?;
        let (store, mut state) = Store::open(directory)?;
        let recovered = state.recover();
        if !state.projects.contains(&repo) {
            state.projects.push(repo.clone());
        }
        store.save(&state)?;
        let settings = if state.orchestrator.is_none() {
            Some(ConfigDraft::new(None, state.max_workers))
        } else {
            None
        };
        Ok(Self {
            state,
            settings,
            store,
            repo,
            view: 0,
            selected: 0,
            input: String::new(),
            notice: if recovered > 0 {
                format!("{recovered} tareas interrumpidas; revisar antes de reiniciar")
            } else {
                "F1–F4 navegar · :help comandos · :fluke powershell.exe iniciar terminal".into()
            },
            sessions: Vec::new(),
            direct: false,
            quitting: false,
            busy: false,
            launching_worker: false,
            launch: None,
        })
    }

    fn save(&mut self, next: State) -> io::Result<()> {
        self.store.save(&next)?;
        self.state = next;
        Ok(())
    }

    pub fn workers(&self) -> usize {
        self.sessions
            .iter()
            .filter(|s| s.task_id.is_some() && !s.exited)
            .count()
            + usize::from(self.launching_worker)
    }

    pub fn tick(&mut self) -> io::Result<bool> {
        let mut changed = false;
        let launched = self.launch.as_ref().and_then(|rx| match rx.try_recv() {
            Ok(result) => Some(result),
            Err(mpsc::TryRecvError::Empty) => None,
            Err(mpsc::TryRecvError::Disconnected) => Some(Err(io::Error::other(
                "La preparación de la sesión se interrumpió",
            ))),
        });
        if let Some(result) = launched {
            self.launch = None;
            self.busy = false;
            self.launching_worker = false;
            match result {
                Ok((task, session)) => {
                    if let Some(task) = task {
                        let mut next = self.state.clone();
                        if let Some(current) = next.tasks.iter_mut().find(|t| t.id == task.id) {
                            *current = task;
                        }
                        // Persist ownership before exposing the session. On failure Drop stops it.
                        self.save(next)?;
                    }
                    self.sessions.push(session);
                    self.selected = self.sessions.len() - 1;
                    self.view = 2;
                    self.notice =
                        "Sesión abierta. Enter para entrar; Ctrl+X vuelve a Fluke.".into();
                }
                Err(error) => {
                    self.notice = format!("No se pudo iniciar: {error}. No se eliminan worktrees.")
                }
            }
            changed = true;
        }
        let mut next = None;
        for session in &mut self.sessions {
            while let Ok(event) = session.events.try_recv() {
                if let Err(error) = event {
                    self.notice = format!("Terminal {}: {error}", session.label);
                }
                changed = true;
            }
            if session.check_exit()? {
                if session.task_id.is_some() {
                    let state = next.get_or_insert_with(|| self.state.clone());
                    if let Some(task) = state
                        .tasks
                        .iter_mut()
                        .find(|t| session.task_id.as_ref() == Some(&t.id))
                    {
                        task.status = Status::Interrupted;
                        task.note = "Proceso terminado; resultado pendiente de inspección. No implica aceptación.".into();
                    }
                }
                self.notice = format!("{} terminó. Su salida sigue disponible.", session.label);
                changed = true;
            }
        }
        if let Some(next) = next {
            self.save(next)?;
        }
        Ok(changed)
    }

    pub fn key(&mut self, key: KeyEvent) -> io::Result<bool> {
        if self.settings.is_some() {
            self.settings_key(key);
            return Ok(false);
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('x') {
            self.direct = false;
            return Ok(false);
        }
        if self.direct {
            if let Some(session) = self.sessions.get_mut(self.selected) {
                if !session.exited {
                    session.input(&terminal_key(key))?;
                }
            }
            return Ok(false);
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('q') {
            if self.busy {
                self.notice =
                    "Esperá a que termine la apertura de la sesión antes de salir.".into();
            } else if self.sessions.iter().any(|s| !s.exited) && !self.quitting {
                self.quitting = true;
                self.notice =
                    "Salir termina las sesiones. Ctrl+Q confirma; cualquier otra tecla cancela."
                        .into();
            } else {
                return Ok(true);
            }
            return Ok(false);
        }
        self.quitting = false;
        match key.code {
            KeyCode::F(5) => self.open_settings(),
            KeyCode::F(number @ 1..=4) => {
                self.view = usize::from(number - 1);
                self.selected = 0;
            }
            KeyCode::Up => self.selected = self.selected.saturating_sub(1),
            KeyCode::Down => {
                let count = match self.view {
                    2 => self.sessions.len(),
                    3 => self.state.decisions.len(),
                    _ => self
                        .state
                        .tasks
                        .iter()
                        .filter(|t| t.repo == self.repo)
                        .count(),
                };
                self.selected = (self.selected + 1).min(count.saturating_sub(1));
            }
            KeyCode::Backspace => {
                self.input.pop();
            }
            KeyCode::Esc => self.input.clear(),
            KeyCode::Char(character) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.input.push(character)
            }
            KeyCode::Enter => {
                if self.input.is_empty() && self.view == 0 {
                    if let Some(index) = self
                        .sessions
                        .iter()
                        .position(|s| s.task_id.is_none() && s.cwd == self.repo && !s.exited)
                    {
                        self.selected = index;
                        self.view = 2;
                        self.direct = true;
                    } else if let Err(error) = self.command(":fluke") {
                        self.notice = error.to_string();
                    }
                } else if self.input.is_empty() && self.view == 1 {
                    if let Some(id) = self
                        .state
                        .tasks
                        .iter()
                        .filter(|t| t.repo == self.repo)
                        .nth(self.selected)
                        .map(|t| t.id.clone())
                    {
                        if let Err(error) = self.command(&format!(":start {id}")) {
                            self.notice = error.to_string();
                        }
                    }
                } else if self.input.is_empty() && self.view == 2 {
                    self.direct = self.sessions.get(self.selected).is_some_and(|s| !s.exited);
                } else {
                    let input = std::mem::take(&mut self.input);
                    if let Err(error) = self.command(&input) {
                        self.notice = error.to_string();
                    }
                }
            }
            _ => {}
        }
        Ok(false)
    }

    pub fn paste(&mut self, text: &str) -> io::Result<()> {
        if let Some(draft) = &mut self.settings {
            if draft.selected > 0 {
                draft.fields[draft.selected - 1].extend(text.chars().filter(|c| !c.is_control()));
            }
            return Ok(());
        }
        if self.direct {
            if let Some(session) = self.sessions.get_mut(self.selected).filter(|s| !s.exited) {
                let bracketed = session
                    .parser
                    .lock()
                    .map_err(|_| io::Error::other("Pantalla no disponible"))?
                    .screen()
                    .bracketed_paste();
                if bracketed {
                    session.input(b"\x1b[200~")?;
                }
                session.input(text.as_bytes())?;
                if bracketed {
                    session.input(b"\x1b[201~")?;
                }
            }
        } else {
            // Pasting a command never submits it, even when the clipboard contains newlines.
            self.input.extend(text.chars().filter(|c| !c.is_control()));
        }
        Ok(())
    }

    fn open_settings(&mut self) {
        self.settings = Some(ConfigDraft::new(
            self.state.orchestrator.as_ref(),
            self.state.max_workers,
        ));
    }

    fn settings_key(&mut self, key: KeyEvent) {
        if key.code == KeyCode::Esc {
            self.settings = None;
            return;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('s') {
            let result = self
                .settings
                .as_ref()
                .unwrap()
                .values()
                .and_then(|(config, limit)| {
                    let mut next = self.state.clone();
                    next.orchestrator = Some(config);
                    next.max_workers = limit;
                    self.save(next)
                });
            match result {
                Ok(()) => {
                    self.settings = None;
                    self.notice = "Configuración guardada. Se aplica al próximo arranque; las sesiones actuales continúan.".into();
                }
                Err(error) => self.settings.as_mut().unwrap().error = error.to_string(),
            }
            return;
        }
        let draft = self.settings.as_mut().unwrap();
        draft.error.clear();
        match key.code {
            KeyCode::Tab | KeyCode::Down | KeyCode::Enter => {
                draft.selected = (draft.selected + 1) % 5
            }
            KeyCode::BackTab | KeyCode::Up => draft.selected = (draft.selected + 4) % 5,
            KeyCode::Left | KeyCode::Right if draft.selected == 0 => {
                draft.provider = match draft.provider {
                    Provider::Codex => Provider::Claude,
                    Provider::Claude => Provider::Custom,
                    Provider::Custom => Provider::Codex,
                };
                draft.fields[0] = draft.provider.executable().into();
                draft.fields[1].clear();
                draft.fields[2] = "[]".into();
            }
            KeyCode::Backspace if draft.selected > 0 => {
                draft.fields[draft.selected - 1].pop();
            }
            KeyCode::Char(c)
                if draft.selected > 0 && !key.modifiers.contains(KeyModifiers::CONTROL) =>
            {
                draft.fields[draft.selected - 1].push(c)
            }
            _ => {}
        }
    }

    fn command(&mut self, input: &str) -> io::Result<()> {
        let (command, args) = input.split_once(' ').unwrap_or((input, ""));
        let args = args.trim();
        match command {
            ":config" => self.open_settings(),
            ":help" => self.notice = "F5 config · :fluke · :task título | aceptación · :start ID · :stop ID/fluke · :repo ruta · :limit N · :decision pregunta · :answer N texto".into(),
            ":repo" => {
                let repo = repository(Path::new(args.trim_matches('"')))?;
                let mut next = self.state.clone();
                if !next.projects.contains(&repo) { next.projects.push(repo.clone()); }
                self.save(next)?;
                self.repo = repo;
                self.selected = 0;
                self.notice = "Proyecto cambiado; las sesiones continúan en sus repos originales.".into();
            }
            ":task" => {
                let (title, acceptance) = args.split_once('|').ok_or_else(|| io::Error::other("Usá :task título | aceptación"))?;
                let mut next = self.state.clone();
                let id = next.add_task(self.repo.clone(), title, acceptance)?;
                let task = next.tasks.last().unwrap();
                let spec = self.repo.join(".fluke/specs").join(format!("{id}.md"));
                atomic_write(&spec, brief(task).as_bytes())?;
                self.save(next)?;
                self.notice = format!("Tarea {id} guardada. Spec: {}", spec.display());
            }
            ":limit" => {
                let mut next = self.state.clone();
                next.max_workers = args.parse::<usize>().ok().filter(|n| *n > 0)
                    .ok_or_else(|| io::Error::other("El límite debe ser un entero mayor que cero"))?;
                self.save(next)?;
                self.notice = "Límite global actualizado. Las sesiones en curso continúan.".into();
            }
            ":fluke" | ":start" => {
                if self.busy { return Err(io::Error::other("Ya se está preparando una sesión")); }
                let (task, program) = if command == ":start" {
                    if self.workers() >= self.state.max_workers { return Err(io::Error::other("Sin capacidad: alcanzaste el máximo de workers")); }
                    let (id, program) = args.split_once(' ').unwrap_or((args, ""));
                    let task = self.state.tasks.iter().find(|t| t.id == id).cloned()
                        .ok_or_else(|| io::Error::other("Tarea desconocida; copiá el ID de Proyecto"))?;
                    if self.sessions.iter().any(|s| s.task_id.as_deref() == Some(id) && !s.exited) {
                        return Err(io::Error::other("Esa tarea ya tiene un worker activo"));
                    }
                    (Some(task), program)
                } else {
                    if self.sessions.iter().any(|s| s.task_id.is_none() && s.cwd == self.repo && !s.exited) {
                        return Err(io::Error::other("Fluke ya tiene una sesión activa en este proyecto"));
                    }
                    (None, args)
                };
                let (program, arguments, config) = if program.is_empty() {
                    let config = self.state.orchestrator.as_ref().ok_or_else(|| io::Error::other("Configurá la CLI y el modelo en F5 antes de arrancar"))?;
                    (config.executable.clone(), config.launch_arguments()?, Some(config.clone()))
                } else { (program.trim_matches('"').to_string(), Vec::new(), None) };
                if program.is_empty() { return Err(io::Error::other("Indicá un ejecutable")); }
                let repo = self.repo.clone();
                let directory = self.store.directory.clone();
                let context = if task.is_none() {
                    let index = self.state.projects.iter().position(|p| p == &self.repo).unwrap();
                    let path = directory.join("contexts").join(format!("project-{index}.md"));
                    atomic_write(&path, project_context(&self.state, &self.repo).as_bytes())?;
                    Some(path)
                } else { None };
                let (tx, rx) = mpsc::sync_channel(1);
                self.launch = Some(rx);
                self.busy = true;
                self.launching_worker = task.is_some();
                self.notice = "Preparando sesión… La interfaz sigue disponible.".into();
                thread::spawn(move || {
                    let result = (|| {
                        let mut arguments = arguments;
                        let mut task = task;
                        let cwd = if let Some(task) = &mut task {
                            let cwd = prepare_worktree(task, &directory)?;
                            task.worktree = Some(cwd.clone());
                            task.status = Status::Running;
                            task.note = "Sesión manual; el brief está en .fluke-task.md. No se envían prompts automáticamente.".into();
                            let brief_path = cwd.join(".fluke-task.md");
                            let text = brief(task);
                            match std::fs::read(&brief_path) {
                                Ok(bytes) if bytes != text.as_bytes() => return Err(io::Error::other("Ya existe un brief diferente; revisarlo antes de iniciar")),
                                Ok(_) => {},
                                Err(error) if error.kind() == io::ErrorKind::NotFound => atomic_write(&brief_path, text.as_bytes())?,
                                Err(error) => return Err(error),
                            }
                            cwd
                        } else { repo };
                        if config.as_ref().is_some_and(|c| c.provider != Provider::Custom) {
                            let prompt = if task.is_some() {
                                "Leé .fluke-task.md y trabajá sobre esa tarea. Respetá AGENTS.md, el alcance y los criterios de aceptación. Consultá decisiones de producto y cambios de alcance. Presentá evidencia para revisión humana; no hagas merge.".into()
                            } else {
                                format!("Actuá como orquestador de este proyecto. Leé el contexto en {}. Acordá objetivo, alcance y aceptación con el usuario. Esta consola todavía requiere arranque manual de workers: no afirmes que creaste sesiones ni que las controlás. Consultá cambios de alcance y decisiones de producto. Respetá AGENTS.md.", context.as_ref().unwrap().display())
                            };
                            arguments.push(prompt);
                        }
                        let model = config.as_ref().map(|c| if c.model.is_empty() { "modelo de CLI" } else { c.model.as_str() }).unwrap_or("terminal");
                        let label = task.as_ref().map(|t| format!("{} / {model}", t.title)).unwrap_or_else(|| format!("FLUKE / {} / {model}", cwd.file_name().unwrap_or_default().to_string_lossy()));
                        let session = Session::spawn(label, task.as_ref().map(|t| t.id.clone()), &cwd, &program, &arguments)?;
                        Ok((task, session))
                    })();
                    let _ = tx.send(result);
                });
            }
            ":stop" => {
                let session = self.sessions.iter_mut().find(|s| !s.exited && (s.task_id.as_deref() == Some(args) || (args == "fluke" && s.task_id.is_none() && s.cwd == self.repo)))
                    .ok_or_else(|| io::Error::other("No hay un worker activo con ese ID"))?;
                session.stop()?;
                self.notice = "Se solicitó terminar el proceso. El worktree y los cambios se conservan.".into();
            }
            ":close" => {
                let index = args.parse::<usize>().ok().and_then(|n| n.checked_sub(1))
                    .filter(|i| *i < self.sessions.len()).ok_or_else(|| io::Error::other("Usá :close N (número de sesión)"))?;
                if !self.sessions[index].exited { return Err(io::Error::other("Terminá el proceso antes de cerrar su salida")); }
                self.sessions.remove(index);
                self.selected = self.selected.min(self.sessions.len().saturating_sub(1));
                self.notice = "Salida cerrada; tarea y worktree conservados.".into();
            }
            ":decision" => {
                if args.is_empty() { return Err(io::Error::other("Indicá la pregunta")); }
                let mut next = self.state.clone();
                next.decisions.push(Decision { repo: self.repo.clone(), question: args.into(), answer: None });
                self.save(next)?;
                self.view = 3;
                self.selected = self.state.decisions.len() - 1;
                self.notice = "Decisión registrada; responder con :answer N texto.".into();
            }
            ":answer" => {
                let (number, answer) = args.split_once(' ').ok_or_else(|| io::Error::other("Usá :answer N texto"))?;
                let index = number.parse::<usize>().ok().and_then(|n| n.checked_sub(1))
                    .ok_or_else(|| io::Error::other("Número de decisión inválido"))?;
                let mut next = self.state.clone();
                let decision = next.decisions.get_mut(index).ok_or_else(|| io::Error::other("Decisión desconocida"))?;
                if answer.trim().is_empty() { return Err(io::Error::other("La respuesta no puede estar vacía")); }
                decision.answer = Some(answer.trim().into());
                self.save(next)?;
                self.notice = "Respuesta guardada. La comunicación automática con workers aún no está implementada.".into();
            }
            _ => self.notice = "Para conversar, F3 → sesión → Enter. :help muestra comandos de la consola.".into(),
        }
        Ok(())
    }
}

fn git(repo: &Path, args: &[&str]) -> io::Result<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().into())
}

fn repository(path: &Path) -> io::Result<PathBuf> {
    if path.as_os_str().is_empty() {
        return Err(io::Error::other("Indicá una ruta de repositorio"));
    }
    dunce::canonicalize(PathBuf::from(git(path, &["rev-parse", "--show-toplevel"])?))
}

fn prepare_worktree(task: &Task, directory: &Path) -> io::Result<PathBuf> {
    let path = task
        .worktree
        .clone()
        .unwrap_or_else(|| directory.join("worktrees").join(&task.id));
    if path.exists() {
        let root = repository(&path)?;
        if root != dunce::canonicalize(&path)?
            || git(&path, &["branch", "--show-current"])? != task.branch
            || git(
                &path,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            )
            .and_then(dunce::canonicalize)?
                != git(
                    &task.repo,
                    &["rev-parse", "--path-format=absolute", "--git-common-dir"],
                )
                .and_then(dunce::canonicalize)?
        {
            return Err(io::Error::other(
                "El worktree existente no pertenece a esta tarea; revisar manualmente",
            ));
        }
        return Ok(path);
    }
    std::fs::create_dir_all(
        path.parent()
            .ok_or_else(|| io::Error::other("Ruta inválida"))?,
    )?;
    let output = Command::new("git")
        .arg("-C")
        .arg(&task.repo)
        .args(["worktree", "add", "-b"])
        .arg(&task.branch)
        .arg(&path)
        .arg("HEAD")
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }
    Ok(path)
}

fn brief(task: &Task) -> String {
    format!(
        "# {}\n\nID: {}\nRepo: {}\nRama: {}\n\n## Aceptación\n\n{}\n\n## Flujo\n\nAnalizar, planificar, implementar y verificar esta tarea. Consultar cambios de alcance y decisiones de producto. Respetar AGENTS.md. Presentar evidencia y cambios para revisión humana; no hacer merge.\n",
        task.title,
        task.id,
        task.repo.display(),
        task.branch,
        task.acceptance
    )
}

fn project_context(state: &State, repo: &Path) -> String {
    let mut text = format!(
        "# Contexto de proyecto\n\nRepo: {}\nMáximo global de workers: {}\n\n## Tareas\n\n",
        repo.display(),
        state.max_workers
    );
    for task in state.tasks.iter().filter(|t| t.repo == repo) {
        text.push_str(&format!(
            "### {} — {}\n\nEstado: {}\nAceptación: {}\nRama: {}\nWorktree: {}\nNotas: {}\n\n",
            task.id,
            task.title,
            task.status.label(),
            task.acceptance,
            task.branch,
            task.worktree
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "sin iniciar".into()),
            task.note
        ));
    }
    text.push_str("## Decisiones\n\n");
    for decision in state.decisions.iter().filter(|d| d.repo == repo) {
        text.push_str(&format!(
            "- {}\n  Respuesta: {}\n",
            decision.question,
            decision.answer.as_deref().unwrap_or("pendiente")
        ));
    }
    text.push_str("\nEste documento es un snapshot al iniciar una sesión; no implica que los procesos anteriores continúen. No repetir trabajo sin inspeccionar cambios y estado real. Las tareas interrumpidas necesitan reconciliación. Los planes y las decisiones se pueden revisar con el usuario.\n");
    text
}

fn terminal_key(key: KeyEvent) -> Vec<u8> {
    let bytes = match key.code {
        KeyCode::Char(c) if key.modifiers.contains(KeyModifiers::CONTROL) && c.is_ascii() => {
            vec![(c as u8) & 0x1f]
        }
        KeyCode::Char(c) => c.to_string().into_bytes(),
        KeyCode::Enter => b"\r".to_vec(),
        KeyCode::Backspace => vec![127],
        KeyCode::Tab => b"\t".to_vec(),
        KeyCode::BackTab => b"\x1b[Z".to_vec(),
        KeyCode::Esc => vec![27],
        KeyCode::Up => b"\x1b[A".to_vec(),
        KeyCode::Down => b"\x1b[B".to_vec(),
        KeyCode::Right => b"\x1b[C".to_vec(),
        KeyCode::Left => b"\x1b[D".to_vec(),
        KeyCode::Home => b"\x1b[H".to_vec(),
        KeyCode::End => b"\x1b[F".to_vec(),
        KeyCode::Delete => b"\x1b[3~".to_vec(),
        KeyCode::Insert => b"\x1b[2~".to_vec(),
        KeyCode::PageUp => b"\x1b[5~".to_vec(),
        KeyCode::PageDown => b"\x1b[6~".to_vec(),
        _ => Vec::new(),
    };
    if key.modifiers.contains(KeyModifiers::ALT) && matches!(key.code, KeyCode::Char(_)) {
        [vec![27], bytes].concat()
    } else {
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, App) {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo con espacios");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "--initial-branch=main"]).unwrap();
        std::fs::write(repo.join("seed.txt"), "initial").unwrap();
        git(&repo, &["add", "seed.txt"]).unwrap();
        git(
            &repo,
            &[
                "-c",
                "user.name=Fluke Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgSign=false",
                "-c",
                "core.hooksPath=disabled-test-hooks",
                "commit",
                "-m",
                "initial",
            ],
        )
        .unwrap();
        let state = root.path().join("state");
        std::fs::create_dir(&state).unwrap();
        let app = App::new(repo, state.canonicalize().unwrap()).unwrap();
        (root, app)
    }

    #[test]
    fn first_run_config_can_be_saved_and_reopened_without_affecting_tasks() {
        let (_root, mut app) = fixture();
        assert!(app.settings.is_some());
        let draft = app.settings.as_mut().unwrap();
        draft.fields[1] = "chosen-model".into();
        draft.fields[3] = "3".into();
        app.settings_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL));
        assert!(app.settings.is_none());
        assert_eq!(app.state.max_workers, 3);
        assert_eq!(
            app.state.orchestrator.as_ref().unwrap().model,
            "chosen-model"
        );
        let repo = app.repo.clone();
        let directory = app.store.directory.clone();
        drop(app);
        let mut reopened = App::new(repo, directory).unwrap();
        assert!(reopened.settings.is_none());
        reopened.command(":config").unwrap();
        assert_eq!(
            reopened.settings.as_ref().unwrap().fields[1],
            "chosen-model"
        );
        reopened.settings.as_mut().unwrap().fields[3] = "0".into();
        reopened.settings_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL));
        assert!(reopened.settings.is_some());
        assert_eq!(reopened.state.max_workers, 3);
    }

    #[cfg(windows)]
    #[test]
    fn two_workers_use_separate_worktrees_and_third_is_rejected() {
        use std::time::{Duration, Instant};
        let (_root, mut app) = fixture();
        let mut config = crate::config::AgentConfig::default();
        config.provider = Provider::Custom;
        config.executable = "powershell.exe".into();
        config.arguments = vec![
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-Command".into(),
            "Write-Output 'WORKER_READY'; Start-Sleep -Seconds 30".into(),
        ];
        let mut next = app.state.clone();
        next.orchestrator = Some(config);
        app.save(next).unwrap();
        for title in ["Uno", "Dos", "Tres"] {
            app.command(&format!(":task {title} | Archivo válido"))
                .unwrap();
        }
        let ids = app
            .state
            .tasks
            .iter()
            .map(|t| t.id.clone())
            .collect::<Vec<_>>();
        for id in &ids[..2] {
            app.command(&format!(":start {id}")).unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            while app.busy && Instant::now() < deadline {
                app.tick().unwrap();
                thread::sleep(Duration::from_millis(20));
            }
            assert!(!app.busy, "Session launch hung: {}", app.notice);
        }
        assert_eq!(app.workers(), 2, "{}", app.notice);
        assert!(app.command(&format!(":start {}", ids[2])).is_err());
        assert!(app.command(&format!(":start {}", ids[0])).is_err());
        let one = app.state.tasks[0].worktree.clone().unwrap();
        let two = app.state.tasks[1].worktree.clone().unwrap();
        assert_ne!(one, two);
        assert_eq!(
            git(&one, &["branch", "--show-current"]).unwrap(),
            app.state.tasks[0].branch
        );
        assert_eq!(
            git(&two, &["branch", "--show-current"]).unwrap(),
            app.state.tasks[1].branch
        );
        app.command(&format!(":stop {}", ids[0])).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while app.workers() == 2 && Instant::now() < deadline {
            app.tick().unwrap();
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(app.workers(), 1);
        assert_eq!(app.state.tasks[0].status, Status::Interrupted);
        assert!(one.join(".fluke-task.md").exists());
        app.command(&format!(":start {}", ids[0])).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while app.busy && Instant::now() < deadline {
            app.tick().unwrap();
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(app.workers(), 2, "{}", app.notice);
        assert_eq!(app.state.tasks[0].worktree.as_ref().unwrap(), &one);
    }
    #[test]
    fn terminal_interrupt_and_unicode_are_forwarded() {
        assert_eq!(
            terminal_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            vec![3]
        );
        assert_eq!(
            terminal_key(KeyEvent::new(KeyCode::Char('ñ'), KeyModifiers::NONE)),
            "ñ".as_bytes()
        );
    }
}
