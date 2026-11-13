package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/hinshun/vt10x"
)

func messageTestModel(t *testing.T) (*model, Task) {
	t.Helper()
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.lock.Close() })
	repo := t.TempDir()
	state.Projects = []string{repo}
	state.Orchestrator = &AgentConfig{Provider: "codex", Executable: "codex"}
	if err = state.addTask(repo, "Worker", "Verified file"); err != nil {
		t.Fatal(err)
	}
	task := &state.Tasks[0]
	task.Status, task.AgentRun, task.AgentSeq, task.AgentProvider, task.Worktree = "running", "run", 3, "codex", &repo
	m := newModel(store, state, repo)
	w := &terminalWindow{ID: "worker", screen: vt10x.New(vt10x.WithSize(80, 20))}
	m.terminals.Windows = []*terminalWindow{w}
	m.sessions[task.ID] = w.ID
	if err = os.Mkdir(filepath.Join(repo, ".fluke-worker"), 0700); err != nil {
		t.Fatal(err)
	}
	return m, *task
}

func TestWorkerMessageReachesPlanAndRejectsOldDelivery(t *testing.T) {
	m, task := messageTestModel(t)
	m.sendWorkerMessage(task.ID, "Cover the empty-input case")
	if len(m.state.Decisions) != 1 || !m.state.Decisions[0].DirectInstruction || m.state.Decisions[0].Continuation != "pending" {
		t.Fatal(m.notice, m.state.Decisions)
	}
	data, err := json.Marshal(m.orchestratorContext(task.Repo))
	if err != nil || !strings.Contains(string(data), "Cover the empty-input case") {
		t.Fatal("orchestrator lost direct instruction", err)
	}
	if err = os.WriteFile(filepath.Join(task.Repo, "result.txt"), []byte("result"), 0600); err != nil {
		t.Fatal(err)
	}
	report := workerReport{Version: 1, RunID: "run", Seq: 4, Status: "ready", Message: "Ready", Evidence: []string{"result.txt"}}
	path := workerSignalPath(task.Repo, task.ID, "run", "state")
	_ = atomicJSON(path, report)
	m.observeWorkers(true)
	if m.state.Tasks[0].Status == "awaiting_review" {
		t.Fatal("ready predating instruction accepted")
	}
	_ = m.setContinuation(0, "sent")
	m.observeWorkers(true)
	if m.state.Tasks[0].Status == "awaiting_review" {
		t.Fatal("ready without instruction acknowledgment accepted")
	}
	report.HumanInstructionSeq = 1
	_ = atomicJSON(path, report)
	m.observeWorkers(true)
	if m.state.Tasks[0].Status != "awaiting_review" {
		t.Fatal("acknowledged delivery not reviewable", m.notice)
	}
}

func TestDecisionAmendmentPreservesHistoryAndSource(t *testing.T) {
	m, task := messageTestModel(t)
	answer := "CSV"
	m.state.Decisions = []Decision{{Repo: task.Repo, TaskID: task.ID, RunID: "run", Seq: 1, Question: "Output format?", Answer: &answer, Continuation: "sent"}}
	m.amendDecision("1 JSON")
	if len(m.state.Decisions) != 2 || *m.state.Decisions[0].Answer != "CSV" || m.state.Decisions[0].Continuation != "superseded" {
		t.Fatal("original answer lost", m.notice)
	}
	d := m.state.Decisions[1]
	if d.Supersedes != 1 || *d.Answer != "JSON" || d.HumanInstructionSeq != 2 || d.Seq != task.AgentSeq || d.Continuation != "pending" {
		t.Fatal("amendment lost association", d)
	}
	m.amendDecision("1 TSV")
	if len(m.state.Decisions) != 2 {
		t.Fatal("branched correction chain")
	}
	m.amendDecision("2 TSV")
	if len(m.state.Decisions) != 3 || m.state.Decisions[2].Supersedes != 2 {
		t.Fatal("latest correction failed", m.notice)
	}
	_ = m.store.lock.Close()
	reopened, restored, err := openStore(m.store.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.lock.Close()
	if len(restored.Decisions) != 3 || *restored.Decisions[0].Answer != "CSV" || *restored.Decisions[2].Answer != "TSV" {
		t.Fatal("history lost on restart")
	}
}

func TestWorkerInstructionSaveFailureAndPublishedHold(t *testing.T) {
	m, task := messageTestModel(t)
	if err := os.Mkdir(filepath.Join(m.store.dir, "state.json"), 0700); err != nil {
		t.Fatal(err)
	}
	m.sendWorkerMessage(task.ID, "new instruction")
	if len(m.state.Decisions) != 0 || m.state.Tasks[0].AgentState != task.AgentState {
		t.Fatal("failed save changed instruction/state")
	}
	_ = os.Remove(filepath.Join(m.store.dir, "state.json"))
	m.state.Tasks[0].Publication = &githubPRPlan{Complete: true}
	m.sendWorkerMessage(task.ID, "change published work")
	if len(m.state.Decisions) != 0 {
		t.Fatal("changed published delivery without follow-up")
	}
	if !strings.Contains(m.notice, "follow-up") && !strings.Contains(m.notice, "seguimiento") {
		t.Fatal(m.notice)
	}
}

func TestWorkerMessageComposerRoutesFocusedProject(t *testing.T) {
	m, task := messageTestModel(t)
	m.repo = t.TempDir()
	m.config = false
	m.view, m.terminals.Mode = 2, windowMode
	m.Update(tea.KeyPressMsg{Text: "m", Code: 'm'})
	if m.workerMessageID != task.ID || m.repo != task.Repo {
		t.Fatal("focused worker composer misrouted", m.workerMessageID, m.repo)
	}
	if !strings.Contains(ansi.Strip(m.footer()), task.Title) {
		t.Fatal("composer invisible")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	if m.workerMessageID != "" || len(m.state.Decisions) != 0 {
		t.Fatal("cancel sent message")
	}
}

func TestWorkerInstructionsSerializeAndResultHasExactIdentity(t *testing.T) {
	m, task := messageTestModel(t)
	m.sendWorkerMessage(task.ID, "first")
	m.sendWorkerMessage(task.ID, "second")
	w := m.terminalFor(task.ID)
	_, _ = w.screen.Write([]byte("\x1b]0;Codex\x07"))
	m.idleSince[task.ID] = time.Now().Add(-time.Second)
	cmd := m.continueAnsweredWorkers()
	if cmd == nil || m.state.Decisions[0].Continuation != "sending" || m.state.Decisions[1].Continuation != "pending" {
		t.Fatal("simultaneous worker prompts", m.state.Decisions)
	}
	if m.continueAnsweredWorkers() != nil {
		t.Fatal("second prompt dispatched while first in flight")
	}
	m.receiveContinuation(continuationResult{TaskID: task.ID, RunID: "run", Seq: task.AgentSeq, DecisionIndex: 1})
	if m.state.Decisions[0].Continuation != "sending" {
		t.Fatal("wrong instruction received first completion")
	}
	m.receiveContinuation(continuationResult{TaskID: task.ID, RunID: "run", Seq: task.AgentSeq, DecisionIndex: 0})
	if m.state.Decisions[0].Continuation != "sent" || m.state.Decisions[1].Continuation != "pending" {
		t.Fatal("instruction completion misassociated")
	}
}
