package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func TestGithubFollowupSchedulingIsBoundedAndReachesPlan(t *testing.T) {
	task, _, _ := followupFixture(t)
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	state.Projects, state.Tasks = []string{task.Repo}, []Task{task}
	m := newModel(store, state, task.Repo)
	if m.scheduleGithubFollowup() == nil || m.scheduleGithubFollowup() != nil {
		t.Fatal("duplicate follow-up timer")
	}
	cmd := m.queryPublishedPR("", false)
	if cmd == nil || len(m.githubFollowupCancel) != 1 {
		t.Fatal("published PR not queried")
	}
	if m.queryPublishedPR(task.ID, true) != nil {
		t.Fatal("parallel polling exceeded bound")
	}
	m.Update(cmd())
	if len(m.githubFollowupCancel) != 0 || m.githubFollowups[task.ID].Snapshot.State != "OPEN" {
		t.Fatal("result lost", m.githubFollowups)
	}
	if m.queryPublishedPR("", false) != nil {
		t.Fatal("polled before one-minute interval")
	}
	data, _ := json.Marshal(m.orchestratorContext(task.Repo))
	if !strings.Contains(string(data), "pull_requests") || !strings.Contains(string(data), "REVIEW_REQUIRED") || strings.Contains(string(data), "CheckedAt") {
		t.Fatal("missing or noisy PR coordination", string(data))
	}
	if m.state.Tasks[0].Status != task.Status || m.state.Tasks[0].Integration != task.Integration {
		t.Fatal("remote status mutated local integration")
	}
	watch := m.githubFollowups[task.ID]
	watch.AttemptedAt = time.Now().Add(-2 * time.Minute)
	m.githubFollowups[task.ID] = watch
	if m.queryPublishedPR("", false) == nil {
		t.Fatal("due poll missing")
	}
	for _, cancel := range m.githubFollowupCancel {
		cancel()
	}
}

func TestGithubFollowupAlertsRouteAndKeepOldGoodStatus(t *testing.T) {
	task, snapshot, _ := followupFixture(t)
	m := attentionFixture()
	m.width, m.height = 140, 40
	m.state.Tasks = []Task{task}
	m.state.Projects = append(m.state.Projects, task.Repo)
	snapshot.ReviewDecision = "CHANGES_REQUESTED"
	m.githubFollowups = map[string]githubPRWatch{task.ID: {Publication: *task.Publication, Snapshot: snapshot}}
	items := m.attentionItems()
	if len(items) != 1 || items[0].Kind != "github" || !m.openAttention(0) || m.repo != task.Repo || m.view != 1 {
		t.Fatal("PR attention lost destination", items)
	}
	if !strings.Contains(ansi.Strip(m.planContent(80, 30)), "CHANGES_REQUESTED") {
		t.Fatal("PR status not visible")
	}
	errorResult := githubPRFollowupResult{Repo: task.Repo, TaskID: task.ID, Publication: *task.Publication, Snapshot: githubPRFollowup{Error: "read failed"}}
	m.receiveGithubFollowup(errorResult)
	if m.githubFollowups[task.ID].Snapshot.State != "OPEN" || !strings.Contains(m.githubPRStatusText(task), "Ctrl+R") {
		t.Fatal("failed refresh erased last good status")
	}
	changed := *task.Publication
	changed.Complete = false
	m.state.Tasks[0].Publication = &changed
	if m.githubPRContext(m.state.Tasks[0]) != nil {
		t.Fatal("incomplete publication retained remote context")
	}
	changed.Complete = true
	changed.SourceHead = strings.Repeat("a", 40)
	m.state.Tasks[0].Publication = &changed
	if m.githubPRContext(m.state.Tasks[0]) != nil {
		t.Fatal("old publication cache displayed as current")
	}
	m.receiveGithubFollowup(errorResult)
	if _, exists := m.githubFollowups[task.ID]; exists {
		t.Fatal("stale result accepted")
	}
}

func TestGlobalAttentionEnterOpensOtherProjectDecision(t *testing.T) {
	m := attentionFixture()
	m.width, m.height, m.view, m.pane = 140, 40, 0, 2
	m.state.Decisions = []Decision{{Repo: "second", Question: "Product decision?"}}
	if !strings.Contains(ansi.Strip(m.attentionContent(25)), "second") {
		t.Fatal("alert lacks project source")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if m.repo != "second" || m.view != 3 || m.selectedDecision() != 0 {
		t.Fatal("Enter did not route attention")
	}
}
