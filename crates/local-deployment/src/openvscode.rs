use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};

use command_group::{AsyncCommandGroup, AsyncGroupChild};
use thiserror::Error;
use tokio::{io::AsyncBufReadExt, net::TcpStream, process::Command, sync::Mutex, time::sleep};
use tokio_util::sync::CancellationToken;
use utils::{path::expand_tilde, shell::resolve_executable_path};

const BINARY_NAME: &str = "openvscode-server";
const BINARY_ENV_VAR: &str = "VK_OPENVSCODE_PATH";
const USER_DATA_DIR: &str = "~/.openvscode-server/data";
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Seeded on first run only (the file is never touched once it exists, so
/// changes made from the editor UI stick). Strips the workbench down to an
/// embedded-editor look: no activity bar, no status bar, no welcome page —
/// the vibe-kanban shell already provides that chrome.
const DEFAULT_USER_SETTINGS: &str = r#"{
    // Seeded by vibe-kanban on first run: slim chrome for the embedded
    // editor. Edit freely — this file is only written when missing.
    "workbench.startupEditor": "none",
    "workbench.activityBar.location": "hidden",
    "workbench.statusBar.visible": false,
    "window.commandCenter": false,
    "workbench.layoutControl.enabled": false,
    "workbench.tips.enabled": false,
    "security.workspace.trust.enabled": false
}
"#;

#[derive(Debug, Error)]
pub enum OpenVscodeError {
    #[error(
        "openvscode-server not found. Install it and add it to PATH, or set {BINARY_ENV_VAR} to the binary path."
    )]
    BinaryNotFound,
    #[error("Failed to spawn openvscode-server: {0}")]
    SpawnFailed(String),
    #[error("openvscode-server exited during startup ({0})")]
    ExitedEarly(String),
    #[error("openvscode-server did not become ready within {}s", READY_TIMEOUT.as_secs())]
    NotReady,
}

struct RunningServer {
    port: u16,
    child: AsyncGroupChild,
}

/// One openvscode-server instance per host, spawned on demand on an ephemeral
/// loopback port. The embedded editor iframe reaches it through the preview
/// proxy (subdomain routing), so the process itself never listens beyond
/// 127.0.0.1. The workspace folder is picked per-iframe via the `?folder=`
/// query parameter, so a single server covers every workspace.
#[derive(Clone)]
pub struct OpenVscodeService {
    inner: Arc<Mutex<Option<RunningServer>>>,
}

impl OpenVscodeService {
    pub fn new(shutdown: CancellationToken) -> Self {
        let inner: Arc<Mutex<Option<RunningServer>>> = Arc::new(Mutex::new(None));

        let shutdown_inner = inner.clone();
        tokio::spawn(async move {
            shutdown.cancelled().await;
            if let Some(mut server) = shutdown_inner.lock().await.take() {
                let _ = utils::process::kill_process_group(&mut server.child).await;
            }
        });

        Self { inner }
    }

    /// Return the port of the running server, spawning it first if needed.
    pub async fn ensure(&self) -> Result<u16, OpenVscodeError> {
        let mut guard = self.inner.lock().await;

        if let Some(server) = guard.as_mut() {
            if matches!(server.child.try_wait(), Ok(None)) {
                return Ok(server.port);
            }
            // The process died since we spawned it — fall through and respawn.
            *guard = None;
        }

        let binary = match std::env::var(BINARY_ENV_VAR) {
            Ok(path) if !path.trim().is_empty() => resolve_executable_path(&path).await,
            _ => resolve_executable_path(BINARY_NAME).await,
        }
        .ok_or(OpenVscodeError::BinaryNotFound)?;

        let port = pick_free_port().map_err(|e| OpenVscodeError::SpawnFailed(e.to_string()))?;

        let user_data_dir = expand_tilde(USER_DATA_DIR);
        seed_default_user_settings(&user_data_dir).await;

        let mut child = Command::new(&binary)
            .args([
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
                "--without-connection-token",
                "--user-data-dir",
            ])
            .arg(&user_data_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .group_spawn()
            .map_err(|e| OpenVscodeError::SpawnFailed(e.to_string()))?;

        forward_stderr_to_logs(&mut child);

        if let Err(err) = wait_until_ready(&mut child, port).await {
            let _ = utils::process::kill_process_group(&mut child).await;
            return Err(err);
        }

        tracing::info!(
            "openvscode-server ready on 127.0.0.1:{port} ({})",
            binary.display()
        );
        *guard = Some(RunningServer { port, child });
        Ok(port)
    }
}

/// Write the slim-chrome defaults if the user has no settings file yet.
async fn seed_default_user_settings(user_data_dir: &Path) {
    let settings_path: PathBuf = user_data_dir.join("User").join("settings.json");
    if tokio::fs::try_exists(&settings_path).await.unwrap_or(false) {
        return;
    }

    let result = async {
        if let Some(parent) = settings_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&settings_path, DEFAULT_USER_SETTINGS).await
    }
    .await;

    if let Err(e) = result {
        tracing::warn!(
            "Failed to seed openvscode-server settings at {}: {e}",
            settings_path.display()
        );
    }
}

fn pick_free_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

fn forward_stderr_to_logs(child: &mut AsyncGroupChild) {
    if let Some(stderr) = child.inner().stderr.take() {
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!("openvscode-server: {line}");
            }
        });
    }
}

async fn wait_until_ready(
    child: &mut AsyncGroupChild,
    port: u16,
) -> Result<(), OpenVscodeError> {
    let deadline = Instant::now() + READY_TIMEOUT;

    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(OpenVscodeError::ExitedEarly(status.to_string()));
        }

        if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return Ok(());
        }

        if Instant::now() >= deadline {
            return Err(OpenVscodeError::NotReady);
        }

        sleep(READY_POLL_INTERVAL).await;
    }
}
