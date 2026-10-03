//! Fluke's live CLI (J0.1, #727).
//!
//! Every turn used to relaunch the Claude CLI with `--resume`, paying its
//! startup (~1.2 s of the ~2.6 s to the first token). For Fluke's sessions
//! the CLI now starts once and stays alive between turns: the next message
//! goes into its stdin. The rest of the app still sees one execution process
//! per turn (logs, cost, status): each turn gets a placeholder child whose
//! stdout carries that turn's lines, and ends at the CLI's `result`.
//!
//! One live CLI per Claude session, at most one turn on it at a time; a
//! second concurrent turn falls back to a regular spawn. It dies after
//! [`IDLE_TIMEOUT`] without turns, when the CLI exits, or when the session
//! is reset (retry / edit of an earlier message). If the server dies, the
//! CLI's stdin closes and it exits by itself.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex as StdMutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use command_group::AsyncGroupChild;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, BufReader},
    sync::{Mutex, oneshot},
};
use tokio_util::sync::CancellationToken;

use super::{
    client::ClaudeAgentClient,
    protocol::{ProtocolPeer, background_tasks_alive, exit_result_from_payload},
    types::CLIMessage,
};
use crate::executors::{ExecutorError, ExecutorExitResult};

/// A live CLI without turns for this long is stopped (D7 of the spec).
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const IDLE_CHECK: Duration = Duration::from_secs(60);

struct Turn {
    id: u64,
    client: Arc<ClaudeAgentClient>,
    exit_tx: oneshot::Sender<ExecutorExitResult>,
    done: CancellationToken,
}

pub struct Host {
    session_id: String,
    peer: ProtocolPeer,
    turn: Mutex<Option<Turn>>,
    child: Mutex<Option<AsyncGroupChild>>,
    busy: AtomicBool,
    alive: AtomicBool,
    next_turn: AtomicU64,
    last_used: StdMutex<Instant>,
}

fn registry() -> &'static StdMutex<HashMap<String, Arc<Host>>> {
    static REGISTRY: OnceLock<StdMutex<HashMap<String, Arc<Host>>>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}

/// The session's live CLI, reserved for one turn; `None` if there is none
/// or it is busy.
pub fn claim(session_id: &str) -> Option<Arc<Host>> {
    let map = registry().lock().ok()?;
    let host = map.get(session_id)?;
    (host.alive.load(Ordering::SeqCst)
        && host
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok())
    .then(|| host.clone())
}

/// Stop the session's live CLI, if any (its history no longer matches the
/// session, or it failed to start).
pub async fn evict(session_id: &str) {
    let host = registry().lock().ok().and_then(|mut map| map.remove(session_id));
    if let Some(host) = host {
        host.stop().await;
    }
}

impl Host {
    /// Takes over the CLI's stdin, stdout and stderr, starts reading, and
    /// registers it reserved for the turn that started it. The child itself
    /// is handed over with [`Self::attach_child`].
    pub fn start(session_id: &str, child: &mut AsyncGroupChild) -> Result<Arc<Self>, ExecutorError> {
        let missing = |what: &str| ExecutorError::Io(std::io::Error::other(format!("Claude Code missing {what}")));
        let stdin = child.inner().stdin.take().ok_or_else(|| missing("stdin"))?;
        let stdout = child.inner().stdout.take().ok_or_else(|| missing("stdout"))?;
        let stderr = child.inner().stderr.take();

        let host = Arc::new(Self {
            session_id: session_id.to_string(),
            peer: ProtocolPeer::writer(stdin),
            turn: Mutex::new(None),
            child: Mutex::new(None),
            busy: AtomicBool::new(true),
            alive: AtomicBool::new(true),
            next_turn: AtomicU64::new(0),
            last_used: StdMutex::new(Instant::now()),
        });
        if let Some(previous) = registry()
            .lock()
            .ok()
            .and_then(|mut map| map.insert(session_id.to_string(), host.clone()))
        {
            tokio::spawn(async move { previous.stop().await });
        }

        tokio::spawn(host.clone().read_loop(stdout));
        if let Some(stderr) = stderr {
            tokio::spawn(drain_stderr(stderr));
        }
        tokio::spawn(host.clone().reap_when_idle());
        Ok(host)
    }

    pub async fn attach_child(&self, child: AsyncGroupChild) {
        *self.child.lock().await = Some(child);
    }

    pub fn peer(&self) -> &ProtocolPeer {
        &self.peer
    }

    /// Route the CLI's output to this turn and send it the prompt. A cancel
    /// interrupts the CLI, which still ends the turn with its `result`.
    pub async fn run_turn(
        self: &Arc<Self>,
        client: Arc<ClaudeAgentClient>,
        exit_tx: oneshot::Sender<ExecutorExitResult>,
        cancel: CancellationToken,
        prompt: String,
    ) {
        let id = self.next_turn.fetch_add(1, Ordering::SeqCst);
        let done = CancellationToken::new();
        *self.turn.lock().await = Some(Turn {
            id,
            client,
            exit_tx,
            done: done.clone(),
        });

        let host = self.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = done.cancelled() => {}
                _ = cancel.cancelled() => {
                    if let Err(e) = host.peer.interrupt().await {
                        tracing::warn!("Failed to interrupt Fluke's live CLI: {e}");
                    }
                }
            }
        });

        if let Err(e) = self.peer.send_user_message(prompt).await {
            tracing::warn!("Fluke's live CLI did not take the message: {e}");
            self.finish(id, ExecutorExitResult::Failure).await;
            evict(&self.session_id).await;
        }
    }

    /// End turn `id` (if it is still the current one) with `result`.
    async fn finish(&self, id: u64, result: ExecutorExitResult) {
        let turn = {
            let mut slot = self.turn.lock().await;
            match slot.as_ref() {
                Some(turn) if turn.id == id => slot.take(),
                _ => None,
            }
        };
        if let Some(turn) = turn {
            turn.done.cancel();
            let _ = turn.exit_tx.send(result);
            // Dropping the client closes this turn's log pipe.
        }
        if let Ok(mut last) = self.last_used.lock() {
            *last = Instant::now();
        }
        self.busy.store(false, Ordering::SeqCst);
    }

    async fn current(&self) -> Option<(u64, Arc<ClaudeAgentClient>)> {
        self.turn
            .lock()
            .await
            .as_ref()
            .map(|t| (t.id, t.client.clone()))
    }

    async fn read_loop(self: Arc<Self>, stdout: impl AsyncRead + Unpin) {
        let mut reader = BufReader::new(stdout);
        let mut buffer = String::new();
        let mut background_tasks = false;
        loop {
            buffer.clear();
            match reader.read_line(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let line = buffer.trim();
            if line.is_empty() {
                continue;
            }
            let current = self.current().await;
            if let Some((_, client)) = &current
                && let Err(e) = client.log_message(line).await
            {
                tracing::warn!("Failed to log Fluke's live CLI output: {e}");
            }
            match serde_json::from_str::<CLIMessage>(line) {
                Ok(CLIMessage::ControlRequest {
                    request_id,
                    request,
                }) => {
                    if let Some((_, client)) = &current {
                        self.peer
                            .handle_control_request(client, request_id, request)
                            .await;
                    }
                }
                Ok(CLIMessage::Other(message)) => {
                    if let Some(alive) = background_tasks_alive(&message) {
                        background_tasks = alive;
                    }
                }
                // Subagents or shells still running: the CLI starts another
                // turn by itself when they finish, ending in another result.
                Ok(CLIMessage::Result(_)) if background_tasks => {}
                Ok(CLIMessage::Result(payload)) => {
                    if let Some((id, _)) = current {
                        self.finish(id, exit_result_from_payload(&payload)).await;
                    }
                }
                _ => {}
            }
        }

        // The CLI exited: whatever turn was running failed with it.
        self.alive.store(false, Ordering::SeqCst);
        if let Some((id, _)) = self.current().await {
            self.finish(id, ExecutorExitResult::Failure).await;
        }
        if let Ok(mut map) = registry().lock()
            && map
                .get(&self.session_id)
                .is_some_and(|h| Arc::ptr_eq(h, &self))
        {
            map.remove(&self.session_id);
        }
    }

    async fn reap_when_idle(self: Arc<Self>) {
        loop {
            tokio::time::sleep(IDLE_CHECK).await;
            if !self.alive.load(Ordering::SeqCst) {
                return;
            }
            let idle = self
                .last_used
                .lock()
                .map(|last| last.elapsed() >= IDLE_TIMEOUT)
                .unwrap_or(false);
            if idle && !self.busy.load(Ordering::SeqCst) {
                tracing::info!("Stopping Fluke's idle CLI for session {}", self.session_id);
                evict(&self.session_id).await;
                return;
            }
        }
    }

    async fn stop(&self) {
        self.alive.store(false, Ordering::SeqCst);
        if let Some(mut child) = self.child.lock().await.take()
            && let Err(e) = workspace_utils::process::kill_process_group(&mut child).await
        {
            tracing::warn!("Failed to stop Fluke's CLI: {e}");
        }
    }
}

/// The CLI writes diagnostics on stderr; nobody reads them per turn, but the
/// pipe must not fill up.
async fn drain_stderr(stderr: impl AsyncRead + Unpin) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        tracing::debug!(target: "fluke_cli", "{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn one_turn_at_a_time_and_evict() {
        // A real CLI is not needed to check the reservation rules.
        let (peer, _child) = dummy_peer();
        let host = Arc::new(Host {
            session_id: "s".into(),
            peer,
            turn: Mutex::new(None),
            child: Mutex::new(None),
            busy: AtomicBool::new(false),
            alive: AtomicBool::new(true),
            next_turn: AtomicU64::new(0),
            last_used: StdMutex::new(Instant::now()),
        });
        registry().lock().unwrap().insert("s".into(), host.clone());

        let first = claim("s").expect("idle host");
        assert!(claim("s").is_none(), "busy host is not claimed twice");
        first.finish(0, ExecutorExitResult::Success).await;
        assert!(claim("s").is_some(), "free again after its turn");
        assert!(claim("other").is_none());

        evict("s").await;
        assert!(claim("s").is_none());
        assert!(!host.alive.load(Ordering::SeqCst));
    }

    /// A peer over a process that only reads stdin, enough to build a Host.
    fn dummy_peer() -> (ProtocolPeer, tokio::process::Child) {
        #[cfg(windows)]
        let mut cmd = std::process::Command::new("cmd");
        #[cfg(windows)]
        cmd.args(["/C", "more"]);
        #[cfg(unix)]
        let mut cmd = std::process::Command::new("cat");
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null());
        let mut child = tokio::process::Command::from(cmd)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        (ProtocolPeer::writer(stdin), child)
    }
}
