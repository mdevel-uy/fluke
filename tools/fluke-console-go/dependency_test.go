package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func dependencyTestGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := git(dir, args...)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func dependencyTestRepo(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	dependencyTestGit(t, repo, "init", "--initial-branch=main")
	if err := os.WriteFile(filepath.Join(repo, "seed.txt"), []byte("seed"), 0600); err != nil {
		t.Fatal(err)
	}
	dependencyTestGit(t, repo, "add", "seed.txt")
	dependencyTestGit(t, repo, "-c", "user.name=Dependency Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=", "commit", "-m", "base")
	return repo
}

func dependencyTestFixture(t *testing.T, commitChanges bool) (State, Task, Task) {
	t.Helper()
	repo, stateDir := dependencyTestRepo(t), t.TempDir()
	goal := ProjectGoal{ID: "g" + strings.Repeat("a", 32), Objective: "Dependency test", Acceptance: "Verified integration"}
	dependency := Task{ID: "t1", Repo: repo, GoalID: goal.ID, Branch: "codex/fluke/t1", Title: "Dependency", Acceptance: "Changes reviewed", Status: "accepted"}
	target := Task{ID: "t2", Repo: repo, GoalID: goal.ID, Branch: "codex/fluke/t2", Title: "Dependent task", Acceptance: "Uses dependency", Status: "pending", DependsOn: []string{dependency.ID}}
	dependency.BaseCommit = dependencyTestGit(t, repo, "rev-parse", "HEAD")
	path, err := prepareTask(dependency, stateDir)
	if err != nil {
		t.Fatal(err)
	}
	dependency.Worktree = &path
	oldPath, err := prepareTask(target, stateDir)
	if err != nil {
		t.Fatal(err)
	}
	target.Worktree = &oldPath
	if commitChanges {
		if err := os.WriteFile(filepath.Join(path, "product.txt"), []byte("dependency changes"), 0600); err != nil {
			t.Fatal(err)
		}
		dependencyTestGit(t, path, "add", "product.txt")
	}
	dependencyTestGit(t, path, "-c", "user.name=Dependency Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=", "commit", "--allow-empty", "-m", "dependency delivery")
	dependency.AcceptedTree = dependencyTestGit(t, path, "rev-parse", "HEAD^{tree}")
	return State{Tasks: []Task{dependency, target}, Goals: map[string]ProjectGoal{repo: goal}}, dependency, target
}

func TestDependencyRejectsChangesCommittedAfterAcceptance(t *testing.T) {
	state, dependency, target := dependencyTestFixture(t, true)
	_ = os.WriteFile(filepath.Join(*dependency.Worktree, "product.txt"), []byte("unaccepted change"), 0600)
	dependencyTestGit(t, *dependency.Worktree, "add", "product.txt")
	dependencyTestGit(t, *dependency.Worktree, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=", "commit", "-m", "after acceptance")
	dependencyTestGit(t, target.Repo, "merge", "--ff-only", dependency.Branch)
	if err := dependencyReadiness(state, target, target.Repo); err == nil || !strings.Contains(err.Error(), "aceptación vigente") {
		t.Fatal("unaccepted commit released dependent task", err)
	}
}

func TestDependencyIntegrationAndOldTargetWorktree(t *testing.T) {
	state, dependency, target := dependencyTestFixture(t, true)
	if err := dependencyReadiness(state, target, target.Repo); err == nil || !strings.Contains(err.Error(), "integrado") {
		t.Fatalf("accepted but unmerged dependency was allowed: %v", err)
	}
	dependencyTestGit(t, target.Repo, "merge", "--ff-only", dependency.Branch)
	if err := dependencyReadiness(state, target, target.Repo); err != nil {
		t.Fatalf("real merge did not release dependency: %v", err)
	}
	if err := dependencyReadiness(state, target, *target.Worktree); err == nil {
		t.Fatal("old target worktree started without dependency changes")
	}
	refreshed, err := refreshDependencyWorktree(state, target, *target.Worktree)
	if err != nil || refreshed != dependencyTestGit(t, target.Repo, "rev-parse", "HEAD") {
		t.Fatal("clean old worktree was not refreshed", refreshed, err)
	}
	if err := dependencyReadiness(state, target, *target.Worktree); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(*dependency.Worktree, "uncommitted.txt"), []byte("pending changes"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := dependencyReadiness(state, target, target.Repo); err == nil || !strings.Contains(err.Error(), "sin commit") {
		t.Fatalf("dirty accepted worktree was allowed: %v", err)
	}
}

func TestDependencyRefreshPreservesMetadataAndDoesNotRunHooks(t *testing.T) {
	state, dependency, target := dependencyTestFixture(t, true)
	target.BaseCommit = dependencyTestGit(t, *target.Worktree, "rev-parse", "HEAD")
	state.Tasks[1] = target
	script := []byte("#!/bin/sh\nprintf hook > hook-ran.txt\n")
	if err := os.WriteFile(filepath.Join(*dependency.Worktree, "post-merge"), script, 0700); err != nil {
		t.Fatal(err)
	}
	dependencyTestGit(t, *dependency.Worktree, "add", "post-merge")
	dependencyTestGit(t, *dependency.Worktree, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=", "commit", "-m", "product script")
	dependency.AcceptedTree = dependencyTestGit(t, *dependency.Worktree, "rev-parse", "HEAD^{tree}")
	state.Tasks[0] = dependency
	dependencyTestGit(t, target.Repo, "merge", "--ff-only", dependency.Branch)
	metadata := filepath.Join(*target.Worktree, ".fluke-worker-contract.md")
	if err := os.WriteFile(metadata, []byte("saved worker context"), 0600); err != nil {
		t.Fatal(err)
	}
	hooks := t.TempDir()
	if err := os.WriteFile(filepath.Join(hooks, "post-merge"), script, 0700); err != nil {
		t.Fatal(err)
	}
	dependencyTestGit(t, target.Repo, "config", "core.hooksPath", filepath.ToSlash(hooks))
	old := dependencyTestGit(t, *target.Worktree, "rev-parse", "HEAD")
	if err := dependencyDispatchReadiness(state, target, *target.Worktree); err != nil {
		t.Fatal(err)
	}
	if got := dependencyTestGit(t, *target.Worktree, "rev-parse", "HEAD"); got != old {
		t.Fatal("queue probe mutated the worktree")
	}
	newBase, err := refreshDependencyWorktree(state, target, *target.Worktree)
	if err != nil || newBase == "" || newBase == old {
		t.Fatal("refresh failed", newBase, err)
	}
	if data, err := os.ReadFile(metadata); err != nil || string(data) != "saved worker context" {
		t.Fatal("metadata changed", string(data), err)
	}
	if _, err := os.Stat(filepath.Join(*target.Worktree, "hook-ran.txt")); !os.IsNotExist(err) {
		t.Fatal("automatic base refresh ran a hook", err)
	}
	target.BaseCommit = newBase
	state.Tasks[1] = target
	if again, err := refreshDependencyWorktree(state, target, *target.Worktree); err != nil || again != "" {
		t.Fatal("ready base was needlessly updated", again, err)
	}
}

func TestDependencyRefreshReconcilesCrashBeforeSavingBase(t *testing.T) {
	state, dependency, target := dependencyTestFixture(t, true)
	target.BaseCommit = dependencyTestGit(t, *target.Worktree, "rev-parse", "HEAD")
	state.Tasks[1] = target
	state.Version, state.MaxWorkers = 1, 2
	store, _, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err = store.save(state); err != nil {
		_ = store.lock.Close()
		t.Fatal(err)
	}
	dependencyTestGit(t, target.Repo, "merge", "--ff-only", dependency.Branch)
	newBase, err := refreshDependencyWorktree(state, target, *target.Worktree)
	if err != nil || newBase == "" {
		_ = store.lock.Close()
		t.Fatal("initial refresh", newBase, err)
	}
	// Git advanced, but the process died before launchResult updated the store.
	_ = store.lock.Close()
	reopened, restored, err := openStore(store.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.lock.Close()
	restoredTarget := restored.Tasks[1]
	if restoredTarget.BaseCommit != target.BaseCommit {
		t.Fatal("fixture did not preserve the old saved base")
	}
	reconciled, err := refreshDependencyWorktree(restored, restoredTarget, *restoredTarget.Worktree)
	if err != nil || reconciled != newBase {
		t.Fatal("exact journal did not recover the advanced base", reconciled, err)
	}
	if got := dependencyTestGit(t, *target.Worktree, "rev-parse", "HEAD"); got != newBase {
		t.Fatal("reconciliation moved the worktree")
	}
}

func TestDependencyRefreshJournalRejectsLaterChanges(t *testing.T) {
	for _, name := range []string{"file edit", "own commit", "acceptance changed", "other task"} {
		t.Run(name, func(t *testing.T) {
			state, dependency, target := dependencyTestFixture(t, true)
			target.BaseCommit = dependencyTestGit(t, *target.Worktree, "rev-parse", "HEAD")
			state.Tasks[1] = target
			dependencyTestGit(t, target.Repo, "merge", "--ff-only", dependency.Branch)
			if _, err := refreshDependencyWorktree(state, target, *target.Worktree); err != nil {
				t.Fatal(err)
			}
			switch name {
			case "file edit", "own commit":
				if err := os.WriteFile(filepath.Join(*target.Worktree, "seed.txt"), []byte("manual edit"), 0600); err != nil {
					t.Fatal(err)
				}
				if name == "own commit" {
					dependencyTestGit(t, *target.Worktree, "add", "seed.txt")
					dependencyTestGit(t, *target.Worktree, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=", "commit", "-m", "manual edit after refresh")
				}
			case "acceptance changed":
				state.Tasks[0].AcceptedTree = dependencyTestGit(t, *target.Worktree, "rev-parse", target.BaseCommit+"^{tree}")
			case "other task":
				gitDir := dependencyTestGit(t, *target.Worktree, "rev-parse", "--absolute-git-dir")
				path := filepath.Join(gitDir, "fluke-dependency-base.json")
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				if err = os.WriteFile(path, []byte(strings.Replace(string(data), `"TaskID": "t2"`, `"TaskID": "t9"`, 1)), 0600); err != nil {
					t.Fatal(err)
				}
			}
			head := dependencyTestGit(t, *target.Worktree, "rev-parse", "HEAD")
			index := dependencyTestGit(t, *target.Worktree, "write-tree")
			if _, err := refreshDependencyWorktree(state, target, *target.Worktree); err == nil {
				t.Fatal("journal concealed a later change")
			}
			if dependencyTestGit(t, *target.Worktree, "rev-parse", "HEAD") != head || dependencyTestGit(t, *target.Worktree, "write-tree") != index {
				t.Fatal("rejected journal rewrote worker data")
			}
		})
	}
}

func TestDependencyRefreshKeepsUnsafeWorktreeUnchanged(t *testing.T) {
	for _, name := range []string{"dirty", "staged", "untracked", "ignored collision", "own commit", "diverged", "rewritten main", "pending integration", "pending worktree merge", "pending main merge", "internal metadata"} {
		t.Run(name, func(t *testing.T) {
			state, dependency, target := dependencyTestFixture(t, true)
			target.BaseCommit = dependencyTestGit(t, *target.Worktree, "rev-parse", "HEAD")
			state.Tasks[1] = target
			dependencyTestGit(t, target.Repo, "merge", "--ff-only", dependency.Branch)
			var preservedFile string
			switch name {
			case "dirty", "staged":
				preservedFile = filepath.Join(*target.Worktree, "seed.txt")
				if err := os.WriteFile(preservedFile, []byte("worker draft"), 0600); err != nil {
					t.Fatal(err)
				}
				if name == "staged" {
					dependencyTestGit(t, *target.Worktree, "add", "seed.txt")
				}
			case "untracked", "ignored collision":
				file := "local.txt"
				if name == "ignored collision" {
					file = "product.txt"
					exclude := dependencyTestGit(t, *target.Worktree, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude")
					f, err := os.OpenFile(exclude, os.O_APPEND|os.O_WRONLY, 0600)
					if err != nil {
						t.Fatal(err)
					}
					_, err = f.WriteString("\nproduct.txt\n")
					_ = f.Close()
					if err != nil {
						t.Fatal(err)
					}
				}
				preservedFile = filepath.Join(*target.Worktree, file)
				if err := os.WriteFile(preservedFile, []byte("worker draft"), 0600); err != nil {
					t.Fatal(err)
				}
			case "own commit", "diverged":
				preservedFile = filepath.Join(*target.Worktree, "own.txt")
				if err := os.WriteFile(preservedFile, []byte("worker draft"), 0600); err != nil {
					t.Fatal(err)
				}
				dependencyTestGit(t, *target.Worktree, "add", "own.txt")
				dependencyTestGit(t, *target.Worktree, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=", "commit", "-m", "worker commit")
				if name == "diverged" {
					target.BaseCommit = dependencyTestGit(t, *target.Worktree, "rev-parse", "HEAD")
					state.Tasks[1] = target
				}
			case "rewritten main":
				tree := dependencyTestGit(t, target.Repo, "rev-parse", "HEAD^{tree}")
				rewrite := dependencyTestGit(t, target.Repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", tree, "-m", "rewritten root")
				dependencyTestGit(t, target.Repo, "update-ref", "refs/heads/main", rewrite)
			case "pending integration":
				state.Tasks[0].Integration = &integrationPlan{Started: true}
			case "pending worktree merge", "pending main merge":
				dir := *target.Worktree
				if name == "pending main merge" {
					dir = target.Repo
				}
				merge := dependencyTestGit(t, dir, "rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD")
				if err := os.WriteFile(merge, []byte(dependencyTestGit(t, target.Repo, "rev-parse", "HEAD")+"\n"), 0600); err != nil {
					t.Fatal(err)
				}
			case "internal metadata":
				if err := os.WriteFile(filepath.Join(target.Repo, ".fluke-task.md"), []byte("foreign metadata"), 0600); err != nil {
					t.Fatal(err)
				}
				dependencyTestGit(t, target.Repo, "add", "-f", ".fluke-task.md")
				dependencyTestGit(t, target.Repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=", "commit", "-m", "metadata")
			}
			head := dependencyTestGit(t, *target.Worktree, "rev-parse", "HEAD")
			index := dependencyTestGit(t, *target.Worktree, "write-tree")
			if _, err := refreshDependencyWorktree(state, target, *target.Worktree); err == nil {
				t.Fatal("unsafe worktree was refreshed")
			}
			if got := dependencyTestGit(t, *target.Worktree, "rev-parse", "HEAD"); got != head {
				t.Fatal("rejected update moved HEAD")
			}
			if got := dependencyTestGit(t, *target.Worktree, "write-tree"); got != index {
				t.Fatal("rejected update changed the index")
			}
			if preservedFile != "" {
				if data, err := os.ReadFile(preservedFile); err != nil || string(data) != "worker draft" {
					t.Fatal("worker file changed", string(data), err)
				}
			}
		})
	}
}

func TestDependencyMetadataAndEmptyDelivery(t *testing.T) {
	state, dependency, target := dependencyTestFixture(t, true)
	dependencyTestGit(t, target.Repo, "merge", "--ff-only", dependency.Branch)
	for _, name := range []string{".fluke-task.md", ".fluke-worker-contract.md"} {
		if err := os.WriteFile(filepath.Join(*dependency.Worktree, name), []byte("local metadata"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := dependencyReadiness(state, target, target.Repo); err != nil {
		t.Fatalf("metadata incorrectly blocked committed delivery: %v", err)
	}
	emptyState, emptyDependency, emptyTarget := dependencyTestFixture(t, false)
	dependencyTestGit(t, emptyTarget.Repo, "merge", "--ff-only", emptyDependency.Branch)
	if err := dependencyReadiness(emptyState, emptyTarget, emptyTarget.Repo); err == nil || !strings.Contains(err.Error(), "no contiene cambios") {
		t.Fatalf("empty commit treated as verified dependency: %v", err)
	}
}

func TestDependencyGraphValidation(t *testing.T) {
	repo, other := t.TempDir(), t.TempDir()
	base := Task{ID: "t1", Repo: repo, GoalID: "goal", DependsOn: []string{"t2"}}
	dependency := Task{ID: "t2", Repo: repo, GoalID: "goal"}
	for _, test := range []struct {
		name   string
		task   Task
		others []Task
	}{
		{"duplicate", Task{ID: "t1", Repo: repo, GoalID: "goal", DependsOn: []string{"t2", "t2"}}, []Task{dependency}},
		{"self", Task{ID: "t1", Repo: repo, GoalID: "goal", DependsOn: []string{"t1"}}, nil},
		{"unknown", Task{ID: "t1", Repo: repo, GoalID: "goal", DependsOn: []string{"t9"}}, []Task{dependency}},
		{"other repo", base, []Task{{ID: "t2", Repo: other, GoalID: "goal"}}},
		{"other goal", base, []Task{{ID: "t2", Repo: repo, GoalID: "another"}}},
		{"cycle", base, []Task{{ID: "t2", Repo: repo, GoalID: "goal", DependsOn: []string{"t3"}}, {ID: "t3", Repo: repo, GoalID: "goal", DependsOn: []string{"t1"}}}},
		{"too many", Task{ID: "t1", Repo: repo, DependsOn: make([]string, 33)}, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := State{Tasks: append([]Task{base}, test.others...), Goals: map[string]ProjectGoal{repo: {ID: "goal"}}}
			if err := validateTaskDependencies(state, test.task); err == nil {
				t.Fatal("invalid dependency graph accepted")
			}
		})
	}
	state := State{Tasks: []Task{base, dependency}, Goals: map[string]ProjectGoal{repo: {ID: "new-current-goal"}}}
	if err := validateTaskDependencies(state, base); err != nil {
		t.Fatalf("historical tasks with matching goal were rejected: %v", err)
	}
}

func TestDependencyGraphRejectsOrphanedCrossGoalEdges(t *testing.T) {
	repo := t.TempDir()
	task := Task{ID: "t1", Repo: repo, GoalID: "old", DependsOn: []string{"t2"}}
	dependency := Task{ID: "t2", Repo: repo, GoalID: "current"}
	state := State{Tasks: []Task{task, dependency}}
	if err := validateTaskDependencies(state, task); err == nil {
		t.Fatal("cross-goal dependency without a current goal was accepted")
	}
	state.Goals = map[string]ProjectGoal{repo: {ID: "current"}}
	if err := validateTaskDependencies(state, task); err != nil {
		t.Fatalf("partial adoption of historical dependencies was rejected: %v", err)
	}
}

func TestDependencyRejectsUnacceptedAndForeignWorktree(t *testing.T) {
	state, dependency, target := dependencyTestFixture(t, true)
	state.Tasks[0].Status = "awaiting_review"
	if err := dependencyReadiness(state, target, target.Repo); err == nil || !strings.Contains(err.Error(), "aceptada") {
		t.Fatalf("unaccepted delivery allowed: %v", err)
	}
	foreign := dependencyTestRepo(t)
	dependencyTestGit(t, foreign, "checkout", "-b", dependency.Branch)
	state.Tasks[0].Status, state.Tasks[0].Worktree = "accepted", &foreign
	if err := dependencyReadiness(state, target, target.Repo); err == nil || !strings.Contains(err.Error(), "no corresponde") {
		t.Fatalf("foreign worktree allowed: %v", err)
	}
}
