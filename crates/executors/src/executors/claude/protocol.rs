use std::sync::Arc;

use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

use super::types::{CLIMessage, ControlRequestType, ControlResponseMessage, ControlResponseType};
use crate::{
    approvals::ExecutorApprovalError,
    executors::{
        ExecutorError, ExecutorExitResult,
        claude::{
            client::ClaudeAgentClient,
            types::{Message, PermissionMode, SDKControlRequest, SDKControlRequestType},
        },
    },
};

/// How long the CLI gets to exit on its own after emitting its `result`
/// message before the exit signal fires and the container kills the process
/// group. Normally the CLI exits within a second or two of the result;
/// the grace period only matters for the hung-after-result case (incidente
/// PR #499: end_turn + result emitidos, stdin cerrado, y el proceso siguió
/// vivo 7 horas — la task quedó in_progress y el veredicto sin someter).
const EXIT_AFTER_RESULT_GRACE: std::time::Duration = std::time::Duration::from_secs(30);

/// Map a raw `{"type":"result", ...}` payload to the exit result the
/// container should record if the CLI has to be reaped. `is_error: true`
/// (or an unreadable flag) marks the run failed; absent defaults to success
/// because every healthy result carries `is_error: false`.
pub(crate) fn exit_result_from_payload(payload: &serde_json::Value) -> ExecutorExitResult {
    match payload.get("is_error").and_then(|v| v.as_bool()) {
        Some(true) => ExecutorExitResult::Failure,
        _ => ExecutorExitResult::Success,
    }
}

/// `Some(alive)` for a `background_tasks_changed` system message (the CLI
/// sends the full live set on every change), `None` for anything else.
pub(crate) fn background_tasks_alive(message: &serde_json::Value) -> Option<bool> {
    if message.get("subtype")?.as_str()? != "background_tasks_changed" {
        return None;
    }
    Some(
        message
            .get("tasks")
            .and_then(|t| t.as_array())
            .is_some_and(|t| !t.is_empty()),
    )
}

/// Handles bidirectional control protocol communication
#[derive(Clone)]
pub struct ProtocolPeer {
    stdin: Arc<Mutex<ChildStdin>>,
}

impl ProtocolPeer {
    /// Only the writing side: the caller runs its own read loop (the
    /// persistent CLI of `persistent.rs`, which outlives a single turn).
    pub(crate) fn writer(stdin: ChildStdin) -> Self {
        Self {
            stdin: Arc::new(Mutex::new(stdin)),
        }
    }

    pub fn spawn(
        stdin: ChildStdin,
        stdout: ChildStdout,
        client: Arc<ClaudeAgentClient>,
        cancel: CancellationToken,
        exit_tx: tokio::sync::oneshot::Sender<ExecutorExitResult>,
    ) -> Self {
        let peer = Self {
            stdin: Arc::new(Mutex::new(stdin)),
        };

        let reader_peer = peer.clone();
        tokio::spawn(async move {
            if let Err(e) = reader_peer.read_loop(stdout, client, cancel, exit_tx).await {
                tracing::error!("Protocol reader loop error: {}", e);
            }
        });

        peer
    }

    async fn read_loop(
        &self,
        stdout: ChildStdout,
        client: Arc<ClaudeAgentClient>,
        cancel: CancellationToken,
        exit_tx: tokio::sync::oneshot::Sender<ExecutorExitResult>,
    ) -> Result<(), ExecutorError> {
        let mut reader = BufReader::new(stdout);
        let mut buffer = String::new();
        let mut interrupt_sent = false;
        let mut exit_tx = Some(exit_tx);
        let mut background_tasks = false;

        loop {
            buffer.clear();
            tokio::select! {
                biased;
                _ = cancel.cancelled(), if !interrupt_sent => {
                    interrupt_sent = true;
                    tracing::info!("Cancellation received in read_loop, sending interrupt to Claude");
                    if let Err(e) = self.interrupt().await {
                        tracing::warn!("Failed to send interrupt to Claude: {e}");
                    }
                    // Continue the loop to read Claude's response (it should send a result)
                }
                line_result = reader.read_line(&mut buffer) => {
                    match line_result {
                        Ok(0) => break, // EOF
                        Ok(_) => {
                            let line = buffer.trim();
                            if line.is_empty() {
                                continue;
                            }
                            client.log_message(line).await?;

                            // Parse and handle control messages
                            match serde_json::from_str::<CLIMessage>(line) {
                                Ok(CLIMessage::ControlRequest {
                                    request_id,
                                    request,
                                }) => {
                                    self.handle_control_request(&client, request_id, request)
                                        .await;
                                }
                                Ok(CLIMessage::Other(message)) => {
                                    if let Some(alive) = background_tasks_alive(&message) {
                                        background_tasks = alive;
                                    }
                                }
                                // The agent ended its turn with subagents or
                                // shells still running in background: keep
                                // stdin open so the CLI gets their completion
                                // notification and starts a new turn, which
                                // ends in another result. A cancel still ends
                                // the run at the next result.
                                Ok(CLIMessage::Result(_)) if background_tasks && !interrupt_sent => {}
                                Ok(CLIMessage::Result(payload)) => {
                                    // The run is over: the CLI is expected to
                                    // exit by itself now that the result is
                                    // out and stdin closes when this loop
                                    // drops the peer. It doesn't always (a
                                    // hung CLI leaves the task in_progress
                                    // forever), so arm a delayed exit signal:
                                    // if the process is still alive after the
                                    // grace period, the container kills the
                                    // group and records the result-derived
                                    // status. If the CLI exited normally the
                                    // receiver is already gone and the send
                                    // is a no-op.
                                    if let Some(tx) = exit_tx.take() {
                                        let result = exit_result_from_payload(&payload);
                                        tokio::spawn(async move {
                                            tokio::time::sleep(EXIT_AFTER_RESULT_GRACE).await;
                                            if tx.send(result).is_ok() {
                                                tracing::warn!(
                                                    "Claude CLI still alive {}s after its result \
                                                     message — signaling the container to reap it",
                                                    EXIT_AFTER_RESULT_GRACE.as_secs()
                                                );
                                            }
                                        });
                                    }
                                    break;
                                }
                                _ => {}
                            }
                        }
                        Err(e) => {
                            tracing::error!("Error reading stdout: {}", e);
                            break;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    pub(crate) async fn handle_control_request(
        &self,
        client: &Arc<ClaudeAgentClient>,
        request_id: String,
        request: ControlRequestType,
    ) {
        match request {
            ControlRequestType::CanUseTool {
                tool_name,
                input,
                permission_suggestions,
                blocked_paths: _,
                tool_use_id,
            } => {
                match client
                    .on_can_use_tool(tool_name, input, permission_suggestions, tool_use_id)
                    .await
                {
                    Ok(result) => {
                        if let Err(e) = self
                            .send_hook_response(request_id, serde_json::to_value(result).unwrap())
                            .await
                        {
                            tracing::error!("Failed to send permission result: {e}");
                        }
                    }
                    Err(ExecutorError::ExecutorApprovalError(ExecutorApprovalError::Cancelled)) => {
                    }
                    Err(e) => {
                        tracing::error!("Error in on_can_use_tool: {e}");
                        if let Err(e2) = self.send_error(request_id, e.to_string()).await {
                            tracing::error!("Failed to send error response: {e2}");
                        }
                    }
                }
            }
            ControlRequestType::HookCallback {
                callback_id,
                input,
                tool_use_id,
            } => {
                match client
                    .on_hook_callback(callback_id, input, tool_use_id)
                    .await
                {
                    Ok(hook_output) => {
                        if let Err(e) = self.send_hook_response(request_id, hook_output).await {
                            tracing::error!("Failed to send hook callback result: {e}");
                        }
                    }
                    Err(e) => {
                        tracing::error!("Error in on_hook_callback: {e}");
                        if let Err(e2) = self.send_error(request_id, e.to_string()).await {
                            tracing::error!("Failed to send error response: {e2}");
                        }
                    }
                }
            }
        }
    }

    pub async fn send_hook_response(
        &self,
        request_id: String,
        hook_output: serde_json::Value,
    ) -> Result<(), ExecutorError> {
        self.send_json(&ControlResponseMessage::new(ControlResponseType::Success {
            request_id,
            response: Some(hook_output),
        }))
        .await
    }

    /// Send error response to CLI
    async fn send_error(&self, request_id: String, error: String) -> Result<(), ExecutorError> {
        self.send_json(&ControlResponseMessage::new(ControlResponseType::Error {
            request_id,
            error: Some(error),
        }))
        .await
    }

    async fn send_json<T: serde::Serialize>(&self, message: &T) -> Result<(), ExecutorError> {
        let json = serde_json::to_string(message)?;
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(json.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
    }

    pub async fn send_user_message(&self, content: String) -> Result<(), ExecutorError> {
        let message = Message::new_user(content);
        self.send_json(&message).await
    }

    pub async fn initialize(&self, hooks: Option<serde_json::Value>) -> Result<(), ExecutorError> {
        self.send_json(&SDKControlRequest::new(SDKControlRequestType::Initialize {
            hooks,
        }))
        .await
    }
    pub async fn interrupt(&self) -> Result<(), ExecutorError> {
        self.send_json(&SDKControlRequest::new(SDKControlRequestType::Interrupt {}))
            .await
    }

    pub async fn set_permission_mode(&self, mode: PermissionMode) -> Result<(), ExecutorError> {
        self.send_json(&SDKControlRequest::new(
            SDKControlRequestType::SetPermissionMode { mode },
        ))
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real-shaped success line: the reaped status must be Completed, same
    /// as a clean self-exit with code 0.
    #[test]
    fn exit_result_success_when_is_error_false() {
        let payload: serde_json::Value = serde_json::from_str(
            r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":6059,"result":"done"}"#,
        )
        .unwrap();
        assert!(matches!(
            exit_result_from_payload(&payload),
            ExecutorExitResult::Success
        ));
    }

    /// An errored run (e.g. the fable-404 incident line) must be reaped as
    /// Failure so the orchestrator's failure classification still runs.
    #[test]
    fn exit_result_failure_when_is_error_true() {
        let payload: serde_json::Value = serde_json::from_str(
            r#"{"type":"result","subtype":"success","is_error":true,"api_error_status":404,"result":"model error"}"#,
        )
        .unwrap();
        assert!(matches!(
            exit_result_from_payload(&payload),
            ExecutorExitResult::Failure
        ));
    }

    /// A result without the flag (or with a non-bool value) defaults to
    /// Success — every healthy result carries is_error, so absence means an
    /// old/odd payload, not a failure.
    #[test]
    fn exit_result_defaults_to_success_without_flag() {
        let payload: serde_json::Value =
            serde_json::from_str(r#"{"type":"result","subtype":"success"}"#).unwrap();
        assert!(matches!(
            exit_result_from_payload(&payload),
            ExecutorExitResult::Success
        ));
    }

    /// Shapes taken from a real run (Flor, 28-sep): launch lists the task,
    /// completion sends an empty list, other system messages are ignored.
    #[test]
    fn background_tasks_alive_tracks_live_set() {
        let launched: serde_json::Value = serde_json::from_str(
            r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"a15a","task_type":"local_agent"}]}"#,
        )
        .unwrap();
        let finished: serde_json::Value = serde_json::from_str(
            r#"{"type":"system","subtype":"background_tasks_changed","tasks":[]}"#,
        )
        .unwrap();
        let other: serde_json::Value =
            serde_json::from_str(r#"{"type":"system","subtype":"task_started"}"#).unwrap();
        assert_eq!(background_tasks_alive(&launched), Some(true));
        assert_eq!(background_tasks_alive(&finished), Some(false));
        assert_eq!(background_tasks_alive(&other), None);
    }
}
