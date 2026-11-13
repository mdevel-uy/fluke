package main

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/hinshun/vt10x"
)

func TestBriefEditorSameContentDockedAndFloating(t *testing.T) {
	for _, floating := range []bool{false, true} {
		m := projectTestModel(t)
		m.repo, m.home, m.view, m.pane = t.TempDir(), false, 1, 1
		if floating {
			m.toggleFloatingChat()
		}
		m.Update(tea.PasteMsg{Content: "Una app\r\nCriterio: rápido界"})
		m.Update(tea.KeyPressMsg{Code: tea.KeyHome})
		m.Update(tea.PasteMsg{Content: "2. "})
		m.Update(tea.KeyPressMsg{Code: tea.KeyEnd})
		m.Update(tea.KeyPressMsg{Code: tea.KeyLeft})
		m.Update(tea.KeyPressMsg{Code: tea.KeyDelete})
		m.Update(tea.KeyPressMsg{Code: tea.KeyEnter, Mod: tea.ModAlt})
		m.Update(tea.PasteMsg{Content: "3. Verificable"})
		want := "Una app\n2. Criterio: rápido\n3. Verificable"
		if got := m.chatDraft[m.repo]; got != want {
			t.Fatalf("floating=%v: %q", floating, got)
		}
		m.Update(tea.KeyPressMsg{Code: tea.KeyHome, Mod: tea.ModCtrl})
		m.Update(tea.PasteMsg{Content: "Brief: "})
		if m.chatDraft[m.repo] != "Brief: "+want {
			t.Fatal("insert at beginning lost text")
		}
		view := ansi.Strip(m.chatEditor(44, 3, true))
		if !strings.Contains(view, "Brief: ▌Una app") || !strings.Contains(view, "2. Criterio") {
			t.Fatal(view)
		}
		for _, line := range strings.Split(view, "\n") {
			if ansi.StringWidth(line) != 44 {
				t.Fatal("editor width", line)
			}
		}
		before := m.chatDraft[m.repo]
		m.insertChat(strings.Repeat("x", 16001))
		if m.chatDraft[m.repo] != before {
			t.Fatal("oversized paste damaged draft")
		}
	}
}

func TestWrappedBriefAndLongTaskDetails(t *testing.T) {
	m := projectTestModel(t)
	m.repo, m.home, m.view, m.pane, m.width, m.height = t.TempDir(), false, 1, 1, 44, 24
	m.insertChat(strings.Repeat("a", 80))
	end := m.chatPosition()
	m.chatKey(tea.KeyPressMsg{Code: tea.KeyUp})
	if m.chatPosition() >= end {
		t.Fatal("up ignored soft wrap")
	}
	m.chatKey(tea.KeyPressMsg{Code: tea.KeyDown})
	if m.chatPosition() != end {
		t.Fatal("down failed to restore visual column")
	}
	m.state.Tasks = []Task{{ID: "t123", Repo: m.repo, Status: "pending", Acceptance: strings.Repeat("criterion ", 100), AgentEvidence: []string{"FINAL EVIDENCE"}}}
	m.pane = 2
	m.taskScroll = 10000
	if !strings.Contains(ansi.Strip(m.taskPanel(40, 13)), "FINAL EVIDENCE") {
		t.Fatal("long task evidence unreachable")
	}
	before := m.taskScroll
	m.Update(tea.KeyPressMsg{Code: tea.KeyPgUp})
	if m.taskScroll >= before {
		t.Fatal("Workers keyboard scroll disconnected")
	}
	m.Update(tea.KeyPressMsg{Code: 'a', Text: "a"})
	if m.command == nil || !strings.HasPrefix(*m.command, "agent t123") {
		t.Fatal("Workers agent action disconnected")
	}
}

func TestChatKeepsCompleteReplyAndScrollReversesAtBoundary(t *testing.T) {
	m := projectTestModel(t)
	m.repo, m.home, m.view, m.pane, m.width, m.height = t.TempDir(), false, 1, 1, 80, 30
	dir := t.TempDir()
	m.orchestration[m.repo] = &orchestratorSession{RunID: "test", Dir: dir}
	text := strings.Repeat("Acceptance criterion: complete and verifiable.\n", 40) + "FINAL CRITERION"
	if err := atomicJSON(filepath.Join(dir, "update.json"), orchestratorMessage{Version: 1, RunID: "test", Seq: 1, Message: text}); err != nil {
		t.Fatal(err)
	}
	m.readOrchestratorMessages()
	if got := m.state.Conversations[m.repo]; len(got) != 1 || got[0].Text != text {
		t.Fatal("reply truncated", got)
	}
	for range 100 {
		m.scrollChat(20)
	}
	before := m.chatScroll
	m.scrollChat(-3)
	if m.chatScroll != before-3 {
		t.Fatal("scroll accumulated hidden offset", before, m.chatScroll)
	}
	page := m.chatBody(80, 24, true)
	m.scrollChat(-10000)
	if page == m.chatBody(80, 24, true) || !strings.Contains(ansi.Strip(m.chatBody(80, 24, true)), "FINAL CRITERION") {
		t.Fatal("cannot return to latest message")
	}
}

func TestProjectMouseJourneyAndKeyboardRefocus(t *testing.T) {
	m := projectTestModel(t)
	a, b := t.TempDir(), t.TempDir()
	m.state.Projects = []string{a, b}
	// 99 columns keeps the pane-switching workspace; the shell starts at 100.
	m.repo, m.selected, m.width, m.height = a, 1, 99, 40
	m.globalKey("ctrl+f")
	if m.repo != b {
		t.Fatal("chat ignored highlighted project")
	}
	bounds := m.floating.bounds
	m.globalKey("f2")
	m.globalKey("ctrl+f")
	if !m.floating.focused || m.floating.bounds != bounds {
		t.Fatal("refocus lost window placement")
	}
	m.toggleFloatingChat()
	m.state.Tasks = []Task{{ID: "task-1", Repo: b, Title: "First task", Acceptance: "VISIBLE CRITERION", Status: "pending"}, {ID: "task-2", Repo: b, Title: "Second task", Status: "pending"}}
	m.Update(tea.MouseClickMsg{X: 9, Y: m.headerRows(), Button: tea.MouseLeft})
	if m.pane != 0 {
		t.Fatal("Plan button didn't focus plan")
	}
	chat, detail := m.projectPanels()
	m.Update(tea.MouseClickMsg{X: detail.x + 3, Y: m.headerRows() + detail.y + 4, Button: tea.MouseLeft})
	if m.selected != 1 {
		t.Fatal("task click failed")
	}
	m.Update(tea.MouseClickMsg{X: chat.x + 3, Y: m.headerRows() + chat.y + 5, Button: tea.MouseLeft})
	m.Update(tea.PasteMsg{Content: "Draft remains here"})
	if m.pane != 1 || m.chatDraft[b] != "Draft remains here" {
		t.Fatal("chat mouse focus failed")
	}
	// Pin action is located from the exact rendered labels and panel rectangle.
	x := chat.x + 2 + ansi.StringWidth(strings.Join(chatActions()[:2], " ")) + 1
	m.Update(tea.MouseClickMsg{X: x, Y: m.headerRows() + chat.y + chat.h - 3, Button: tea.MouseLeft})
	if !m.floating.open {
		t.Fatal("visible pin button didn't work")
	}
	if dock, _ := m.projectPanels(); dock.w != 0 {
		t.Fatal("pinned chat duplicated docked chat")
	}
}

func TestChatWorkspaceCaptures(t *testing.T) {
	previous := uiLanguage()
	setUILanguage("es")
	t.Cleanup(func() { setUILanguage(previous) })
	m := projectTestModel(t)
	m.repo, m.home, m.view, m.pane = t.TempDir(), false, 1, 1
	m.state.Projects = []string{m.repo}
	m.state.Tasks = []Task{{ID: "task-1", Repo: m.repo, Title: "Exportar pedidos", Acceptance: "CSV con fecha, cliente y total; validar un pedido vacío.", Status: "awaiting_review", AgentMessage: "Exportación lista. Probé el CSV con pedidos y sin resultados.", AgentEvidence: []string{"orders/export_test.go"}}}
	m.state.Conversations = map[string][]ConversationMessage{m.repo: {{Role: "human", Text: "Quiero que mis clientes puedan exportar sus pedidos."}, {Role: "fluke", Text: "La exportación está lista para revisar. El worker verificó el archivo y el caso sin pedidos.\n\nAbrí Revisar en el plan: ahí están el criterio acordado, su evidencia y los cambios. La vista móvil sigue pendiente."}}}
	m.insertChat("Antes de aceptar:\n¿Incluye pedidos cancelados?")
	for _, size := range [][2]int{{140, 40}, {80, 30}, {44, 24}} {
		m.width, m.height = size[0], size[1]
		view := m.View().Content
		for _, line := range strings.Split(ansi.Strip(view), "\n") {
			if ansi.StringWidth(line) > size[0] {
				t.Fatal("horizontal overflow", line)
			}
		}
		if !strings.Contains(ansi.Strip(view), "[Enviar]") || !strings.Contains(ansi.Strip(view), "pedidos cancelados") {
			t.Fatal("composer/action hidden", ansi.Strip(view))
		}
		screen := vt10x.New(vt10x.WithSize(size[0], size[1]))
		screen.Write([]byte(strings.ReplaceAll(view, "\n", "\r\n")))
		captureNativeScreen(t, screen, fmt.Sprintf("go-workspace-%d", size[0]))
	}
}
