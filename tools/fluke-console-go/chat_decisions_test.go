package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func TestChatBriefApprovalPlanAndExecution(t *testing.T) {
	m := projectTestModel(t)
	m.repo, m.home, m.view, m.pane = t.TempDir(), false, 1, 1
	s := &orchestratorSession{RunID: "run", Dir: t.TempDir()}
	m.orchestration[m.repo] = s
	_, err := m.applyOrchestratorCommand(m.repo, orchestratorCommand{Action: "propose_goal", RunID: "run", Seq: 1, Title: "Delivery app", Acceptance: "Save customers and optimize delivery stops"})
	if err != nil {
		t.Fatal(err)
	}
	if m.reviewedChatDecision() != 0 || !strings.Contains(ansi.Strip(m.conversation(90, 24, true)), "Save customers") {
		t.Fatal("proposal was not offered in chat")
	}
	m.Update(tea.PasteMsg{Content: "apruebo"})
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	goal := m.state.Goals[m.repo]
	if m.view != 1 || goal.ID == "" || !s.Notify || m.chatDraft[m.repo] != "" || m.reviewedChatDecision() >= 0 {
		t.Fatal("approval did not stay in chat or notify planner")
	}
	if len(m.state.Conversations[m.repo]) != 2 || m.state.Conversations[m.repo][0].Text != "apruebo" {
		t.Fatal("approval missing from conversation")
	}
	_, err = m.applyOrchestratorCommand(m.repo, orchestratorCommand{Action: "create_task", GoalID: goal.ID, RunID: "run", Seq: 2, Title: "Customer records", Acceptance: "Persist and reopen customers"})
	if err != nil {
		t.Fatal(err)
	}
	task := m.state.Tasks[0]
	if task.Queued || !task.AwaitingExecution || m.drainQueue() != nil || m.preparingWorker {
		t.Fatal("brief approval started implementation")
	}
	if _, err = m.applyOrchestratorCommand(m.repo, orchestratorCommand{Action: "queue_task", TaskID: task.ID}); err == nil {
		t.Fatal("agent bypassed execution approval")
	}
	// Explicit execution applies only to the plan already visible, not future tasks.
	m.Update(tea.PasteMsg{Content: "ejecutar plan"})
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if !m.state.Tasks[0].Queued || m.state.Tasks[0].AwaitingExecution || m.chatDraft[m.repo] != "" || m.view != 1 {
		t.Fatal("chat did not authorize plan execution")
	}
	_, err = m.applyOrchestratorCommand(m.repo, orchestratorCommand{Action: "create_task", GoalID: goal.ID, Title: "Routes", Acceptance: "Optimize stops"})
	if err != nil || !m.state.Tasks[1].AwaitingExecution || m.state.Tasks[1].Queued {
		t.Fatal("later task inherited execution approval", err)
	}
}

func TestChatDecisionTargetAndFreeTextAnswer(t *testing.T) {
	m := projectTestModel(t)
	m.repo, m.home, m.view, m.pane = t.TempDir(), false, 1, 1
	m.state.Decisions = []Decision{{Repo: m.repo, Question: "Which delivery days?"}}
	m.Update(tea.KeyPressMsg{Code: 'd', Mod: tea.ModCtrl})
	// A new decision must not steal the reply to the reviewed question.
	m.state.Decisions = append(m.state.Decisions, Decision{Repo: m.repo, Question: "Which routing service?"})
	m.Update(tea.PasteMsg{Content: "Tuesday and Friday"})
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if m.state.Decisions[0].Answer == nil || *m.state.Decisions[0].Answer != "Tuesday and Friday" || m.state.Decisions[1].Answer != nil || m.view != 1 {
		t.Fatal("free-text answer reached wrong decision")
	}
	m.Update(tea.KeyPressMsg{Code: 'd', Mod: tea.ModCtrl})
	m.repo = t.TempDir()
	m.chatDraft[m.repo] = "apruebo"
	m.chatDecisionKey("enter")
	if m.state.Decisions[1].Answer != nil {
		t.Fatal("changing project authorized another project's decision")
	}
}

func TestChatApprovalDoesNotInferConsentAndSurvivesSaveFailure(t *testing.T) {
	for _, text := range []string{"sí, pero cambiale el alcance", "no sé", "dale una vuelta", "could you approve this?"} {
		if _, ok := proposalChatReply(text); ok {
			t.Fatalf("inferred consent from %q", text)
		}
	}
	m := projectTestModel(t)
	m.repo, m.home, m.view, m.pane = t.TempDir(), false, 1, 1
	m.state.Decisions = []Decision{{Repo: m.repo, ProposedGoal: true, ProposedTitle: "App", ProposedAcceptance: "Saved data"}}
	m.chatDecision, m.chatDraft[m.repo] = 1, "apruebo"
	previousDir := m.store.dir
	invalid := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(invalid, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	m.store.dir = invalid
	m.chatDecisionKey("enter")
	if m.state.Decisions[0].Answer != nil || m.chatDraft[m.repo] != "apruebo" || len(m.state.Goals) != 0 || len(m.state.Conversations[m.repo]) != 0 {
		t.Fatal("failed save lost input or authorized work")
	}
	m.store.dir = previousDir
	m.chatDecisionKey("enter")
	if m.state.Decisions[0].Answer == nil || len(m.state.Conversations[m.repo]) != 2 {
		t.Fatal("reply not saved once on retry")
	}
	m.chatDraft[m.repo] = "apruebo"
	if handled, _ := m.chatDecisionKey("enter"); handled {
		t.Fatal("approval was replayed with no reviewed proposal")
	}
}

func TestRequirementDraftSurvivesRestartWithoutAuthorizingWork(t *testing.T) {
	m := projectTestModel(t)
	m.repo = t.TempDir()
	_, err := m.applyOrchestratorCommand(m.repo, orchestratorCommand{Action: "draft_goal", Title: "Delivery app", Acceptance: "Customers have addresses; deliveries twice a week", Question: "Which device?"})
	if err != nil {
		t.Fatal(err)
	}
	if len(m.state.Goals) != 0 || len(m.state.Tasks) != 0 || !strings.Contains(ansi.Strip(m.planContent(90, 20)), "Customers have addresses") {
		t.Fatal("draft authorized work or stayed hidden")
	}
	data, err := os.ReadFile(filepath.Join(m.store.dir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	var restored State
	if err := json.Unmarshal(data, &restored); err != nil {
		t.Fatal(err)
	}
	draft := restored.DraftGoals[m.repo]
	if draft.Title != "Delivery app" || draft.OpenQuestions != "Which device?" {
		t.Fatal("requirements did not survive persistence")
	}
	context, err := json.Marshal(m.orchestratorContext(m.repo))
	if err != nil || !strings.Contains(string(context), "draft_goal") || !strings.Contains(string(context), "Which device?") {
		t.Fatal("agent cannot recover draft", err)
	}
}
