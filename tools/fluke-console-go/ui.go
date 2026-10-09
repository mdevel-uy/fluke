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

// Approved BBS palette: cyan structure, magenta focus, violet ink.
var cyan = lipgloss.Color("#20e9ef")
var pink = lipgloss.Color("#f00ed5")
var lime = lipgloss.Color("#6ff566")
var amber = lipgloss.Color("#f5d547")
var muted = lipgloss.Color("#9298bd")
var ground = lipgloss.Color("#0b0619")
var textStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("#eeeafa")).Background(ground)

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
	return neonFrame(title, body, w, h, c, focused)
}

func section(title string, w int) string { return accent(title, cyan) + "\n" + rule(w, cyan) }
func (m *model) headerRows() int {
	if m.panelMaximized || (m.view == 2 && m.terminals.zoomedID != "") {
		return 1
	}
	if m.width < 76 || m.height < 26 {
		return 3
	}
	return 6
}
func (m *model) footerRows() int {
	if m.height < 26 {
		return 3
	}
	return 4
}
func (m *model) workspaceHeight() int { return max(1, m.height-m.headerRows()-m.footerRows()) }
func (m *model) header() string {
	w := max(1, m.width)
	if m.headerRows() == 1 {
		mark := " " + brandTail + " "
		return fit(accent(mark, cyan)+m.tabsForWidth(w-ansi.StringWidth(mark)), w, 1)
	}
	pending := 0
	for _, d := range m.state.Decisions {
		if d.Answer == nil {
			pending++
		}
	}
	if m.headerRows() == 3 {
		label := filepath.Base(m.repo)
		if m.home {
			label = localText("All projects", "Todos los proyectos")
		}
		return fit(accent(" fluke / ", cyan)+label+accent(fmt.Sprintf("   %d/%d workers", m.liveWorkers(), m.state.MaxWorkers), lime)+"\n"+m.tabs()+"\n"+rule(w, cyan), w, 3)
	}
	return m.brandHeader(m.tabsForWidth(w - 2))
}

func (m *model) tabs() string {
	return m.tabsForWidth(m.width)
}

func (m *model) tabsForWidth(w int) string {
	labels := []string{localText("[F1] Projects", "[F1] Proyectos"), localText("[F2] Workspace", "[F2] Trabajo"), localText("[F3] Terminals", "[F3] Terminales"), "[F4] Brief", localText("F5 Settings", "F5 Ajustes"), "F6 GitHub", localText("F7 Review", "F7 Revisión")}
	if w < 120 {
		labels = []string{localText("F1 Projects", "F1 Proyectos"), localText("F2 Workspace", "F2 Trabajo"), localText("F3 Terminals", "F3 Terminales"), "F4 Brief", localText("F5 Settings", "F5 Ajustes"), "F6 GitHub", localText("F7 Review", "F7 Revisión")}
	}
	labelWidth := func() int {
		total := len(labels)*2 + len(labels) - 1
		for _, label := range labels {
			total += ansi.StringWidth(label)
		}
		return total
	}
	if labelWidth() > w {
		labels = []string{localText("F1 Proj", "F1 Proy"), localText("F2 Work", "F2 Trabajo"), "F3 Term", "F4 Brief", localText("F5 Set", "F5 Ajust"), "F6 GH", "F7 Rev"}
	}
	if labelWidth() > w {
		labels = []string{"F1", "F2", "F3", "F4", "F5", "F6", "F7"}
	}
	parts := []string{}
	for i, label := range labels {
		active := (i == m.view && !m.githubOpen && !m.config && !m.review.open) || (i == 4 && m.config && !m.review.open) || (i == 5 && m.githubOpen && !m.config && !m.review.open) || (i == 6 && m.review.open)
		if active {
			parts = append(parts, lipgloss.NewStyle().Foreground(ground).Background(pink).Bold(true).Render(" "+label+" "))
		} else {
			parts = append(parts, accent(" "+label+" ", cyan))
		}
	}
	return strings.Join(parts, accent("│", muted))
}

func (m *model) footer() string {
	w := max(1, m.width)
	message := m.notice
	if message == "" {
		message = uiText("Tu proyecto, tus decisiones, tus workers.")
	}
	first := accent("─╱╲─ │ ", cyan) + message
	keys := accent(uiText(" [Tab] Panel   [Enter] Enviar   [PgUp/PgDn] Historial   [Ctrl+Y] Copiar   [Ctrl+K] Comandos   [Ctrl+Q] Salir"), cyan)
	if m.view == 1 && m.pane == 0 {
		keys = accent(localText(" [↑/↓] Task   [Enter] Worker   [m] Message   [q] Queue   [v/F7] Review   [p] Pause/resume", " [↑/↓] Tarea   [Enter] Worker   [m] Mensaje   [q] Cola   [v/F7] Revisar   [p] Pausar/seguir"), cyan)
	}
	if m.view == 1 && m.pane == 2 {
		keys = accent(localText(" [↑/↓] Agent   [Enter] Open session   [F7] Review", " [↑/↓] Agente   [Enter] Abrir sesión   [F7] Revisar"), cyan)
	}
	if m.view != 2 {
		label := localText(" [F8/Ctrl+F] Maximize focused panel", " [F8/Ctrl+F] Maximizar panel")
		if m.panelMaximized {
			label = localText(" [F8/Ctrl+F] Restore panels", " [F8/Ctrl+F] Restaurar paneles")
		}
		keys = accent(label, cyan) + keys
	}
	if m.view == 0 && m.pane == 2 {
		keys = accent(localText(" [↑/↓] Alert   [Enter] Open project / task / session   [Tab] Panel", " [↑/↓] Alerta   [Enter] Abrir proyecto / tarea / sesión   [Tab] Panel"), cyan)
	}
	if m.view == 2 {
		keys = accent(localText(" [Tab] Focus   [m] Message   [t] Tile   [Enter] Native terminal   [PgUp/PgDn] History", " [Tab] Foco   [m] Mensaje   [t] Mosaico   [Enter] Terminal nativa   [PgUp/PgDn] Historial"), cyan)
		if m.terminals.Mode == windowMode {
			first = accent(uiText("VENTANAS: arrastrá el título · bordes redimensionan"), cyan) + " │ " + message
		} else {
			first = accent(uiText("TERMINAL: entrada directa"), cyan) + " │ " + message
			keys = accent(uiText(" [Ctrl+X] Ventanas   [Shift+PgUp/PgDn] Historial   [Shift+End] En vivo   [Ctrl+Y] Copiar"), cyan)
		}
	}
	if m.view == 2 {
		keys = accent(localText(" [Ctrl+F/F8] Maximize/restore", " [Ctrl+F/F8] Maximizar/restaurar"), cyan) + keys
	}
	if m.home && m.view == 0 {
		keys = accent(localText(" [N] New project   [O] Open   [↑/↓] Choose   [Enter] Tasks   [C] Chat   [Tab] Attention", " [N] Nuevo proyecto   [O] Abrir   [↑/↓] Elegir   [Enter] Tareas   [C] Chat   [Tab] Atención"), cyan)
		if m.pane == 2 {
			keys = accent(localText(" [↑/↓] Alert   [Enter] Open   [Tab] Projects   [N] New   [O] Open repository", " [↑/↓] Alerta   [Enter] Abrir   [Tab] Proyectos   [N] Nuevo   [O] Abrir repositorio"), cyan)
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
	}
	if m.view == 3 && !m.config && !m.githubOpen && !m.review.open {
		keys = accent(localText(" [Tab] Brief/decisions   [PgUp/PgDn] Read   [Ctrl+D] Reply in F2   [C] Chat   [Ctrl+F] Maximize", " [Tab] Brief/decisiones   [PgUp/PgDn] Leer   [Ctrl+D] Responder en F2   [C] Chat   [Ctrl+F] Maximizar"), cyan)
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
		if m.configSection == 1 {
			keys = accent(uiText(" [Tab] Acción   [Enter] Ejecutar   [o] Abrir navegador   [Esc] Cancelar / volver   [Ctrl+O] Orquestador"), cyan)
		}
	}
	if m.projects.open {
		keys = accent(localText(" [Tab] Field   [Enter] Continue   [Ctrl+U] Clear field   [Esc] Cancel", " [Tab] Campo   [Enter] Seguir   [Ctrl+U] Limpiar campo   [Esc] Cancelar"), cyan)
	}
	if m.footerRows() == 3 {
		return fit(first+"\n"+rule(w, cyan)+"\n"+keys, w, 3)
	}
	return fit(accent("┌"+strings.Repeat("─", max(0, w-2))+"┐", cyan)+"\n"+accent("│", cyan)+fit(first, w-2, 1)+accent("│", cyan)+"\n"+accent("│", cyan)+fit(keys, w-2, 1)+accent("│", cyan)+"\n"+accent("└"+strings.Repeat("─", max(0, w-2))+"┘", cyan), w, 4)
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
	inside := max(1, w-4)
	bodyRows := max(1, h-4)
	inputRows := min(len(composerLines(m.chatDraft[m.repo], inside)), max(1, bodyRows-4))
	entryRows := inputRows + 3
	transcriptRows := max(1, bodyRows-entryRows)
	content := ""
	if messages := m.state.Conversations[m.repo]; len(messages) > 0 {
		content = conversationTranscriptAt(messages, inside, transcriptRows, m.chatScroll)
	} else {
		content = strings.Join(brandTranscriptLines([]ConversationMessage{{Role: "fluke", Text: uiText("Contame qué querés lograr. Acordamos el alcance, preparo el plan y coordino los workers.\n\nVos decidís lo importante y revisás las entregas.")}}, inside), "\n") + "\n"
		if goal := m.state.Goals[m.repo]; goal.ID != "" {
			content += strong(uiText("OBJETIVO ACORDADO"), lime) + "\n" + wrap(goal.Objective, inside) + "\n\n"
		}
		if m.sessionAlive("fluke:" + m.repo) {
			content += strong(uiText("FLUKE ESTÁ ORGANIZANDO EL TRABAJO"), cyan) + "\n" + accent(uiText("F3 · entrar a su sesión"), muted) + "\n\n"
		} else {
			content += strong(uiText("ABRIR ORQUESTADOR"), pink) + "\n" + accent(uiText("[Enter] iniciar conversación"), cyan) + "\n\n"
		}
		for _, t := range m.projectTasks() {
			if t.AgentMessage != "" {
				content += strong("worker>", statusInk(taskAgentStatus(t))) + " " + wrap(conciseAgentMessage(t.AgentMessage), inside-8) + "\n\n"
			}
		}
		if !compact && len(m.projectTasks()) == 0 {
			content += accent(uiText("PRIMER ENCARGO"), cyan) + "\n" + wrap(uiText(":task título | criterio de aceptación"), inside) + "\n\n" + accent(uiText("F6 · importar una issue de GitHub"), muted)
		}
	}
	if m.reviewedChatDecision() >= 0 {
		content = m.chatDecisionContent(inside, transcriptRows)
	}
	state, hint := m.sessionSummary()
	ink := cyan
	if state == uiText("NECESITA TU ATENCIÓN") || state == uiText("DESCONECTADO") {
		ink = amber
	}
	statusLine := strong(state+" · ", ink) + hint
	if m.pendingChatDecision() >= 0 {
		statusLine = strong(localText("DECISION · Ctrl+D to reply here", "DECISIÓN · Ctrl+D para responder acá"), amber)
	}
	if m.hasPendingPlanExecution() {
		statusLine = strong(localText("EXECUTION PENDING · type run plan", "EJECUCIÓN PENDIENTE · ejecutar plan"), amber)
	}
	if index := m.reviewedChatDecision(); index >= 0 {
		hint := localText("Answer here · Enter sends", "Respondé acá · Enter envía")
		if m.state.Decisions[index].ProposedTitle != "" {
			hint = localText("Type approve / reject · Enter", "Escribí apruebo / rechazo · Enter")
		}
		statusLine = strong(hint, amber)
	}
	if m.chatScroll > 0 {
		statusLine = accent(uiText("HISTORIAL · PgDn vuelve a los mensajes recientes"), amber)
	}
	composer := ansi.Truncate(statusLine, inside, "…") + "\n" + brandComposerRows(m.chatDraft[m.repo], inside, m.pane == 1, inputRows)
	return fit(content, inside, transcriptRows) + "\n" + fit(composer, inside, entryRows)
}

func (m *model) globalView(w, h int) string {
	if m.home {
		return m.homeView(w, h)
	}
	if w < 92 || m.panelMaximized {
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
	if index := m.pendingGoalProposal(); index >= 0 {
		d := m.state.Decisions[index]
		return strong(localText("REQUIREMENTS / PROPOSED SCOPE", "REQUISITOS / ALCANCE PROPUESTO"), amber) + "\n" +
			accent(localText("Chat · Ctrl+D to review and reply", "Chat · Ctrl+D para revisar y responder"), pink) + "\n\n" +
			wrap(d.ProposedTitle, w) + "\n\n" + strong(localText("ACCEPTANCE CRITERIA", "CRITERIOS DE ACEPTACIÓN"), cyan) + "\n" + wrap(d.ProposedAcceptance, w)
	}
	tasks := m.projectTasks()
	if len(tasks) == 0 && m.state.Goals[m.repo].ID != "" {
		goal := m.state.Goals[m.repo]
		return strong(uiText("CONTEXTO / ")+goal.Objective, cyan) + "\n" + wrap(goal.Acceptance, w) + "\n\n" + strong(uiText("OBJETIVO ACORDADO"), lime) + "\n\n" + wrap(uiText("Fluke prepara las tareas del plan. Podés conversar para afinarlo."), w)
	}
	if len(tasks) == 0 && m.state.DraftGoals[m.repo].Title != "" {
		draft := m.state.DraftGoals[m.repo]
		return strong(localText("REQUIREMENTS / DRAFT", "REQUISITOS / BORRADOR"), amber) + "\n\n" + wrap(draft.Title, w) + "\n\n" + wrap(draft.Acceptance, w) + "\n\n" + wrap(draft.OpenQuestions, w)
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
	content := ""
	if m.hasPendingPlanExecution() {
		content = accent(localText("EXECUTION PENDING · chat: run plan", "EJECUCIÓN PENDIENTE · chat: ejecutar plan"), amber) + "\n"
	}
	content += strong(uiText("CONTEXTO / ")+title, cyan) + "\n" + wrap(acceptance, w) + "\n\n"
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
	columns, gridRows := 2, 1
	if m.panelMaximized && m.pane == 2 {
		columns, gridRows = max(1, w/48), max(1, h/10)
		for i, task := range windows {
			if task.ID == selectedID {
				start = i / (columns * gridRows) * (columns * gridRows)
			}
		}
	}
	count := min(columns*gridRows, len(windows)-start)
	columns = min(columns, count)
	gridRows = (count + columns - 1) / columns
	colW := (w - columns + 1) / columns
	cellH := max(1, (h-gridRows+1)/gridRows)
	parts, renderedRows := []string{}, []string{}
	for i := 0; i < count; i++ {
		t := windows[start+i]
		ink := statusInk(taskAgentStatus(t))
		meta := accent(strings.ToUpper(t.AgentProvider), cyan) + accent(" / "+shortBranch(t.Branch), muted)
		if t.AgentProvider == "" {
			meta = accent(shortBranch(t.Branch), muted)
		}
		rows := max(1, cellH-9)
		activity := accent(uiText("Sin reporte todavía.\nF3 abre la sesión completa."), muted)
		if t.AgentMessage != "" {
			activity = strong("worker> ", cyan) + wrap(conciseAgentMessage(t.AgentMessage), max(1, colW-12))
			if len(t.AgentEvidence) > 0 {
				activity += "\n" + accent(uiText("Evidencia: ")+strings.Join(t.AgentEvidence, ", "), muted)
			}
		}
		body := meta + "\n" + rule(colW-4, muted) + "\n" + fit(activity, colW-4, rows) + "\n" + rule(colW-4, cyan) + "\n" + strong(status(taskAgentStatus(t)), ink) + "\n" + accent(uiText("F3 abrir sesión · F7 revisar diff"), muted)
		parts = append(parts, frame(t.Title, body, colW, cellH, cyan, m.pane == 2 && t.ID == selectedID))
		if i%columns == columns-1 || i == count-1 {
			renderedRows = append(renderedRows, lipgloss.JoinHorizontal(lipgloss.Top, parts...))
			parts = nil
		} else {
			parts = append(parts, " ")
		}
	}
	return strings.Join(renderedRows, "\n")
}

func (m *model) projectView(w, h int) string {
	if m.panelMaximized {
		switch m.pane {
		case 0:
			return frame(uiText("MISIÓN / ")+strings.ToUpper(filepath.Base(m.repo)), m.planContent(w-4, h-4), w, h, cyan, true)
		case 2:
			return m.workerPreviews(w, h)
		default:
			return frame(localText("FLUKE / CHAT · Ctrl+F restore", "FLUKE / CHAT · Ctrl+F restaurar"), m.conversation(w, h, true), w, h, cyan, true)
		}
	}
	if w < 92 || h < 20 {
		if m.pane == 1 {
			return frame(uiText("FLUKE SIGUE EL PROYECTO"), m.conversation(w, h, true), w, h, cyan, true)
		}
		if m.pane == 2 {
			return m.workerPreviews(w, h)
		}
		return frame(uiText("MISIÓN / ")+strings.ToUpper(filepath.Base(m.repo)), m.planContent(w-4, h-4), w, h, cyan, true)
	}
	right := max(36, w*45/100)
	left := w - right - 1
	upper := max(17, h*57/100)
	if h-upper < 10 {
		upper = h / 2
	}
	overview := frame(uiText("MISIÓN / ")+strings.ToUpper(filepath.Base(m.repo)), m.planContent(left-4, upper-4), left, upper, cyan, m.pane == 0)
	return lipgloss.JoinHorizontal(lipgloss.Top, overview+"\n"+m.workerPreviews(left, h-upper-1), " ", frame(uiText("FLUKE SIGUE EL PROYECTO"), m.conversation(right, h, true), right, h, cyan, m.pane == 1))
}

func (m *model) configView(w, h int) string {
	if m.configSection == 1 {
		return m.githubConfigView(w, h)
	}
	labels := []string{uiText("Proveedor (←/→)"), uiText("Ejecutable"), uiText("Modelo (←/→ o escribir)"), uiText("Argumentos JSON"), uiText("Máximo de workers")}
	content := accent(uiText("ORQUESTADOR / CONFIGURACIÓN"), pink) + "\n\n"
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

func (m *model) providerConfigContent(w int) string {
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
		if m.provider.Version != "" {
			content += "\n" + accent(m.provider.Version, muted)
		}
	}
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
		content := accent("GITHUB", pink) + " · "
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
	content := accent(uiText("CONFIGURACIÓN / GITHUB"), pink) + accent(uiText("   [Ctrl+O] Orquestador"), cyan) + "\n\n"
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
	if m.setup.open {
		view := tea.NewView(textStyle.Render(m.setupView()))
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
		if len(m.terminals.Windows) > 0 {
			terminal = m.terminals.View()
			body = terminal.Content
		} else {
			body = frame(uiText("SESIONES / TERMINALES"), m.contextContent(max(1, w-4))+uiText("\n\n:fluke abre el orquestador · :start ID abre un worker"), w, bodyH, cyan, false)
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
		body = m.review.view(w, bodyH)
	}
	if m.projects.open {
		body = m.projectEditorView(w, bodyH)
	}
	content := textStyle.Render(fit(m.header()+"\n"+fit(body, w, bodyH)+"\n"+m.footer(), w, h))
	// Nested styles reset SGR; restore the canvas ink instead of host defaults.
	content = strings.ReplaceAll(content, "\x1b[0m", "\x1b[0;38;2;238;234;250;48;2;11;6;25m")
	view := tea.NewView(content)
	view.BackgroundColor = ground
	view.AltScreen = true
	// Let the terminal own text selection/copy. Capture the mouse only while
	// arranging windows; a regular terminal should behave like a terminal.
	if m.view == 2 && m.terminals.Mode == windowMode && !m.projects.open && !m.config && !m.githubOpen && !m.review.open && m.command == nil && m.workerMessageID == "" {
		view.MouseMode = tea.MouseModeAllMotion
	}
	if m.view == 2 && !m.projects.open && !m.config && !m.githubOpen && !m.review.open && !m.quitting && m.command == nil && terminal.Cursor != nil {
		cursor := *terminal.Cursor
		cursor.Y += m.headerRows()
		view.Cursor = &cursor
	}
	return view
}
