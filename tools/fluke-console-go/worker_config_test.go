package main

import (
	"strings"
	"testing"
)

func TestWorkerConfigIsPerTaskAndCannotReplaceLiveSession(t *testing.T) {
	m, task := messageTestModel(t)
	m.assignWorkerConfig(task.ID + " | claude | sonnet")
	if m.state.Tasks[0].WorkerConfig != nil {
		t.Fatal("live worker configuration changed")
	}
	m.terminalFor(task.ID).exited.Store(true)
	m.state.Tasks[0].Status = "interrupted"
	m.assignWorkerConfig(task.ID + " | claude | sonnet")
	a := m.state.Tasks[0].WorkerConfig
	if a == nil || a.Provider != "claude" || a.Model != "sonnet" || len(a.Arguments) != 0 || m.state.Orchestrator.Provider != "codex" {
		t.Fatal("provider configuration leaked", a)
	}
	m.assignWorkerConfig(task.ID + " | claude | " + strings.Repeat("x", 101))
	if m.state.Tasks[0].WorkerConfig.Model != "sonnet" {
		t.Fatal("invalid model persisted")
	}
	m.assignWorkerConfig(task.ID + " | default | ")
	if m.state.Tasks[0].WorkerConfig != nil {
		t.Fatal("default did not restore global selection")
	}
}
