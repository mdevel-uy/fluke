package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

func acceptedDelivery(t *testing.T, committed bool) Task {
	t.Helper()
	_, task, _ := dependencyTestFixture(t, true)
	if _, err := prepareWorkerContract(*task.Worktree, task.ID); err != nil {
		t.Fatal(err)
	}
	dependencyTestGit(t, task.Repo, "config", "user.name", "Fluke Test")
	dependencyTestGit(t, task.Repo, "config", "user.email", "test@example.invalid")
	dependencyTestGit(t, task.Repo, "config", "commit.gpgsign", "false")
	dependencyTestGit(t, task.Repo, "config", "core.hooksPath", "")
	if !committed {
		if err := os.WriteFile(filepath.Join(*task.Worktree, "new.txt"), []byte("accepted new file\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	var err error
	task.AcceptedTree, err = deliveryTree(context.Background(), task)
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func integrateDelivery(task Task, approved integrationPlan) (integrationPlan, error) {
	plan, err := prepareIntegration(task, approved)
	if err != nil || plan.MergedCommit != "" {
		return plan, err
	}
	return finishIntegration(task, plan)
}

func TestIntegrationConfirmsAcceptedFilesAndReconcilesRestart(t *testing.T) {
	for _, committed := range []bool{false, true} {
		t.Run(map[bool]string{false: "commit-and-merge", true: "existing-commit"}[committed], func(t *testing.T) {
			task := acceptedDelivery(t, committed)
			before := dependencyTestGit(t, *task.Worktree, "diff", "--cached")
			plan, err := inspectIntegration(task)
			if err != nil {
				t.Fatal(err)
			}
			if plan.Commit == committed || plan.MergedCommit != "" {
				t.Fatal("incorrect plan", plan)
			}
			if _, err = os.Stat(filepath.Join(task.Repo, "product.txt")); !os.IsNotExist(err) {
				t.Fatal("preview changed destination")
			}
			if after := dependencyTestGit(t, *task.Worktree, "diff", "--cached"); after != before {
				t.Fatal("snapshot modified the user index")
			}
			merged, err := integrateDelivery(task, plan)
			if err != nil || !validGitHash(merged.MergedCommit) {
				t.Fatal(merged, err)
			}
			if _, err = os.Stat(filepath.Join(task.Repo, "product.txt")); err != nil {
				t.Fatal(err)
			}
			if !committed {
				if data, err := os.ReadFile(filepath.Join(task.Repo, "new.txt")); err != nil || strings.ReplaceAll(string(data), "\r\n", "\n") != "accepted new file\n" {
					t.Fatal("new file not committed/merged", err)
				}
			}
			for _, internal := range []string{".fluke-task.md", ".fluke-worker-contract.md"} {
				if out := dependencyTestGit(t, task.Repo, "ls-files", internal); out != "" {
					t.Fatal("internal metadata committed", out)
				}
			}
			// Persisted intention can lag Git after a crash: recognize ancestry instead of replaying.
			pending := merged
			pending.MergedCommit = ""
			task.Integration = &pending
			task.Integration.Started = true
			recovered, err := inspectIntegration(task)
			if err != nil || recovered.MergedCommit != merged.MergedCommit {
				t.Fatal("merge recovery failed", recovered, err)
			}
			if tip := dependencyTestGit(t, task.Repo, "rev-parse", "HEAD"); tip != merged.MergedCommit {
				t.Fatal("recovery created another commit")
			}
		})
	}
}

func TestIntegrationHookCannotMergeUnacceptedChanges(t *testing.T) {
	task := acceptedDelivery(t, false)
	hooks := t.TempDir()
	dependencyTestGit(t, task.Repo, "config", "core.hooksPath", hooks)
	if err := os.WriteFile(filepath.Join(hooks, "post-commit"), []byte("#!/bin/sh\nprintf 'hook changed delivery' > product.txt\n"), 0700); err != nil {
		t.Fatal(err)
	}
	plan, err := inspectIntegration(task)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = integrateDelivery(task, plan); err == nil || !strings.Contains(err.Error(), "cambió") {
		t.Fatal("hook changed approved files and was still merged", err)
	}
	if _, err = os.Stat(filepath.Join(task.Repo, "product.txt")); !os.IsNotExist(err) {
		t.Fatal("unapproved hook changes reached target")
	}
}

func TestMergeHookChangesRemainUnverifiedAndBlockDependents(t *testing.T) {
	for _, hook := range []string{"pre-merge-commit", "post-merge"} {
		t.Run(hook, func(t *testing.T) {
			task := acceptedDelivery(t, true)
			hooks := t.TempDir()
			dependencyTestGit(t, task.Repo, "config", "core.hooksPath", hooks)
			script := "#!/bin/sh\nprintf 'unreviewed hook change' > personal.txt\ngit add personal.txt\n"
			if hook == "post-merge" {
				script += "git commit -m 'hook added unreviewed changes'\n"
			}
			if err := os.WriteFile(filepath.Join(hooks, hook), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			plan, err := inspectIntegration(task)
			if err != nil {
				t.Fatal(err)
			}
			prepared, err := prepareIntegration(task, plan)
			if err != nil {
				t.Fatal(err)
			}
			prepared.Started = true
			task.Integration = &prepared
			if _, err = finishIntegration(task, prepared); err == nil || !strings.Contains(err.Error(), "fuera") {
				t.Fatal("unreviewed merge hook certified", err)
			}
			if _, err = os.Stat(filepath.Join(task.Repo, "personal.txt")); err != nil {
				t.Fatal("hook changes weren't preserved for review", err)
			}
			if _, err = inspectIntegration(task); err == nil {
				t.Fatal("restart silently certified hook changes", err)
			}
			dependent := Task{ID: "t2", Repo: task.Repo, GoalID: task.GoalID, DependsOn: []string{task.ID}}
			if err = dependencyReadiness(State{Tasks: []Task{task, dependent}}, dependent, task.Repo); err == nil || !strings.Contains(err.Error(), "pendiente") {
				t.Fatal("unverified hook changes released dependent", err)
			}
		})
	}
}

func TestIntegrationSaveFailureCannotMutateGit(t *testing.T) {
	task := acceptedDelivery(t, false)
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	state.Tasks = []Task{task}
	m := newModel(store, state, task.Repo)
	m.Update(m.previewIntegration(task.ID)())
	if err = os.Mkdir(filepath.Join(store.dir, "state.json"), 0700); err != nil {
		t.Fatal(err)
	}
	if cmd := m.confirmIntegration(); cmd != nil || !strings.Contains(m.notice, "No se pudo guardar") {
		t.Fatal("merge scheduled without durable authorization", m.notice)
	}
	if _, err = os.Stat(filepath.Join(task.Repo, "product.txt")); !os.IsNotExist(err) {
		t.Fatal("save failure changed target")
	}
}

func TestIntegrationRejectsChangedFilesDestinationAndPendingGit(t *testing.T) {
	for _, change := range []string{"delivery", "dirty-target", "target-head", "pending-git", "internal-files"} {
		t.Run(change, func(t *testing.T) {
			task := acceptedDelivery(t, true)
			plan, err := inspectIntegration(task)
			if err != nil {
				t.Fatal(err)
			}
			switch change {
			case "delivery":
				_ = os.WriteFile(filepath.Join(*task.Worktree, "product.txt"), []byte("not accepted"), 0600)
			case "dirty-target":
				_ = os.WriteFile(filepath.Join(task.Repo, "personal.txt"), []byte("personal changes"), 0600)
			case "target-head":
				dependencyTestGit(t, task.Repo, "commit", "--allow-empty", "-m", "another task")
			case "pending-git":
				path := dependencyTestGit(t, task.Repo, "rev-parse", "--git-path", "MERGE_HEAD")
				if !filepath.IsAbs(path) {
					path = filepath.Join(task.Repo, path)
				}
				_ = os.WriteFile(path, []byte(plan.SourceHead+"\n"), 0600)
			case "internal-files":
				dependencyTestGit(t, *task.Worktree, "add", "-f", ".fluke-task.md")
				dependencyTestGit(t, *task.Worktree, "commit", "-m", "wrong metadata")
				task.AcceptedTree, _ = deliveryTree(context.Background(), task)
			}
			if _, err = integrateDelivery(task, plan); err == nil {
				t.Fatal("unsafe integration was allowed")
			}
			if _, err = os.Stat(filepath.Join(task.Repo, "product.txt")); !os.IsNotExist(err) {
				t.Fatal("destination modified despite rejected confirmation")
			}
		})
	}
}

func TestIntegrationPredictsConflictAndKeepsDestinationUntouched(t *testing.T) {
	task := acceptedDelivery(t, true)
	_ = os.WriteFile(filepath.Join(*task.Worktree, "seed.txt"), []byte("worker version\n"), 0600)
	dependencyTestGit(t, *task.Worktree, "add", "seed.txt")
	dependencyTestGit(t, *task.Worktree, "commit", "-m", "worker edit")
	task.AcceptedTree, _ = deliveryTree(context.Background(), task)
	_ = os.WriteFile(filepath.Join(task.Repo, "seed.txt"), []byte("human version\n"), 0600)
	dependencyTestGit(t, task.Repo, "add", "seed.txt")
	dependencyTestGit(t, task.Repo, "commit", "-m", "human edit")
	plan, err := inspectIntegration(task)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = integrateDelivery(task, plan); err == nil || !strings.Contains(err.Error(), "seed.txt") {
		t.Fatal("conflict not exposed", err)
	}
	if conflicts := dependencyTestGit(t, task.Repo, "diff", "--name-only", "--diff-filter=U"); conflicts != "" {
		t.Fatal("preview wrote conflict markers", conflicts)
	}
	if data, err := os.ReadFile(filepath.Join(task.Repo, "seed.txt")); err != nil || strings.TrimSpace(string(data)) != "human version" {
		t.Fatal("conflict preview changed human files", err)
	}
}

func TestIntegrationUIRequiresConfirmationAndPersistsResult(t *testing.T) {
	task := acceptedDelivery(t, false)
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	state.Tasks = []Task{task}
	m := newModel(store, state, task.Repo)
	cmd := m.previewIntegration(task.ID)
	if cmd == nil {
		t.Fatal(m.notice)
	}
	m.Update(cmd())
	if m.review.integration == nil || m.review.integrationLoading {
		t.Fatal(m.notice)
	}
	if text := strings.Join(m.review.content(95), "\n"); !strings.Contains(text, "Confirmar integración") || !strings.Contains(text, "main") {
		t.Fatal("confirmation not reviewable", text)
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	if m.review.open {
		t.Fatal("Escape didn't close preview")
	}
	if _, err = os.Stat(filepath.Join(task.Repo, "new.txt")); !os.IsNotExist(err) {
		t.Fatal("Escape executed merge")
	}
	cmd = m.previewIntegration(task.ID)
	m.Update(cmd())
	_, cmd = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if cmd == nil || m.state.Tasks[0].Integration == nil || !m.state.Tasks[0].Integration.Started {
		t.Fatal("intent not persisted before merge", m.notice)
	}
	_, finish := m.Update(cmd())
	if finish == nil || m.state.Tasks[0].Integration.ExpectedTree == "" {
		t.Fatal("expected merge not saved before execution", m.notice)
	}
	if _, err = os.Stat(filepath.Join(task.Repo, "new.txt")); !os.IsNotExist(err) {
		t.Fatal("commit preparation merged before journal save")
	}
	m.Update(finish())
	if m.state.Tasks[0].Integration.MergedCommit == "" {
		t.Fatal(m.notice)
	}
	_ = store.lock.Close()
	reopened, restored, err := openStore(store.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.lock.Close()
	if restored.Tasks[0].Integration.MergedCommit == "" {
		t.Fatal("integration lost on restart")
	}
}

func TestAcceptanceRejectsChangedReviewedSnapshot(t *testing.T) {
	task := acceptedDelivery(t, true)
	task.Status = "awaiting_review"
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	state.Tasks = []Task{task}
	state.Goals = map[string]ProjectGoal{task.Repo: {ID: task.GoalID}}
	m := newModel(store, state, task.Repo)
	m.review.task, m.review.data.Tree = task, task.AcceptedTree
	_ = os.WriteFile(filepath.Join(*task.Worktree, "product.txt"), []byte("changed since review"), 0600)
	cmd := m.acceptTask(task.ID)
	if cmd == nil {
		t.Fatal(m.notice)
	}
	m.Update(cmd())
	if m.state.Tasks[0].Status == "accepted" || !strings.Contains(m.notice, "cambió") {
		t.Fatal("stale review accepted", m.notice)
	}
}
