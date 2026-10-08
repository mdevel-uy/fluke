package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestStoreLocksRecoversAndRetainsCorruption(t *testing.T) {
	dir := t.TempDir()
	store, state, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if second, _, err := openStore(dir); err == nil {
		second.lock.Close()
		t.Fatal("second owner acquired lock")
	}
	repo := t.TempDir()
	if err = state.addTask(repo, "Fix", "Tests pass"); err != nil {
		t.Fatal(err)
	}
	state.Tasks[0].Status = "running"
	state.Orchestrator = &AgentConfig{Provider: "custom", Executable: "example", Arguments: []string{}}
	if err = store.save(state); err != nil {
		t.Fatal(err)
	}
	store.lock.Close()
	reopened, recovered, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Tasks[0].Status != "interrupted" || recovered.Orchestrator.Executable != "example" {
		t.Fatal(recovered)
	}
	if err = reopened.save(recovered); err != nil {
		t.Fatal(err)
	}
	reopened.lock.Close()
	path := filepath.Join(dir, "state.json")
	bad := []byte("{broken")
	os.WriteFile(path, bad, 0600)
	if owner, _, err := openStore(dir); err == nil {
		owner.lock.Close()
		t.Fatal("accepted corrupt state")
	}
	got, _ := os.ReadFile(path)
	if !reflect.DeepEqual(got, bad) {
		t.Fatal("corrupt state changed")
	}
}
func TestModelArgumentsStaySeparate(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		argv, err := launchArgv(AgentConfig{Provider: provider, Executable: os.Args[0], Arguments: []string{"--allowedTools", "Read,Write"}}, "Task prompt")
		if err != nil || len(argv) < 2 || argv[len(argv)-2] != "--" || argv[len(argv)-1] != "Task prompt" {
			t.Fatal("CLI option consumed task prompt", argv, err)
		}
	}
	a := AgentConfig{Provider: "codex", Executable: "codex", Model: "a model; echo bad", Arguments: []string{"--no-alt-screen"}}
	got, err := a.argv()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []string{"codex", "--no-alt-screen", "--model", "a model; echo bad"}) {
		t.Fatal(got)
	}
	a.Arguments = []string{"--model=other"}
	if _, err = a.argv(); err == nil {
		t.Fatal("accepted duplicate model")
	}
	a.Provider = "custom"
	a.Arguments = []string{"{model}"}
	if _, err = a.argv(); err != nil {
		t.Fatal(err)
	}
	a.Arguments = nil
	if _, err = a.argv(); err == nil {
		t.Fatal("dropped custom model")
	}
}
func TestWorktreeIsolationAndBriefProtection(t *testing.T) {
	repo := t.TempDir()
	if _, err := git(repo, "init", "--initial-branch=main"); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(repo, "seed.txt"), []byte("seed"), 0600)
	if _, err := git(repo, "add", "seed.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err := git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "seed"); err != nil {
		t.Fatal(err)
	}
	state := State{}
	state.addTask(repo, "A", "Acceptance A")
	state.addTask(repo, "B", "Acceptance B")
	state.Tasks[0].IssueURL = "https://github.com/example/demo/issues/12"
	state.Tasks[0].IssueBody = "External issue description"
	dir := t.TempDir()
	a, err := prepareTask(state.Tasks[0], dir)
	if err != nil {
		t.Fatal(err)
	}
	b, err := prepareTask(state.Tasks[1], dir)
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatal("shared worktree")
	}
	brief, err := os.ReadFile(filepath.Join(a, ".fluke-task.md"))
	if err != nil || !strings.Contains(string(brief), state.Tasks[0].IssueURL) || !strings.Contains(string(brief), state.Tasks[0].IssueBody) || !strings.Contains(string(brief), "Acceptance A") {
		t.Fatalf("GitHub context missing from brief: %v", err)
	}
	state.Tasks[0].Worktree = &a
	run, err := prepareWorkerContract(a, state.Tasks[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	nextRun, err := prepareWorkerContract(a, state.Tasks[0].ID)
	if err != nil || nextRun == run {
		t.Fatal("worker run identity reused", err)
	}
	ignored, err := git(a, "check-ignore", ".fluke-worker-contract.md")
	if err != nil || ignored != ".fluke-worker-contract.md" {
		t.Fatal("contract could be committed", err, ignored)
	}
	if _, err = prepareTask(state.Tasks[0], dir); err != nil {
		t.Fatal(err)
	}
	changed := state.Tasks[0]
	changed.Acceptance = "different"
	if _, err = prepareTask(changed, dir); err == nil {
		t.Fatal("overwrote existing brief")
	}
	t.Cleanup(func() { git(repo, "worktree", "remove", "--force", a); git(repo, "worktree", "remove", "--force", b) })
}
