use std::{
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver},
    },
    thread,
};

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};

pub struct Session {
    pub label: String,
    pub task_id: Option<String>,
    pub cwd: PathBuf,
    pub parser: Arc<Mutex<vt100::Parser>>,
    pub events: Receiver<io::Result<()>>,
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn Child + Send + Sync>,
    pub exited: bool,
    size: (u16, u16),
    exit_reported: bool,
}

impl Session {
    pub fn spawn(
        label: String,
        task_id: Option<String>,
        cwd: &Path,
        program: &str,
        args: &[String],
    ) -> io::Result<Self> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(io::Error::other)?;
        let mut command = command_builder(cwd, program, args)?;
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("FLUKE_SESSION", &label);
        if let Some(id) = &task_id {
            command.env("FLUKE_TASK_ID", id);
        }
        let mut reader = pair.master.try_clone_reader().map_err(io::Error::other)?;
        let writer = Arc::new(Mutex::new(
            pair.master.take_writer().map_err(io::Error::other)?,
        ));
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(io::Error::other)?;
        drop(pair.slave);
        let parser = Arc::new(Mutex::new(vt100::Parser::new(24, 80, 2000)));
        let screen = Arc::clone(&parser);
        let responses = Arc::clone(&writer);
        // A single bounded notification is enough: the parser retains the latest screen.
        let (tx, events) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut bytes = [0; 8192];
            let mut queries = vte::Parser::new();
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(count) => {
                        let Ok(mut parser) = screen.lock() else {
                            break;
                        };
                        let mut reply = Vec::new();
                        for byte in &bytes[..count] {
                            parser.process(std::slice::from_ref(byte));
                            queries.advance(
                                &mut TerminalReplies {
                                    screen: parser.screen(),
                                    output: &mut reply,
                                },
                                *byte,
                            );
                        }
                        drop(parser);
                        if !reply.is_empty() {
                            let result = responses
                                .lock()
                                .map_err(|_| io::Error::other("Entrada no disponible"))
                                .and_then(|mut writer| {
                                    writer.write_all(&reply)?;
                                    writer.flush()
                                });
                            if let Err(error) = result {
                                let _ = tx.try_send(Err(error));
                                break;
                            }
                        }
                        let _ = tx.try_send(Ok(()));
                    }
                    Err(error) => {
                        let _ = tx.try_send(Err(error));
                        break;
                    }
                }
            }
        });
        Ok(Self {
            label,
            task_id,
            cwd: cwd.to_owned(),
            parser,
            events,
            master: pair.master,
            writer,
            child,
            exited: false,
            size: (24, 80),
            exit_reported: false,
        })
    }

    pub fn resize(&mut self, rows: u16, cols: u16) -> io::Result<()> {
        let rows = rows.max(1);
        let cols = cols.max(1);
        if self.size == (rows, cols) {
            return Ok(());
        }
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(io::Error::other)?;
        self.parser
            .lock()
            .map_err(|_| io::Error::other("Pantalla no disponible"))?
            .set_size(rows, cols);
        self.size = (rows, cols);
        Ok(())
    }

    pub fn input(&mut self, bytes: &[u8]) -> io::Result<()> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| io::Error::other("Entrada no disponible"))?;
        writer.write_all(bytes)?;
        writer.flush()
    }

    pub fn process_id(&self) -> Option<u32> {
        self.child.process_id()
    }

    pub fn check_exit(&mut self) -> io::Result<bool> {
        if !self.exited && self.child.try_wait().map_err(io::Error::other)?.is_some() {
            self.exited = true;
        }
        let changed = self.exited && !self.exit_reported;
        self.exit_reported |= self.exited;
        Ok(changed)
    }

    pub fn stop(&mut self) -> io::Result<()> {
        if self.child.try_wait().map_err(io::Error::other)?.is_some() {
            self.exited = true;
        }
        if self.exited {
            return Ok(());
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // The shell can own an agent and build children. Terminate the tree, not only the shell.
            if let Some(pid) = self.child.process_id() {
                let output = std::process::Command::new("taskkill.exe")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .creation_flags(0x08000000)
                    .output()?;
                if !output.status.success() {
                    if self.child.try_wait().map_err(io::Error::other)?.is_some() {
                        self.exited = true;
                    }
                    if !self.exited {
                        return Err(io::Error::other(
                            String::from_utf8_lossy(&output.stderr).into_owned(),
                        ));
                    }
                }
                return Ok(());
            }
        }
        self.child.kill().map_err(io::Error::other)?;
        Ok(())
    }
}

struct TerminalReplies<'a> {
    screen: &'a vt100::Screen,
    output: &'a mut Vec<u8>,
}

impl vte::Perform for TerminalReplies<'_> {
    fn csi_dispatch(
        &mut self,
        params: &vte::Params,
        intermediates: &[u8],
        ignore: bool,
        action: char,
    ) {
        if ignore || params.iter().count() > 1 {
            return;
        }
        let code = params
            .iter()
            .next()
            .and_then(|p| p.first())
            .copied()
            .unwrap_or(0);
        match (action, intermediates, code) {
            ('n', [], 6) => {
                let (row, col) = self.screen.cursor_position();
                self.output
                    .extend_from_slice(format!("\x1b[{};{}R", row + 1, col + 1).as_bytes());
            }
            ('n', [], 5) => self.output.extend_from_slice(b"\x1b[0n"),
            ('c', [], 0) => self.output.extend_from_slice(b"\x1b[?1;2c"),
            ('c', [b'>'], 0) => self.output.extend_from_slice(b"\x1b[>0;1;0c"),
            ('t', [], 18) => {
                let (rows, cols) = self.screen.size();
                self.output
                    .extend_from_slice(format!("\x1b[8;{rows};{cols}t").as_bytes());
            }
            _ => {}
        }
    }
}

fn command_builder(cwd: &Path, program: &str, args: &[String]) -> io::Result<CommandBuilder> {
    #[cfg(windows)]
    {
        let requested = PathBuf::from(program);
        let mut candidates = Vec::new();
        if requested.is_absolute() {
            candidates.push(requested);
        } else if requested.components().count() > 1 {
            candidates.push(cwd.join(requested));
        } else {
            candidates.push(cwd.join(&requested));
            for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
                candidates.push(directory.join(&requested));
            }
        }
        let executable = candidates
            .into_iter()
            .find_map(|path| {
                if path.is_file() {
                    return Some(path);
                }
                if path.extension().is_none() {
                    for extension in ["exe", "cmd", "bat", "ps1"] {
                        let with_extension = path.with_extension(extension);
                        if with_extension.is_file() {
                            return Some(with_extension);
                        }
                    }
                }
                None
            })
            .ok_or_else(|| {
                io::Error::other(format!(
                    "No se encontró {program} en PATH ni en el proyecto"
                ))
            })?;
        if executable
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| {
                ["cmd", "bat", "ps1"]
                    .iter()
                    .any(|candidate| e.eq_ignore_ascii_case(candidate))
            })
        {
            let mut command = CommandBuilder::new("powershell.exe");
            command.args(["-NoLogo", "-NoProfile", "-Command"]);
            // Each value is a PowerShell literal: shell metacharacters cannot become commands.
            let mut invocation = format!("& {}", ps_literal(&executable.to_string_lossy()));
            for argument in args {
                invocation.push(' ');
                invocation.push_str(&ps_literal(argument));
            }
            command.arg(invocation);
            return Ok(command);
        }
        let mut command = CommandBuilder::new(executable);
        command.args(args);
        Ok(command)
    }
    #[cfg(not(windows))]
    {
        let _ = cwd;
        let mut command = CommandBuilder::new(program);
        command.args(args);
        Ok(command)
    }
}

#[cfg(windows)]
fn ps_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(all(test, windows))]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    #[test]
    fn real_conpty_receives_output_and_reaps_exit() {
        let cwd = tempfile::tempdir().unwrap();
        let mut session = Session::spawn(
            "PTY smoke".into(),
            None,
            cwd.path(),
            "powershell.exe",
            &[
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-Command".into(),
                "Write-Output 'FLUKE_PTY_OK'".into(),
            ],
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if session.check_exit().unwrap() {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            session.exited,
            "PowerShell did not exit. Screen: {:?}",
            session.parser.lock().unwrap().screen().contents()
        );
        let deadline = Instant::now() + Duration::from_secs(2);
        while !session
            .parser
            .lock()
            .unwrap()
            .screen()
            .contents()
            .contains("FLUKE_PTY_OK")
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            session
                .parser
                .lock()
                .unwrap()
                .screen()
                .contents()
                .contains("FLUKE_PTY_OK")
        );
    }

    #[test]
    fn npm_wrapper_arguments_are_literal_not_powershell_commands() {
        let cwd = tempfile::tempdir().unwrap();
        let wrapper = cwd.path().join("echo arguments.ps1");
        std::fs::write(&wrapper, "param([string]$Value)\nWrite-Output $Value\n").unwrap();
        let malicious = format!(
            "value with spaces'; Set-Content '{}' 'BAD'; #",
            cwd.path().join("injected.txt").display()
        );
        let mut session = Session::spawn(
            "literal args".into(),
            None,
            cwd.path(),
            wrapper.to_str().unwrap(),
            std::slice::from_ref(&malicious),
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline && !session.exited {
            session.check_exit().unwrap();
            thread::sleep(Duration::from_millis(20));
        }
        assert!(session.exited);
        assert!(!cwd.path().join("injected.txt").exists());
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline
            && !session
                .parser
                .lock()
                .unwrap()
                .screen()
                .contents()
                .contains("value with spaces")
        {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            session
                .parser
                .lock()
                .unwrap()
                .screen()
                .contents()
                .contains("value with spaces"),
            "Wrapper didn't receive the argument"
        );
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if !self.exited {
            let _ = self.stop();
        }
    }
}
