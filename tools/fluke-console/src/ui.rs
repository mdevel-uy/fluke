use ratatui::{
    Frame,
    buffer::Buffer,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Widget, Wrap},
};

use crate::{app::App, model::Status, session::Session};

const BG: Color = Color::Rgb(12, 9, 22);
const FG: Color = Color::Rgb(223, 224, 239);
const CYAN: Color = Color::Rgb(72, 224, 230);
const PINK: Color = Color::Rgb(245, 99, 203);
const LIME: Color = Color::Rgb(183, 234, 100);
const AMBER: Color = Color::Rgb(247, 193, 97);
const MUTED: Color = Color::Rgb(139, 139, 162);

pub fn draw(frame: &mut Frame, app: &mut App) {
    let area = frame.area();
    frame.render_widget(Block::default().style(Style::default().bg(BG).fg(FG)), area);
    if area.width < 40 || area.height < 12 {
        frame.render_widget(
            Paragraph::new("FLUKE\nAmpliá la terminal a 40 × 12 o más.\nCtrl+Q salir")
                .style(Style::default().fg(CYAN)),
            area,
        );
        return;
    }
    let parts = Layout::vertical([
        Constraint::Length(2),
        Constraint::Length(2),
        Constraint::Min(4),
        Constraint::Length(3),
        Constraint::Length(1),
    ])
    .split(area);
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                " ▒ FLUKE ",
                Style::default().fg(PINK).add_modifier(Modifier::BOLD),
            ),
            Span::styled("/ CONTROL LOCAL", Style::default().fg(CYAN)),
            Span::styled(
                format!("   {} / {} workers", app.workers(), app.state.max_workers),
                Style::default().fg(LIME),
            ),
        ])),
        parts[0],
    );
    let mut tabs = ["Fluke", "Proyecto", "Sesiones", "Decisiones"]
        .into_iter()
        .enumerate()
        .map(|(i, title)| {
            Span::styled(
                format!(" F{} {}  ", i + 1, title),
                Style::default().fg(if i == app.view { PINK } else { MUTED }),
            )
        })
        .collect::<Vec<_>>();
    tabs.push(Span::styled(" F5 Config ", Style::default().fg(CYAN)));
    frame.render_widget(Paragraph::new(Line::from(tabs)), parts[1]);
    match app.view {
        0 => global(frame, parts[2], app),
        1 => project(frame, parts[2], app),
        2 => sessions(frame, parts[2], app),
        _ => decisions(frame, parts[2], app),
    }
    let title = if app.direct {
        " TERMINAL ACTIVA · Ctrl+X volver "
    } else {
        " COMANDO · :help "
    };
    let border = panel(title, PINK);
    let inner = border.inner(parts[3]);
    frame.render_widget(border, parts[3]);
    if !app.direct && app.settings.is_none() {
        let width = inner.width.saturating_sub(3) as usize;
        let tail = app
            .input
            .chars()
            .rev()
            .take(width)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<String>();
        frame.render_widget(Paragraph::new(format!("> {tail}")), inner);
        frame.set_cursor_position((inner.x + 2 + tail.chars().count() as u16, inner.y));
    }
    frame.render_widget(
        Paragraph::new(app.notice.as_str()).style(Style::default().fg(AMBER)),
        parts[4],
    );
    if app.settings.is_some() {
        settings(frame, app);
    }
}

fn panel(title: &str, color: Color) -> Block<'_> {
    Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(color))
}

fn global(frame: &mut Frame, area: Rect, app: &mut App) {
    if area.width < 95 {
        orchestrator(frame, area, app);
        return;
    }
    let columns = Layout::horizontal([
        Constraint::Length(25),
        Constraint::Min(30),
        Constraint::Length(29),
    ])
    .split(area);
    let project = app.repo.file_name().unwrap_or_default().to_string_lossy();
    let mut lines = vec![
        Line::styled(project.into_owned(), Style::default().fg(LIME)),
        Line::raw(""),
        Line::styled("REPOS REGISTRADOS", Style::default().fg(MUTED)),
    ];
    for repo in &app.state.projects {
        lines.push(Line::raw(format!(
            "{} {}",
            if repo == &app.repo { ">" } else { " " },
            repo.file_name().unwrap_or_default().to_string_lossy()
        )));
    }
    lines.extend([
        Line::raw(""),
        Line::styled("CAMBIAR PROYECTO", Style::default().fg(CYAN)),
        Line::raw(":repo ruta"),
        Line::raw(""),
        Line::raw("1 repo = 1 proyecto"),
        Line::raw("1 worker = 1 tarea"),
    ]);
    frame.render_widget(
        Paragraph::new(lines)
            .block(panel(" PROYECTO ", CYAN))
            .wrap(Wrap { trim: false }),
        columns[0],
    );
    orchestrator(frame, columns[1], app);
    let right = Layout::vertical([Constraint::Percentage(60), Constraint::Percentage(40)])
        .split(columns[2]);
    let sessions = app.sessions.iter().map(|s| {
        ListItem::new(format!("{} {}", if s.exited { "○" } else { "●" }, s.label))
            .style(Style::default().fg(if s.exited { MUTED } else { LIME }))
    });
    frame.render_widget(
        List::new(sessions).block(panel(" SESIONES · F3 ", CYAN)),
        right[0],
    );
    let pending = app
        .state
        .decisions
        .iter()
        .filter(|d| d.answer.is_none())
        .map(|d| ListItem::new(d.question.as_str()));
    frame.render_widget(
        List::new(pending).block(panel(" ATENCIÓN · F4 ", AMBER)),
        right[1],
    );
}

fn orchestrator(frame: &mut Frame, area: Rect, app: &mut App) {
    if let Some(session) = app
        .sessions
        .iter_mut()
        .rev()
        .find(|s| s.task_id.is_none() && s.cwd == app.repo)
    {
        terminal(frame, area, session, false);
    } else {
        let lines = vec![
            Line::styled(
                "Un proyecto. Una conversación. Trabajo visible.",
                Style::default().fg(PINK),
            ),
            Line::raw(""),
            Line::raw("Esta primera versión conecta terminales locales."),
            Line::raw("La coordinación automática todavía no está implementada."),
            Line::raw(""),
            Line::styled("EMPEZAR", Style::default().fg(CYAN)),
            Line::raw("F5 · elegir CLI y modelo"),
            Line::raw(":fluke · iniciar con la configuración guardada"),
            Line::raw(""),
            Line::raw("Dentro de esa terminal podés iniciar tu CLI de agente."),
            Line::raw("F3 → seleccionar sesión → Enter para conversar."),
            Line::raw("Ctrl+X para volver a la consola."),
        ];
        frame.render_widget(
            Paragraph::new(lines)
                .block(panel(" FLUKE / ORQUESTADOR ", PINK))
                .wrap(Wrap { trim: false }),
            area,
        );
    }
}

fn settings(frame: &mut Frame, app: &App) {
    let draft = app.settings.as_ref().unwrap();
    let screen = frame.area();
    let width = screen.width.saturating_sub(2).min(90);
    let height = screen.height.saturating_sub(2).min(23);
    let area = Rect::new(
        (screen.width - width) / 2,
        (screen.height - height) / 2,
        width,
        height,
    );
    frame.render_widget(Clear, area);
    let block = panel(" CONFIGURACIÓN / ORQUESTADOR ", PINK).style(Style::default().bg(BG).fg(FG));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let rows = Layout::vertical([
        Constraint::Length(2),
        Constraint::Min(3),
        Constraint::Length(3),
        Constraint::Length(2),
    ])
    .split(inner);
    frame.render_widget(Paragraph::new("Configuración global · se aplica a nuevas sesiones\nAutenticación: se usa la de tu CLI instalada.").style(Style::default().fg(MUTED)), rows[0]);
    let values = [
        ("CLI · ← → cambiar", draft.provider.label()),
        ("Ejecutable", draft.fields[0].as_str()),
        (
            "Modelo · vacío = predeterminado de la CLI",
            draft.fields[1].as_str(),
        ),
        ("Argumentos · lista JSON", draft.fields[2].as_str()),
        ("Máximo de workers simultáneos", draft.fields[3].as_str()),
    ];
    let items = values.iter().enumerate().map(|(index, (title, value))| {
        ListItem::new(vec![
            Line::styled(
                format!(
                    "{} {title}",
                    if index == draft.selected { ">" } else { " " }
                ),
                Style::default().fg(if index == draft.selected { PINK } else { CYAN }),
            ),
            Line::raw(format!(
                "  {}",
                if value.is_empty() {
                    "(sin especificar)"
                } else {
                    value
                }
            )),
        ])
    });
    let mut selection = ListState::default().with_selected(Some(draft.selected));
    frame.render_stateful_widget(List::new(items), rows[1], &mut selection);
    let hint = if draft.error.is_empty() {
        "Cambiar el modelo no reinicia sesiones activas.\nLa disponibilidad del modelo la valida tu proveedor."
    } else {
        draft.error.as_str()
    };
    frame.render_widget(
        Paragraph::new(hint)
            .style(Style::default().fg(AMBER))
            .wrap(Wrap { trim: false }),
        rows[2],
    );
    frame.render_widget(
        Paragraph::new(
            "Tab / ↑↓ campo · escribir / Backspace editar\nCtrl+S guardar · Esc cancelar",
        )
        .style(Style::default().fg(CYAN)),
        rows[3],
    );
}

fn project(frame: &mut Frame, area: Rect, app: &mut App) {
    if area.width < 100 || area.height < 18 {
        project_context(frame, area, app);
        return;
    }
    let columns =
        Layout::horizontal([Constraint::Percentage(74), Constraint::Percentage(26)]).split(area);
    let main = Layout::vertical([Constraint::Percentage(52), Constraint::Percentage(48)])
        .split(columns[0]);
    project_context(frame, main[0], app);
    let terminals =
        Layout::horizontal([Constraint::Percentage(50), Constraint::Percentage(50)]).split(main[1]);
    let task_ids = app
        .state
        .tasks
        .iter()
        .filter(|t| t.repo == app.repo)
        .map(|t| t.id.as_str())
        .collect::<Vec<_>>();
    let mut workers = app.sessions.iter_mut().filter(|s| {
        s.task_id
            .as_deref()
            .is_some_and(|id| task_ids.contains(&id))
            && !s.exited
    });
    for pane in terminals.iter() {
        if let Some(session) = workers.next() {
            terminal(frame, *pane, session, false);
        } else {
            frame.render_widget(
                Paragraph::new(
                    "Sin worker activo\n\n:start ID ejecutable\nF3 para entrar a una sesión",
                )
                .block(panel(" WORKER ", CYAN)),
                *pane,
            );
        }
    }
    orchestrator(frame, columns[1], app);
}

fn project_context(frame: &mut Frame, area: Rect, app: &mut App) {
    let columns =
        Layout::horizontal([Constraint::Percentage(45), Constraint::Percentage(55)]).split(area);
    let items = app
        .state
        .tasks
        .iter()
        .filter(|t| t.repo == app.repo)
        .enumerate()
        .map(|(index, task)| {
            let color = match task.status {
                Status::Running => LIME,
                Status::Interrupted => AMBER,
                Status::AwaitingReview => PINK,
                Status::Pending => MUTED,
            };
            ListItem::new(vec![
                Line::styled(
                    format!(
                        "{} {}",
                        if index == app.selected { ">" } else { " " },
                        task.title
                    ),
                    Style::default().fg(color),
                ),
                Line::raw(format!("  {} · {}", task.status.label(), task.id)),
                Line::raw(""),
            ])
        });
    frame.render_widget(
        List::new(items).block(panel(" TAREAS · ↑↓ ", CYAN)),
        columns[0],
    );
    if let Some(task) = app
        .state
        .tasks
        .iter()
        .filter(|t| t.repo == app.repo)
        .nth(app.selected)
    {
        let text = format!(
            "{}\n\nACEPTACIÓN\n{}\n\nRama: {}\n{}\n\n:start {} powershell.exe",
            task.title, task.acceptance, task.branch, task.note, task.id
        );
        frame.render_widget(
            Paragraph::new(text)
                .block(panel(" PLAN / CONTEXTO ", CYAN))
                .wrap(Wrap { trim: false }),
            columns[1],
        );
    } else {
        frame.render_widget(Paragraph::new("Registrá una tarea:\n\n:task título | criterio de aceptación\n\nEl brief se guarda en .fluke/specs/ dentro del repo.\nLos worktrees parten de HEAD, sin copiar cambios sin commit.").block(panel(" PLAN / CONTEXTO ", CYAN)).wrap(Wrap { trim: false }), columns[1]);
    }
}

fn sessions(frame: &mut Frame, area: Rect, app: &mut App) {
    let columns = if area.width >= 80 {
        Layout::horizontal([Constraint::Length(26), Constraint::Min(30)]).split(area)
    } else {
        Layout::horizontal([Constraint::Length(0), Constraint::Min(30)]).split(area)
    };
    let items = app.sessions.iter().enumerate().map(|(index, session)| {
        ListItem::new(format!(
            "{} {} {}",
            if index == app.selected { ">" } else { " " },
            if session.exited { "○" } else { "●" },
            session.label
        ))
        .style(Style::default().fg(if index == app.selected { PINK } else { FG }))
    });
    frame.render_widget(
        List::new(items).block(panel(" SESIONES · ↑↓ ", CYAN)),
        columns[0],
    );
    if let Some(session) = app.sessions.get_mut(app.selected) {
        terminal(frame, columns[1], session, app.direct);
    } else {
        frame.render_widget(Paragraph::new("Sin sesiones.\n\n:fluke ejecutable\n:start ID ejecutable\n\nEnter entra en la sesión seleccionada.\nCtrl+X vuelve a Fluke.").block(panel(" TERMINAL ", CYAN)), columns[1]);
    }
}

fn decisions(frame: &mut Frame, area: Rect, app: &mut App) {
    let sections =
        Layout::vertical([Constraint::Percentage(55), Constraint::Percentage(45)]).split(area);
    let items = app.state.decisions.iter().enumerate().map(|(i, d)| {
        ListItem::new(vec![
            Line::styled(
                format!(
                    "{} {}. {}",
                    if i == app.selected { ">" } else { " " },
                    i + 1,
                    d.question
                ),
                Style::default().fg(if d.answer.is_some() { LIME } else { AMBER }),
            ),
            Line::raw(format!(
                "   {}",
                d.answer
                    .as_deref()
                    .unwrap_or("Pendiente · :answer N respuesta")
            )),
            Line::styled(
                format!("   {}", d.repo.display()),
                Style::default().fg(MUTED),
            ),
        ])
    });
    if app.state.decisions.is_empty() {
        frame.render_widget(Paragraph::new("No hay decisiones registradas.\n\n:decision pregunta\n:answer N respuesta\n\nLa respuesta queda guardada; el envío automático a workers está pendiente.").block(panel(" DECISIONES ", AMBER)).wrap(Wrap { trim: false }), sections[0]);
    } else {
        frame.render_widget(
            List::new(items).block(panel(" DECISIONES · REGISTRO LOCAL ", AMBER)),
            sections[0],
        );
    }
    orchestrator(frame, sections[1], app);
}

fn terminal(frame: &mut Frame, area: Rect, session: &mut Session, focused: bool) {
    let title = format!(
        "{} · PID {}",
        session.label,
        session
            .process_id()
            .map(|pid| pid.to_string())
            .unwrap_or_else(|| "?".into())
    );
    let border = panel(&title, if focused { PINK } else { CYAN });
    let inner = border.inner(area);
    frame.render_widget(border, area);
    if inner.width == 0 || inner.height == 0 {
        return;
    }
    if let Err(error) = session.resize(inner.height, inner.width) {
        frame.render_widget(
            Paragraph::new(format!("No se pudo redimensionar: {error}")),
            inner,
        );
        return;
    }
    if let Ok(parser) = session.parser.lock() {
        frame.render_widget(TerminalScreen(parser.screen()), inner);
        if focused && !parser.screen().hide_cursor() {
            let (row, col) = parser.screen().cursor_position();
            if row < inner.height && col < inner.width {
                frame.set_cursor_position((inner.x + col, inner.y + row));
            }
        }
    }
}

struct TerminalScreen<'a>(&'a vt100::Screen);
impl Widget for TerminalScreen<'_> {
    fn render(self, area: Rect, buffer: &mut Buffer) {
        for row in 0..area.height {
            for col in 0..area.width {
                let Some(cell) = self.0.cell(row, col) else {
                    continue;
                };
                if cell.is_wide_continuation() {
                    continue;
                }
                let mut style = Style::default()
                    .fg(terminal_color(cell.fgcolor(), FG))
                    .bg(terminal_color(cell.bgcolor(), BG));
                for (enabled, modifier) in [
                    (cell.bold(), Modifier::BOLD),
                    (cell.italic(), Modifier::ITALIC),
                    (cell.underline(), Modifier::UNDERLINED),
                    (cell.inverse(), Modifier::REVERSED),
                ] {
                    if enabled {
                        style = style.add_modifier(modifier);
                    }
                }
                let text = cell.contents();
                buffer[(area.x + col, area.y + row)]
                    .set_symbol(if text.is_empty() { " " } else { &text })
                    .set_style(style);
            }
        }
    }
}

fn terminal_color(color: vt100::Color, default: Color) -> Color {
    match color {
        vt100::Color::Default => default,
        vt100::Color::Idx(index) => Color::Indexed(index),
        vt100::Color::Rgb(r, g, b) => Color::Rgb(r, g, b),
    }
}
