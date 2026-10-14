package main

import (
	"fmt"
	"path/filepath"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/colorprofile"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/xpty"
	"github.com/hinshun/vt10x"
)

// The demo shares production views, but never runs the model's command dispatcher.
type demoModel struct{ app *model }

func newDemo() (*demoModel, error) {
	s := State{Version: 1, MaxWorkers: 8, Theme: "gentle", Language: uiLanguage(), Orchestrator: &AgentConfig{Provider: "codex", Executable: "codex", Model: "DEMO"}, Goals: map[string]ProjectGoal{}, Conversations: map[string][]ConversationMessage{}}
	names := []string{"01-Mercado", "02-Turnos", "03-Pulso"}
	goals := []string{"Vender productos y exportar pedidos sin fricción.", "Reservar turnos sin superposiciones y enviar recordatorios.", "Entender el uso del producto con métricas y alertas."}
	chats := []string{
		"La exportación está lista para tu revisión. El worker validó pedidos vacíos y caracteres especiales.\n\nDestrabé el checkout: acordamos usar el mismo cálculo de impuestos que el catálogo. Ahora está verificando el flujo de pago. La vista móvil ya fue aceptada.",
		"La agenda ya evita reservas superpuestas. Para cerrar recordatorios necesito una decisión: ¿email o WhatsApp en esta primera versión? La dejé en F4.\n\nMientras tanto, el otro worker sigue con las pruebas de zonas horarias. Ninguno necesita esperar por el otro.",
		"El panel ya está aceptado. Estoy coordinando dos frentes: optimizar la consulta de eventos y probar las alertas.\n\nLa primera entrega de alertas necesitó una corrección para no duplicar avisos; el worker incorporó el caso a sus pruebas. Podés ver tiempo y retrabajo en Balance.",
	}
	titles := [][]string{{"Checkout e impuestos", "Exportar pedidos CSV", "Catálogo móvil"}, {"Agenda sin superposiciones", "Recordatorios por canal"}, {"Consulta de eventos", "Alertas sin duplicados", "Panel de métricas"}}
	reports := [][]string{{"Verificando el total con descuentos e impuestos.", "CSV listo. Casos con pedidos, sin pedidos y Unicode verificados.", "Vista móvil aceptada; navegación por teclado revisada."}, {"Probando cambio de día y zonas horarias.", "Necesito elegir el canal para terminar el recordatorio."}, {"Comparando la consulta paginada con el conjunto de ejemplo.", "Corregí el aviso duplicado; verificando reintentos.", "Panel aceptado con filtros por período y proyecto."}}
	for p, name := range names {
		repo, err := filepath.Abs(filepath.Join(string(filepath.Separator), "DEMO", name))
		if err != nil {
			return nil, err
		}
		s.Projects = append(s.Projects, repo)
		s.Goals[repo] = ProjectGoal{ID: fmt.Sprintf("g%032d", p+1), Objective: goals[p], Acceptance: "Flujo completo, errores claros y evidencia de los casos acordados."}
		s.Conversations[repo] = []ConversationMessage{{Role: "human", Text: goals[p]}, {Role: "fluke", Text: chats[p]}}
		for n, title := range titles[p] {
			id := fmt.Sprintf("t%032d", len(s.Tasks)+1)
			provider := []string{"codex", "claude"}[(p+n)%2]
			task := Task{ID: id, Repo: repo, GoalID: s.Goals[repo].ID, Title: title, Acceptance: "Completar el flujo sin regresiones y documentar las pruebas.", Status: "running", AgentState: "working", AgentProvider: provider, AgentRun: "demo-" + id, AgentSeq: 1, AgentMessage: reports[p][n], Branch: "codex/fluke/" + id, AgentEvidence: []string{"DEMO: resultados ilustrativos; no son pruebas ejecutadas."}, WorkerConfig: &AgentConfig{Provider: provider, Model: "DEMO"}}
			cost := 0.12 + float64(p+n)*0.08
			task.Metrics = TaskMetrics{Runs: 1, ObservedMS: int64(8+p*3+n*7) * 60000, Usage: []RunUsage{{RunID: task.AgentRun, WorkerUsage: WorkerUsage{InputTokens: int64(9000 + n*4200), OutputTokens: int64(1800 + p*700), CostUSD: &cost, Source: "demo.json"}}}}
			if p == 0 && n == 1 {
				task.Status = "awaiting_review"
				task.Metrics.Deliveries = 1
			}
			if n == 2 {
				task.Status = "accepted"
				task.Metrics.Deliveries = 1
			}
			if p == 1 && n == 1 {
				task.AgentState = "needs_response"
				s.Decisions = append(s.Decisions, Decision{Number: 1, Repo: repo, TaskID: id, Question: "¿Email o WhatsApp para los recordatorios de la primera versión? Email evita depender de una cuenta externa para probar el flujo."})
			}
			if p == 2 && n == 1 {
				task.Metrics.Runs, task.Metrics.Deliveries, task.Metrics.Reworks = 2, 1, 1
			}
			s.Tasks = append(s.Tasks, task)
		}
	}
	d := &demoModel{app: newModel(nil, s, "")}
	d.app.provider = providerHealth{Provider: "codex", Available: true, Message: localText("DEMO · Simulated CLI, no real authentication.", "DEMO · CLI simulada, sin autenticación real.")}
	d.app.auth = githubAuth{Available: true}
	for _, task := range s.Tasks {
		// Allocate a terminal buffer without starting a process or executable.
		pty, err := xpty.NewPty(80, 20)
		if err != nil {
			d.close()
			return nil, err
		}
		w := &terminalWindow{ID: task.ID, Name: filepath.Base(task.Repo) + " / " + task.AgentProvider + " / " + task.Title, pty: pty, screen: vt10x.New(vt10x.WithSize(80, 20))}
		d.app.terminals.Windows = append(d.app.terminals.Windows, w)
		if task.Status == "running" {
			d.app.sessions[task.ID] = w.ID
		}
	}
	d.paintWorkers()
	return d, nil
}

func (d *demoModel) close() {
	for _, w := range d.app.terminals.Windows {
		_ = w.pty.Close()
	}
}

func (d *demoModel) paintWorkers() {
	for i, w := range d.app.terminals.Windows {
		t := d.app.state.Tasks[i]
		cols, _ := w.screen.Size()
		text := "DEMO / SESIÓN SIMULADA\n\n" + t.Title + "\n" + status(taskAgentStatus(t)) + "\n\n" + t.AgentMessage + "\n\nFluke: " + []string{"Criterio acordado; seguí con la verificación.", "Conservá la evidencia para la revisión humana.", "Contexto compartido con los otros workers."}[i%3]
		_, _ = w.screen.Write([]byte("\x1b[2J\x1b[H\x1b[?25l" + strings.ReplaceAll(wrap(text, max(1, cols-1)), "\n", "\r\n")))
	}
}

func (d *demoModel) Init() tea.Cmd { return nil }

func (d *demoModel) navigate(key string) {
	m := d.app
	if key == "f5" {
		m.closePanels()
		m.openConfig()
		m.config, m.configSection, m.themeSelected = true, 2, themeIndex(m.state.Theme)
		return
	}
	if key == "f1" || key == "f2" || key == "f3" || key == "f4" {
		m.globalKey(key)
		for i, w := range m.terminals.Windows {
			w.hidden = m.state.Tasks[i].Repo != m.repo
		}
		m.terminals.layout()
		d.paintWorkers()
	}
}

func (d *demoModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	m := d.app
	if handled, _ := m.switcherInput(msg); handled {
		if m.switcher == nil && m.view == 2 {
			for i, w := range m.terminals.Windows {
				w.hidden = m.state.Tasks[i].Repo != m.repo
			}
			m.terminals.layout()
			d.paintWorkers()
		}
		return d, nil
	}
	switch v := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = v.Width, v.Height
		m.terminals.Update(tea.WindowSizeMsg{Width: v.Width, Height: m.workspaceHeight()})
		d.paintWorkers()
	case tea.KeyPressMsg:
		key := v.String()
		if key == "ctrl+c" || key == "ctrl+q" {
			return d, tea.Quit
		}
		if strings.HasPrefix(key, "f") && len(key) == 2 {
			d.navigate(key)
			return d, nil
		}
		if key == "esc" {
			m.config = false
			return d, nil
		}
		if m.config {
			switch key {
			case "ctrl+right":
				m.cycleConfigSection(1)
			case "ctrl+left":
				m.cycleConfigSection(-1)
			case "ctrl+t":
				m.selectConfigSection(2)
			case "ctrl+o":
				m.selectConfigSection(0)
			case "ctrl+g":
				m.selectConfigSection(1)
			}
			if m.configSection != 2 {
				if m.configSection == 0 {
					switch key {
					case "tab", "down":
						m.field = (m.field + 1) % 5
					case "shift+tab", "up":
						m.field = (m.field + 4) % 5
					}
				}
				return d, nil
			}
			switch key {
			case "down", "tab":
				m.themeSelected = (m.themeSelected + 1) % len(consoleThemes)
			case "up", "shift+tab":
				m.themeSelected = (m.themeSelected + len(consoleThemes) - 1) % len(consoleThemes)
			case "enter":
				m.state.Theme = consoleThemes[m.themeSelected].ID
				applyTheme(m.state.Theme)
				m.config = false
			}
			return d, nil
		}
		if m.home {
			switch key {
			case "up", "down", "tab", "shift+tab", "enter", "c", "i":
				m.homeKey(v)
			}
			return d, nil
		}
		if m.view == 2 {
			switch key {
			case "tab":
				m.terminals.cycleFocus(1)
			case "shift+tab":
				m.terminals.cycleFocus(-1)
			case "z":
				m.terminals.ToggleZoom()
			case "t":
				m.terminals.ToggleTiling()
			case "p":
				m.terminals.TogglePin()
			}
			d.paintWorkers()
		} else {
			switch key {
			case "down":
				m.selected++
			case "up":
				m.selected = max(0, m.selected-1)
			case "tab":
				if m.view == 1 {
					m.pane = (m.pane + 1) % 3
				}
			case "shift+tab":
				if m.view == 1 {
					m.pane = (m.pane + 2) % 3
				}
			case "i":
				m.insights, m.pane = !m.insights, 0
			case "pgup":
				if m.pane == 1 {
					m.scrollChat(5)
				} else {
					m.taskScroll = max(0, m.taskScroll-5)
				}
			case "pgdown":
				if m.pane == 1 {
					m.scrollChat(-5)
				} else {
					m.taskScroll += 5
				}
			}
		}
	case tea.MouseClickMsg:
		x, y := m.navOrigin()
		origin := x
		if v.Y == y && v.Button == tea.MouseLeft {
			for i, label := range m.tabLabels() {
				width := ansi.StringWidth(label) + 2
				if v.X >= x && v.X < x+width {
					d.navigate(fmt.Sprintf("f%d", i+1))
					return d, nil
				}
				x += width + 1
			}
			bar := ansi.Strip(m.tabs())
			for _, shortcut := range []struct{ label, key string }{{"[Ctrl+P]", "ctrl+p"}, {"[Alt+K]", "alt+k"}} {
				if index := strings.Index(bar, shortcut.label); index >= 0 {
					start := origin + ansi.StringWidth(bar[:index])
					if v.X >= start && v.X < start+len(shortcut.label) {
						m.globalKey(shortcut.key)
						return d, nil
					}
				}
			}
		}
		if m.config {
			if handled, _ := m.configTabClick(v.Mouse()); !handled {
				m.clickPanel(v.Mouse())
			}
			return d, nil
		}
		if m.home && v.Y-m.headerRows() < 6 {
			return d, nil
		}
		m.clickWorkspace(v.Mouse())
		if m.view == 2 && v.Y >= m.headerRows() && v.Y < m.height-m.footerRows() {
			v.Y -= m.headerRows()
			m.terminals.Update(v)
			d.paintWorkers()
		}
	case tea.MouseMotionMsg:
		if m.view == 2 && !m.config {
			v.Y -= m.headerRows()
			m.terminals.Update(v)
			d.paintWorkers()
		}
	case tea.MouseReleaseMsg:
		if m.view == 2 && !m.config {
			v.Y -= m.headerRows()
			m.terminals.Update(v)
			d.paintWorkers()
		}
	}
	return d, nil
}

func (d *demoModel) View() tea.View {
	m := d.app
	v := m.View()
	lines := strings.Split(v.Content, "\n")
	help := "[Alt+K] Vistas/ajustes [Ctrl+P] Buscar · [F1] Proyectos [F2] Chat/plan [F3] Workers [F4] Decisiones [F5] Temas [Ctrl+Q] Salir"
	if m.view == 2 {
		help = "[Tab] Worker [z] Zoom [t] Mosaico [p] Fijar · Mouse: mover/redimensionar · F1 volver"
	}
	if m.width < 92 {
		help = "Alt+K Ajustes · F1–F5 Vistas · Ctrl+Q Salir"
	}
	if m.config {
		help = "[Ctrl+←/→] Sección · [Esc] Volver · Conexiones y ajustes simulados"
		if m.configSection == 2 {
			help = "[↑/↓] Tema [Enter] Elegir [Ctrl+←/→] Sección [Esc] Volver"
		}
	}
	if m.switcher != nil {
		help = "[↑/↓] Elegir [Enter/clic] Abrir [Esc] Volver"
	}
	demoLines := accent("DEMO · 3 proyectos / 8 agentes · Solo navegación · Datos y consumos ficticios", muted) + "\n" + accent(help, cyan)
	if !m.shellMode() {
		demoLines = rule(m.width, borderInk) + "\n" + demoLines
	}
	footer := fit(demoLines, m.width, m.footerRows())
	v.Content = themeCanvas(textStyle.Render(strings.Join(lines[:max(0, len(lines)-m.footerRows())], "\n") + "\n" + footer))
	return v
}

func runDemo(language string, monochrome bool) error {
	if language == "" {
		language = "es"
	}
	if err := setUILanguage(language); err != nil {
		return err
	}
	d, err := newDemo()
	if err != nil {
		return err
	}
	defer d.close()
	profile := colorprofile.TrueColor
	if monochrome {
		profile = colorprofile.NoTTY
	}
	_, err = tea.NewProgram(d, tea.WithFPS(30), tea.WithColorProfile(profile)).Run()
	return err
}
