package main

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func shellTestModel(t *testing.T, w, h int) (*model, string) {
	t.Helper()
	previous := uiLanguage()
	setUILanguage("es")
	t.Cleanup(func() { setUILanguage(previous) })
	m := projectTestModel(t)
	repo, other := t.TempDir(), t.TempDir()
	m.repo, m.home, m.view, m.pane = repo, false, 1, 1
	m.state.Projects = []string{repo, other}
	m.state.Tasks = []Task{
		{ID: "t1", Repo: repo, Title: "Exportar pedidos", Acceptance: "CSV con fecha, cliente y total.", Status: "running", AgentState: "working", AgentProvider: "codex", WorkerConfig: &AgentConfig{Provider: "codex", Model: "gpt-5.5"}},
		{ID: "t2", Repo: repo, Title: "Catálogo móvil", Acceptance: "Vista móvil accesible.", Status: "awaiting_review", AgentMessage: "Listo para revisar."},
		{ID: "t3", Repo: repo, Title: "Importar clientes", Acceptance: "Importar CSV.", Status: "pending"},
	}
	m.state.Conversations = map[string][]ConversationMessage{repo: {{Role: "human", Text: "Quiero exportar pedidos."}, {Role: "fluke", Text: "Acordado; preparo el plan."}}}
	m.width, m.height = w, h
	return m, other
}

func TestShellProjectFitsWithOneRowHeader(t *testing.T) {
	for _, size := range [][2]int{{140, 40}, {120, 30}, {100, 24}} {
		m, _ := shellTestModel(t, size[0], size[1])
		if m.headerRows() != 1 || m.footerRows() != 2 {
			t.Fatalf("%v: header/footer rows %d/%d", size, m.headerRows(), m.footerRows())
		}
		lines := strings.Split(ansi.Strip(m.View().Content), "\n")
		if len(lines) != size[1] {
			t.Fatalf("%v: %d lines", size, len(lines))
		}
		for _, line := range lines {
			if ansi.StringWidth(line) > size[0] {
				t.Fatalf("%v: overflow %q", size, line)
			}
		}
		view := strings.Join(lines, "\n")
		for _, want := range []string{"PROYECTOS", "PLAN", "WORKERS", "Exportar pedidos", "[Enviar]", "Alt+K"} {
			if !strings.Contains(view, want) {
				t.Fatalf("%v: missing %q\n%s", size, want, view)
			}
		}
	}
}

func TestShellFallsBackWhenNarrowOrFloating(t *testing.T) {
	m, _ := shellTestModel(t, 80, 30)
	if m.shellMode() || m.headerRows() != 3 || m.footerRows() != 3 {
		t.Fatal("narrow terminal kept shell chrome")
	}
	lines := strings.Split(ansi.Strip(m.View().Content), "\n")
	if !strings.Contains(lines[1], "F2") || !strings.Contains(lines[2], "─") {
		t.Fatal("legacy three-row header missing", lines[:3])
	}
	m, _ = shellTestModel(t, 140, 40)
	m.toggleFloatingChat()
	if m.shellProject() {
		t.Fatal("floating chat must keep the pane layout")
	}
	if dock, _ := m.projectPanels(); dock.w != 0 {
		t.Fatal("floating chat duplicated the docked one")
	}
}

func TestShellTaskCardShowsOnlyReportedUsage(t *testing.T) {
	cost := 0.1234
	task := Task{Metrics: TaskMetrics{Usage: []RunUsage{{WorkerUsage: WorkerUsage{InputTokens: 9000, OutputTokens: 3500, CostUSD: &cost}}}}}
	if tokens, spent := taskUsageSummary(task); tokens != "12k" || spent != "$0.12" {
		t.Fatalf("%q %q", tokens, spent)
	}
	if tokens, spent := taskUsageSummary(Task{}); tokens != "—" || spent != "—" {
		t.Fatalf("missing usage must not read as zero: %q %q", tokens, spent)
	}
	if _, spent := taskUsageSummary(Task{Metrics: TaskMetrics{Usage: []RunUsage{{WorkerUsage: WorkerUsage{InputTokens: 10}}}}}); spent != "—" {
		t.Fatalf("unreported cost must stay unknown: %q", spent)
	}
}

func TestShellClicksSelectTaskProjectAndCard(t *testing.T) {
	m, other := shellTestModel(t, 140, 40)
	g := m.shellGeometry()
	_, hits := m.shellRail(g)
	taskRow, projectRow := -1, -1
	for i, h := range hits {
		if h.kind == "task" && h.index == 2 {
			taskRow = i
		}
		if h.kind == "project" && m.state.Projects[h.index] == other {
			projectRow = i
		}
	}
	if taskRow < 0 || projectRow < 0 {
		t.Fatal("rail rows are not addressable", hits)
	}
	m.Update(tea.MouseClickMsg{X: g.rail.x + 4, Y: m.headerRows() + taskRow, Button: tea.MouseLeft})
	if m.selected != 2 || m.pane != 0 {
		t.Fatalf("task click: selected=%d pane=%d", m.selected, m.pane)
	}
	m.Update(tea.MouseClickMsg{X: 6, Y: m.headerRows() + g.cardRow + 1, Button: tea.MouseLeft})
	if m.selected != 0 || m.pane != 2 {
		t.Fatalf("card click: selected=%d pane=%d", m.selected, m.pane)
	}
	m.Update(tea.MouseClickMsg{X: 6, Y: m.headerRows() + g.editorRow + 1, Button: tea.MouseLeft})
	if m.pane != 1 {
		t.Fatal("editor click did not focus the conversation")
	}
	m.Update(tea.MouseClickMsg{X: g.rail.x + 4, Y: m.headerRows() + projectRow, Button: tea.MouseLeft})
	if m.repo != other || m.pane != 1 || m.view != 1 {
		t.Fatalf("project click: repo=%q pane=%d view=%d", m.repo, m.pane, m.view)
	}
}

func TestShellHeaderNavigationClicks(t *testing.T) {
	m, _ := shellTestModel(t, 140, 40)
	x, y := m.navOrigin()
	if y != 0 || x == 0 {
		t.Fatalf("navigation origin %d,%d", x, y)
	}
	// The third label is F3; its centre must route to the sessions view.
	labels := m.tabLabels()
	pos := x
	for i := 0; i < 2; i++ {
		pos += ansi.StringWidth(labels[i]) + 3
	}
	m.Update(tea.MouseClickMsg{X: pos + 2, Y: 0, Button: tea.MouseLeft})
	if m.view != 2 {
		t.Fatalf("F3 click opened view %d", m.view)
	}
}
