package main

import (
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func TestReportedUsageHasEvidenceAndDoesNotDoubleCount(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "usage.json"), []byte(`{"input_tokens":20}`), 0600)
	task := Task{Worktree: &root, AgentRun: "run"}
	u := WorkerUsage{InputTokens: 20, OutputTokens: 4, Source: "usage.json"}
	if err := validateWorkerUsage(u, task); err != nil {
		t.Fatal(err)
	}
	task.Metrics = task.Metrics.withUsage("run", u)
	u.InputTokens = 25
	task.Metrics = task.Metrics.withUsage("run", u)
	if len(task.Metrics.Usage) != 1 || task.Metrics.Usage[0].InputTokens != 25 {
		t.Fatal("usage snapshots were summed")
	}
	for _, invalid := range []WorkerUsage{{InputTokens: -1, Source: u.Source}, {InputTokens: 1e13, Source: u.Source}, {InputTokens: 24, Source: u.Source}, {InputTokens: 25, OutputTokens: 4, Source: "../usage.json"}, {InputTokens: 25, OutputTokens: 4, Source: "missing.json"}} {
		if err := validateWorkerUsage(invalid, task); err == nil {
			t.Fatal("invalid usage accepted", invalid)
		}
	}
	nan := math.NaN()
	u.CostUSD = &nan
	if validUsageNumbers(u) {
		t.Fatal("NaN cost accepted")
	}
	u.CostUSD = nil
	task.Metrics = task.Metrics.withUsage("next", u)
	task.Metrics.Runs = 2
	s := summarizeProject(State{Tasks: []Task{task}}, "")
	if s.Tokens != 58 || s.UsageRuns != 2 || s.CostRuns != 0 {
		t.Fatal(s)
	}
}

func TestMetricsSeparateAcceptanceIntegrationAndUnmeasuredHistory(t *testing.T) {
	state := State{Tasks: []Task{
		{Repo: "a", Status: "accepted", Metrics: TaskMetrics{Deliveries: 1, Runs: 1}},
		{Repo: "a", Status: "accepted", Metrics: TaskMetrics{Deliveries: 2, Reworks: 1}, Integration: &integrationPlan{MergedCommit: "commit"}},
		{Repo: "a", Status: "accepted"},
		{Repo: "a", Status: "awaiting_review"},
		{Repo: "a", Status: "running", AgentState: "blocked"},
		{Repo: "b", Status: "pending"},
	}}
	s := summarizeProject(state, "a")
	if s.Total != 5 || s.Accepted != 3 || s.Integrated != 1 || s.Reviewing != 1 || s.Remaining != 1 || s.Reviewed != 2 || s.FirstPass != 1 || s.Blocked != 1 {
		t.Fatal(s)
	}
}

func TestObservedTimeExcludesPausesDowntimeAndReview(t *testing.T) {
	m, task := messageTestModel(t)
	now := time.Now()
	m.metricsAt = now
	m.state.Tasks[0].AgentState = "working"
	m.observeWorkTime(now.Add(time.Second))
	if m.state.Tasks[0].Metrics.ObservedMS != 1000 {
		t.Fatal("working interval missing")
	}
	m.state.Tasks[0].AgentState = "blocked"
	m.observeWorkTime(now.Add(2 * time.Second))
	m.state.Tasks[0].AgentState = "working"
	m.observeWorkTime(now.Add(time.Hour))
	m.state.Tasks[0].Paused = true
	m.observeWorkTime(now.Add(time.Hour + time.Second))
	m.state.Tasks[0].Paused = false
	m.state.Tasks[0].Status = "awaiting_review"
	m.observeWorkTime(now.Add(time.Hour + 2*time.Second))
	if m.state.Tasks[0].Metrics.ObservedMS != 1000 {
		t.Fatal("waiting counted as work", task.ID)
	}
}

func TestMissionControlFitsAndKeepsFlukeAndBalanceAccessible(t *testing.T) {
	previous := uiLanguage()
	t.Cleanup(func() { setUILanguage(previous) })
	for _, lang := range []string{"en", "es"} {
		setUILanguage(lang)
		m := projectTestModel(t)
		repo := t.TempDir()
		m.state.Projects = []string{repo}
		m.state.Conversations = map[string][]ConversationMessage{repo: {{Role: "fluke", Text: "FLUKE_SENTINEL: parser worker needs help; review the accepted API."}}}
		m.state.Tasks = []Task{{Repo: repo, Title: "API", Status: "accepted", Metrics: TaskMetrics{Runs: 1, Deliveries: 1, ObservedMS: 65000}}}
		for _, size := range [][2]int{{44, 24}, {80, 30}, {140, 40}} {
			m.width, m.height = size[0], size[1]
			m.insights = false
			if size[0] < 92 {
				m.homeKey(tea.KeyPressMsg{Code: 'i', Text: "i"})
			}
			view := m.View().Content
			plain := ansi.Strip(view)
			if !strings.Contains(plain, "1/1") || !strings.Contains(plain, "1m 05s") {
				t.Fatal("balance missing", lang, size, plain)
			}
			if size[1] >= 30 && !strings.Contains(plain, "FLUKE_SENTINEL") {
				t.Fatal("Fluke update hidden", plain)
			}
			for _, line := range strings.Split(view, "\n") {
				if ansi.StringWidth(line) > size[0] {
					t.Fatal("overflow", size)
				}
			}
		}
	}
}

func TestBalanceNavigationOpensPlanAndKeepsSelectedTaskVisible(t *testing.T) {
	m := projectTestModel(t)
	m.repo = t.TempDir()
	m.state.Projects = []string{m.repo}
	m.state.Tasks = []Task{{Repo: m.repo, Title: "SELECTED_TASK", Status: "pending"}}
	m.insights = true
	m.homeKey(tea.KeyPressMsg{Code: tea.KeyEnter})
	if m.insights || m.view != 1 {
		t.Fatal("Open plan retained portfolio balance")
	}
	m.selectProjectPanel(3)
	for _, size := range [][2]int{{44, 24}, {140, 40}} {
		m.width, m.height = size[0], size[1]
		view := ansi.Strip(m.View().Content)
		if !strings.Contains(view, "SELECTED_TASK") || !strings.Contains(view, "[i]") {
			t.Fatal("task balance is hidden", view)
		}
	}
	m.globalKey("f1")
	if m.insights {
		t.Fatal("navigation retained task-only balance")
	}
}
