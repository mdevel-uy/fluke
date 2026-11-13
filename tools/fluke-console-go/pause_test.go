package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func pauseTestWindow(t *testing.T, m *model, key string) {
	t.Helper()
	argv := []string{"sh", "-c", "sleep 30"}
	if runtime.GOOS == "windows" {
		argv = []string{"powershell.exe", "-NoLogo", "-NoProfile", "-Command", "Start-Sleep -Seconds 30"}
	}
	before := len(m.terminals.Windows)
	m.terminals.AddWindowIn(t.TempDir(), key, argv...)
	if len(m.terminals.Windows) != before+1 {
		t.Fatal(m.terminals.lastError)
	}
	m.sessions[key] = m.terminals.Windows[before].ID
}

func TestPauseStopsOnlyProjectWorkersAndResumePreservesReview(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	repo, other := t.TempDir(), t.TempDir()
	state.Tasks = []Task{
		{ID: "own", Repo: repo, Status: "running"},
		{ID: "other", Repo: other, Status: "running"},
		{ID: "review", Repo: repo, Status: "awaiting_review", Paused: true},
		{ID: "done", Repo: repo, Status: "accepted", Paused: true},
	}
	m := newModel(store, state, repo)
	defer m.cleanup()
	pauseTestWindow(t, m, "own")
	pauseTestWindow(t, m, "other")
	pauseTestWindow(t, m, "fluke:"+repo)
	m.pauseProject()
	if !m.state.PausedProjects[repo] || !m.state.Tasks[0].Paused || m.state.Tasks[0].Status != "interrupted" {
		t.Fatalf("own task was not paused: %+v", m.state.Tasks[0])
	}
	if m.sessionAlive("own") || !m.sessionAlive("other") || !m.sessionAlive("fluke:"+repo) {
		t.Fatal("pause stopped an unrelated session or left its worker alive")
	}
	if m.state.Tasks[1].Paused || m.state.PausedProjects[other] {
		t.Fatal("other project was paused")
	}
	if !strings.Contains(m.notice, "Workers detenidos") {
		t.Fatal(m.notice)
	}
	m.resumeProject()
	if m.state.PausedProjects[repo] || !m.state.Tasks[0].Queued || m.state.Tasks[0].Paused {
		t.Fatal("resume did not queue interrupted paused task")
	}
	for _, task := range m.state.Tasks[2:] {
		if task.Queued || task.Paused {
			t.Fatalf("reviewed task incorrectly resumed: %+v", task)
		}
	}
}

func TestPauseSaveFailureKeepsWorkerAndPreparation(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	repo := t.TempDir()
	state.Tasks = []Task{{ID: "own", Repo: repo, Status: "running"}}
	m := newModel(store, state, repo)
	defer m.cleanup()
	pauseTestWindow(t, m, "own")
	m.preparing, m.preparingWorker, m.preparingTaskID = true, true, "own"
	if err = os.Mkdir(filepath.Join(store.dir, "state.json"), 0700); err != nil {
		t.Fatal(err)
	}
	m.pauseProject()
	if !m.sessionAlive("own") || m.state.PausedProjects[repo] || m.state.Tasks[0].Paused || m.cancelPreparing {
		t.Fatal("failed persistence stopped work or mutated state")
	}
	if !strings.Contains(m.notice, "No se pudo guardar") {
		t.Fatal(m.notice)
	}
}

func TestPauseCancelsPreparationAndResumeQueuesIt(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	repo := t.TempDir()
	state.Tasks = []Task{{ID: "preparing", Repo: repo, Status: "pending"}}
	m := newModel(store, state, repo)
	defer m.cleanup()
	m.preparing, m.preparingWorker, m.preparingTaskID = true, true, "preparing"
	m.pauseProject()
	if !m.cancelPreparing || !m.state.Tasks[0].Paused {
		t.Fatal("preparation escaped project pause")
	}
	m.resumeProject()
	if !m.state.Tasks[0].Queued || m.state.Tasks[0].Paused {
		t.Fatal("preparation was lost on resume")
	}
}

func TestProjectPauseSurvivesRestart(t *testing.T) {
	dir, repo := t.TempDir(), t.TempDir()
	store, state, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err = state.addTask(repo, "Interrupted task", "Changes reviewed"); err != nil {
		t.Fatal(err)
	}
	state.Tasks[0].Status, state.Tasks[0].Paused = "interrupted", true
	m := newModel(store, state, repo)
	m.pauseProject()
	if err = store.lock.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, recovered, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.lock.Close()
	if !recovered.PausedProjects[repo] || !recovered.Tasks[0].Paused || recovered.Tasks[0].Status != "interrupted" {
		t.Fatal("saved project/task pause lost after restart")
	}
	restarted := newModel(reopened, recovered, repo)
	restarted.resumeProject()
	if restarted.state.PausedProjects[repo] || restarted.state.Tasks[0].Paused || !restarted.state.Tasks[0].Queued {
		t.Fatal("persisted paused task could not resume")
	}
}
