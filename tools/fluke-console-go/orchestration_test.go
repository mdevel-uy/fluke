package main

import (
	"encoding/json"
	"github.com/hinshun/vt10x"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOrchestratorCommandsScopeAndApproval(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	repo, other := t.TempDir(), t.TempDir()
	state.Projects = []string{repo, other}
	_ = state.addTask(repo, "Approved task", "Verified result")
	_ = state.addTask(other, "Other task", "Other result")
	m := newModel(store, state, repo)
	defer m.cleanup()
	c := orchestratorCommand{Action: "queue_task", TaskID: m.state.Tasks[1].ID}
	if _, err = m.applyOrchestratorCommand(repo, c); err == nil {
		t.Fatal("cross-repo action accepted")
	}
	c.TaskID = m.state.Tasks[0].ID
	if _, err = m.applyOrchestratorCommand(repo, c); err != nil || !m.state.Tasks[0].Queued {
		t.Fatal(err, "authorized task not queued")
	}
	c = orchestratorCommand{Action: "propose_task", Title: "New scope", Acceptance: "Explicit acceptance", RunID: "run", Seq: 1}
	if _, err = m.applyOrchestratorCommand(repo, c); err != nil {
		t.Fatal(err)
	}
	if len(m.state.Tasks) != 2 || len(m.state.Decisions) != 1 {
		t.Fatal("proposal immediately executed")
	}
	m.execute("answer 1 approved")
	if m.state.Decisions[0].Answer != nil {
		t.Fatal("ordinary answer authorized proposal")
	}
	m.resolveProposal("1", true)
	if len(m.state.Tasks) != 3 || !m.state.Tasks[2].Queued || m.state.Tasks[2].Repo != repo {
		t.Fatal("approval not materialized")
	}
	m.resolveProposal("1", true)
	if len(m.state.Tasks) != 3 {
		t.Fatal("approval repeated")
	}
	_, _ = m.applyOrchestratorCommand(repo, c)
	m.resolveProposal("2", false)
	if len(m.state.Tasks) != 3 || m.state.Decisions[1].Answer == nil {
		t.Fatal("rejected proposal executed")
	}
	_, _ = m.applyOrchestratorCommand(repo, orchestratorCommand{Action: "ask", Question: "Product decision?"})
	m.execute("answer 3 yes")
	m.execute("answer 3 no")
	if *m.state.Decisions[2].Answer != "yes" {
		t.Fatal("answered decision resent/replaced")
	}
	data, _ := json.Marshal(m.orchestratorContext(repo))
	var context struct {
		Tasks     []Task
		Decisions []Decision
	}
	_ = json.Unmarshal(data, &context)
	if len(context.Tasks) != 2 || len(context.Decisions) != 3 {
		t.Fatal("context scope incorrect")
	}
	if _, err = m.applyOrchestratorCommand(repo, orchestratorCommand{Action: "merge"}); err == nil {
		t.Fatal("unsupported command accepted")
	}
}

func TestOrchestratorPollingSequencesAndPersistence(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	repo := t.TempDir()
	m := newModel(store, state, repo)
	dir := t.TempDir()
	w := &terminalWindow{ID: "test", screen: vt10x.New(vt10x.WithSize(80, 20))}
	m.terminals.Windows = []*terminalWindow{w}
	m.sessions["fluke:"+repo] = w.ID
	defer func() { m.terminals.Windows = nil; m.sessions = map[string]string{}; m.cleanup() }()
	s := &orchestratorSession{RunID: "current", Dir: dir, Provider: "codex"}
	m.orchestration[repo] = s
	c := orchestratorCommand{Version: 1, RunID: "old", Seq: 1, Action: "ask", Question: "Question?"}
	write := func() {
		if err := atomicJSON(filepath.Join(dir, "command.json"), c); err != nil {
			t.Fatal(err)
		}
	}
	write()
	m.pollOrchestrators()
	if len(m.state.Decisions) != 0 {
		t.Fatal("stale run accepted")
	}
	c.RunID = s.RunID
	write()
	m.pollOrchestrators()
	m.pollOrchestrators()
	if len(m.state.Decisions) != 1 || s.Seq != 1 {
		t.Fatal("duplicate command")
	}
	var ack orchestratorAck
	data, err := os.ReadFile(filepath.Join(dir, "ack.json"))
	if err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal(data, &ack)
	if !ack.OK || ack.Seq != 1 {
		t.Fatal("missing acknowledgement")
	}
	c.Seq = 2
	c.Action = "forbidden"
	write()
	m.pollOrchestrators()
	data, _ = os.ReadFile(filepath.Join(dir, "ack.json"))
	_ = json.Unmarshal(data, &ack)
	if ack.OK || ack.Seq != 2 {
		t.Fatal("invalid action not acknowledged")
	}
	if err = os.Remove(filepath.Join(store.dir, "state.json")); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(filepath.Join(store.dir, "state.json"), 0700); err != nil {
		t.Fatal(err)
	}
	c.Seq = 3
	c.Action = "ask"
	write()
	m.pollOrchestrators()
	if len(m.state.Decisions) != 1 {
		t.Fatal("failed save changed live state")
	}
	data, _ = os.ReadFile(filepath.Join(dir, "ack.json"))
	_ = json.Unmarshal(data, &ack)
	if ack.OK {
		t.Fatal("failed save acknowledged success")
	}
	// No prompt is injected while a user has a draft or a native dialog is open.
	_, _ = w.screen.Write([]byte("\x1b]0;Codex\x07"))
	s.Notify = true
	s.IdleSince = time.Now().Add(-time.Second)
	w.userInputPending.Store(true)
	if m.wakeOrchestrators() != nil {
		t.Fatal("draft interrupted")
	}
	w.userInputPending.Store(false)
	m.chatDraft[repo] = "draft"
	if m.wakeOrchestrators() != nil {
		t.Fatal("conversation draft interrupted")
	}
	m.chatDraft[repo] = ""
	_, _ = w.screen.Write([]byte("\x1b]0;Action Required\x07"))
	if m.wakeOrchestrators() != nil || s.Sending {
		t.Fatal("approval dialog interrupted")
	}
}

func TestContinuationCrashRecoveryAndQueueReservation(t *testing.T) {
	dir := t.TempDir()
	store, state, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	repo := t.TempDir()
	_ = state.addTask(repo, "One", "Result")
	_ = state.addTask(repo, "Two", "Result")
	answer := "yes"
	state.Decisions = []Decision{{Repo: repo, TaskID: state.Tasks[0].ID, RunID: "run", Seq: 1, Answer: &answer, Continuation: "sending"}}
	if err = store.save(state); err != nil {
		t.Fatal(err)
	}
	_ = store.lock.Close()
	store, state, err = openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	if state.Decisions[0].Continuation != "uncertain" {
		t.Fatal("crash blindly retries prompt")
	}
	state.Orchestrator = &AgentConfig{Provider: "codex", Executable: "codex", Arguments: []string{}}
	state.MaxWorkers = 1
	m := newModel(store, state, repo)
	defer m.cleanup()
	m.queueTask(state.Tasks[0].ID, true)
	m.queueTask(state.Tasks[1].ID, true)
	if m.drainQueue() == nil || !m.preparingWorker || m.liveWorkers() != 1 {
		t.Fatal("queue failed to reserve slot")
	}
	if m.drainQueue() != nil {
		t.Fatal("queue exceeded reserved capacity")
	}
	m.preparing = false
	m.preparingWorker = false
	m.failQueuedLaunch(state.Tasks[0].ID, "Launch error")
	if m.state.Tasks[0].Queued || !m.state.Tasks[1].Queued {
		t.Fatal("failed launch loops/loses remaining queue")
	}
}

func TestCoordinatorRetriesAckAndCancelsPreparedLaunch(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	repo := t.TempDir()
	state.Orchestrator = &AgentConfig{Provider: "codex", Executable: "codex", Arguments: []string{}}
	_ = state.addTask(repo, "One", "Result")
	m := newModel(store, state, repo)
	dir := t.TempDir()
	w := &terminalWindow{ID: "test", writer: &ptyWriter{}, screen: vt10x.New(vt10x.WithSize(80, 20))}
	m.terminals.Windows = []*terminalWindow{w}
	m.sessions["fluke:"+repo] = w.ID
	defer func() { m.terminals.Windows = nil; m.sessions = map[string]string{}; m.cleanup() }()
	s := &orchestratorSession{RunID: "run", Dir: dir, Provider: "codex"}
	m.orchestration[repo] = s
	if err = os.Mkdir(filepath.Join(dir, "ack.json"), 0700); err != nil {
		t.Fatal(err)
	}
	c := orchestratorCommand{Version: 1, RunID: "run", Seq: 1, Action: "ask", Question: "Product?"}
	_ = atomicJSON(filepath.Join(dir, "command.json"), c)
	m.pollOrchestrators()
	if s.PendingAck == nil || len(m.state.Decisions) != 1 {
		t.Fatal("failed ack not retained")
	}
	m.pollOrchestrators()
	if len(m.state.Decisions) != 1 {
		t.Fatal("failed ack repeats action")
	}
	if err = os.Remove(filepath.Join(dir, "ack.json")); err != nil {
		t.Fatal(err)
	}
	m.pollOrchestrators()
	if s.PendingAck != nil {
		t.Fatal("ack not retried")
	}
	var ack orchestratorAck
	data, _ := os.ReadFile(filepath.Join(dir, "ack.json"))
	_ = json.Unmarshal(data, &ack)
	if !ack.OK || ack.Seq != 1 {
		t.Fatal("wrong retry acknowledgement")
	}
	m.queueTask(state.Tasks[0].ID, true)
	if m.drainQueue() == nil {
		t.Fatal("no launch preparation")
	}
	m.queueTask(state.Tasks[0].ID, false)
	m.Update(launchResult{taskID: state.Tasks[0].ID, path: repo, argv: []string{"invalid-executable"}})
	if len(m.terminals.Windows) != 1 || m.state.Tasks[0].Status != "pending" || m.preparing {
		t.Fatal("unqueue did not cancel prepared launch")
	}
	// A human draft appears after the Cmd was scheduled but before it executes.
	_, _ = w.screen.Write([]byte("\x1b]0;Codex\x07"))
	s.Notify = true
	s.IdleSince = time.Now().Add(-time.Second)
	cmd := m.wakeOrchestrators()
	if cmd == nil {
		t.Fatal("no wake command")
	}
	w.conversationPending.Store(true)
	// tea.Batch returns the only Cmd directly when there is one command.
	msg := cmd()
	m.Update(msg)
	if !s.Notify || s.Sending {
		t.Fatal("deferred automatic prompt lost notification")
	}
}

func TestGoalApprovalAndAutonomousDecomposition(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	repo := t.TempDir()
	m := newModel(store, state, repo)
	defer m.cleanup()
	task := orchestratorCommand{Action: "create_task", Title: "One part", Acceptance: "Verified part"}
	if _, err = m.applyOrchestratorCommand(repo, task); err == nil {
		t.Fatal("tasks created without agreed goal")
	}
	_, err = m.applyOrchestratorCommand(repo, orchestratorCommand{Action: "propose_goal", RunID: "run", Seq: 1, Title: "Complete export", Acceptance: "Valid JSON and documented use"})
	if err != nil {
		t.Fatal(err)
	}
	if len(m.state.Goals) != 0 || len(m.state.Tasks) != 0 {
		t.Fatal("goal bypasses approval")
	}
	m.resolveProposal("1", true)
	goal := m.state.Goals[repo]
	if goal.ID == "" || len(m.state.Tasks) != 0 {
		t.Fatal("approval did not agree goal / created a task prematurely")
	}
	task.GoalID = goal.ID
	if _, err = m.applyOrchestratorCommand(repo, task); err != nil {
		t.Fatal(err)
	}
	if len(m.state.Tasks) != 1 || !m.state.Tasks[0].Queued || m.state.Tasks[0].GoalID != goal.ID {
		t.Fatal("authorized decomposition failed")
	}
	if _, err = m.applyOrchestratorCommand(repo, task); err == nil || len(m.state.Tasks) != 1 {
		t.Fatal("reanudar el orquestador duplicó una tarea del mismo objetivo")
	}
	if _, err = os.Stat(filepath.Join(repo, ".fluke", "specs", goal.ID+".json")); err != nil {
		t.Fatal("agreed spec missing", err)
	}
	task.GoalID = "stale"
	if _, err = m.applyOrchestratorCommand(repo, task); err == nil {
		t.Fatal("old objective authorized new task")
	}
	if err = store.save(m.state); err != nil {
		t.Fatal(err)
	}
	_ = store.lock.Close()
	reopened, recovered, err := openStore(store.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.lock.Close()
	if recovered.Goals[repo].Objective != goal.Objective || recovered.Tasks[0].GoalID != goal.ID {
		t.Fatal("agreed objective lost on restart")
	}
}
