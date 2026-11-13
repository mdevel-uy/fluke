package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestTaskScopeErrorPreservesLegacyAndChecksCurrentGoal(t *testing.T) {
	state := State{Goals: map[string]ProjectGoal{"repo": {ID: "current"}}}
	for _, test := range []struct {
		name, repo, goal string
		blocked          bool
	}{
		{"legacy", "repo", "", false},
		{"current", "repo", "current", false},
		{"old", "repo", "old", true},
		{"missing objective", "other", "old", true},
		{"legacy without objective", "other", "", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := taskScopeError(state, Task{ID: "t1", Repo: test.repo, GoalID: test.goal})
			if (err != nil) != test.blocked {
				t.Fatalf("scope error = %v; blocked = %v", err, test.blocked)
			}
		})
	}
}

func goalScopeTestModel(t *testing.T) *model {
	t.Helper()
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo := t.TempDir()
	if err = state.setGoal(repo, "Old goal", "Old acceptance"); err != nil {
		t.Fatal(err)
	}
	m := newModel(store, state, repo)
	t.Cleanup(func() { m.cleanup(); _ = m.store.lock.Close() })
	return m
}

func goalScopeTestTask(t *testing.T, m *model, repo, title string) int {
	t.Helper()
	if err := m.state.addTask(repo, title, "Preserve this acceptance"); err != nil {
		t.Fatal(err)
	}
	return len(m.state.Tasks) - 1
}

func TestGoalScopeEditStopsOldWorkersAndPreservesOtherWork(t *testing.T) {
	m := goalScopeTestModel(t)
	other := t.TempDir()
	if err := m.state.setGoal(other, "Other goal", "Other acceptance"); err != nil {
		t.Fatal(err)
	}
	own := goalScopeTestTask(t, m, m.repo, "Running old task")
	preparing := goalScopeTestTask(t, m, m.repo, "Preparing old task")
	accepted := goalScopeTestTask(t, m, m.repo, "Accepted old task")
	legacy := goalScopeTestTask(t, m, m.repo, "Legacy task")
	elsewhere := goalScopeTestTask(t, m, other, "Other worker")
	path := t.TempDir()
	marker := filepath.Join(path, "preserved.txt")
	if err := os.WriteFile(marker, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	m.state.Tasks[own].Status, m.state.Tasks[own].Worktree = "running", &path
	m.state.Tasks[preparing].Queued = true
	m.state.Tasks[accepted].Status = "accepted"
	m.state.Tasks[legacy].GoalID, m.state.Tasks[legacy].Queued = "", true
	m.state.Tasks[elsewhere].Status = "running"
	acceptedBefore, legacyBefore, elsewhereBefore := m.state.Tasks[accepted], m.state.Tasks[legacy], m.state.Tasks[elsewhere]
	pauseTestWindow(t, m, m.state.Tasks[own].ID)
	pauseTestWindow(t, m, m.state.Tasks[elsewhere].ID)
	pauseTestWindow(t, m, "fluke:"+m.repo)
	m.preparing, m.preparingWorker, m.preparingTaskID = true, true, m.state.Tasks[preparing].ID
	next := m.state
	if err := next.setGoal(m.repo, "New goal", "New acceptance"); err != nil {
		t.Fatal(err)
	}
	if !m.saveGoalEdit(next, "Objetivo acordado.") {
		t.Fatal(m.notice)
	}
	if m.sessionAlive(m.state.Tasks[own].ID) || !m.cancelPreparing || m.state.Tasks[own].Status != "interrupted" {
		t.Fatal("old worker or preparation escaped objective change")
	}
	for _, index := range []int{own, preparing} {
		task := m.state.Tasks[index]
		if !task.Paused || task.Queued || !strings.Contains(task.Note, "alcance anterior") {
			t.Fatalf("old task not held with its reason: %+v", task)
		}
	}
	if !reflect.DeepEqual(acceptedBefore, m.state.Tasks[accepted]) || !reflect.DeepEqual(legacyBefore, m.state.Tasks[legacy]) || !reflect.DeepEqual(elsewhereBefore, m.state.Tasks[elsewhere]) {
		t.Fatal("accepted, legacy or unrelated task changed")
	}
	if !m.sessionAlive(m.state.Tasks[elsewhere].ID) || !m.sessionAlive("fluke:"+m.repo) {
		t.Fatal("unrelated worker or orchestrator was stopped")
	}
	if content, err := os.ReadFile(marker); err != nil || string(content) != "keep" {
		t.Fatal("worker files changed", err)
	}
	if err := m.store.lock.Close(); err != nil {
		t.Fatal(err)
	}
	store, recovered, err := openStore(m.store.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	if !recovered.Tasks[own].Paused || recovered.Tasks[own].Queued || !strings.Contains(recovered.Tasks[own].Note, "alcance anterior") {
		t.Fatal("objective hold did not survive reopening")
	}
}

func TestGoalScopeEditSaveFailureKeepsWorkerAndPreparation(t *testing.T) {
	m := goalScopeTestModel(t)
	index := goalScopeTestTask(t, m, m.repo, "Live task")
	m.state.Tasks[index].Status, m.state.Tasks[index].Queued = "running", true
	id := m.state.Tasks[index].ID
	pauseTestWindow(t, m, id)
	m.preparing, m.preparingWorker, m.preparingTaskID = true, true, id
	beforeGoal, beforeTask := m.state.Goals[m.repo], m.state.Tasks[index]
	next := m.state
	if err := next.setGoal(m.repo, "New goal", "New acceptance"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(m.store.dir, "state.json"), 0700); err != nil {
		t.Fatal(err)
	}
	if m.saveGoalEdit(next, "Changed") || !m.sessionAlive(id) || m.cancelPreparing || !reflect.DeepEqual(beforeGoal, m.state.Goals[m.repo]) || !reflect.DeepEqual(beforeTask, m.state.Tasks[index]) {
		t.Fatal("failed persistence changed the objective, task or owned process")
	}
}

func TestGoalScopeAdoptionRequiresDependenciesAndPreservesDelivery(t *testing.T) {
	m := goalScopeTestModel(t)
	base := goalScopeTestTask(t, m, m.repo, "Accepted dependency")
	dependent := goalScopeTestTask(t, m, m.repo, "Dependent task")
	m.state.Tasks[base].Status, m.state.Tasks[base].AcceptedTree = "accepted", strings.Repeat("a", 40)
	m.state.Tasks[dependent].DependsOn = []string{m.state.Tasks[base].ID}
	path := t.TempDir()
	brief := filepath.Join(path, ".fluke-task.md")
	if err := os.WriteFile(brief, []byte("unchanged brief"), 0600); err != nil {
		t.Fatal(err)
	}
	m.state.Tasks[dependent].Worktree = &path
	next := m.state
	if err := next.setGoal(m.repo, "New goal", "New acceptance"); err != nil {
		t.Fatal(err)
	}
	if !m.saveGoalEdit(next, "Changed") {
		t.Fatal(m.notice)
	}
	beforeDependency, beforeDependent := m.state.Tasks[base], m.state.Tasks[dependent]
	if cmd := m.adoptTaskGoal(beforeDependent.ID); cmd != nil || m.state.Tasks[dependent].GoalID != beforeDependent.GoalID || !strings.Contains(m.notice, "primero sus dependencias") {
		t.Fatal("adoption bypassed an old dependency", m.notice)
	}
	if cmd := m.adoptTaskGoal(beforeDependency.ID); cmd != nil || m.state.Tasks[base].GoalID != m.state.Goals[m.repo].ID {
		t.Fatal("accepted dependency could not be explicitly adopted", m.notice)
	}
	dependencyAfter := m.state.Tasks[base]
	dependencyAfter.GoalID, dependencyAfter.Note = beforeDependency.GoalID, beforeDependency.Note
	if !reflect.DeepEqual(dependencyAfter, beforeDependency) {
		t.Fatal("adoption changed the accepted delivery")
	}
	if err := m.store.lock.Close(); err != nil {
		t.Fatal(err)
	}
	store, recovered, err := openStore(m.store.dir)
	if err != nil {
		t.Fatal("partially adopted historical graph cannot reopen", err)
	}
	m.store, m.state = store, recovered
	if cmd := m.adoptTaskGoal(beforeDependent.ID); cmd != nil || m.state.Tasks[dependent].GoalID != m.state.Goals[m.repo].ID || m.state.Tasks[dependent].Paused || m.state.Tasks[dependent].Queued {
		t.Fatal("dependent adoption did not wait for an explicit new launch", m.notice)
	}
	adopted := m.state.Tasks[dependent]
	adopted.GoalID, adopted.Note, adopted.Paused, adopted.Queued = beforeDependent.GoalID, beforeDependent.Note, beforeDependent.Paused, beforeDependent.Queued
	if !reflect.DeepEqual(adopted, beforeDependent) {
		t.Fatal("adoption changed the task brief, worktree, status or acceptance")
	}
	if content, err := os.ReadFile(brief); err != nil || string(content) != "unchanged brief" {
		t.Fatal("adoption rewrote the brief", err)
	}
	if err := store.lock.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, final, err := openStore(store.dir)
	if err != nil {
		t.Fatal(err)
	}
	m.store, m.state = reopened, final
	if final.Tasks[base].GoalID != final.Tasks[dependent].GoalID || final.Tasks[dependent].Queued {
		t.Fatal("adoption did not persist without launching")
	}
}

func TestGoalScopeAdoptionGuardsAndRespectsExistingPauses(t *testing.T) {
	for _, operation := range []string{"preparing", "accepting", "integrating", "publishing", "live", "missing goal", "other repo", "save failure"} {
		t.Run(operation, func(t *testing.T) {
			m := goalScopeTestModel(t)
			index := goalScopeTestTask(t, m, m.repo, "Task")
			id := m.state.Tasks[index].ID
			if err := m.state.setGoal(m.repo, "New goal", "New acceptance"); err != nil {
				t.Fatal(err)
			}
			switch operation {
			case "preparing":
				m.preparing = true
			case "accepting":
				m.acceptingTaskID = "other task"
			case "integrating":
				m.integratingTaskID = "other task"
			case "publishing":
				m.publishingTaskID = "other task"
			case "live":
				pauseTestWindow(t, m, id)
			case "missing goal":
				delete(m.state.Goals, m.repo)
			case "other repo":
				m.repo = t.TempDir()
			case "save failure":
				if err := os.Mkdir(filepath.Join(m.store.dir, "state.json"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			before := m.state.Tasks[index]
			if cmd := m.adoptTaskGoal(id); cmd != nil || !reflect.DeepEqual(before, m.state.Tasks[index]) {
				t.Fatal("guarded adoption changed the task or scheduled work")
			}
		})
	}
	for _, pause := range []string{"manual", "project"} {
		t.Run(pause, func(t *testing.T) {
			m := goalScopeTestModel(t)
			index := goalScopeTestTask(t, m, m.repo, "Paused task")
			m.state.Tasks[index].Paused, m.state.Tasks[index].Queued = true, true
			if pause == "manual" {
				m.state.Tasks[index].ManuallyPaused = true
			} else {
				m.state.PausedProjects = map[string]bool{m.repo: true}
			}
			if err := m.state.setGoal(m.repo, "New goal", "New acceptance"); err != nil {
				t.Fatal(err)
			}
			if cmd := m.adoptTaskGoal(m.state.Tasks[index].ID); cmd != nil || !m.state.Tasks[index].Paused || m.state.Tasks[index].Queued {
				t.Fatal("adoption bypassed existing pause or launched work")
			}
		})
	}
}

func TestGoalScopeHumanCallersCancelOldPreparationAndQueue(t *testing.T) {
	for _, caller := range []string{"goal", "approve"} {
		t.Run(caller, func(t *testing.T) {
			m := goalScopeTestModel(t)
			index := goalScopeTestTask(t, m, m.repo, "Preparing old task")
			id, oldGoal := m.state.Tasks[index].ID, m.state.Tasks[index].GoalID
			m.state.Tasks[index].Queued = true
			m.state.Orchestrator = &AgentConfig{Provider: "custom", Executable: "unused"}
			m.preparing, m.preparingWorker, m.preparingTaskID, m.preparingQueued = true, true, id, true
			if caller == "goal" {
				m.execute("goal New scope | New acceptance")
			} else {
				if _, err := m.applyOrchestratorCommand(m.repo, orchestratorCommand{Action: "propose_goal", Title: "New scope", Acceptance: "New acceptance"}); err != nil {
					t.Fatal(err)
				}
				m.execute("approve 1")
				if m.state.Decisions[0].Answer == nil || *m.state.Decisions[0].Answer != "aprobada" {
					t.Fatal("goal approval did not persist its answer")
				}
			}
			if m.state.Goals[m.repo].ID == oldGoal || !m.cancelPreparing || !m.state.Tasks[index].Paused || m.state.Tasks[index].Queued {
				t.Fatal("human caller failed to hold the old plan and preparation")
			}
			m.execute("queue " + id)
			m.execute("continue " + id)
			if !m.state.Tasks[index].Paused || m.state.Tasks[index].Queued {
				t.Fatal("queue or continue bypassed the changed objective")
			}
			path := t.TempDir()
			m.Update(launchResult{taskID: id, repo: m.repo, path: path, baseCommit: strings.Repeat("b", 40), runID: "old-run", argv: []string{"unused"}})
			if len(m.terminals.Windows) != 0 || m.state.Tasks[index].AgentRun != "" || m.preparing || !strings.Contains(m.notice, "cancelado") {
				t.Fatal("late preparation escaped the changed scope", m.notice)
			}
			if m.state.Tasks[index].Worktree == nil || *m.state.Tasks[index].Worktree != path {
				t.Fatal("cancelling an old preparation lost its worktree")
			}
			fresh := goalScopeTestTask(t, m, m.repo, "Current task")
			m.state.Tasks[fresh].Queued = true
			// Model a pre-guard saved queue: its old first entry must not starve the new plan.
			m.state.Tasks[index].Paused, m.state.Tasks[index].Queued = false, true
			if cmd := m.drainQueue(); cmd == nil || m.preparingTaskID != m.state.Tasks[fresh].ID {
				t.Fatal("old queued task blocked or replaced the current plan", m.notice)
			}
		})
	}
}
