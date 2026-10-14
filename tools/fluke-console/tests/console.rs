#![cfg(windows)]

// Use the same terminal transport as the app to exercise the native executable.
#[path = "../src/session.rs"]
#[allow(dead_code)]
mod session;

use std::{
    process::Command,
    thread,
    time::{Duration, Instant},
};

use session::Session;

fn wait_for(session: &mut Session, text: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let contents = session.parser.lock().unwrap().screen().contents();
        if contents.contains(text) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "Missing {text:?}. Screen: {contents}"
        );
        assert!(
            !session.check_exit().unwrap(),
            "Console exited before displaying {text}"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn capture(session: &Session, name: &str) {
    let Some(directory) = std::env::var_os("FLUKE_CONSOLE_CAPTURE_DIR") else {
        return;
    };
    let directory = std::path::PathBuf::from(directory);
    std::fs::create_dir_all(&directory).unwrap();
    let parser = session.parser.lock().unwrap();
    let screen = parser.screen();
    let (rows, cols) = screen.size();
    let mut cells = Vec::new();
    for row in 0..rows {
        for col in 0..cols {
            let cell = screen.cell(row, col).unwrap();
            if cell.is_wide_continuation() {
                continue;
            }
            let color = |value: vt100::Color| match value {
                vt100::Color::Default => serde_json::Value::Null,
                vt100::Color::Rgb(r, g, b) => serde_json::json!([r, g, b]),
                vt100::Color::Idx(index) => serde_json::json!(index),
            };
            cells.push(serde_json::json!({"x":col,"y":row,"text":cell.contents(),"fg":color(cell.fgcolor()),"bg":color(cell.bgcolor()),"bold":cell.bold(),"inverse":cell.inverse()}));
        }
    }
    std::fs::write(
        directory.join(format!("{name}.json")),
        serde_json::to_vec(&serde_json::json!({"rows":rows,"cols":cols,"cells":cells})).unwrap(),
    )
    .unwrap();
}

#[test]
fn native_console_saves_config_launches_terminal_and_exits_cleanly() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo with spaces");
    std::fs::create_dir(&repo).unwrap();
    let output = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["init", "--initial-branch=main"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let state = root.path().join("state");
    let args = vec![
        "--repo".into(),
        repo.to_string_lossy().into_owned(),
        "--state-dir".into(),
        state.to_string_lossy().into_owned(),
    ];
    let mut console = Session::spawn(
        "Console E2E".into(),
        None,
        root.path(),
        env!("CARGO_BIN_EXE_fluke-console"),
        &args,
    )
    .unwrap();
    console.resize(40, 140).unwrap();
    wait_for(&mut console, "CONFIGURACIÓN / ORQUESTADOR");
    capture(&console, "01-configuracion");
    console
        .input(b"\x1b[C\x1b[C\tpowershell.exe\t\t\x7f\x7f")
        .unwrap();
    let arguments = serde_json::to_string(&vec![
        "-NoLogo",
        "-NoProfile",
        "-Command",
        "Write-Output 'FLUKE_CONSOLE_READY'; Start-Sleep -Seconds 30",
    ])
    .unwrap();
    console.input(arguments.as_bytes()).unwrap();
    console.input(b"\x13").unwrap(); // Ctrl+S
    wait_for(&mut console, "Configuración guardada");
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(state.join("state.json")).unwrap()).unwrap();
    assert_eq!(saved["orchestrator"]["provider"], "custom");
    assert_eq!(saved["orchestrator"]["executable"], "powershell.exe");
    console.input(b":fluke\r").unwrap();
    wait_for(&mut console, "FLUKE_CONSOLE_READY");
    capture(&console, "02-sesion-real");
    console.input(b"\x1b[15~").unwrap(); // F5
    wait_for(&mut console, "CONFIGURACIÓN / ORQUESTADOR");
    console.input(b"\x1b").unwrap(); // Esc, leave settings
    thread::sleep(Duration::from_millis(100));
    console.input(b"\x11").unwrap(); // Ctrl+Q, request exit
    wait_for(&mut console, "Ctrl+Q confirma");
    console.input(b"\x11").unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !console.exited && Instant::now() < deadline {
        console.check_exit().unwrap();
        thread::sleep(Duration::from_millis(20));
    }
    assert!(
        console.exited,
        "Console didn't terminate its session and exit"
    );
}
