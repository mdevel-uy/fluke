package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func projectTestModel(t *testing.T) *model {
	t.Helper()
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	state.Orchestrator = &AgentConfig{Provider: "codex", Executable: "codex", Arguments: []string{}}
	m := newModel(store, state, "")
	t.Cleanup(func() { m.cleanup(); store.lock.Close() })
	return m
}

func TestProjectCreateAndOpenPersistWithoutLosingOtherWork(t *testing.T) {
	m := projectTestModel(t)
	existing := testRepo(t)
	m.state.Projects = []string{existing}
	m.state.Conversations = map[string][]ConversationMessage{existing: {{Role: "human", Text: "Keep this conversation"}}}
	m.state.Tasks = []Task{{ID: "t123", Repo: existing, Title: "Keep this task", Status: "pending"}}
	m.openProjectEditor(true)
	m.pasteProjectField("Mi idea")
	m.projectEditorKey(tea.KeyPressMsg{Code: tea.KeyEnter})
	m.projectEditorKey(tea.KeyPressMsg{Code: 'u', Mod: tea.ModCtrl})
	created := filepath.Join(t.TempDir(), "Mi idea")
	m.pasteProjectField(created)
	cmd := m.projectEditorKey(tea.KeyPressMsg{Code: tea.KeyEnter})
	if cmd == nil || !m.projects.busy {
		t.Fatal("creation did not start asynchronously")
	}
	m.Update(cmd())
	if m.projects.open || m.repo != created || m.home || m.view != 1 || m.pane != 1 || len(m.state.Projects) != 2 {
		t.Fatalf("creation failed: %s", m.notice)
	}
	m.openProjectEditor(false)
	m.pasteProjectField(filepath.Join(existing, "."))
	m.Update(m.projectEditorKey(tea.KeyPressMsg{Code: tea.KeyEnter})())
	if len(m.state.Projects) != 2 || m.repo != existing || len(m.state.Tasks) != 1 || len(m.state.Conversations[existing]) != 1 {
		t.Fatal("opening lost work or duplicated project")
	}
	m.globalKey("f1")
	m.homeKey(tea.KeyPressMsg{Code: tea.KeyDown})
	m.homeKey(tea.KeyPressMsg{Code: tea.KeyEnter})
	if m.repo != created || m.view != 1 || m.home || m.pane != 0 {
		t.Fatal("hub did not switch projects")
	}
	data, err := os.ReadFile(filepath.Join(m.store.dir, "state.json"))
	if err != nil || !strings.Contains(string(data), "Keep this conversation") {
		t.Fatal("conversation not persisted")
	}
}

func TestProjectFailedSaveRetainsRepositoryAndState(t *testing.T) {
	m := projectTestModel(t)
	m.openProjectEditor(true)
	m.projects.name = "Keep me"
	m.projects.path = filepath.Join(t.TempDir(), "keep-me")
	m.projects.field = 1
	if err := os.Mkdir(filepath.Join(m.store.dir, "state.json"), 0700); err != nil {
		t.Fatal(err)
	}
	m.Update(m.projectEditorKey(tea.KeyPressMsg{Code: tea.KeyEnter})())
	if !m.projects.open || m.projects.busy || len(m.state.Projects) != 0 || m.repo != "" {
		t.Fatal("failed persistence changed state")
	}
	if _, err := os.Stat(filepath.Join(m.projects.path, ".git")); err != nil {
		t.Fatal("created repo must be retained")
	}
	if !strings.Contains(m.notice, m.projects.path) {
		t.Fatal("recovery path missing")
	}
}

func TestHomePreventsEmptyRepositoryLaunchAndAllowsGlobalKeys(t *testing.T) {
	m := projectTestModel(t)
	if cmd := m.startSession("", false); cmd != nil || m.preparing {
		t.Fatal("started a provider without a repository")
	}
	m.openConfig()
	m.applyConfig()
	if m.preparing || !m.home || m.view != 0 || m.pane != 0 {
		t.Fatal("applying settings launched a no-repo session")
	}
	m.openProjectEditor(true)
	m.Update(tea.KeyPressMsg{Code: tea.KeyF1})
	if m.projects.open || !m.home || m.pane != 0 {
		t.Fatal("project form swallowed F1")
	}
	m.pane = 1
	m.homeKey(tea.KeyPressMsg{Code: tea.KeyTab})
	if m.pane != 2 {
		t.Fatal("home tab retained an invalid pane")
	}
	m.homeKey(tea.KeyPressMsg{Code: tea.KeyTab})
	if m.pane != 0 {
		t.Fatal("home tab did not return to projects")
	}
}

func TestHomeAndProjectFormsFitAndSelectedAttentionIsVisible(t *testing.T) {
	original := uiLanguage()
	t.Cleanup(func() { setUILanguage(original) })
	for _, language := range []string{"en", "es"} {
		setUILanguage(language)
		m := projectTestModel(t)
		for i := 0; i < 9; i++ {
			repo := filepath.Join(t.TempDir(), strings.Repeat("proyecto", 12))
			m.state.Projects = append(m.state.Projects, repo)
			m.state.Decisions = append(m.state.Decisions, Decision{Repo: repo, Question: "Attention sentinel " + string(rune('A'+i))})
		}
		for _, width := range []int{44, 80, 100, 140} {
			m.width, m.height, m.home, m.view, m.pane, m.selected = width, 36, true, 0, 2, 8
			content := m.View().Content
			if !strings.Contains(ansi.Strip(content), "sentinel I") {
				t.Fatalf("%s/%d selected alert hidden", language, width)
			}
			for _, row := range strings.Split(content, "\n") {
				if ansi.StringWidth(row) > width {
					t.Fatal("home overflow")
				}
			}
			m.openProjectEditor(true)
			m.projects.name, m.projects.path = "Proyecto nuevo", strings.Repeat("path/", 100)
			for _, row := range strings.Split(m.View().Content, "\n") {
				if ansi.StringWidth(row) > width {
					t.Fatal("project form overflow")
				}
			}
			m.projects.open = false
		}
	}
}

func TestSetupCanCompleteAndResumeWithoutAProject(t *testing.T) {
	m := projectTestModel(t)
	m.beginSetup("", true)
	m.setup.step = 4
	m.setupKey(tea.KeyPressMsg{Code: tea.KeyEnter})
	if m.setup.step != 5 || m.repo != "" || len(m.state.Projects) != 0 {
		t.Fatal("setup forced a repository")
	}
	m.beginSetup("", false)
	if m.setup.step != 5 {
		t.Fatal("resumed optional repo at the wrong step")
	}
	m.setupKey(tea.KeyPressMsg{Code: tea.KeyEnter})
	m.setupKey(tea.KeyPressMsg{Code: tea.KeyEnter})
	if m.setup.open || !m.state.Setup.Complete || !m.home || m.pane != 0 {
		t.Fatal("setup did not open global home")
	}
}
