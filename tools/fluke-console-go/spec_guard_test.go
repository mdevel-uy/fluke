package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func supervisedSpecTask(t *testing.T, m *model) Task {
	t.Helper()
	index := goalScopeTestTask(t, m, m.repo, "Supervised task")
	task := &m.state.Tasks[index]
	path := t.TempDir()
	task.Worktree, task.BriefHash = &path, briefIdentity(*task)
	if err := writeBrief(filepath.Join(m.repo, ".fluke", "specs", task.ID+".md"), taskBrief(*task)); err != nil {
		t.Fatal(err)
	}
	if err := writeBrief(filepath.Join(path, ".fluke-task.md"), taskBrief(*task)); err != nil {
		t.Fatal(err)
	}
	if err := atomicJSON(filepath.Join(m.repo, ".fluke", "specs", task.GoalID+".json"), m.state.Goals[m.repo]); err != nil {
		t.Fatal(err)
	}
	return *task
}

func TestSpecGuardDetectsEditsAndPreservesTheirContent(t *testing.T) {
	m := goalScopeTestModel(t)
	task := supervisedSpecTask(t, m)
	goal := m.state.Goals[m.repo]
	if err := checkTaskSpecs(task, goal); err != nil {
		t.Fatal(err)
	}
	// Goal JSON formatting is harmless; its approved meaning must remain identical.
	data, _ := json.Marshal(goal)
	goalPath := filepath.Join(m.repo, ".fluke", "specs", goal.ID+".json")
	if err := os.WriteFile(goalPath, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := checkTaskSpecs(task, goal); err != nil {
		t.Fatal("format-only goal change blocked", err)
	}
	goal.Acceptance = "Changed outside Fluke"
	if err := atomicJSON(goalPath, goal); err != nil {
		t.Fatal(err)
	}
	if err := checkTaskSpecs(task, m.state.Goals[m.repo]); err == nil {
		t.Fatal("external goal edit accepted")
	}
	data, _ = os.ReadFile(goalPath)
	if string(data) == "" || !json.Valid(data) {
		t.Fatal("edited goal was overwritten")
	}
	if err := atomicJSON(goalPath, m.state.Goals[m.repo]); err != nil {
		t.Fatal(err)
	}
	brief := filepath.Join(*task.Worktree, ".fluke-task.md")
	if err := os.WriteFile(brief, []byte("Edited task scope"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := checkTaskSpecs(task, m.state.Goals[m.repo]); err == nil {
		t.Fatal("external task brief edit accepted")
	}
	if data, _ = os.ReadFile(brief); string(data) != "Edited task scope" {
		t.Fatal("edited brief was overwritten")
	}
}

func TestSpecGuardStopsOwnedWorkerAndBlocksResumeUntilRestored(t *testing.T) {
	m := goalScopeTestModel(t)
	task := supervisedSpecTask(t, m)
	pauseTestWindow(t, m, task.ID)
	m.state.Tasks[0].Status = "running"
	m.state.Tasks[0].Queued = true
	brief := filepath.Join(*task.Worktree, ".fluke-task.md")
	if err := os.WriteFile(brief, []byte("Edited task scope"), 0600); err != nil {
		t.Fatal(err)
	}
	m.enforceTaskSpecs()
	if m.sessionAlive(task.ID) || !m.state.Tasks[0].Paused || m.state.Tasks[0].Queued {
		t.Fatal("edited spec kept running", m.notice)
	}
	m.setTaskPaused(task.ID, false)
	if !m.state.Tasks[0].Paused {
		t.Fatal("resume bypassed edited brief")
	}
	if err := os.WriteFile(brief, []byte(taskBrief(task)), 0600); err != nil {
		t.Fatal(err)
	}
	m.setTaskPaused(task.ID, false)
	if m.state.Tasks[0].Paused {
		t.Fatal("restored approved brief could not resume", m.notice)
	}
}
