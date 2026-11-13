package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTaskManualPauseSurvivesProjectResume(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	repo, other := t.TempDir(), t.TempDir()
	state.Tasks = []Task{
		{ID: "manual", Repo: repo, Status: "pending", Queued: true},
		{ID: "other", Repo: other, Status: "pending", Queued: true},
	}
	m := newModel(store, state, repo)
	defer m.cleanup()
	m.setTaskPaused("manual", true)
	m.pauseProject()
	m.resumeProject()
	if !m.state.Tasks[0].Paused || !m.state.Tasks[0].ManuallyPaused || !m.state.Tasks[0].Queued {
		t.Fatal("project resume removed explicit individual pause or queue intent")
	}
	if m.state.Tasks[1].Paused || m.state.Tasks[1].ManuallyPaused {
		t.Fatal("other project task was paused")
	}
	m.setTaskPaused("other", true)
	if !strings.Contains(m.notice, "otro proyecto") || m.state.Tasks[1].Paused {
		t.Fatal("individual pause bypassed current project")
	}
	m.setTaskPaused("manual", false)
	if m.state.Tasks[0].Paused || m.state.Tasks[0].ManuallyPaused || !m.state.Tasks[0].Queued {
		t.Fatal("individual resume did not release queued task")
	}
}

func TestTaskPauseSaveFailureKeepsWorkerRunning(t *testing.T) {
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
	m.setTaskPaused("own", true)
	if !m.sessionAlive("own") || m.state.Tasks[0].Paused || m.state.Tasks[0].ManuallyPaused || m.cancelPreparing {
		t.Fatal("failed pause persistence stopped worker or changed state")
	}
}

func TestTaskPauseStopsOwnSessionAndCancelsOwnPreparation(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	repo := t.TempDir()
	state.Tasks = []Task{{ID: "own", Repo: repo, Status: "running"}, {ID: "other", Repo: repo, Status: "pending"}}
	m := newModel(store, state, repo)
	defer m.cleanup()
	pauseTestWindow(t, m, "own")
	m.preparing, m.preparingWorker, m.preparingTaskID = true, true, "other"
	m.setTaskPaused("own", true)
	if m.sessionAlive("own") || m.cancelPreparing || m.state.Tasks[0].Status != "interrupted" {
		t.Fatal("pause failed to stop own worker or canceled another task preparation")
	}
	m.setTaskPaused("other", true)
	if !m.cancelPreparing || !m.state.Tasks[1].ManuallyPaused {
		t.Fatal("individual pause did not cancel its pending launch")
	}
}

func TestTaskResumeWaitsForProjectAndDoesNotQueueDeliveries(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	repo := t.TempDir()
	state.PausedProjects = map[string]bool{repo: true}
	state.Tasks = []Task{
		{ID: "pending", Repo: repo, Status: "interrupted", Paused: true, ManuallyPaused: true},
		{ID: "ready", Repo: repo, Status: "awaiting_review", Paused: true, ManuallyPaused: true},
		{ID: "accepted", Repo: repo, Status: "accepted"},
	}
	m := newModel(store, state, repo)
	defer m.cleanup()
	m.setTaskPaused("pending", false)
	if !m.state.Tasks[0].Paused || m.state.Tasks[0].ManuallyPaused || !m.state.Tasks[0].Queued || !strings.Contains(m.notice, "proyecto sigue pausado") {
		t.Fatal("individual resume bypassed project pause")
	}
	m.setTaskPaused("ready", false)
	if m.state.Tasks[1].Queued || m.state.Tasks[1].Status != "awaiting_review" {
		t.Fatal("ready delivery was queued by resume")
	}
	m.setTaskPaused("accepted", true)
	if m.state.Tasks[2].Paused || m.state.Tasks[2].ManuallyPaused {
		t.Fatal("accepted delivery was paused")
	}
}
