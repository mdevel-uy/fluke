package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestInspectTaskChanges(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git no disponible")
	}
	repo := t.TempDir()
	run := func(dir string, args ...string) string {
		t.Helper()
		out, err := git(dir, args...)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	write := func(dir, name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	run(repo, "init")
	original := strings.Repeat("original\n", 20)
	write(repo, "old.txt", original)
	write(repo, "data.bin", "\x00before")
	run(repo, "add", ".")
	run(repo, "-c", "user.name=Review Test", "-c", "user.email=review@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "base")
	base := run(repo, "rev-parse", "HEAD")
	worktree := filepath.Join(t.TempDir(), "worker")
	task := Task{ID: "tabc123", Repo: repo, Worktree: &worktree, Branch: "codex/fluke/tabc123", BaseCommit: base}
	run(repo, "worktree", "add", "-b", task.Branch, worktree)
	write(worktree, "committed.txt", "worker committed this\n")
	run(worktree, "add", "committed.txt")
	run(worktree, "-c", "user.name=Review Test", "-c", "user.email=review@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "worker commit")
	run(worktree, "mv", "old.txt", "renamed.txt")
	write(worktree, "renamed.txt", original+"unstaged edit\n")
	write(worktree, "data.bin", "\x00after")
	write(worktree, "new file.txt", "untracked\n")
	write(worktree, ".fluke-task.md", "internal brief")
	write(worktree, ".fluke-worker-contract.md", "internal contract")
	if err := os.Mkdir(filepath.Join(worktree, ".fluke-worker"), 0700); err != nil {
		t.Fatal(err)
	}
	write(worktree, ".fluke-worker/report.json", "{}")
	beforeIndex := run(worktree, "diff", "--cached")
	review, err := inspectTaskChanges(task)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(review.Diff, "unstaged edit") || !strings.Contains(review.Diff, "Binary files") || !strings.Contains(review.Diff, "rename from old.txt") {
		t.Fatalf("faltan cambios staged/unstaged/binario/rename: %s", review.Diff)
	}
	if !strings.Contains(review.Diff, "worker committed this") || !strings.Contains(review.Diff, "--- archivo nuevo \"new file.txt\" ---\nuntracked") {
		t.Fatalf("faltan commits o contenido untracked: %s", review.Diff)
	}
	if len(review.Untracked) != 1 || review.Untracked[0] != "new file.txt" || strings.Contains(review.Status, ".fluke") || review.Truncated {
		t.Fatalf("listado incorrecto: %#v", review)
	}
	if beforeIndex != run(worktree, "diff", "--cached") {
		t.Fatal("la revisión modificó el index")
	}
	wrong := task
	wrong.Branch = "codex/fluke/tother"
	if _, err = inspectTaskChanges(wrong); err == nil {
		t.Fatal("se aceptó una rama inválida")
	}
	wrong = task
	other := t.TempDir()
	run(other, "init")
	wrong.Repo = other
	if _, err = inspectTaskChanges(wrong); err == nil {
		t.Fatal("se aceptó un repo ajeno")
	}
	wrong = task
	wrong.BaseCommit = "HEAD"
	if _, err = inspectTaskChanges(wrong); err == nil {
		t.Fatal("se aceptó una referencia arbitraria")
	}
	wrong.BaseCommit = run(worktree, "-c", "user.name=Review Test", "-c", "user.email=review@example.invalid", "commit-tree", "HEAD^{tree}", "-m", "unrelated root")
	if _, err = inspectTaskChanges(wrong); err == nil {
		t.Fatal("se aceptó un commit base ajeno al historial")
	}
	write(worktree, "new.bin", "\x00binary untracked")
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err = os.WriteFile(outside, []byte("outside secret"), 0600); err != nil {
		t.Fatal(err)
	}
	linked := os.Symlink(outside, filepath.Join(worktree, "link.txt")) == nil
	review, err = inspectTaskChanges(task)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(review.Diff, "archivo binario; contenido omitido") || strings.Contains(review.Diff, "outside secret") || (linked && !strings.Contains(review.Diff, "enlace; contenido omitido")) {
		t.Fatalf("binario/enlace no se omitieron correctamente: %s", review.Diff)
	}
	write(worktree, "renamed.txt", strings.Repeat("large change\n", 30000))
	review, err = inspectTaskChanges(task)
	if err != nil {
		t.Fatal(err)
	}
	if !review.Truncated || len(review.Diff)+len(review.Summary)+len(review.Status) > 256*1024 {
		t.Fatal("el diff no respeta el límite de memoria")
	}
}
