package main

import (
	"fmt"
	"image/color"
	"path/filepath"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// Shell layout: a one-row header and a two-row footer around every view, and in
// F2 a single conversation surface with a persistent side rail (projects, plan,
// attention) plus a card for the project's workers. Narrow terminals keep the
// original three-row chrome and the pane-switching workspace.
const (
	shellMinWidth  = 100
	shellMinHeight = 24
)

func (m *model) shellMode() bool {
	return !m.setup.open && m.width >= shellMinWidth && m.height >= shellMinHeight
}

// The docked shell workspace; a floating chat keeps the pane-switching layout.
func (m *model) shellProject() bool { return m.shellMode() && !m.floatingVisible() }

func (m *model) pendingDecisions() int {
	n := 0
	for _, d := range m.state.Decisions {
		if d.Answer == nil {
			n++
		}
	}
	return n
}

func (m *model) shellLabel() string {
	if m.home || m.repo == "" {
		if len(m.state.Projects) == 1 {
			return localText("1 project", "1 proyecto")
		}
		return fmt.Sprintf(localText("%d projects", "%d proyectos"), len(m.state.Projects))
	}
	label := filepath.Base(m.repo)
	if m.state.PausedProjects[m.repo] {
		label += localText(" · paused", " · en pausa")
	}
	return label
}

func (m *model) shellLead() string {
	return strong(" ≋ fluke", cyan) + accent("  ·  ", borderInk) + ansi.Truncate(m.shellLabel(), 16, "…") + "  "
}

func (m *model) shellStatus() string {
	s := fmt.Sprintf("%d/%d", m.liveWorkers(), m.state.MaxWorkers)
	if n := m.pendingDecisions(); n > 0 {
		s += fmt.Sprintf(localText(" · %d to decide", " · %d por decidir"), n)
	}
	return s
}

// Columns left for the F1–F7 labels once brand, project and status are placed.
func (m *model) navBudget() int {
	if m.shellMode() {
		return m.width - ansi.StringWidth(m.shellLead()) - ansi.StringWidth(m.shellStatus()) - 3
	}
	return m.width - 2
}

// Where the navigation labels start: the legacy bar is row 1, the shell's is inside the header.
func (m *model) navOrigin() (x, y int) {
	if m.shellMode() {
		return ansi.StringWidth(m.shellLead()), 0
	}
	return 0, 1
}

func (m *model) shellHeader() string {
	w := max(1, m.width)
	right := m.shellStatus()
	space := max(1, w-ansi.StringWidth(right)-2)
	line := fit(ansi.Truncate(m.shellLead()+m.tabs(), space, "…"), space, 1) + " " + accent(right, attentionInk(m.pendingDecisions()))
	return fit(line, w, 1)
}

// ---- task presentation -------------------------------------------------

func taskGlyph(t Task) (string, color.Color) {
	s := taskAgentStatus(t)
	glyph := "○"
	switch s {
	case "integrated", "accepted":
		glyph = "✓"
	case "awaiting_review":
		glyph = "◉"
	case "running", "working":
		glyph = "◐"
	case "idle", "turn_finished":
		glyph = "◑"
	case "needs_response":
		glyph = "?"
	case "blocked", "waiting_dependencies":
		glyph = "⊘"
	case "interrupted":
		glyph = "!"
	case "paused", "pausing":
		glyph = "‖"
	}
	return glyph, statusInk(s)
}

func shellStatusWord(s string) string {
	switch s {
	case "running", "working":
		return localText("working", "trabajando")
	case "idle", "turn_finished":
		return localText("ready", "lista")
	case "awaiting_review":
		return localText("to review", "para revisar")
	case "accepted":
		return localText("accepted", "aceptada")
	case "integrated":
		return localText("integrated", "integrada")
	case "blocked":
		return localText("blocked", "bloqueada")
	case "needs_response":
		return localText("question", "pregunta")
	case "interrupted":
		return localText("interrupted", "interrumpida")
	case "paused", "pausing":
		return localText("paused", "pausada")
	case "queued":
		return localText("queued", "en cola")
	case "waiting_dependencies":
		return localText("waiting", "espera")
	case "pending":
		return localText("pending", "pendiente")
	}
	return s
}

func attentionKindWord(kind string) string {
	switch kind {
	case "decision":
		return localText("decide", "decidir")
	case "delivery":
		return localText("review", "revisar")
	case "report":
		return localText("reply", "responder")
	case "native":
		return localText("permission", "permiso")
	case "github":
		return "GitHub"
	}
	return kind
}

func compactTokens(n int64) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1e6)
	case n >= 1000:
		return fmt.Sprintf("%dk", n/1000)
	}
	return fmt.Sprintf("%d", n)
}

// Reported figures only: a run without reported usage or cost stays "—", never zero.
func taskUsageSummary(t Task) (tokens, cost string) {
	var total int64
	var spent float64
	tokenKnown, costKnown := false, false
	for _, u := range t.Metrics.Usage {
		tokenKnown = true
		total += u.InputTokens + u.OutputTokens
		if u.CostUSD != nil {
			costKnown = true
			spent += *u.CostUSD
		}
	}
	tokens, cost = "—", "—"
	if tokenKnown {
		tokens = compactTokens(total)
	}
	if costKnown {
		cost = fmt.Sprintf("$%.2f", spent)
	}
	return
}

func taskModelLabel(t Task) string {
	provider, model := t.AgentProvider, ""
	if c := t.WorkerConfig; c != nil {
		if c.Provider != "" {
			provider = c.Provider
		}
		model = c.Model
	}
	if provider == "" {
		return "—"
	}
	if model == "" {
		return provider
	}
	return provider + " · " + model
}

func padCell(s string, w int) string {
	s = ansi.Truncate(s, max(0, w), "…")
	return s + strings.Repeat(" ", max(0, w-ansi.StringWidth(s)))
}

func padLeftCell(s string, w int) string {
	s = ansi.Truncate(s, max(0, w), "…")
	return strings.Repeat(" ", max(0, w-ansi.StringWidth(s))) + s
}

// ---- geometry ------------------------------------------------------------

type shellGeometry struct {
	chat, rail                    rectangle
	inside, rows, inputRows       int
	cardTasks                     int
	cardRow, statusRow, editorRow int
}

func (m *model) shellGeometry() shellGeometry {
	w, h := m.width, max(1, m.workspaceHeight())
	rw := 26
	if w >= 140 {
		rw = 34
	} else if w >= 120 {
		rw = 30
	}
	cw := w - rw
	g := shellGeometry{chat: rectangle{0, 0, cw, h}, rail: rectangle{cw, 0, rw, h}, inside: max(1, cw-4)}
	g.cardTasks = min(len(m.projectTasks()), 4)
	g.inputRows = 2
	if h >= 30 {
		g.inputRows = 3
	}
	for {
		card := 0
		if g.cardTasks > 0 {
			card = 1 + g.cardTasks
		}
		// transcript + gap + card + status line + framed editor
		g.rows = h - 4 - card - g.inputRows
		if g.rows >= 4 {
			break
		}
		if g.cardTasks > 0 {
			g.cardTasks--
		} else if g.inputRows > 1 {
			g.inputRows--
		} else {
			break
		}
	}
	g.rows = max(1, g.rows)
	g.cardRow = g.rows + 1
	g.statusRow = g.cardRow
	if g.cardTasks > 0 {
		g.statusRow += 1 + g.cardTasks
	}
	g.editorRow = g.statusRow + 1
	return g
}

// First task shown by the workers card: the selection always stays visible.
func cardStart(count, shown, selected int) int {
	if count <= shown {
		return 0
	}
	return max(0, min(selected-shown+1, count-shown))
}

func (m *model) projectMessages() []ConversationMessage {
	messages := m.state.Conversations[m.repo]
	if len(messages) == 0 {
		messages = []ConversationMessage{{Role: "fluke", Text: localText("What do you want to build?\nLet's define the brief and plan.", "¿Qué querés construir?\nArmemos el brief y el plan.")}}
	}
	return messages
}

// ---- rendering -------------------------------------------------------------

func (m *model) shellProjectView(h int) string {
	g := m.shellGeometry()
	center := m.shellCenter(g)
	rail, _ := m.shellRail(g)
	rows := make([]string, h)
	for i := range rows {
		left, right := strings.Repeat(" ", g.chat.w), strings.Repeat(" ", g.rail.w)
		if i < len(center) {
			left = center[i]
		}
		if i < len(rail) {
			right = rail[i]
		}
		rows[i] = left + right
	}
	return strings.Join(rows, "\n")
}

func (m *model) shellCenter(g shellGeometry) []string {
	margin := "  "
	line := func(s string) string { return fit(margin+s, g.chat.w, 1) }
	lines := make([]string, 0, g.chat.h)
	transcript := conversationTranscriptAt(m.projectMessages(), g.inside, g.rows, m.chatScroll)
	for _, l := range strings.Split(fit(transcript, g.inside, g.rows), "\n") {
		lines = append(lines, line(l))
	}
	lines = append(lines, line(""))
	if g.cardTasks > 0 {
		for _, l := range m.shellCard(g) {
			lines = append(lines, line(l))
		}
	}
	state, hint := m.sessionSummary()
	if m.chatScroll > 0 {
		state, hint = localText("HISTORY · PgDn for recent messages", "HISTORIAL · PgDn para volver"), ""
	}
	actions := accent(strings.Join(chatActions(), " "), cyan)
	room := max(1, g.inside-ansi.StringWidth(strings.Join(chatActions(), " "))-1)
	left := accent(state, cyan)
	if hint != "" {
		left += accent("  ·  "+hint, muted)
	}
	left = fit(ansi.Truncate(left, room, "…"), room, 1)
	lines = append(lines, line(left+" "+actions))
	for _, l := range strings.Split(m.chatEditor(g.inside, g.inputRows, m.pane == 1), "\n") {
		lines = append(lines, line(l))
	}
	for len(lines) < g.chat.h {
		lines = append(lines, line(""))
	}
	return lines[:g.chat.h]
}

// Workers card: one row per task with its model, reported usage and time.
func (m *model) shellCard(g shellGeometry) []string {
	tasks := m.projectTasks()
	selected := 0
	if len(tasks) > 0 {
		selected = m.selected % len(tasks)
	}
	running, review := 0, 0
	for _, t := range tasks {
		switch taskAgentStatus(t) {
		case "running", "working", "idle", "turn_finished", "blocked", "needs_response":
			running++
		case "awaiting_review":
			review++
		}
	}
	head := strong("WORKERS", cyan) + accent(fmt.Sprintf(localText(" · %d active · %d to review", " · %d activos · %d para revisar"), running, review), muted)
	cap := accent(fmt.Sprintf(localText("limit %d/%d", "cupo %d/%d"), m.liveWorkers(), m.state.MaxWorkers), muted)
	gap := max(1, g.inside-ansi.StringWidth(head)-ansi.StringWidth(cap))
	marker := "  "
	if m.pane == 2 {
		marker = "› "
	}
	out := []string{fit(accent(marker, pink)+head+strings.Repeat(" ", gap-2)+cap, g.inside, 1)}
	// Drop columns in this order when space is short: model, tokens and cost, time.
	const statusW, timeW, costW, tokW, modelW = 12, 8, 8, 7, 22
	showModel, showUsage, showTime := true, true, true
	titleW := func() int {
		used := 2 + 2 + 1 + statusW
		if showTime {
			used += 1 + timeW
		}
		if showUsage {
			used += 2 + tokW + costW
		}
		if showModel {
			used += 1 + modelW
		}
		return g.inside - used
	}
	for _, drop := range []*bool{&showModel, &showUsage, &showTime} {
		if titleW() >= 16 {
			break
		}
		*drop = false
	}
	start := cardStart(len(tasks), g.cardTasks, selected)
	for i := start; i < len(tasks) && i < start+g.cardTasks; i++ {
		t := tasks[i]
		s := taskAgentStatus(t)
		glyph, ink := taskGlyph(t)
		mark := "  "
		if i == selected {
			mark = "› "
		}
		row := accent(mark, pink) + accent(glyph, ink) + " " + padCell(t.Title, titleW())
		if showModel {
			row += " " + accent(padCell(taskModelLabel(t), modelW), muted)
		}
		if showUsage {
			tokens, cost := taskUsageSummary(t)
			row += "  " + accent(padLeftCell(tokens, tokW), muted) + accent(padLeftCell(cost, costW), muted)
		}
		if showTime {
			elapsed := "—"
			if t.Metrics.ObservedMS > 0 {
				elapsed = metricsDuration(t.Metrics.ObservedMS)
			}
			row += " " + accent(padLeftCell(elapsed, timeW), muted)
		}
		row += " " + accent(padLeftCell(shellStatusWord(s), statusW), ink)
		out = append(out, fit(row, g.inside, 1))
	}
	return out
}

type shellHit struct {
	kind  string // "project", "task", "attention"
	index int
}

// Rail rows are returned with what a click on each row means; the same builder
// feeds rendering and hit testing.
func (m *model) shellRail(g shellGeometry) ([]string, []shellHit) {
	inner := max(8, g.rail.w-3)
	h := g.rail.h
	var lines []string
	var hits []shellHit
	add := func(text string, hit shellHit) {
		lines = append(lines, text)
		hits = append(hits, hit)
	}
	none := shellHit{}
	if m.insights {
		for _, l := range strings.Split(m.planContent(inner, h), "\n") {
			add(l, none)
		}
		return m.shellRailFrame(g, lines), hits
	}

	tasks := m.projectTasks()
	selected := 0
	if len(tasks) > 0 {
		selected = m.selected % len(tasks)
	}
	attention := m.attentionItems()
	perRepo := map[string]int{}
	for _, item := range attention {
		perRepo[item.Repo]++
	}

	// Projects
	add(strong(localText("PROJECTS", "PROYECTOS"), cyan), none)
	shown := min(len(m.state.Projects), 5)
	if h < 24 {
		shown = min(shown, 3)
	}
	first := 0
	for i, repo := range m.state.Projects {
		if repo == m.repo {
			first = max(0, min(i-shown+1, len(m.state.Projects)-shown))
		}
	}
	for i := first; i < first+shown && i < len(m.state.Projects); i++ {
		repo := m.state.Projects[i]
		s := summarizeProject(m.state, repo)
		right := fmt.Sprintf("%d/%d", s.Accepted, s.Total)
		if m.state.PausedProjects[repo] {
			right = "‖ " + right
		}
		if n := perRepo[repo]; n > 0 {
			right += fmt.Sprintf(" !%d", n)
		}
		mark, ink := "  ", muted
		if repo == m.repo {
			mark, ink = "› ", foreground
		}
		name := padCell(filepath.Base(repo), max(1, inner-2-ansi.StringWidth(right)-1))
		line := accent(mark, pink) + accent(name, ink) + " " + accent(right, attentionInk(perRepo[repo]))
		add(line, shellHit{"project", i})
	}
	if extra := len(m.state.Projects) - shown; extra > 0 {
		add(accent(fmt.Sprintf(localText("  +%d more · Ctrl+P", "  +%d más · Ctrl+P"), extra), muted), none)
	}
	add("", none)

	// Space left for plan and detail once attention is reserved.
	attentionRows := 2 + max(1, min(3, len(attention)))
	remaining := h - len(lines) - attentionRows
	add(strong("PLAN", cyan), none)
	goal := m.state.Goals[m.repo]
	if m.state.PausedProjects[m.repo] {
		add(strong(localText("PROJECT PAUSED", "PROYECTO PAUSADO"), amber), none)
		remaining--
	}
	if goal.ID != "" {
		for i, l := range strings.Split(wrap(goal.Objective, inner), "\n") {
			if i >= 2 {
				break
			}
			add(accent(ansi.Truncate(l, inner, "…"), muted), none)
			remaining--
		}
	}
	remaining -= 1 // plan heading
	if len(tasks) == 0 {
		add(accent(localText("Waiting for the first task", "Esperando el primer encargo"), muted), none)
	} else {
		// Keep room for a detail block when the rail is tall enough.
		detailRows := 0
		if remaining >= 12 {
			detailRows = min(8, remaining-6)
		}
		list := max(1, min(len(tasks), remaining-detailRows-1))
		start := cardStart(len(tasks), list, selected)
		for i := start; i < len(tasks) && i < start+list; i++ {
			t := tasks[i]
			glyph, ink := taskGlyph(t)
			mark, markInk := "  ", muted
			if i == selected {
				mark = "› "
				if m.pane != 1 {
					markInk = pink
				}
			}
			title := ansi.Truncate(t.Title, max(1, inner-6), "…")
			style := lipgloss.NewStyle().Foreground(foreground).Background(ground)
			switch taskAgentStatus(t) {
			case "integrated":
				style = lipgloss.NewStyle().Foreground(muted).Background(ground).Strikethrough(true)
			case "accepted":
				style = lipgloss.NewStyle().Foreground(muted).Background(ground)
			}
			add(accent(mark, markInk)+accent(glyph, ink)+" "+accent(fmt.Sprintf("%d ", i+1), muted)+style.Render(title), shellHit{"task", i})
		}
		if detailRows > 0 {
			add("", none)
			for _, l := range m.shellDetail(tasks[selected], inner, detailRows) {
				add(l, none)
			}
		}
	}
	add("", none)

	// Attention (all projects)
	add(strong(localText("ATTENTION", "ATENCIÓN"), amber), none)
	if len(attention) == 0 {
		add(accent(localText("All clear.", "Todo despejado."), lime), none)
	}
	for i, item := range attention {
		if i >= 3 {
			break
		}
		label := filepath.Base(item.Repo)
		for _, t := range m.state.Tasks {
			if t.ID == item.TaskID {
				label += " / " + t.Title
				break
			}
		}
		add(strong("! ", amber)+accent(ansi.Truncate(attentionKindWord(item.Kind)+" · "+label, max(1, inner-2), "…"), foreground), shellHit{"attention", i})
	}
	if len(attention) > 3 {
		add(accent(fmt.Sprintf(localText("  +%d more · F1", "  +%d más · F1"), len(attention)-3), muted), none)
	}
	return m.shellRailFrame(g, lines), hits
}

// Selected task: when it is done and what the worker last reported.
func (m *model) shellDetail(t Task, w, rows int) []string {
	lines := []string{strong(localText("DONE WHEN", "TERMINADO CUANDO"), cyan)}
	for _, l := range strings.Split(wrap(t.Acceptance, w), "\n") {
		lines = append(lines, l)
	}
	if t.AgentMessage != "" {
		lines = append(lines, "", strong(localText("LAST REPORT", "ÚLTIMO REPORTE"), cyan))
		for _, l := range strings.Split(wrap(conciseAgentMessage(t.AgentMessage), w), "\n") {
			lines = append(lines, l)
		}
	}
	if reason := m.dependencyChecks[t.ID]; reason != "" {
		lines = append(lines, "", accent(wrap(cleanAgentText(reason), w), amber))
	}
	if len(lines) > rows {
		lines = lines[:rows]
		lines[rows-1] = ansi.Truncate(lines[rows-1], max(1, w-1), "") + accent("…", muted)
	}
	return lines
}

func (m *model) shellRailFrame(g shellGeometry, lines []string) []string {
	inner := max(1, g.rail.w-3)
	out := make([]string, g.rail.h)
	for i := range out {
		body := ""
		if i < len(lines) {
			body = lines[i]
		}
		out[i] = accent("│", borderInk) + " " + fit(body, inner, 1) + " "
	}
	return out
}

// ---- pointer -------------------------------------------------------------

func (m *model) shellClickable() bool {
	return m.view == 1 && m.shellProject() && !m.mouseDisabled && !m.config && !m.githubOpen && !m.review.open && !m.projects.open && !m.quitting && m.command == nil && m.workerMessageID == "" && m.switcher == nil
}

func (m *model) clickShell(mouse tea.Mouse) (bool, tea.Cmd) {
	if mouse.Button != tea.MouseLeft || !m.shellClickable() {
		return false, nil
	}
	g := m.shellGeometry()
	x, y := mouse.X, mouse.Y-m.headerRows()
	if y < 0 || y >= g.chat.h || x < 0 || x >= m.width {
		return false, nil
	}
	tasks := m.projectTasks()
	if x < g.chat.w {
		m.pane = 1
		if y == g.statusRow {
			actions := strings.Join(chatActions(), " ")
			origin := 2 + g.inside - ansi.StringWidth(actions)
			switch actionAt(x-origin, chatActions()) {
			case 0:
				return true, m.chatKey(tea.KeyPressMsg{Code: tea.KeyEnter})
			case 1:
				if !m.sessionAlive("fluke:" + m.repo) {
					m.notice = localText("Send a message to connect Fluke.", "Enviá un mensaje para conectar Fluke.")
					return true, nil
				}
				m.closePanels()
				m.view, m.home = 2, false
				m.focus("fluke:" + m.repo)
				m.terminals.Mode = terminalMode
			case 2:
				m.toggleFloatingChat()
			}
			return true, nil
		}
		if g.cardTasks > 0 && y > g.cardRow && y <= g.cardRow+g.cardTasks && len(tasks) > 0 {
			selected := m.selected % len(tasks)
			m.selected = cardStart(len(tasks), g.cardTasks, selected) + y - g.cardRow - 1
			m.taskScroll, m.pane = 0, 2
		}
		return true, nil
	}
	_, hits := m.shellRail(g)
	if m.pane != 2 {
		m.pane = 0
	}
	if y < len(hits) {
		switch hit := hits[y]; hit.kind {
		case "task":
			m.selected, m.taskScroll = hit.index, 0
		case "attention":
			m.openAttention(hit.index)
		case "project":
			if hit.index < len(m.state.Projects) && m.state.Projects[hit.index] != m.repo {
				m.closePanels()
				m.repo, m.home, m.view, m.pane, m.selected = m.state.Projects[hit.index], false, 1, 1, 0
				m.chatScroll, m.taskScroll, m.insights = 0, 0, false
				m.hideFlukeTerminals()
			}
		}
	}
	return true, nil
}
