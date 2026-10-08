package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOwnedWorktreeAcceptsFilesystemAlias(t *testing.T) {
	repo := testRepo(t)
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	if err := state.addTask(repo, "Alias", "Reviewed result"); err != nil {
		t.Fatal(err)
	}
	task := state.Tasks[0]
	worktree, err := prepareTask(task, store.dir)
	if err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(worktree, alias); err != nil {
		t.Skipf("directory symlinks unavailable: %v", err)
	}
	task.Worktree = &worktree
	if err := validateOwnedWorktree(task, alias); err != nil {
		t.Fatal("valid alias rejected:", err)
	}
	if dependencySamePath(alias, t.TempDir()) {
		t.Fatal("unrelated directory accepted as alias")
	}
}
