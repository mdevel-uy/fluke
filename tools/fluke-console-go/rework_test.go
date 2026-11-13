package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/hinshun/vt10x"
)

func TestHumanReviewCannotBeSatisfiedByAnOldWorkerReport(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	repo := t.TempDir()
	_ = state.addTask(repo, "Entrega", "Archivo verificado")
	task := &state.Tasks[0]
	task.Status, task.AgentRun, task.AgentSeq, task.AgentProvider, task.Worktree = "awaiting_review", "run", 1, "codex", &repo
	m := newModel(store, state, repo)
	w := &terminalWindow{ID: "worker", screen: vt10x.New(vt10x.WithSize(80, 20))}
	m.terminals.Windows = []*terminalWindow{w}
	m.sessions[task.ID] = w.ID
	_, _ = w.screen.Write([]byte("\x1b]0;Codex\x07"))
	m.idleSince[task.ID] = time.Now().Add(-time.Second)
	_ = os.Mkdir(filepath.Join(repo, ".fluke-worker"), 0700)
	_ = os.WriteFile(filepath.Join(repo, "result.txt"), []byte("before"), 0600)
	m.requestTaskChanges(task.ID, "Agregar el caso de error faltante")
	if m.state.Tasks[0].Status != "running" || m.state.Tasks[0].ReviewFeedback == "" || len(m.state.Decisions) != 1 {
		t.Fatal("feedback not registered", m.notice)
	}
	var answer Decision
	data, err := os.ReadFile(workerSignalPath(repo, task.ID, "run", "answer"))
	if err != nil || json.Unmarshal(data, &answer) != nil || !answer.ReviewFeedback || answer.Answer == nil {
		t.Fatal("feedback not delivered through existing contract", err)
	}
	m.acceptTask(task.ID)
	if m.state.Tasks[0].Status == "accepted" {
		t.Fatal("accepted stale delivery while feedback pending")
	}
	report := workerReport{Version: 1, RunID: "run", Seq: 2, Status: "ready", Message: "Old delivery", Evidence: []string{"result.txt"}}
	path := workerSignalPath(repo, task.ID, "run", "state")
	_ = atomicJSON(path, report)
	m.observeWorkers(true)
	if m.state.Tasks[0].Status == "awaiting_review" {
		t.Fatal("pre-feedback result came back to review")
	}
	_ = m.setContinuation(0, "sent")
	m.observeWorkers(true)
	if m.state.Tasks[0].Status == "awaiting_review" {
		t.Fatal("missing feedback acknowledgment accepted")
	}
	report.ReviewSeq = 1
	_ = atomicJSON(path, report)
	m.observeWorkers(true)
	if m.state.Tasks[0].Status != "awaiting_review" || m.state.Tasks[0].AgentSeq != 2 {
		t.Fatal("corrected delivery couldn't be reviewed", m.notice)
	}
}

func TestReviewFeedbackSurvivesRestartAndFailedSaveDoesNotApply(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo := t.TempDir()
	_ = state.addTask(repo, "Entrega", "Verificado")
	state.Tasks[0].Status = "awaiting_review"
	m := newModel(store, state, repo)
	m.requestTaskChanges(state.Tasks[0].ID, "Corregir validación")
	if !m.state.Tasks[0].Queued || m.state.Tasks[0].Status != "interrupted" {
		t.Fatal("closed worker didn't retain queued correction")
	}
	_ = store.lock.Close()
	reopened, restored, err := openStore(store.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.lock.Close()
	if restored.Tasks[0].ReviewFeedback != "Corregir validación" {
		t.Fatal("feedback lost on restart")
	}
	restored.Tasks[0].Status = "awaiting_review"
	m = newModel(reopened, restored, repo)
	if err = os.Remove(filepath.Join(store.dir, "state.json")); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(filepath.Join(store.dir, "state.json"), 0700); err != nil {
		t.Fatal(err)
	}
	m.requestTaskChanges(state.Tasks[0].ID, "Otro comentario")
	if m.state.Tasks[0].Status != "awaiting_review" || m.state.Tasks[0].ReviewFeedback != "Corregir validación" {
		t.Fatal("failed save changed task")
	}
}
