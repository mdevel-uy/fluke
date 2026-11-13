package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type taskReview struct {
	Tree      string
	Summary   string
	Diff      string
	Status    string
	Untracked []string
	Truncated bool
}

// Keep draining git's output after the display limit, without retaining it.
type reviewOutput struct {
	text      strings.Builder
	remaining int
	truncated bool
}

func (b *reviewOutput) Write(p []byte) (int, error) {
	n := len(p)
	if len(p) > b.remaining {
		p = p[:b.remaining]
		b.truncated = true
	}
	b.text.Write(p)
	b.remaining -= len(p)
	return n, nil
}

func reviewGit(ctx context.Context, dir string, limit int, args ...string) (string, bool, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir, "--no-pager", "-c", "core.fsmonitor=false"}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	cmd.WaitDelay = 2 * time.Second
	out := &reviewOutput{remaining: limit}
	stderr := &reviewOutput{remaining: 2048}
	cmd.Stdout, cmd.Stderr = out, stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", false, fmt.Errorf(uiText("revisión git: %w"), ctx.Err())
		}
		return out.text.String(), out.truncated, fmt.Errorf(uiText("revisión git: %s (%w)"), strings.TrimSpace(stderr.text.String()), err)
	}
	return out.text.String(), out.truncated, nil
}

// Inspect only; this never changes the index, creates commits or merges.
// The saved base includes committed, staged and unstaged changes in this task.
func inspectTaskChanges(task Task) (taskReview, error) {
	var result taskReview
	if !validID(task.ID) || task.Branch != "codex/fluke/"+task.ID || task.Worktree == nil || !filepath.IsAbs(*task.Worktree) || !filepath.IsAbs(task.Repo) {
		return result, errors.New(uiText("la tarea no tiene un worktree válido para revisar"))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	readIdentity := func(dir string, args ...string) (string, error) {
		value, truncated, err := reviewGit(ctx, dir, 4096, args...)
		if truncated && err == nil {
			err = errors.New("identidad git demasiado larga")
		}
		return strings.TrimSpace(value), err
	}
	if err := validateOwnedWorktreeContext(ctx, task, *task.Worktree); err != nil {
		return result, err
	}
	initialTree, err := deliveryTree(ctx, task)
	if err != nil {
		return result, err
	}
	base := "HEAD" // Old tasks did not save their starting commit.
	if task.BaseCommit != "" {
		if len(task.BaseCommit) != 40 && len(task.BaseCommit) != 64 {
			return result, errors.New(uiText("commit base inválido"))
		}
		for _, c := range task.BaseCommit {
			if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
				return result, errors.New(uiText("commit base inválido"))
			}
		}
		resolved, e := readIdentity(*task.Worktree, "rev-parse", "--verify", task.BaseCommit+"^{commit}")
		if e != nil || !strings.EqualFold(resolved, task.BaseCommit) {
			return result, errors.New(uiText("commit base inexistente o inválido"))
		}
		if _, _, e = reviewGit(ctx, *task.Worktree, 2048, "merge-base", "--is-ancestor", resolved, "HEAD"); e != nil {
			return result, errors.New(uiText("el commit base no pertenece al historial de esta tarea"))
		}
		base = resolved
	}
	paths := []string{"--", ".", ":(top,exclude).fluke-task.md", ":(top,exclude).fluke-worker-contract.md", ":(top,exclude).fluke-worker/**"}
	budget := 256 * 1024
	read := func(args ...string) (string, error) {
		value, truncated, err := reviewGit(ctx, *task.Worktree, budget, append(args, paths...)...)
		budget -= len(value)
		result.Truncated = result.Truncated || truncated
		return value, err
	}
	if result.Status, err = read("status", "--porcelain=v1", "--untracked-files=all"); err != nil {
		return result, err
	}
	untracked, err := read("ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return result, err
	}
	// A truncated final name is incomplete; don't present it as an actual path.
	if end := strings.LastIndexByte(untracked, 0); end >= 0 {
		result.Untracked = strings.Split(untracked[:end], "\x00")
	}
	if len(result.Untracked) > 200 {
		result.Untracked = result.Untracked[:200]
		result.Truncated = true
	}
	if result.Summary, err = read("diff", base, "--stat", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames"); err != nil {
		return result, err
	}
	result.Diff, err = read("diff", base, "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames")
	if err != nil {
		return result, err
	}
	// OpenRoot confines reads even if a worker replaces a directory with a
	// symlink while this snapshot is being collected.
	files, err := os.OpenRoot(*task.Worktree)
	if err != nil {
		return result, err
	}
	defer files.Close()
	preview := &reviewOutput{remaining: budget}
	for _, name := range result.Untracked {
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		if preview.remaining == 0 {
			result.Truncated = true
			break
		}
		fmt.Fprintf(preview, uiText("\n--- archivo nuevo %q ---\n"), name)
		if !filepath.IsLocal(name) || len(name) > 4096 {
			fmt.Fprintln(preview, uiText("[ruta inválida; contenido omitido]"))
			continue
		}
		info, e := files.Lstat(name)
		if e != nil || !info.Mode().IsRegular() {
			fmt.Fprintln(preview, uiText("[archivo no regular o enlace; contenido omitido]"))
			continue
		}
		f, e := files.Open(name)
		if e != nil {
			fmt.Fprintln(preview, uiText("[no se pudo leer dentro del worktree]"))
			continue
		}
		info, e = f.Stat()
		if e != nil || !info.Mode().IsRegular() {
			f.Close()
			fmt.Fprintln(preview, uiText("[archivo no regular; contenido omitido]"))
			continue
		}
		data, e := io.ReadAll(io.LimitReader(f, int64(preview.remaining)+1))
		f.Close()
		if e != nil {
			fmt.Fprintln(preview, uiText("[error leyendo el archivo]"))
		} else if strings.IndexByte(string(data), 0) >= 0 {
			fmt.Fprintln(preview, uiText("[archivo binario; contenido omitido]"))
		} else {
			preview.Write(data)
			fmt.Fprintln(preview)
		}
	}
	result.Diff += preview.text.String()
	result.Truncated = result.Truncated || preview.truncated
	result.Tree, err = deliveryTree(ctx, task)
	if err != nil {
		return result, err
	}
	if result.Tree != initialTree {
		return result, errors.New(uiText("la entrega cambió mientras se leía el diff; actualizá la revisión"))
	}
	return result, nil
}
