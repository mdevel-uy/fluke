package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
)

func TestDependencyQueuePreparesWorkerOnlyAfterHumanIntegration(t *testing.T) {
	state, dependency, target := dependencyTestFixture(t, true)
	store, _, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	state.Orchestrator = &AgentConfig{Provider: "custom", Executable: os.Args[0]}
	state.MaxWorkers = 2
	state.Tasks[1].Queued = true
	m := newModel(store, state, target.Repo)
	result := m.checkDependencies()().(dependencyCheckResult)
	m.Update(result)
	if m.preparing {
		t.Fatal("accepted unmerged delivery launched dependent")
	}
	dependencyTestGit(t, target.Repo, "merge", "--ff-only", dependency.Branch)
	m.dependencyChecked = time.Time{}
	result = m.checkDependencies()().(dependencyCheckResult)
	if dependencyTestGit(t, *target.Worktree, "rev-parse", "HEAD") == dependencyTestGit(t, target.Repo, "rev-parse", "HEAD") {
		t.Fatal("queue readiness check mutated the old worktree")
	}
	_, launch := m.Update(result)
	if launch == nil || !m.preparing || m.preparingTaskID != target.ID {
		t.Fatal("integrated dependency didn't release worker")
	}
	// drainQueue/scheduleWorkerTick returns a Batch; execute the preparation,
	// without starting the test executable as a child worker.
	msg := launch()
	if batch, ok := msg.(tea.BatchMsg); ok {
		msg = batch[0]()
	}
	prepared := msg.(launchResult)
	if prepared.err != nil || prepared.taskID != target.ID {
		t.Fatalf("prepare: %+v", prepared)
	}
	if data, err := os.ReadFile(filepath.Join(prepared.path, "product.txt")); err != nil || string(data) != "dependency changes" {
		t.Fatal("worker base lacks prerequisite", err)
	}
	if prepared.baseCommit != dependencyTestGit(t, target.Repo, "rev-parse", "HEAD") {
		t.Fatal("review base includes prerequisite changes")
	}
}

func TestDependentQueueWaitsWithoutBlockingIndependentTask(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	repo := t.TempDir()
	state.Orchestrator = &AgentConfig{Provider: "custom", Executable: os.Args[0]}
	for _, title := range []string{"Base", "Dependent", "Independent"} {
		if err = state.addTask(repo, title, "Verified"); err != nil {
			t.Fatal(err)
		}
	}
	state.Tasks[1].DependsOn = []string{state.Tasks[0].ID}
	state.Tasks[1].Queued = true
	m := newModel(store, state, repo)
	check := m.drainQueue()
	if check == nil || m.preparing {
		t.Fatal("blocked dependency reserved a worker")
	}
	result := check().(dependencyCheckResult)
	if result.Reasons[state.Tasks[1].ID] == "" {
		t.Fatal("unaccepted prerequisite considered ready")
	}
	m.Update(result)
	if !m.state.Tasks[1].Queued || m.preparing {
		t.Fatal("dependency lost its queue intent or launched")
	}
	m.state.Tasks[2].Queued = true
	if m.drainQueue() == nil || m.preparingTaskID != state.Tasks[2].ID {
		t.Fatal("dependent task starved independent work")
	}
	m.preparing, m.preparingWorker = false, false
	m.Update(launchResult{taskID: state.Tasks[1].ID, err: errors.New("waiting for integration"), dependencyBlocked: true})
	if !m.state.Tasks[1].Queued {
		t.Fatal("blocked launch removed dependent from queue")
	}
}

func TestDependencyEditsAreValidatedAndPersisted(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo := t.TempDir()
	for _, title := range []string{"Base", "Dependent"} {
		_ = state.addTask(repo, title, "Verified")
	}
	m := newModel(store, state, repo)
	m.setDependencies(state.Tasks[1].ID, state.Tasks[0].ID)
	if len(m.state.Tasks[1].DependsOn) != 1 {
		t.Fatal("dependency not saved")
	}
	m.setDependencies(state.Tasks[0].ID, state.Tasks[1].ID)
	if len(m.state.Tasks[0].DependsOn) != 0 {
		t.Fatal("cycle accepted")
	}
	if err = store.save(m.state); err != nil {
		t.Fatal(err)
	}
	_ = store.lock.Close()
	reopened, restored, err := openStore(store.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.lock.Close()
	if len(restored.Tasks[1].DependsOn) != 1 {
		t.Fatal("dependency lost on restart")
	}
	m.dependencyChecked = time.Now()
	m.dependencyHash = dependencyStateHash(m.state)
	m.Update(dependencyCheckResult{Hash: [32]byte{1}, Reasons: map[string]string{state.Tasks[1].ID: ""}})
	if len(m.dependencyChecks) != 0 {
		t.Fatal("stale dependency probe accepted")
	}
}
