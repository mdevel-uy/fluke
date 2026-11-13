mod app;
mod config;
mod model;
mod session;
mod ui;

use std::{env, io, path::PathBuf, time::Duration};

use crossterm::{
    event::{self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyEventKind},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{Terminal, backend::CrosstermBackend};

fn main() -> io::Result<()> {
    let mut repo = env::current_dir()?;
    let directory_default = env::var_os(if cfg!(windows) {
        "LOCALAPPDATA"
    } else {
        "XDG_STATE_HOME"
    })
    .map(PathBuf::from)
    .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state")))
    .map(|base| base.join("fluke-console"));
    let mut directory = directory_default;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--repo" => {
                repo = PathBuf::from(
                    args.next()
                        .ok_or_else(|| io::Error::other("Falta --repo ruta"))?,
                )
            }
            "--state-dir" => {
                directory = Some(PathBuf::from(
                    args.next()
                        .ok_or_else(|| io::Error::other("Falta --state-dir ruta"))?,
                ))
            }
            "--help" | "-h" => {
                println!(
                    "fluke-console [--repo ruta] [--state-dir ruta]\nF1–F4: vistas · :help: comandos · Ctrl+Q: salir"
                );
                return Ok(());
            }
            _ => return Err(io::Error::other(format!("Argumento desconocido: {arg}"))),
        }
    }
    let directory = directory.ok_or_else(|| {
        io::Error::other("Usá --state-dir ruta: no hay directorio de estado disponible")
    })?;
    std::fs::create_dir_all(&directory)?;
    let mut app = app::App::new(repo, dunce::canonicalize(directory)?)?;
    enable_raw_mode()?;
    let _restore = RestoreTerminal;
    execute!(io::stdout(), EnterAlternateScreen, EnableBracketedPaste)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    let mut dirty = true;
    loop {
        if dirty {
            terminal.draw(|frame| ui::draw(frame, &mut app))?;
        }
        dirty = app.tick()?;
        if event::poll(Duration::from_millis(100))? {
            match event::read()? {
                Event::Key(key) if key.kind != KeyEventKind::Release => {
                    if app.key(key)? {
                        break;
                    }
                    dirty = true;
                }
                Event::Resize(_, _) => dirty = true,
                Event::Paste(text) => {
                    app.paste(&text)?;
                    dirty = true;
                }
                _ => {}
            }
        }
    }
    Ok(())
}

struct RestoreTerminal;

impl Drop for RestoreTerminal {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(
            io::stdout(),
            DisableBracketedPaste,
            LeaveAlternateScreen,
            crossterm::cursor::Show
        );
    }
}
