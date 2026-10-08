package main

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
	"github.com/hinshun/vt10x"
)

func attentionFixture() *model {
	return &model{repo: "first", state: State{Projects: []string{"first", "second"}}, terminals: newWindowManager(100, 30), sessions: map[string]string{}, orchestration: map[string]*orchestratorSession{}}
}

func attentionTerminal(m *model, key, title, body string) *terminalWindow {
	w := &terminalWindow{ID: key, screen: vt10x.New(vt10x.WithSize(100, 20))}
	_, _ = w.screen.Write([]byte("\x1b]0;" + title + "\x07" + body))
	m.terminals.Windows = append(m.terminals.Windows, w)
	m.sessions[key] = key
	return w
}

func TestAttentionGlobalDeduplicationAndDecisionRouting(t *testing.T) {
	m := attentionFixture()
	answer := "done"
	m.state.Decisions = []Decision{
		{Repo: "first", Question: "Old", Answer: &answer},
		{Repo: "second", Question: "Old elsewhere", Answer: &answer},
		{Repo: "second", TaskID: "worker", RunID: "run", Question: "Choose scope"},
		{Repo: "second", TaskID: "worker", RunID: "run", Question: "Choose scope"},
	}
	m.state.Tasks = []Task{{ID: "worker", Repo: "second", Status: "running", AgentRun: "run", AgentState: "needs_response", AgentSeq: 1}}
	attentionTerminal(m, "worker", "Action Required", "Enter to confirm")
	items := m.attentionItems()
	if len(items) != 1 || items[0].DecisionIndex != 2 || items[0].Repo != "second" {
		t.Fatalf("expected one authoritative global decision: %+v", items)
	}
	if !m.openAttention(0) || m.repo != "second" || m.view != 3 || m.selectedDecision() != 2 {
		t.Fatal("attention opened the wrong repo-local decision")
	}
	if m.openAttention(-1) || m.openAttention(1) {
		t.Fatal("invalid attention index changed navigation")
	}
}

func TestAttentionDeliveryRemainsVisibleAndActionable(t *testing.T) {
	m := attentionFixture()
	m.width, m.height = 140, 40
	m.state.Tasks = []Task{{ID: "delivery", Repo: "second", Title: "Export", Status: "awaiting_review", AgentMessage: "Verified output"}}
	items := m.attentionItems()
	if len(items) != 1 || items[0].Kind != "delivery" || !strings.Contains(items[0].Summary, status("awaiting_review")) {
		t.Fatal("human review disappeared from global attention", items)
	}
	if !m.openAttention(0) || m.repo != "second" || m.view != 1 || m.selected != 0 {
		t.Fatal("delivery has no route")
	}
}

func TestAttentionNarrowPanelPreservesNavigationHint(t *testing.T) {
	previous := uiLanguage()
	t.Cleanup(func() { _ = setUILanguage(previous) })
	m := attentionFixture()
	m.width, m.height = 140, 40
	m.state.Decisions = []Decision{{Repo: "second", Question: "Review the requested scope"}}
	for _, language := range []string{"en", "es"} {
		_ = setUILanguage(language)
		for _, width := range []int{18, 25, 35} {
			content := m.attentionContent(width)
			for _, line := range strings.Split(content, "\n") {
				if ansi.StringWidth(line) > width {
					t.Fatalf("%s panel width %d clips %q", language, width, ansi.Strip(line))
				}
			}
			if !strings.Contains(ansi.Strip(content), localText("navigate", "navegar")) {
				t.Fatalf("%s navigation hint was discarded", language)
			}
		}
	}
}

func TestAttentionNativeSignalsAndRouting(t *testing.T) {
	m := attentionFixture()
	m.state.Tasks = []Task{
		{ID: "busy", Repo: "first", Status: "running", AgentProvider: "codex"},
		{ID: "idle", Repo: "first", Status: "running", AgentProvider: "codex"},
		{ID: "permission", Repo: "second", Status: "running", AgentProvider: "codex"},
		{ID: "paused", Repo: "first", Status: "running", AgentProvider: "codex", Paused: true},
	}
	attentionTerminal(m, "busy", "⠋ Codex", "esc to interrupt")
	attentionTerminal(m, "idle", "Codex", "Ready")
	attentionTerminal(m, "permission", "Action Required", "Enter to confirm")
	attentionTerminal(m, "paused", "Action Required", "Enter to confirm")
	m.orchestration["second"] = &orchestratorSession{Provider: "codex", RunID: "orun"}
	attentionTerminal(m, "fluke:second", "Action Required", "Allow command?")
	items := m.attentionItems()
	if len(items) != 2 || items[0].SessionKey != "permission" || items[1].SessionKey != "fluke:second" {
		t.Fatalf("busy, idle or paused sessions became alerts: %+v", items)
	}
	if !m.openAttention(1) || m.repo != "second" || m.view != 2 || m.terminals.Mode != terminalMode {
		t.Fatal("off-focus orchestrator did not open its native terminal")
	}
	w := m.terminalFor("fluke:second")
	w.exited.Store(true)
	if len(m.attentionItems()) != 1 {
		t.Fatal("exited terminal retained native attention")
	}
}

func TestAttentionReportRoutingAndBoundedSummary(t *testing.T) {
	m := attentionFixture()
	m.state.Tasks = []Task{
		{ID: "first-task", Repo: "second", Status: "pending"},
		{ID: "blocked", Repo: "second", Status: "running", AgentSeq: 2, AgentState: "blocked", AgentMessage: strings.Repeat("界\n", 300)},
		{ID: "stale-native", Repo: "first", Status: "running", AgentState: "blocked"},
	}
	items := m.attentionItems()
	if len(items) != 1 || items[0].Kind != "report" || len([]rune(items[0].Summary)) != 180 || strings.Contains(items[0].Summary, "\n") {
		t.Fatalf("report summary is unbounded or stale native alert persisted: %+v", items)
	}
	if !m.openAttention(0) || m.repo != "second" || m.view != 1 || m.selected != 1 {
		t.Fatal("report did not select its task")
	}
}
