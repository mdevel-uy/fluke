package main

import (
	"testing"
)

func TestOnlyHumanAcceptanceCompletesDeliveryAndSurvivesRestart(t *testing.T) {
	repo := testRepo(t)
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	state.Orchestrator = &AgentConfig{Provider: "codex", Executable: "codex"}
	_ = state.addTask(repo, "Entrega", "Un resultado comprobable")
	path, err := prepareTask(state.Tasks[0], store.dir)
	if err != nil {
		t.Fatal(err)
	}
	state.Tasks[0].Worktree = &path
	m := newModel(store, state, repo)
	defer m.cleanup()
	id := state.Tasks[0].ID
	m.acceptTask(id)
	if m.state.Tasks[0].Status != "pending" {
		t.Fatal("se aceptó una tarea sin entrega")
	}
	m.state.Tasks[0].Status = "awaiting_review"
	cmd := m.acceptTask(id)
	if cmd == nil {
		t.Fatal(m.notice)
	}
	m.Update(cmd())
	if m.state.Tasks[0].Status != "accepted" || m.start(id) != nil {
		t.Fatal("la entrega aceptada vuelve a ejecutar el worker")
	}
	_ = store.lock.Close()
	reopened, recovered, err := openStore(store.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.lock.Close()
	if recovered.Tasks[0].Status != "accepted" {
		t.Fatal("la aceptación humana no sobrevive un reinicio")
	}
}
