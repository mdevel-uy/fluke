package main

import (
	"os"
	"path/filepath"
	"testing"
)

func testRepo(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	if _, err := git(repo, "init", "--initial-branch=main"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "seed.txt"), []byte("seed"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := git(repo, "add", "seed.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err := git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "seed"); err != nil {
		t.Fatal(err)
	}
	return repo
}
