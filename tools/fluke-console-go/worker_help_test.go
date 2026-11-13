package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTechnicalHelpIsScopedDurableAndDoesNotImpersonateHuman(t *testing.T) {
	m, task := messageTestModel(t)
	m.state.Tasks[0].AgentState = "blocked"
	m.state.Decisions = []Decision{{Repo: task.Repo, TaskID: task.ID, RunID: task.AgentRun, Seq: task.AgentSeq, Question: "Which existing parser handles this?", Assistance: true}}
	c := orchestratorCommand{Action: "answer_worker", TaskID: task.ID, DecisionNumber: 1, Answer: "Reuse parseConfig and cover the empty-input case."}
	if _, err := m.applyOrchestratorCommand(t.TempDir(), c); err == nil {
		t.Fatal("cross-project help accepted")
	}
	m.state.Decisions[0].Assistance = false
	if _, err := m.applyOrchestratorCommand(task.Repo, c); err == nil {
		t.Fatal("human decision answered by agent")
	}
	m.state.Decisions[0].Assistance = true
	m.state.Tasks[0].Paused = true
	if _, err := m.applyOrchestratorCommand(task.Repo, c); err == nil {
		t.Fatal("pause bypassed")
	}
	m.state.Tasks[0].Paused = false
	m.state.Tasks[0].AgentSeq++
	if _, err := m.applyOrchestratorCommand(task.Repo, c); err == nil {
		t.Fatal("stale report answered")
	}
	m.state.Tasks[0].AgentSeq--
	if _, err := m.applyOrchestratorCommand(task.Repo, c); err != nil {
		t.Fatal(err)
	}
	d := m.state.Decisions[0]
	if d.AnsweredBy != "fluke" || d.Continuation != "pending" || d.Answer == nil || *d.Answer != c.Answer {
		t.Fatal(d)
	}
	if _, err := m.applyOrchestratorCommand(task.Repo, c); err == nil {
		t.Fatal("duplicate response accepted")
	}
	data, err := os.ReadFile(filepath.Join(m.store.dir, "state.json"))
	if err != nil || !strings.Contains(string(data), `"answered_by": "fluke"`) {
		t.Fatal("response not durable", err)
	}
	w := m.terminalFor(task.ID)
	w.screen.Write([]byte("\x1b]0;Codex\x07"))
	m.idleSince[task.ID] = time.Now().Add(-time.Second)
	if m.continueAnsweredWorkers() == nil {
		t.Fatal("technical response was not queued to the real mailbox")
	}
	if _, err := os.Stat(workerSignalPath(*task.Worktree, task.ID, task.AgentRun, "answer-1")); err != nil {
		t.Fatal(err)
	}
}

func TestTechnicalHelpEscalationAndHumanCorrection(t *testing.T) {
	m, task := messageTestModel(t)
	m.state.Tasks[0].AgentState = "blocked"
	m.state.Decisions = []Decision{{Repo: task.Repo, TaskID: task.ID, RunID: task.AgentRun, Seq: task.AgentSeq, Question: "Need a product choice", Assistance: true}}
	c := orchestratorCommand{Action: "escalate_worker", TaskID: task.ID, DecisionNumber: 1}
	if _, err := m.applyOrchestratorCommand(task.Repo, c); err != nil {
		t.Fatal(err)
	}
	if m.state.Decisions[0].Assistance || m.state.Decisions[0].Answer != nil || len(m.state.Decisions) != 1 {
		t.Fatal("escalation lost the original request")
	}
	m.execute("answer 1 Keep the existing format")
	if m.state.Decisions[0].AnsweredBy != "human" {
		t.Fatal("human response source lost")
	}
	m.state.Decisions[0].Continuation = "sent"
	m.state.Decisions[0].AnsweredBy = "fluke"
	m.amendDecision("1 Use the newer parser")
	if len(m.state.Decisions) != 2 || m.state.Decisions[1].AnsweredBy != "human" {
		t.Fatal("correction impersonates Fluke")
	}
}
