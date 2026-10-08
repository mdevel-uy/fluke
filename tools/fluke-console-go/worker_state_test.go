package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hinshun/vt10x"
)

func TestWorkerSignalsQuestionsAndReview(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	repo := t.TempDir()
	state.Projects = []string{repo}
	state.Tasks = []Task{{ID: "t123", Repo: repo, Worktree: &repo, Branch: "codex/fluke/t123", Status: "running", AgentRun: "run1", AgentProvider: "codex"}}
	state.Decisions = []Decision{{Repo: t.TempDir(), Question: "Other project"}}
	m := newModel(store, state, repo)
	w := &terminalWindow{ID: "test", screen: vt10x.New(vt10x.WithSize(100, 20))}
	m.terminals.Windows = []*terminalWindow{w}
	m.sessions["t123"] = w.ID
	writeTitle := func(title string) { _, _ = w.screen.Write([]byte("\x1b]0;" + title + "\x07")); m.observeWorkers(true) }
	writeTitle("Codex")
	if m.state.Tasks[0].AgentState != "idle" || m.state.Tasks[0].Status != "running" {
		t.Fatal("startup readiness incorrectly completed a task")
	}
	writeTitle("⠋ Codex")
	writeTitle("Codex")
	if m.state.Tasks[0].AgentState != "turn_finished" || m.state.Tasks[0].Status != "running" {
		t.Fatal("turn completion incorrectly accepted a task")
	}
	writeTitle("Action Required")
	if m.state.Tasks[0].AgentState != "blocked" {
		t.Fatal("approval not detected")
	}
	if got := detectAgentState("custom", "Action Required", ""); got != "unknown" {
		t.Fatal("custom CLI guessed", got)
	}
	quotaScreen := "You've hit your session limit · resets 3:40am\nStop and wait for limit to reset\nEnter to confirm"
	if detectAgentState("claude", "✳ Claude Code", quotaScreen) != "blocked" || providerLimitMessage("claude", quotaScreen) == "" {
		t.Fatal("Claude quota was treated as idle")
	}
	if providerLimitMessage("claude", "You've hit your session limit · resets 3:40am\n❯ Next message") != "" {
		t.Fatal("old quota message blocked a recovered CLI")
	}
	if got := detectAgentState("codex", `C:\WINDOWS\system32\cmd.exe`, "Trust this folder?\n1. Trust and continue\n\n\n"); got != "blocked" {
		t.Fatal("trust prompt classified as idle", got)
	}
	if got := detectAgentState("codex", `C:\WINDOWS\system32\cmd.exe`, ""); got != "unknown" {
		t.Fatal("shell title classified as agent readiness", got)
	}
	os.MkdirAll(filepath.Join(repo, ".fluke-worker"), 0700)
	path := workerSignalPath(repo, "t123", "run1", "state")
	// Claude can send a valid question without a separate redundant summary.
	report := workerReport{Version: 1, RunID: "run1", Seq: 1, Status: "needs_response", Question: "¿CSV o JSON?"}
	if err := atomicJSON(path, report); err != nil {
		t.Fatal(err)
	}
	m.observeWorkers(false)
	if len(m.state.Decisions) != 1 {
		t.Fatal("terminal redraw scanned report files")
	}
	m.observeWorkers(true)
	m.observeWorkers(true)
	if len(m.state.Decisions) != 2 || m.selectedDecision() != 1 || !strings.Contains(m.decisionsView(100, 25), report.Question) {
		t.Fatal("lost question or repeated it", m.state.Decisions)
	}
	m.execute("answer 2 JSON")
	_, _ = w.screen.Write([]byte("\x1b]0;Codex\x07\x1b[2J"))
	m.idleSince["t123"] = time.Now().Add(-time.Second)
	if m.continueAnsweredWorkers() == nil {
		t.Fatal("saved answer was not dispatched")
	}
	data, err := os.ReadFile(workerSignalPath(repo, "t123", "run1", "answer"))
	if err != nil {
		t.Fatal(err)
	}
	var answer Decision
	if err := json.Unmarshal(data, &answer); err != nil || answer.Answer == nil || *answer.Answer != "JSON" || answer.Seq != 1 || answer.RunID != "run1" {
		t.Fatal("lost answer association", string(data))
	}
	report.Seq = 2
	report.Status = "ready"
	report.Message = "Implementado y verificado"
	report.Question = ""
	report.Evidence = []string{"missing.txt"}
	atomicJSON(path, report)
	m.observeWorkers(true)
	if m.state.Tasks[0].Status == "awaiting_review" {
		t.Fatal("accepted missing evidence")
	}
	os.WriteFile(filepath.Join(repo, "result.txt"), []byte("result"), 0600)
	report.Evidence = []string{"../outside.txt"}
	atomicJSON(path, report)
	m.observeWorkers(true)
	if m.state.Tasks[0].Status == "awaiting_review" {
		t.Fatal("accepted evidence outside worktree")
	}
	report.Evidence = []string{"result.txt"}
	report.RunID = "old-run"
	atomicJSON(path, report)
	m.observeWorkers(true)
	if m.state.Tasks[0].AgentSeq != 1 {
		t.Fatal("accepted stale execution")
	}
	report.RunID = "run1"
	atomicJSON(path, report)
	// Persistence failure must leave the report retryable.
	os.Remove(filepath.Join(store.dir, "state.json"))
	os.Mkdir(filepath.Join(store.dir, "state.json"), 0700)
	m.observeWorkers(true)
	if m.state.Tasks[0].AgentSeq != 1 {
		t.Fatal("lost unpersisted result")
	}
	os.Remove(filepath.Join(store.dir, "state.json"))
	m.observeWorkers(true)
	if m.state.Tasks[0].Status != "awaiting_review" || m.liveWorkers() != 1 {
		t.Fatal("review or live capacity wrong", m.state.Tasks)
	}
	w.exited.Store(true)
	m.reconcile()
	if m.state.Tasks[0].Status != "awaiting_review" || m.liveWorkers() != 0 {
		t.Fatal("exit erased deliverable")
	}
}
