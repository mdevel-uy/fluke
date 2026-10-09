package main

import (
	"fmt"
	"github.com/hinshun/vt10x"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func TestGlobalNavigationEscapesEditorsAndReview(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	repo := t.TempDir()
	state.Orchestrator = &AgentConfig{Provider: "codex", Executable: "codex"}
	_ = state.addTask(repo, "Una tarea", "Un resultado verificable")
	state.Decisions = []Decision{{Repo: repo, TaskID: state.Tasks[0].ID, Question: "Continuar?"}}
	m := newModel(store, state, repo)
	defer m.cleanup()
	for _, code := range []rune{tea.KeyF1, tea.KeyF2, tea.KeyF3, tea.KeyF4} {
		m.openConfig()
		m.githubOpen = true
		m.review.open = true
		m.Update(tea.KeyPressMsg{Code: code})
		if m.view != int(code-tea.KeyF1) || m.config || m.githubOpen || m.review.open {
			t.Fatalf("%v quedó atrapada en un panel", code)
		}
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyF7})
	if !m.review.open || m.review.task.ID != state.Tasks[0].ID {
		t.Fatal("F7 no abre la revisión de la tarea seleccionada")
	}
	generation := m.review.generation
	m.Update(tea.KeyPressMsg{Code: tea.KeyF7})
	if !m.review.open || m.review.generation != generation || m.view != 3 {
		t.Fatal("F7 repetido abandona o reinicia la revisión desde F4")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	if m.review.open {
		t.Fatal("Esc no cierra la revisión")
	}
	m.openConfig()
	m.Update(tea.KeyPressMsg{Code: '2', Mod: tea.ModAlt})
	if m.view != 1 || m.config {
		t.Fatal("Alt+2 no funciona como alternativa a F2")
	}
	if m.View().MouseMode != tea.MouseModeNone {
		t.Fatal("la interfaz captura la selección de texto del terminal")
	}
	m.globalKey("ctrl+x")
	if m.View().MouseMode != tea.MouseModeAllMotion {
		t.Fatal("gestión de ventanas perdió el mouse")
	}
}

func TestReviewNavigationWithoutTasks(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	m := newModel(store, state, t.TempDir())
	defer m.cleanup()
	m.width, m.height = 120, 35
	m.Update(tea.KeyPressMsg{Code: tea.KeyF4})
	_, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyF7})
	if !m.review.open || m.review.task.ID != "" || m.review.loading || cmd != nil {
		t.Fatal("F7 sin tareas no abre una revisión vacía")
	}
	text := ansi.Strip(m.review.view(120, 25))
	if !strings.Contains(text, "TODAVÍA NO HAY TAREAS") || strings.Contains(text, "Worktree limpio") || strings.Contains(text, "Aceptar") || strings.Contains(text, "Publicar") {
		t.Fatalf("revisión vacía engañosa: %s", text)
	}
	for _, key := range []string{"f7", "r", "a", "p", "m"} {
		if _, cmd := m.Update(tea.KeyPressMsg{Code: map[string]rune{"f7": tea.KeyF7, "r": 'r', "a": 'a', "p": 'p', "m": 'm'}[key]}); cmd != nil || !m.review.open || m.command != nil || m.review.loading {
			t.Fatalf("%s activó una tarea inexistente o cerró revisión", key)
		}
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	if m.review.open || m.view != 3 {
		t.Fatal("Esc no volvió a F4")
	}
}

func TestComposerCursorMatchesInsertionPoint(t *testing.T) {
	for _, draft := range []string{"", "hola", "hola  ", "界🔥  ", strings.Repeat("界🔥", 30) + "  "} {
		for _, width := range []int{8, 20, 60} {
			view := ansi.Strip(brandComposer(draft, width, true))
			lines := strings.Split(view, "\n")
			var recovered strings.Builder
			for i, line := range lines[1 : len(lines)-1] {
				if i == len(lines)-3 {
					recovered.WriteString(strings.SplitN(ansi.Cut(line, 4, width-1), "▌", 2)[0])
				} else {
					recovered.WriteString(ansi.Cut(line, 4, width-2))
				}
			}
			if recovered.String() != draft {
				t.Fatalf("draft lost text at width %d: got %q, want %q", width, recovered.String(), draft)
			}
			if !strings.Contains(lines[len(lines)-2], "▌") {
				t.Fatalf("cursor not on last input row: %q", lines)
			}
			for _, line := range lines {
				if ansi.StringWidth(line) != width {
					t.Fatalf("composer excede ancho %d: %q", width, line)
				}
			}
		}
	}
}

func TestDraftAndPreparedCommandsStayVisible(t *testing.T) {
	for _, draft := range []string{"Hola Fluke", "Quiero probar " + strings.Repeat("texto ", 30) + "FINAL"} {
		body := ansi.Strip(brandComposer(draft, 60, true))
		if strings.HasSuffix(draft, "FINAL") {
			if !strings.Contains(body, "FINAL") {
				t.Fatal("long draft hides current typing", body)
			}
		} else if !strings.Contains(body, draft) {
			t.Fatal("short draft disappeared", body)
		}
	}
	if !strings.Contains(ansi.Strip(brandComposer("", 60, true)), "Hablá con Fluke") {
		t.Fatal("empty composer hint disappeared")
	}
	line := "rework t123 | "
	m := &model{width: 140, height: 40, command: &line}
	if !strings.Contains(ansi.Strip(m.footer()), line) {
		t.Fatal("prepared review command disappeared")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	if m.command != nil {
		t.Fatal("Escape didn't cancel prepared command")
	}
	m.command = &line
	line = strings.Repeat("texto ", 50) + "FINAL"
	if !strings.Contains(ansi.Strip(m.footer()), "FINAL") {
		t.Fatal("long command hides current typing")
	}
	for _, text := range []string{"abc", "αβ🔥abcdefgh", "a very long path ending in repo"} {
		for _, width := range []int{1, 4, 30} {
			if ansi.StringWidth(tailText(text, width)) > width {
				t.Fatal("tail overflows display width")
			}
		}
	}
}

func TestProviderSwitchResetsIncompatibleFlagsAndModel(t *testing.T) {
	m := &model{draft: [5]string{"codex", "codex", "codex-model", `["--sandbox","workspace-write"]`, "2"}}
	m.cycleProvider(false)
	if m.draft[0] != "claude" || m.draft[1] != "claude" || m.draft[2] != "" || m.draft[3] != "[]" {
		t.Fatalf("configuración de Codex se filtró a Claude: %v", m.draft)
	}
	m.cycleModel(false)
	if m.draft[2] != "sonnet" {
		t.Fatal("selector de modelos no cambia el valor")
	}
	m.cycleProvider(true)
	if m.draft[0] != "codex" {
		t.Fatal("flecha izquierda no retrocede proveedor")
	}
}

func TestConversationPagingKeepsOlderUsefulMessages(t *testing.T) {
	messages := []ConversationMessage{{Role: "human", Text: "primer pedido"}, {Role: "fluke", Text: "primera respuesta"}, {Role: "human", Text: "último pedido"}, {Role: "fluke", Text: "última respuesta"}}
	latest := ansi.Strip(conversationTranscriptAt(messages, 60, 3, 0))
	older := ansi.Strip(conversationTranscriptAt(messages, 60, 3, 100))
	if !strings.Contains(latest, "última respuesta") || !strings.Contains(older, "primer pedido") {
		t.Fatal("no se puede volver al comienzo del historial")
	}
}

func TestComposerGrowsAndKeepsMultilineDraft(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	m := newModel(store, state, t.TempDir())
	defer m.cleanup()
	m.home, m.config, m.view, m.pane = false, false, 1, 1
	m.Update(tea.PasteMsg{Content: "PRIMERA línea\r\nSEGUNDA línea"})
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter, Mod: tea.ModAlt})
	m.Update(tea.PasteMsg{Content: "TERCERA línea"})
	want := "PRIMERA línea\nSEGUNDA línea\nTERCERA línea"
	if m.chatDraft[m.repo] != want {
		t.Fatalf("paste or newline changed draft: %q", m.chatDraft[m.repo])
	}
	body := ansi.Strip(m.conversation(64, 22, true))
	for _, part := range strings.Split(want, "\n") {
		if !strings.Contains(body, part) {
			t.Fatalf("multiline input is hidden: %q", body)
		}
	}
	shortRows := len(strings.Split(brandComposer("hola", 30, true), "\n"))
	longRows := len(strings.Split(brandComposer(strings.Repeat("texto", 20), 30, true), "\n"))
	if longRows <= shortRows {
		t.Fatal("composer did not expand as text wrapped")
	}
	m.chatDraft[m.repo] = "COMIENZO " + strings.Repeat("texto ", 300) + "FINAL"
	for _, size := range [][2]int{{44, 16}, {70, 24}, {30, 12}} {
		body = ansi.Strip(m.conversation(size[0], size[1], true))
		if len(strings.Split(body, "\n")) != size[1]-4 || !strings.Contains(body, "FINAL▌") || !strings.Contains(body, "┌…") {
			t.Fatalf("long draft does not fit viewport %v: %q", size, body)
		}
	}
	if !strings.HasPrefix(m.chatDraft[m.repo], "COMIENZO ") {
		t.Fatal("resizing changed the stored draft")
	}
}

func TestProjectScopeProposalIsVisibleAndSelectedForApproval(t *testing.T) {
	m := projectTestModel(t)
	m.repo, m.home, m.view, m.pane = t.TempDir(), false, 1, 1
	m.state.Decisions = []Decision{
		{Repo: m.repo, Question: "Old introductory question"},
		{Repo: t.TempDir(), ProposedGoal: true, ProposedTitle: "Other project", ProposedAcceptance: "Other requirements"},
		{Repo: m.repo, ProposedGoal: true, ProposedTitle: "Delivery planning", ProposedAcceptance: "Save customers and optimize delivery stops"},
	}
	s := &orchestratorSession{RunID: "run", Dir: t.TempDir()}
	m.orchestration[m.repo] = s
	plan := ansi.Strip(m.planContent(90, 20))
	if !strings.Contains(plan, "Delivery planning") || !strings.Contains(plan, "Save customers and optimize delivery stops") || !strings.Contains(plan, "Ctrl+D") {
		t.Fatalf("pending requirements are hidden: %q", plan)
	}
	if !strings.Contains(ansi.Strip(m.conversation(90, 20, true)), "Ctrl+D") {
		t.Fatal("chat does not explain next step")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyF4})
	if m.selectedDecision() != 2 {
		t.Fatal("old question obscures pending scope proposal")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if m.command == nil || *m.command != "approve 3" || len(m.state.Goals) != 0 {
		t.Fatal("review did not prepare the correct approval")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	goal := m.state.Goals[m.repo]
	if goal.ID == "" || !s.Notify || m.pendingGoalProposal() != -1 || len(m.state.Tasks) != 0 {
		t.Fatal("approval did not notify orchestrator to decompose scope")
	}
	if _, err := m.applyOrchestratorCommand(m.repo, orchestratorCommand{Action: "create_task", RunID: "run", Seq: 1, GoalID: goal.ID, Title: "Customer records", Acceptance: "Create and reopen saved customers"}); err != nil {
		t.Fatal(err)
	}
	if len(m.state.Tasks) != 1 || m.state.Tasks[0].Queued || !m.state.Tasks[0].AwaitingExecution || m.state.Tasks[0].GoalID != goal.ID {
		t.Fatal("approved requirements did not permit plan creation before execution")
	}
}

func TestChatMaximizeRestoresLayoutAndKeepsDraft(t *testing.T) {
	m := projectTestModel(t)
	m.repo, m.home, m.view, m.pane, m.width, m.height = t.TempDir(), false, 1, 1, 140, 40
	m.chatDraft[m.repo] = "No perder este borrador"
	m.Update(tea.KeyPressMsg{Code: tea.KeyF8})
	if !m.panelMaximized || m.pane != 1 || m.view != 1 {
		t.Fatal("F8 did not maximize and focus chat")
	}
	text := ansi.Strip(m.View().Content)
	if !strings.Contains(text, "No perder este borrador") || strings.Contains(text, "TU PRÓXIMA MISIÓN") {
		t.Fatal("maximized chat did not replace project panels")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
	if m.pane != 1 {
		t.Fatal("Tab hid the maximized composer")
	}
	m.Update(tea.WindowSizeMsg{Width: 76, Height: 28})
	if !strings.Contains(ansi.Strip(m.View().Content), "No perder este borrador") {
		t.Fatal("terminal resize lost draft")
	}
	m.Update(tea.KeyPressMsg{Code: 'f', Mod: tea.ModCtrl})
	if m.panelMaximized || m.pane != 1 || m.chatDraft[m.repo] != "No perder este borrador" {
		t.Fatal("restoring layout lost focus or draft")
	}
	m.openConfig()
	m.Update(tea.KeyPressMsg{Code: tea.KeyF8})
	if m.panelMaximized || !m.config {
		t.Fatal("maximize shortcut escaped configuration")
	}
}

func TestMaximizeUsesFocusedPanelAndShowsMoreAgents(t *testing.T) {
	m := projectTestModel(t)
	m.repo, m.home, m.view, m.width, m.height = t.TempDir(), false, 1, 180, 65
	for i := 0; i < 10; i++ {
		id := fmt.Sprintf("agent-%02d", i)
		m.state.Tasks = append(m.state.Tasks, Task{ID: id, Repo: m.repo, Title: id, Status: "running", AgentMessage: "Working"})
		m.terminals.Windows = append(m.terminals.Windows, &terminalWindow{ID: id, Name: id, screen: vt10x.New(vt10x.WithSize(50, 12))})
		m.sessions[id] = id
	}
	defer func() { m.terminals.Windows = nil }()
	for _, pane := range []int{0, 1, 2} {
		m.pane = pane
		m.Update(tea.KeyPressMsg{Code: 'f', Mod: tea.ModCtrl})
		if !m.panelMaximized || m.pane != pane {
			t.Fatal("maximize changed the focused panel", pane)
		}
		text := ansi.Strip(m.View().Content)
		if pane == 2 {
			for i := 0; i < 10; i++ {
				if !strings.Contains(strings.ToLower(text), fmt.Sprintf("agent-%02d", i)) {
					t.Fatal("expanded worker panel omitted an agent", i)
				}
			}
		}
		m.Update(tea.KeyPressMsg{Code: 'f', Mod: tea.ModCtrl})
		if m.panelMaximized || m.pane != pane {
			t.Fatal("restore changed focus", pane)
		}
	}
}

func TestMaximizeNativeTerminalRestoresGeometryAndTracksFocus(t *testing.T) {
	m := projectTestModel(t)
	m.view = 2
	m.Update(tea.WindowSizeMsg{Width: m.width, Height: m.height})
	pauseTestWindow(t, m, "first")
	pauseTestWindow(t, m, "second")
	tiled := make([]rectangle, len(m.terminals.Windows))
	for i, w := range m.terminals.Windows {
		tiled[i] = rectangle{w.x, w.y, w.w, w.h}
	}
	m.Update(tea.KeyPressMsg{Code: 'f', Mod: tea.ModCtrl})
	m.Update(tea.KeyPressMsg{Code: 'f', Mod: tea.ModCtrl})
	for i, w := range m.terminals.Windows {
		if (rectangle{w.x, w.y, w.w, w.h}) != tiled[i] {
			t.Fatal("zoom lost tiled layout")
		}
	}
	m.terminals.ToggleTiling()
	first, second := m.terminals.Windows[0], m.terminals.Windows[1]
	first.x, first.y, first.w, first.h = 3, 2, 50, 20
	second.x, second.y, second.w, second.h = 10, 5, 60, 14
	m.terminals.layout()
	m.terminals.FocusWindow(1)
	before := rectangle{second.x, second.y, second.w, second.h}
	normalHeight := m.workspaceHeight()
	m.Update(tea.KeyPressMsg{Code: 'f', Mod: tea.ModCtrl})
	if m.headerRows() != 1 || m.terminals.height != m.workspaceHeight() || m.workspaceHeight() <= normalHeight {
		t.Fatal("native zoom did not reclaim header space")
	}
	if second.x != 0 || second.y != 0 || second.w != m.terminals.width || second.h != m.terminals.height {
		t.Fatal("focused terminal did not fill workspace")
	}
	cols, rows, err := second.pty.Size()
	if err != nil || cols != second.w-2 || rows != second.h-3 {
		t.Fatal("native PTY did not resize", cols, rows, err)
	}
	if strings.Contains(ansi.Strip(m.terminals.View().Content), "first") {
		t.Fatal("another terminal is visible in zoom")
	}
	m.terminals.FocusWindow(0)
	if m.terminals.zoomedID != first.ID || first.w != m.terminals.width || (rectangle{second.x, second.y, second.w, second.h}) != before {
		t.Fatal("changing focus did not transfer zoom and restore old window")
	}
	m.Update(tea.WindowSizeMsg{Width: 90, Height: 30})
	// The window-manager resize normally runs through the returned tea command.
	m.terminals.Update(tea.WindowSizeMsg{Width: 90, Height: m.workspaceHeight()})
	m.terminals.FocusWindow(1)
	m.Update(tea.KeyPressMsg{Code: 'f', Mod: tea.ModCtrl})
	if m.terminals.zoomedID != "" || (rectangle{second.x, second.y, second.w, second.h}) != before {
		t.Fatal("restore lost floating geometry after resize")
	}
	if m.terminals.height != m.workspaceHeight() || m.headerRows() != 6 {
		t.Fatal("restoring native zoom did not restore header and workspace")
	}
}

func TestCompactHeaderKeepsSectionsAndReclaimsSpace(t *testing.T) {
	m := projectTestModel(t)
	m.repo, m.home, m.view, m.pane, m.height = t.TempDir(), false, 1, 1, 38
	for _, width := range []int{44, 76, 100, 140} {
		m.width = width
		normalHeight := m.workspaceHeight()
		normalRows := m.headerRows()
		m.Update(tea.KeyPressMsg{Code: 'f', Mod: tea.ModCtrl})
		header := ansi.Strip(m.header())
		if m.headerRows() != 1 || strings.Contains(header, "\n") || !strings.Contains(header, "▙▟") || strings.Contains(header, "◆") {
			t.Fatal("maximized header is not a single row with the small icon", width, header)
		}
		for section := 1; section <= 7; section++ {
			if !strings.Contains(header, fmt.Sprintf("F%d", section)) {
				t.Fatal("compact header lost a section", width, section, header)
			}
		}
		if ansi.StringWidth(header) != width || m.workspaceHeight() != normalHeight+normalRows-1 {
			t.Fatal("compact header did not reclaim the expected rows", width)
		}
		m.Update(tea.KeyPressMsg{Code: 'f', Mod: tea.ModCtrl})
		if m.headerRows() != normalRows || m.workspaceHeight() != normalHeight {
			t.Fatal("restore did not recover the normal header", width)
		}
	}
	m.width = 140
	lines := strings.Split(ansi.Strip(m.header()), "\n")
	if strings.TrimSpace(string([]rune(lines[3])[1:21])) != "" || !strings.Contains(lines[4], "F1") {
		t.Fatal("normal logo still touches the navigation row")
	}
}
