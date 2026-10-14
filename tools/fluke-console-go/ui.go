package main

import (
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"fmt"
	"github.com/charmbracelet/x/ansi"
	"image/color"
	"path/filepath"
	"strings"
)

// Historic color names now represent the selected theme's semantic roles.
var cyan = lipgloss.Color("#a5b9dd")
var pink = lipgloss.Color("#b6a1ed")
var lime = lipgloss.Color("#a5c4a0")
var amber = lipgloss.Color("#dfbe86")
var muted = lipgloss.Color("#9493a7")
var ground = lipgloss.Color("#15151e")
var foreground = lipgloss.Color("#e2e0ec")
var borderInk color.Color = lipgloss.Color("#34343f")
var textStyle = lipgloss.NewStyle().Foreground(foreground).Background(ground)

func accent(text string, c color.Color) string {
	return lipgloss.NewStyle().Foreground(c).Background(ground).Render(text)
}
func status(s string) string {
	switch s {
	case "pending":
		return uiText("PENDIENTE")
	case "queued":
		return uiText("EN COLA")
	case "waiting_dependencies":
		return uiText("ESPERA BASE / DEPENDENCIAS")
	case "running":
		return uiText("EN CURSO")
	case "working":
		return uiText("TRABAJANDO")
	case "idle":
		return uiText("LISTO PARA ENTRADA")
	case "turn_finished":
		return uiText("TURNO TERMINADO")
	case "blocked":
		return uiText("BLOQUEADO / REQUIERE ACCIÓN")
	case "needs_response":
		return uiText("NECESITA RESPUESTA")
	case "interrupted":
		return uiText("INTERRUMPIDA")
	case "awaiting_review":
		return uiText("PARA REVISAR")
	case "accepted":
		return uiText("ACEPTADA")
	case "integrated":
		return uiText("INTEGRADA")
	case "paused":
		return uiText("PAUSADA")
	case "pausing":
		return uiText("PAUSA SOLICITADA")
	}
	return s
}
func statusInk(s string) color.Color {
	switch s {
	case "running", "working", "accepted", "integrated":
		return lime
	case "blocked", "needs_response":
		return pink
	case "idle", "turn_finished":
		return cyan
	case "pending", "queued", "interrupted", "paused", "pausing", "waiting_dependencies":
		return amber
	case "awaiting_review":
		return pink
	}
	return muted
}
func fit(text string, w, h int) string {
	w = max(1, w)
	h = max(1, h)
	lines := strings.Split(text, "\n")
	out := make([]string, h)
	for i := range out {
		if i < len(lines) {
			out[i] = ansi.Truncate(lines[i], w, "")
		}
		out[i] += strings.Repeat(" ", max(0, w-ansi.StringWidth(out[i])))
	}
	return strings.Join(out, "\n")
}
func wrap(text string, w int) string   { return ansi.Wrap(text, max(1, w), "") }
func rule(w int, c color.Color) string { return accent(strings.Repeat("─", max(1, w)), c) }
func frame(title, body string, w, h int, c color.Color, focused bool) string {
	return panelFrame(title, body, w, h, c, focused, false)
}

func section(title string, w int) string { return accent(title, cyan) + "\n" + rule(w, cyan) }
func (m *model) headerRows() int {
	if m.shellMode() {
		return 1
	}
	return 3
}
func (m *model) footerRows() int {
	if m.shellMode() {
		return 2
	}
	return 3
}
func (m *model) workspaceHeight() int { return max(1, m.height-m.headerRows()-m.footerRows()) }
func (m *model) header() string {
	if m.shellMode() {
		return m.shellHeader()
	}
	return m.brandHeader(m.tabs())
}

func (m *model) tabLabels() []string {
	variants := [][]string{
		{localText("[F1] Projects", "[F1] Proyectos"), uiText("[F2] Proyecto"), uiText("[F3] Sesiones"), uiText("[F4] Decisiones"), "F5 Config", "F6 GitHub", "F7 Review"},
		{localText("F1 Projects", "F1 Proyectos"), uiText("F2 Proyecto"), uiText("F3 Sesiones"), uiText("F4 Decisiones"), "F5 Config", "F6 GitHub", "F7 Review"},
		{localText("F1 All", "F1 Todos"), "F2 Repo", "F3 PTY", uiText("F4 Decidir"), "F5", "F6 GH", "F7 Diff"},
		{"F1", "F2", "F3", "F4", "F5", "F6", "F7"},
	}
	extra := 7
	if m.shellMode() {
		// The header has no room for bracketed labels; it keeps only the palette hint.
		variants, extra = [][]string{
			{localText("F1 Projects", "F1 Proyectos"), localText("F2 Project", "F2 Proyecto"), localText("F3 Sessions", "F3 Sesiones"), localText("F4 Decisions", "F4 Decisiones"), "F5 Config", "F6 GitHub", localText("F7 Review", "F7 Revisión")},
			{localText("F1 All", "F1 Todos"), localText("F2 Project", "F2 Proyecto"), localText("F3 Live", "F3 Sesión"), localText("F4 Decide", "F4 Decidir"), "F5 Config", "F6 GH", "F7 Diff"},
			{"F1", "F2", "F3", "F4", "F5", "F6", "F7"},
		}, 8
	}
	for _, labels := range variants {
		if ansi.StringWidth(strings.Join(labels, ""))+len(labels)*2+len(labels)-1+extra <= m.navBudget() {
			return labels
		}
	}
	return variants[len(variants)-1]
}

// Match the same panel precedence as View, regardless of the underlying view.
func (m *model) activeTab() int {
	if m.review.open {
		return 6
	}
	if m.config {
		return 4
	}
	if m.githubOpen {
		return 5
	}
	return m.view
}

func (m *model) tabs() string {
	parts := []string{}
	for i, label := range m.tabLabels() {
		if i == m.activeTab() {
			parts = append(parts, lipgloss.NewStyle().Foreground(ground).Background(pink).Bold(true).Render(" "+label+" "))
		} else {
			parts = append(parts, accent(" "+label+" ", muted))
		}
	}
	if m.shellMode() {
		return strings.Join(parts, " ") + accent(" [Alt+K]", cyan)
	}
	bar := strings.Join(parts, " ") + accent(" [Chat]", cyan)
	if ansi.StringWidth(bar)+9 <= m.navBudget() {
		bar += accent(" [Ctrl+P]", cyan)
	}
	if ansi.StringWidth(bar)+8 <= m.navBudget() {
		bar += accent(" [Alt+K]", cyan)
	}
	return bar
}

func (m *model) footer() string {
	w := max(1, m.width)
	message := m.notice
	if message == "" {
		message = uiText("Tu proyecto, tus decisiones, tus workers.")
	}
	first := accent(" "+message, muted)
	keys := accent(uiText(" [Tab] Panel   [Enter] Enviar   [PgUp/PgDn] Historial   [Ctrl+Y] Copiar   [Ctrl+K] Comandos   [Ctrl+Q] Salir"), cyan)
	if m.view == 3 {
		keys = accent(localText(" [↑/↓] Decision   [F2] Project chat   [Ctrl+Q] Quit", " [↑/↓] Decisión   [F2] Chat del proyecto   [Ctrl+Q] Salir"), cyan)
	}
	if m.view == 1 && (m.pane == 0 || m.pane == 2) {
		keys = accent(localText(" [↑/↓] Task   [Enter] Worker   [i] Balance   [a] Agent   [m] Message   [q] Queue   [v/F7] Review   [p] Pause/resume", " [↑/↓] Tarea   [Enter] Worker   [i] Balance   [a] Agente   [m] Mensaje   [q] Cola   [v/F7] Revisar   [p] Pausar/seguir"), cyan)
	}
	if m.view == 0 && m.pane == 2 {
		keys = accent(localText(" [↑/↓] Alert   [Enter] Open project / task / session   [Tab] Panel", " [↑/↓] Alerta   [Enter] Abrir proyecto / tarea / sesión   [Tab] Panel"), cyan)
	}
	if m.view == 2 {
		keys = accent(localText(" [Tab] Focus   [m] Message   [z] Maximize   [t] Tile   [Enter] Terminal   [PgUp/PgDn] History", " [Tab] Foco   [m] Mensaje   [z] Maximizar   [t] Mosaico   [Enter] Terminal   [PgUp/PgDn] Historial"), cyan)
		if m.terminals.Mode == windowMode {
			first = accent(localText("WINDOWS: drag title / edges · [p] pin", "VENTANAS: arrastrá título / bordes · [p] fijar"), cyan) + " │ " + message
		} else {
			first = accent(uiText("TERMINAL: entrada directa"), cyan) + " │ " + message
			keys = accent(localText(" [Ctrl+X] Windows [Ctrl+B] Select text [Ctrl+Y] Copy · mouse moves / resizes", " [Ctrl+X] Ventanas [Ctrl+B] Seleccionar [Ctrl+Y] Copiar · mouse mueve / redimensiona"), cyan)
		}
	}
	if m.home && m.view == 0 {
		keys = accent(localText(" [N] New project   [O] Open   [↑/↓] Choose   [Enter] Tasks   [C] Chat   [i] Balance   [Tab] Attention", " [N] Nuevo proyecto   [O] Abrir   [↑/↓] Elegir   [Enter] Tareas   [C] Chat   [i] Balance   [Tab] Atención"), cyan)
		if m.pane == 2 {
			keys = accent(localText(" [↑/↓] Alert   [Enter] Open   [Tab] Projects   [N] New   [O] Open repository", " [↑/↓] Alerta   [Enter] Abrir   [Tab] Proyectos   [N] Nuevo   [O] Abrir repositorio"), cyan)
		}
	}
	if w < 100 {
		if m.view == 0 && m.home {
			keys = accent(localText("[N/O] Projects [C] Chat [i] Balance [Tab]", "[N/O] Proyectos [C] Chat [i] Balance [Tab]"), cyan)
		}
		if m.view == 1 && (m.pane == 0 || m.pane == 2) {
			keys = accent(localText(" [i] Balance [a] Agent [v] Review [Tab]", " [i] Balance [a] Agente [v] Revisar [Tab]"), cyan)
		}
		if m.view == 2 && m.terminals.Mode == windowMode {
			keys = accent(localText(" [Tab] Focus [z] Zoom [t] Tile [Enter]", " [Tab] Foco [z] Zoom [t] Mosaico [Enter]"), cyan)
		}
	}
	if m.githubOpen {
		keys = accent(uiText(" [↑/↓] Issue   [Enter] Importar   [PgUp/PgDn] Leer   [r] Actualizar   [Esc] Volver"), cyan)
	}
	if m.review.open {
		keys = accent(uiText(" [PgUp/PgDn] Leer diff   [r] Actualizar   [a] Aceptar entrega   [c] Pedir cambios   [Esc] Volver"), cyan)
		if m.review.task.ID == "" {
			keys = accent(localText(" [Esc] Return   [F2] Project tasks   [F1] All projects", " [Esc] Volver   [F2] Tareas del proyecto   [F1] Todos los proyectos"), cyan)
		}
		if m.review.task.Status == "accepted" {
			keys = accent(uiText(" [PgUp/PgDn] Leer   [m] Integrar   [p] PR borrador   [a] Reaceptar   [Esc] Volver"), cyan)
		}
		if m.review.integration != nil && m.review.integration.MergedCommit == "" {
			keys = accent(uiText(" [Enter] Confirmar integración local   [Esc] Volver"), lime)
		}
		if m.review.publication != nil && !m.review.publication.Complete {
			keys = accent(uiText(" [e] Editar título/descripción   [Enter] Confirmar publicación en GitHub   [Esc] Volver"), lime)
			if m.review.publicationEditing != 0 {
				keys = accent(uiText(" [Tab] Campo   [Enter] Nueva línea   [Ctrl+U] Limpiar   [Ctrl+S] Vista previa   [Esc] Vista previa"), cyan)
			}
		}
		if m.reviewOverlay() && len(m.reviewTasks()) > 1 && m.review.integration == nil && m.review.publication == nil {
			keys = accent(localText(" [Tab] Delivery", " [Tab] Entrega"), cyan) + keys
		}
	}
	if m.command != nil {
		first = accent(uiText(" COMANDO > "), pink) + tailText(*m.command, w-15) + accent("█", cyan)
		keys = accent(uiText(" [Enter] Ejecutar   [Esc] Cancelar"), cyan)
	}
	if m.workerMessageID != "" {
		label := localText("WORKER", "WORKER")
		for _, task := range m.state.Tasks {
			if task.ID == m.workerMessageID {
				label = task.Title
				break
			}
		}
		prefix := localText(" MESSAGE → ", " MENSAJE → ") + ansi.Truncate(cleanAgentText(label), max(1, w/3), "…") + " > "
		first = accent(prefix, pink) + tailText(strings.ReplaceAll(m.chatDraft[m.workerMessageID], "\n", " ↵ "), max(1, w-ansi.StringWidth(prefix)-1)) + accent("█", cyan)
		keys = accent(localText(" [Enter] Send to worker + Fluke   [Shift+Enter] New line   [Esc] Cancel", " [Enter] Enviar al worker + Fluke   [Shift+Enter] Nueva línea   [Esc] Cancelar"), cyan)
	}
	if m.quitting {
		first = accent(uiText(" CERRAR CONSOLA "), pink) + uiText("¿Cerrar la consola y detener sus sesiones? [s/n]")
		keys = uiText(" Los worktrees y las tareas se conservan.")
	}
	if m.config {
		keys = accent(uiText(" [Tab] Campo   [←/→] Elegir   [Enter] Guardar   [Ctrl+Enter] Aplicar a Fluke   [Ctrl+R] Comprobar   [Ctrl+G] GitHub"), cyan)
		if w < 100 {
			keys = accent(localText("[Tab] Field [Enter] Save [Ctrl+T] Theme", "[Tab] Campo [Enter] Guardar [Ctrl+T] Tema"), cyan)
		}
		if m.configSection == 1 {
			keys = accent(uiText(" [Tab] Acción   [Enter] Ejecutar   [o] Abrir navegador   [Esc] Cancelar / volver   [Ctrl+O] Orquestador"), cyan)
		}
		if m.configSection == 2 {
			first = accent(localText("Theme preview · Enter saves", "Vista previa · Enter guarda"), cyan)
			keys = accent(localText("[↑/↓] Theme [Enter] Save [Esc] Cancel", "[↑/↓] Tema [Enter] Guardar [Esc] Volver"), cyan)
			if strings.Contains(m.notice, localText("Could not save", "No se pudo guardar")) {
				first = m.notice
			}
		}
		if m.configSection == 3 {
			keys = accent(localText("[Ctrl+←/→] Section [Esc] Agent", "[Ctrl+←/→] Sección [Esc] Agente"), cyan)
		}
		if m.configSection == 4 {
			keys = accent(localText("[Ctrl+L] Sign in [Ctrl+R] Check [Esc] Back", "[Ctrl+L] Conectar [Ctrl+R] Comprobar [Esc] Volver"), cyan)
			if m.shellMode() && w >= 90 {
				keys = accent(localText("[↑/↓] Connection [Ctrl+L] Sign in [Ctrl+R] Check [Esc] Back", "[↑/↓] Conexión [Ctrl+L] Conectar [Ctrl+R] Comprobar [Esc] Volver"), cyan)
			}
		}
	}
	if m.projects.open {
		keys = accent(localText(" [Tab] Field   [Enter] Continue   [Ctrl+U] Clear field   [Esc] Cancel", " [Tab] Campo   [Enter] Seguir   [Ctrl+U] Limpiar campo   [Esc] Cancelar"), cyan)
	}
	if m.floatingVisible() && m.floating.focused {
		keys = accent(localText("[Enter] Send [Esc] Panel [Ctrl+F] Close", "[Enter] Enviar [Esc] Panel [Ctrl+F] Cerrar"), cyan)
	}
	if m.switcher != nil {
		first = accent(localText(" Jump to Fluke or a worker · no tasks are started", " Ir a Fluke o a un worker · no inicia tareas"), cyan)
		if m.switcher.commands {
			first = accent(localText(" Views and settings · Ctrl+U clears search", " Vistas y ajustes · Ctrl+U limpia la búsqueda"), cyan)
		}
		keys = accent(localText(" [↑/↓] Choose [Enter/click] Open [Esc] Back", " [↑/↓] Elegir [Enter/clic] Abrir [Esc] Volver"), cyan)
	}
	if m.store != nil && w < 100 && m.switcher == nil && m.command == nil && m.workerMessageID == "" && !m.quitting && !m.projects.open {
		first = accent(" [Alt+K] ", cyan) + first
	}
	if m.shellMode() {
		return fit(first+"\n"+keys, w, m.footerRows())
	}
	return fit(rule(w, borderInk)+"\n"+first+"\n"+keys, w, m.footerRows())
}
func (m *model) contextContent(w int) string {
	tasks := m.projectTasks()
	goal := m.state.Goals[m.repo]
	content := strong(uiText("OBJETIVO"), cyan) + "\n" + rule(w, muted) + "\n"
	if m.state.PausedProjects[m.repo] {
		content += strong(uiText("PROYECTO PAUSADO"), amber) + "\n" + accent(uiText(":continue para retomar"), muted) + "\n\n"
	}
	if goal.ID != "" {
		content += wrap(goal.Objective, w) + "\n\n" + strong(uiText("ACEPTACIÓN"), cyan) + "\n" + fit(wrap(goal.Acceptance, w), w, 3) + "\n\n"
	} else {
		content += uiText("Por acordar con Fluke\n\n")
	}
	content += strong("PLAN", cyan) + "\n" + rule(w, muted) + "\n"
	if len(tasks) == 0 {
		content += accent(uiText("Esperando el primer encargo"), muted) + "\n"
	}
	for i, t := range tasks {
		content += strong(fmt.Sprintf("%02d ", i+1), statusInk(taskAgentStatus(t))) + ansi.Truncate(t.Title, max(1, w-3), "…") + "\n"
	}
	content += "\n" + strong(uiText("PROYECTOS"), cyan) + "\n" + rule(w, muted) + "\n"
	for i, repo := range m.state.Projects {
		marker := "  "
		if repo == m.repo {
			marker = "● "
		}
		if m.view == 0 && m.pane == 0 && i == m.selected%len(m.state.Projects) {
			marker = "> "
		}
		content += accent(marker, cyan) + ansi.Truncate(filepath.Base(repo), max(1, w-2), "…") + "\n"
	}
	content += "\n" + strong(uiText("ORQUESTADOR"), cyan) + "\n"
	if m.sessionAlive("fluke:" + m.repo) {
		state, hint := m.sessionSummary()
		ink := cyan
		if state == uiText("NECESITA TU ATENCIÓN") {
			ink = amber
		}
		content += strong(state, ink) + "\n" + wrap(hint, w)
	} else {
		content += accent(wrap(uiText("○ Enter inicia la conversación"), w), muted)
	}
	content += "\n" + accent(wrap(m.effectiveConfigLabel(), w), muted)
	content += "\n\n" + workerCapacity(m.liveWorkers(), m.state.MaxWorkers, max(1, w-13))
	return content
}

func (m *model) attentionContent(w int) string {
	content := strong(uiText("NECESITA TU ATENCIÓN"), amber) + "\n" + rule(w, muted) + "\n"
	items := m.attentionItems()
	if len(items) == 0 {
		content += accent(uiText("Todo despejado."), lime) + "\n\n"
	} else {
		selected := m.selected % len(items)
		visible := max(1, (m.workspaceHeight()-10)/7)
		start := max(0, selected-visible+1)
		for i := start; i < len(items) && i < start+visible; i++ {
			item := items[i]
			marker := "  "
			if m.view == 0 && m.pane == 2 && i == selected {
				marker = "> "
			}
			label := filepath.Base(item.Repo)
			for _, task := range m.state.Tasks {
				if task.ID == item.TaskID {
					label += " / " + task.Title
					break
				}
			}
			content += strong(fmt.Sprintf("%s%02d ", marker, i+1)+ansi.Truncate(label, max(1, w-5), "…"), pink) + "\n"
			lines := strings.Split(wrap(item.Summary, w), "\n")
			if len(lines) > 3 {
				lines = append(lines[:2], ansi.Truncate(lines[2], max(1, w-1), "")+"…")
			}
			content += strings.Join(lines, "\n") + "\n" + accent(localText("Enter · open", "Enter · abrir"), muted) + "\n\n"
		}
		content += accent(fmt.Sprintf(localText("%d alert(s) · ↑/↓ to navigate", "%d alerta(s) · ↑/↓ para navegar"), len(items)), muted) + "\n\n"
	}
	content += strong("WORKERS", cyan) + "\n" + rule(w, muted) + "\n"
	if m.liveWorkers() == 0 {
		content += accent(uiText("Sin workers abiertos"), muted) + "\n"
	} else {
		content += workerCapacity(m.liveWorkers(), m.state.MaxWorkers, max(1, w-13)) + "\n"
		content += accent(localText("F2 · plan / deliveries", "F2 · plan / entregas"), muted) + "\n"
	}
	return wrap(content, w)
}

func (m *model) terminalFor(key string) *terminalWindow {
	for _, w := range m.terminals.Windows {
		if w.ID == m.sessions[key] {
			return w
		}
	}
	return nil
}
func terminalPreview(w *terminalWindow, cols, rows int) string {
	if w == nil {
		return ""
	}
	content, _ := renderTerminal(w)
	lines := strings.Split(content, "\n")
	for len(lines) > 1 && strings.TrimSpace(ansi.Strip(lines[len(lines)-1])) == "" {
		lines = lines[:len(lines)-1]
	}
	return fit(strings.Join(lines[max(0, len(lines)-rows):], "\n"), cols, rows)
}

func (m *model) conversation(w, h int, compact bool) string {
	return m.chatBody(w, h, m.pane == 1 && !m.floatingVisible())
}

func (m *model) globalView(w, h int) string {
	if m.home {
		return m.homeView(w, h)
	}
	if w < 92 {
		if m.pane == 0 {
			return frame(uiText("PROYECTO / ")+filepath.Base(m.repo), m.contextContent(w-4), w, h, cyan, true)
		}
		if m.pane == 2 {
			return frame(uiText("SESIONES / ATENCIÓN"), m.attentionContent(w-4), w, h, cyan, true)
		}
		return frame(localText("FLUKE / PROJECT CHAT", "FLUKE / CHAT DEL PROYECTO"), m.conversation(w, h, false), w, h, pink, true)
	}
	left := max(19, w*21/100)
	right := max(19, w*21/100)
	center := w - left - right - 2
	return lipgloss.JoinHorizontal(lipgloss.Top, frame(uiText("PROYECTO / ")+strings.ToUpper(filepath.Base(m.repo)), m.contextContent(left-4), left, h, cyan, m.pane == 0), " ", frame(localText("FLUKE / PROJECT CHAT", "FLUKE / CHAT DEL PROYECTO"), m.conversation(center, h, false), center, h, cyan, m.pane == 1), " ", frame(uiText("SESIONES / ATENCIÓN"), m.attentionContent(right-4), right, h, cyan, m.pane == 2))
}

func taskRow(t Task, i int, selected bool, w int) string {
	marker := " "
	if selected {
		marker = ">"
	}
	return accent(fmt.Sprintf("%s %02d ", marker, i+1), cyan) + wrap(t.Title, max(1, w-5)) + "\n     " + accent(status(taskAgentStatus(t)), statusInk(taskAgentStatus(t))) + "  " + accent(t.ID[:min(9, len(t.ID))], muted)
}
func (m *model) planContent(w, h int) string {
	tasks := m.projectTasks()
	if m.insights {
		body := strong(localText("PROJECT BALANCE", "BALANCE DEL PROYECTO"), cyan) + "\n" + metricsContent(summarizeProject(m.state, m.repo), w)
		if len(tasks) > 0 {
			task := tasks[m.selected%len(tasks)]
			detail := strong(task.Title, pink) + "\n" + metricsContent(summarizeProject(State{Tasks: []Task{task}}, m.repo), w)
			if h < 22 {
				total := summarizeProject(m.state, m.repo)
				body = detail + "\n\n" + wrap(fmt.Sprintf(localText("Project: %d/%d accepted · %s observed", "Proyecto: %d/%d aceptadas · %s observado"), total.Accepted, total.Total, metricsDuration(total.ObservedMS)), w)
			} else {
				body += "\n\n" + detail
			}
		}
		return body + "\n\n" + accent(localText("[i] Back to plan · ↑/↓ Select task", "[i] Volver al plan · ↑/↓ Elegir tarea"), cyan)
	}
	if len(tasks) == 0 && m.state.Goals[m.repo].ID != "" {
		goal := m.state.Goals[m.repo]
		return strong(uiText("CONTEXTO / ")+goal.Objective, cyan) + "\n" + wrap(goal.Acceptance, w) + "\n\n" + strong(uiText("OBJETIVO ACORDADO"), lime) + "\n\n" + wrap(uiText("Fluke prepara las tareas del plan. Podés conversar para afinarlo."), w)
	}
	if len(tasks) == 0 {
		return strong(uiText("TU PRÓXIMA MISIÓN"), cyan) + "\n\n" + wrap(uiText("Definí qué tiene que quedar listo y cómo lo vas a comprobar."), w) + "\n\n" + accent(uiText(":task título | criterio de aceptación"), pink) + "\n\n" + accent(uiText("F6 · traer una issue de GitHub"), muted)
	}
	selected := m.selected % len(tasks)
	current := tasks[selected]
	goal := m.state.Goals[m.repo]
	title, acceptance := current.Title, current.Acceptance
	if goal.ID != "" {
		title, acceptance = goal.Objective, goal.Acceptance
	}
	content := strong(uiText("CONTEXTO / ")+title, cyan) + "\n" + wrap(acceptance, w) + "\n\n"
	if current.WorkerConfig != nil {
		content += accent(localText("Worker: ", "Worker: ")+configLabel(current.WorkerConfig), cyan) + "\n"
	}
	if err := taskScopeError(m.state, current); err != nil && current.Status != "accepted" {
		content += strong(uiText("REVISAR ALCANCE"), amber) + "\n" + wrap(err.Error(), w) + "\n\n"
	} else if current.Paused && current.Note != "" {
		content += accent(wrap(current.Note, w), amber) + "\n\n"
	}
	if len(current.DependsOn) > 0 {
		content += strong(uiText("DEPENDE DE "), amber) + wrap(strings.Join(current.DependsOn, ", "), w-11) + "\n"
		if reason := m.dependencyChecks[current.ID]; reason != "" {
			content += accent(wrap(cleanAgentText(reason), w), amber) + "\n"
		}
	}
	if pr := m.githubPRStatusText(current); pr != "" {
		content += "\n" + strong(wrap(pr, w), cyan) + "\n"
	}
	// Reserve visible rows for navigation even when the context is long.
	listRows := min(len(tasks), max(1, h/3))
	contextRows := max(0, h-listRows-1)
	if w >= 58 && contextRows-strings.Count(content, "\n") >= 8 {
		if goal.ID != "" {
			content += projectFlow(goal, tasks, w) + "\n"
		} else {
			content += missionFlow(current, w) + "\n"
		}
	} else if contextRows-strings.Count(content, "\n") >= 2 {
		content += strong(uiText("ALCANCE → WORKER → REVISIÓN"), cyan) + "\n"
	}
	lines := strings.Split(strings.TrimRight(content, "\n"), "\n")
	if len(lines) > contextRows {
		lines = lines[:contextRows]
		if len(lines) > 0 {
			lines[len(lines)-1] = ansi.Truncate(lines[len(lines)-1], max(1, w-1), "") + accent("…", muted)
		}
	}
	content = strings.Join(lines, "\n")
	if len(lines) > 0 {
		content += "\n\n"
	}
	available := max(1, h-strings.Count(content, "\n"))
	start := max(0, selected-available+1)
	for i := start; i < len(tasks) && i < start+available; i++ {
		t := tasks[i]
		marker := "  "
		if i == selected {
			marker = "> "
		}
		label := fmt.Sprintf("%s%02d ", marker, i+1) + ansi.Truncate(t.Title, max(6, w-30), "…")
		label += strings.Repeat(" ", max(1, w-ansi.StringWidth(label)-24))
		content += strong(label, cyan) + accent(status(taskAgentStatus(t)), statusInk(taskAgentStatus(t))) + "\n"
	}
	return content
}

func (m *model) workerPreviews(w, h int) string {
	windows := []Task{}
	tasks := m.projectTasks()
	selectedID := ""
	if len(tasks) > 0 {
		selectedID = tasks[m.selected%len(tasks)].ID
	}
	start := 0
	for _, t := range tasks {
		if m.terminalFor(t.ID) != nil {
			if t.ID == selectedID {
				start = len(windows) / 2 * 2
			}
			windows = append(windows, t)
		}
	}
	if len(windows) == 0 {
		accepted := ""
		for _, task := range m.projectTasks() {
			if task.Status == "accepted" {
				label := uiText("ACEPTADA · F7 → integrar")
				if task.Integration != nil && task.Integration.MergedCommit != "" {
					label = uiText("INTEGRADA · ") + task.Integration.TargetBranch
				}
				accepted += strong("✓ "+task.Title, lime) + "\n" + accent(label, cyan) + "\n" + accent(task.Branch, muted) + "\n\n"
			}
		}
		if accepted != "" {
			return frame(uiText("ENTREGAS ACEPTADAS"), accepted+wrap(uiText("F7 permite revisar e integrar cada entrega."), w-4), w, h, cyan, m.pane == 2)
		}
		return frame(uiText("WORKERS / TERMINALES"), strong(uiText("EL ESPACIO DE EJECUCIÓN"), cyan)+"\n\n"+wrap(uiText("Cada tarea abre su propia sesión y su worktree. Los workers aparecen acá cuando los iniciás o Fluke los toma de la cola."), w-4)+"\n\n"+accent(uiText("[Enter] iniciar tarea seleccionada"), pink), w, h, cyan, m.pane == 2)
	}
	count := min(2, len(windows)-start)
	colW := (w - count + 1) / count
	parts := []string{}
	for i := 0; i < count; i++ {
		t := windows[start+i]
		ink := statusInk(taskAgentStatus(t))
		meta := accent(strings.ToUpper(t.AgentProvider), cyan) + accent(" / "+shortBranch(t.Branch), muted)
		if t.AgentProvider == "" {
			meta = accent(shortBranch(t.Branch), muted)
		}
		rows := max(1, h-9)
		activity := accent(uiText("Sin reporte todavía.\nF3 abre la sesión completa."), muted)
		if t.AgentMessage != "" {
			activity = strong("worker> ", cyan) + wrap(conciseAgentMessage(t.AgentMessage), max(1, colW-12))
			if len(t.AgentEvidence) > 0 {
				activity += "\n" + accent(uiText("Evidencia: ")+strings.Join(t.AgentEvidence, ", "), muted)
			}
		}
		body := meta + "\n" + rule(colW-4, muted) + "\n" + fit(activity, colW-4, rows) + "\n" + rule(colW-4, cyan) + "\n" + strong(status(taskAgentStatus(t)), ink) + "\n" + accent(uiText("F3 abrir sesión · F7 revisar diff"), muted)
		parts = append(parts, frame(t.Title, body, colW, h, cyan, m.pane == 2 && t.ID == selectedID))
		if i < count-1 {
			parts = append(parts, " ")
		}
	}
	return lipgloss.JoinHorizontal(lipgloss.Top, parts...)
}

func (m *model) projectView(w, h int) string {
	if m.shellProject() {
		return m.shellProjectView(h)
	}
	chat, detail := m.projectPanels()
	body := ""
	if chat.w > 0 {
		body = frame("FLUKE / "+filepath.Base(m.repo), m.conversation(chat.w, chat.h, false), chat.w, chat.h, cyan, m.pane == 1)
	}
	if detail.w > 0 {
		panel := frame("PLAN", m.taskPanel(detail.w-4, detail.h-4), detail.w, detail.h, cyan, m.pane == 0)
		if m.pane == 2 {
			panel = frame("WORKERS", m.taskPanel(detail.w-4, detail.h-4), detail.w, detail.h, cyan, true)
		}
		if body == "" {
			body = panel
		} else {
			body = lipgloss.JoinHorizontal(lipgloss.Top, body, " ", panel)
		}
	}
	return fit(m.projectBar(), w, 1) + "\n" + body
}

func (m *model) decisionsPanels(w, h int) string {
	questionW := w
	if w >= 92 {
		questionW = w * 3 / 5
	}
	question := uiText("Sin decisiones pendientes.")
	answer := ""
	index := m.selectedDecision()
	if index < 0 {
		body := "\n" + accent(question, lime) + "\n\n" + wrap(localText("Requests that need your answer will appear here.\n\nF2 opens your project chat with Fluke.", "Acá aparecerán las solicitudes que necesiten tu respuesta.\n\nF2 abre el chat del proyecto con Fluke."), max(1, w-4))
		return frame(uiText("DECISIONES HUMANAS / ")+localText("UP TO DATE", "AL DÍA"), body, w, h, cyan, true)
	}
	taskID := ""
	if index >= 0 {
		d := m.state.Decisions[index]
		question = d.Question
		taskID = d.TaskID
		if d.Answer != nil {
			answer = *d.Answer
		}
	}
	title := uiText("NECESITA TU DECISIÓN")
	ink := pink
	if index >= 0 && m.state.Decisions[index].Assistance {
		title = localText("FLUKE / TECHNICAL HELP", "FLUKE / AYUDA TÉCNICA")
		ink = cyan
	}
	if answer != "" {
		title = uiText("DECISIÓN REGISTRADA")
		ink = lime
	}
	decisionHelp := uiText("[Enter] Responder ahora")
	if index >= 0 && m.state.Decisions[index].Answer != nil {
		decisionHelp = localText("[Enter] Correct answer (history preserved)", "[Enter] Corregir respuesta (historial conservado)")
	}
	if index >= 0 && m.state.Decisions[index].ProposedTitle != "" {
		decisionHelp = uiText("[Enter] Aprobar propuesta · [r] Rechazar")
	}
	questionBody := "\n" + accent(fmt.Sprintf(uiText("DECISIÓN %02d"), index+1), ink) + "\n" + accent(decisionHelp, ink) + "\n\n" + wrap(question, max(1, questionW-4))
	if answer != "" {
		questionBody += "\n\n" + accent(uiText("RESPUESTA"), lime) + "\n" + wrap(answer, max(1, questionW-4))
		if m.state.Decisions[index].AnsweredBy == "fluke" {
			questionBody += "\n" + accent(localText("Answered by Fluke · technical guidance", "Respondió Fluke · orientación técnica"), cyan)
		}
	}
	if index >= 0 && m.state.Decisions[index].Supersedes > 0 {
		questionBody += "\n\n" + accent(fmt.Sprintf(localText("Replaces answer %02d", "Reemplaza respuesta %02d"), m.state.Decisions[index].Supersedes), amber)
	}
	if w < 92 {
		return frame(uiText("DECISIONES HUMANAS / ")+title, questionBody, w, h, ink, true)
	}
	previewW := w - questionW - 1
	preview := uiText("La decisión se conserva en el proyecto.\n\nLas sesiones mantienen su contexto mientras decidís.")
	for _, t := range m.projectTasks() {
		if taskID == "" || t.ID != taskID {
			continue
		}
		preview = strong(t.Title, cyan) + "\n" + accent(status(taskAgentStatus(t)), statusInk(taskAgentStatus(t))) + "\n\n" + wrap(t.Acceptance, previewW-4)
		if t.AgentMessage != "" {
			preview += "\n\n" + wrap(conciseAgentMessage(t.AgentMessage), previewW-4)
		}
		if len(t.AgentEvidence) > 0 {
			preview += "\n\n" + accent(uiText("EVIDENCIA"), cyan) + "\n" + strings.Join(t.AgentEvidence, "\n")
		}
		break
	}
	return lipgloss.JoinHorizontal(lipgloss.Top, frame(uiText("DECISIONES HUMANAS / ")+title, questionBody, questionW, h, ink, true), " ", frame(uiText("SESIÓN / CONTEXTO"), preview, previewW, h, cyan, false))
}
func (m *model) configView(w, h int) string {
	if m.configSection == 4 {
		return m.connectionView(w, h)
	}
	if m.configSection == 3 {
		return m.typographyView(w, h)
	}
	if m.configSection == 2 {
		return m.themeView(w, h)
	}
	if m.configSection == 1 {
		return m.githubConfigView(w, h)
	}
	labels := []string{uiText("Proveedor (←/→)"), uiText("Ejecutable"), uiText("Modelo (←/→ o escribir)"), uiText("Argumentos JSON"), uiText("Máximo de workers")}
	formWidth := w
	if w >= 104 {
		formWidth = w * 55 / 100
	}
	content := m.configNav(formWidth-4) + "\n" + accent(localText("Ctrl+T · Theme: ", "Ctrl+T · Tema: ")+consoleThemes[themeIndex(m.state.Theme)].Name, cyan) + "\n"
	for i, label := range labels {
		marker := "  "
		c := muted
		if i == m.field {
			marker = "> "
			c = cyan
		}
		value := m.draft[i]
		if i == 2 && value == "" {
			value = uiText("Predeterminado de la CLI")
		}
		content += accent(marker+label, c) + "\n  " + value + "\n\n"
	}
	content += accent("Ctrl+E · English / Español", cyan) + "\n"
	autonomy := localText("OFF", "NO")
	if m.draftAutonomous {
		autonomy = localText("ON · unrestricted files/commands", "SÍ · archivos/comandos sin restricciones")
	}
	content += accent(localText("Ctrl+A · Autonomous Fluke: ", "Ctrl+A · Fluke autónomo: ")+autonomy, pink) + "\n"
	content += accent(uiText("Enter / Ctrl+S · guardar para nuevas sesiones"), cyan) + "\n" + accent(uiText("Ctrl+Enter · reiniciar Fluke con este modelo"), pink) + "\n" + accent(uiText("Las tareas, el historial y los workers se conservan."), muted)
	if w >= 104 {
		left := w * 55 / 100
		return lipgloss.JoinHorizontal(lipgloss.Top, frame(uiText("CONFIGURACIÓN"), content, left, h, pink, true), " ", frame(uiText("CONEXIÓN / MODELOS"), m.providerConfigContent(w-left-5), w-left-1, h, cyan, false))
	}
	rows := max(1, h-4)
	offset := max(0, 2+m.field*3+2-rows)
	lines := strings.Split(content, "\n")
	if h >= 28 {
		lines = append(lines, "", m.providerConfigContent(w-4))
	}
	return frame(uiText("CONFIGURACIÓN"), strings.Join(lines[min(offset, len(lines)):], "\n"), w, h, pink, true)
}

func (m *model) providerStatusContent(w int) string {
	content := strong(strings.ToUpper(m.draft[0]), cyan) + "\n" + rule(w, muted) + "\n"
	if m.providerBusy {
		content += accent(uiText("COMPROBANDO CLI Y AUTENTICACIÓN…"), amber)
	} else if m.provider.Provider != m.draft[0] {
		content += uiText("Ctrl+R comprueba este proveedor.")
	} else {
		ink := amber
		if m.provider.Available && m.provider.Authenticated {
			ink = lime
		}
		content += strong(wrap(m.provider.Message, w), ink)
		cli := localText("not found", "no encontrada")
		if m.provider.Available {
			cli = localText("available", "disponible")
		}
		auth := localText("unverified", "sin verificar")
		if m.provider.AuthKnown {
			auth = localText("sign-in needed", "requiere iniciar sesión")
			if m.provider.Authenticated {
				auth = localText("authenticated", "autenticada")
			}
		}
		content += "\n" + wrap("CLI: "+cli+" · "+localText("Account: ", "Cuenta: ")+auth, w)
		if m.provider.Version != "" {
			content += "\n" + accent(m.provider.Version, muted)
		}
	}
	return content
}

func (m *model) providerConfigContent(w int) string {
	content := m.providerStatusContent(w)
	content += "\n\n" + strong(localText("SAVED FOR NEW SESSIONS", "GUARDADO PARA NUEVAS SESIONES"), cyan) + "\n" + wrap(configLabel(m.state.Orchestrator), w)
	content += "\n\n" + strong(uiText("FLUKE ACTUAL"), cyan) + "\n" + wrap(m.effectiveConfigLabel(), w)
	if m.sessionAlive("fluke:" + m.repo) {
		state, hint := m.sessionSummary()
		content += "\n" + strong(state, cyan) + "\n" + wrap(hint, w)
	} else {
		content += "\n" + accent(uiText("Sin sesión iniciada"), muted)
	}
	if m.field == 2 {
		content += "\n\n" + strong(uiText("MODELOS SUGERIDOS"), cyan) + "\n"
		for _, choice := range m.modelChoices {
			label := choice
			if label == "" {
				label = uiText("Predeterminado")
			}
			if choice == m.draft[2] {
				content += strong("> "+label, pink) + "\n"
			} else {
				content += accent("  "+label, muted) + "\n"
			}
		}
		content += accent(uiText("Sugerencias locales; acceso según tu cuenta."), muted)
	} else {
		content += "\n\n" + accent(uiText("Ctrl+R · volver a comprobar"), cyan) + "\n" + accent(uiText("Ctrl+G · conexión de GitHub"), cyan) + "\n\n" + wrap(uiText("Elegí el campo Modelo para ver las opciones. Las credenciales se administran en cada CLI."), w)
		content += "\n\n" + accent(uiText("Ctrl+L · iniciar sesión con la CLI"), pink)
	}
	return content
}
func (m *model) githubConfigView(w, h int) string {
	a := m.auth
	if h < 24 {
		content := m.configNav(w-4) + "\n" + accent("GITHUB", pink) + " · "
		if a.Username != "" {
			content += a.Username
		} else {
			content += uiText("Sin conexión verificada")
		}
		content += "\n"
		for i, label := range []string{uiText("Conectar"), uiText("Estado"), uiText("Desconectar")} {
			if i == m.authSelected {
				content += accent(" >"+label+" ", cyan)
			} else {
				content += " " + label + " "
			}
		}
		if a.Code != "" {
			content += "\n\n" + accent(uiText("CÓDIGO: ")+a.Code, pink) + "\n" + githubDevicePage + uiText("\n[o] Abrir navegador · [Esc] Cancelar")
		} else if a.Busy {
			content += uiText("\nConectando… [Esc] Cancelar")
		}
		if a.Error != "" {
			content += "\n" + wrap(a.Error, max(1, w-4))
		}
		if m.authConfirm {
			content += uiText("\nDesconectar ") + a.Username + uiText(" de la sesión compartida gh? [s/n]")
		}
		return frame(uiText("CONFIGURACIÓN / GITHUB"), content, w, h, pink, true)
	}
	content := m.configNav(w-4) + "\n\n"
	if a.Available {
		content += accent(uiText("● GitHub CLI disponible"), lime)
	} else {
		content += accent(uiText("○ GitHub CLI no disponible"), amber)
	}
	content += "\n"
	if a.Username != "" {
		content += accent(uiText("● Conectado como ")+a.Username, lime)
	} else {
		content += accent(uiText("○ Sin conexión verificada"), muted)
	}
	if a.Environment {
		content += uiText("\nCuenta administrada por GH_TOKEN/GITHUB_TOKEN.")
	}
	if a.Error != "" {
		content += "\n\n" + wrap(a.Error, max(1, w-6))
	}
	content += "\n\n"
	for i, label := range []string{uiText("Conectar con GitHub"), uiText("Actualizar estado"), uiText("Desconectar cuenta")} {
		marker, ink := "  ", muted
		if m.authSelected == i {
			marker, ink = "> ", cyan
		}
		content += accent(marker+label, ink) + "\n"
	}
	if m.authConfirm {
		content += "\n" + accent(uiText("DESCONECTAR ")+a.Username+uiText("? [s/n]"), pink) + uiText("\nTambién cerrará esa cuenta en la sesión compartida de gh.")
	}
	if a.Busy {
		if a.Code != "" {
			content += "\n" + section(uiText("AUTORIZAR EN EL NAVEGADOR"), max(1, w-6)) + "\n\n" + accent(uiText("  CÓDIGO: ")+a.Code, pink) + "\n\n  " + githubDevicePage + uiText("\n\n[o] Abre el navegador. Ingresá el código y autorizá.\nEsperando autorización… [Esc] Cancela.")
		} else {
			content += "\n" + accent(uiText("Consultando GitHub… [Esc] Cancela."), amber)
		}
	} else {
		content += uiText("\nLas credenciales las administra GitHub CLI.\nF6 muestra las issues del proyecto.")
	}
	return frame(uiText("CONFIGURACIÓN / GITHUB"), content, w, h, pink, true)
}
func (m *model) githubView(w, h int) string {
	s := m.github[m.repo]
	header := accent("GITHUB / ", pink) + filepath.Base(m.repo) + "\n"
	if s.Loading {
		header += accent(uiText("Conectando…"), amber)
	} else if s.Error != "" {
		header += wrap(s.Error, max(1, w-4))
	} else if s.Name != "" {
		header += accent("● "+s.Name, lime) + " · " + s.URL
	} else {
		header += uiText("F6 conecta el origin usando tu sesión de gh.")
	}
	header += "\n" + accent(uiText("[↑/↓] Issue   [Enter] Importar   [PgUp/PgDn] Leer   [r] Actualizar   [Esc] Volver"), cyan)
	list := ""
	selected := m.githubSelected % max(1, len(s.Issues))
	// Keep the selection visible without a background polling loop.
	start := max(0, selected-max(1, h-12)+1)
	for i := start; i < len(s.Issues); i++ {
		issue := s.Issues[i]
		line := fmt.Sprintf("#%d %s", issue.Number, issue.Title)
		if i == selected {
			list += accent("> "+line, pink)
		} else {
			list += "  " + line
		}
		list += "\n"
	}
	if len(s.Issues) == 0 {
		list = uiText("Sin issues cargadas.\n[r] Consultar GitHub")
	}
	detail := uiText("Las issues se convierten en tareas locales.\n\nDefiní la aceptación antes de iniciar un worker.")
	if len(s.Issues) > 0 {
		issue := s.Issues[selected]
		detail = accent(fmt.Sprintf("ISSUE #%d", issue.Number), pink) + "\n" + wrap(issue.Title, max(1, w*2/3-6)) + "\n\n" + wrap(issue.Body, max(1, w*2/3-6))
		if issue.Body == "" {
			detail += uiText("(Sin descripción)")
		}
	}
	detailLines := strings.Split(detail, "\n")
	detail = strings.Join(detailLines[min(m.githubScroll, max(0, len(detailLines)-1)):], "\n")
	if w < 90 || h < 18 {
		if m.githubDetail {
			list = detail
		}
		return frame(uiText("GITHUB / CONEXIÓN"), header+uiText("\n[Tab] Lista / descripción\n\n")+list, w, h, pink, true)
	}
	left := w / 3
	panels := lipgloss.JoinHorizontal(lipgloss.Top, frame(uiText("ISSUES ABIERTAS / HASTA 50"), list, left, h-8, cyan, true), " ", frame(uiText("DESCRIPCIÓN / CONTEXTO EXTERNO"), detail, w-left-1, h-8, cyan, false))
	return frame(uiText("GITHUB / CONEXIÓN"), header, w, 7, cyan, false) + "\n" + panels
}
func (m *model) View() tea.View {
	theme := m.state.Theme
	if m.config && m.configSection == 2 {
		theme = consoleThemes[m.themeSelected].ID
	}
	applyTheme(theme)
	if m.setup.open {
		view := tea.NewView(themeCanvas(textStyle.Render(m.setupView())))
		view.BackgroundColor = ground
		view.AltScreen = true
		return view
	}
	w, h := max(1, m.width), max(1, m.height)
	bodyH := m.workspaceHeight()
	var body string
	var terminal tea.View
	switch m.view {
	case 0:
		body = m.globalView(w, bodyH)
	case 1:
		body = m.projectView(w, bodyH)
	case 2:
		if len(m.terminals.visibleWindows()) > 0 {
			terminal = m.terminals.View()
			body = terminal.Content
		} else {
			body = frame(uiText("SESIONES / TERMINALES"), localText("No worker terminals open.\n\nTalk to Fluke in F2 to plan and start work.\nFluke runs in the background.", "No hay terminales de workers abiertas.\n\nHablá con Fluke en F2 para planificar e iniciar tareas.\nFluke funciona en segundo plano."), w, bodyH, cyan, false)
		}
	case 3:
		body = m.decisionsView(w, bodyH)
	}
	if m.config {
		body = m.configView(w, bodyH)
	} else if m.githubOpen {
		body = m.githubView(w, bodyH)
	}
	if m.review.open {
		for _, task := range m.state.Tasks {
			if task.ID != m.review.task.ID {
				continue
			}
			pr := m.githubPRStatusText(task)
			if pr != m.review.githubStatus {
				m.review.githubStatus, m.review.lines = pr, nil
			}
			break
		}
		body = m.reviewView(w, bodyH)
	}
	if m.projects.open {
		body = m.projectEditorView(w, bodyH)
	}
	if m.floatingVisible() {
		body = m.floatingChatView(body)
		if m.floatingHidesCursor(terminal.Cursor) {
			terminal.Cursor = nil
		}
	}
	if m.switcher != nil {
		body = m.switcherView(w, bodyH)
		terminal.Cursor = nil
	}
	content := textStyle.Render(fit(m.header()+"\n"+fit(body, w, bodyH)+"\n"+m.footer(), w, h))
	// Nested styles reset SGR; restore the canvas ink instead of host defaults.
	content = themeCanvas(content)
	view := tea.NewView(content)
	view.BackgroundColor = ground
	view.AltScreen = true
	// Ctrl+B yields mouse handling back to the host for native text selection.
	if !m.mouseDisabled && !m.projects.open && !m.quitting {
		view.MouseMode = tea.MouseModeAllMotion
	}
	if m.view == 2 && !m.projects.open && !m.config && !m.githubOpen && !m.review.open && !m.quitting && m.command == nil && terminal.Cursor != nil {
		cursor := *terminal.Cursor
		cursor.Y += m.headerRows()
		view.Cursor = &cursor
	}
	return view
}
