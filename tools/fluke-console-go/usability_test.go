package main

import (
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/hinshun/vt10x"
)

func TestNavigationUsesVisibleProjectAndDecision(t *testing.T) {
	m := projectTestModel(t)
	a, b := t.TempDir(), t.TempDir()
	m.state.Projects = []string{a, b}
	m.state.Tasks = []Task{{ID: "task-a", Repo: a}, {ID: "task-b1", Repo: b}, {ID: "task-b2", Repo: b}}
	m.repo, m.selected = a, 1
	m.globalKey("f2")
	if m.repo != b || m.selected != 0 {
		t.Fatal("F2 ignored highlighted project")
	}
	m.state.Decisions = []Decision{{Repo: b, TaskID: "task-b2", Question: "Decision"}}
	m.globalKey("f4")
	m.globalKey("f7")
	if m.review.task.ID != "task-b2" {
		t.Fatal("F7 reviewed task index instead of decision's task")
	}
	m.globalKey("f4")
	m.state.Decisions[0].TaskID = ""
	m.globalKey("f7")
	if m.review.task.ID != "" {
		t.Fatal("unlinked decision reviewed unrelated task")
	}
}

func TestChatPunctuationAndNarrowProjectRemainUsable(t *testing.T) {
	m := projectTestModel(t)
	m.repo, m.home, m.view, m.pane, m.width, m.height = t.TempDir(), false, 1, 1, 44, 20
	for _, r := range "https://repo:8000" {
		m.Update(tea.KeyPressMsg{Code: r, Text: string(r)})
	}
	if m.command != nil || m.chatDraft[m.repo] != "https://repo:8000" {
		t.Fatal("punctuation opened command mode")
	}
	if !strings.Contains(ansi.Strip(m.View().Content), "https://repo:8000") {
		t.Fatal("narrow project hides active chat")
	}
	m.Update(tea.KeyPressMsg{Code: 'u', Mod: tea.ModCtrl})
	if m.chatDraft[m.repo] != "" {
		t.Fatal("Ctrl+U did not clear draft")
	}
	m.Update(tea.KeyPressMsg{Code: 'k', Mod: tea.ModCtrl})
	if m.command == nil {
		t.Fatal("command shortcut lost")
	}
}

func TestSmallProjectFormAndTaskSelectionStayVisible(t *testing.T) {
	original := uiLanguage()
	t.Cleanup(func() { setUILanguage(original) })
	for _, language := range []string{"en", "es"} {
		setUILanguage(language)
		m := projectTestModel(t)
		m.width, m.height = 44, 20
		m.openProjectEditor(true)
		m.projects.name, m.projects.path = "NAME_SENTINEL", "PATH_SENTINEL"
		for field, sentinel := range []string{"NAME_SENTINEL", "PATH_SENTINEL"} {
			m.projects.field = field
			view := ansi.Strip(m.View().Content)
			if !strings.Contains(view, sentinel) || !strings.Contains(view, "▌") {
				t.Fatalf("%s field %d hidden: %s", language, field, view)
			}
		}
		m.projects.open = false
		m.repo = t.TempDir()
		for i := 0; i < 8; i++ {
			m.state.Tasks = append(m.state.Tasks, Task{ID: fmt.Sprintf("task%d", i), Repo: m.repo, Title: fmt.Sprintf("SENTINEL%d", i), Acceptance: strings.Repeat("Long criterion ", 40), Status: "pending"})
		}
		m.selected = 7
		for _, width := range []int{40, 72} {
			for _, height := range []int{5, 13, 30} {
				view := ansi.Strip(fit(m.planContent(width, height), width, height))
				if !strings.Contains(view, "SENTINEL7") {
					t.Fatalf("%s %dx%d task selection hidden: %s", language, width, height, view)
				}
			}
		}
	}
}

func TestGlobalDefaultsKeepBusyProjectAndWorkerPreviewSelection(t *testing.T) {
	m := projectTestModel(t)
	defer func() { m.terminals.Windows, m.sessions = nil, map[string]string{} }()
	m.repo = t.TempDir()
	s := &orchestratorSession{RunID: "keep", ChatSending: true}
	m.orchestration[m.repo] = s
	m.openConfig()
	m.applyConfig()
	if m.orchestration[m.repo] != s || m.config || m.preparing {
		t.Fatal("global defaults restarted or blocked on background session")
	}
	for i := 0; i < 4; i++ {
		id := fmt.Sprintf("task%d", i)
		m.state.Tasks = append(m.state.Tasks, Task{ID: id, Repo: m.repo, Title: "PREVIEW_" + id})
		w := &terminalWindow{ID: id, screen: vt10x.New(vt10x.WithSize(80, 20))}
		m.terminals.Windows = append(m.terminals.Windows, w)
		m.sessions[id] = id
	}
	m.selected, m.pane = 3, 2
	if !strings.Contains(ansi.Strip(m.workerPreviews(80, 16)), "PREVIEW_TASK3") {
		t.Fatal("selected worker preview is offscreen")
	}
	m.view = 2
	m.terminals.FocusedWindow = 2
	m.state.Tasks[2].Repo = t.TempDir()
	m.globalKey("f7")
	if m.review.task.ID != "task2" || m.repo != m.state.Tasks[2].Repo {
		t.Fatal("F7 ignored focused worker")
	}
	m.terminals.Windows, m.sessions = nil, map[string]string{}
}

func TestSetupResumesPublishedPRTracking(t *testing.T) {
	m := setupTestModel(t, 6)
	m.setup.step = 6
	task, _, _ := followupFixture(t)
	m.state.Tasks = []Task{task}
	m.setupKey(tea.KeyPressMsg{Code: tea.KeyEnter})
	if m.setup.open || !m.githubFollowupTickPending || len(m.githubFollowupCancel) != 1 {
		t.Fatal("onboarding completion left existing PR tracking stopped")
	}
}
