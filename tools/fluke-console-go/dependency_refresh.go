package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

type dependencyRefreshIntent struct {
	TaskID, GoalID, Branch, Repo, Worktree string
	RecordedBase, OldHead, NewHead         string
	Dependencies                           [32]byte
}

func dependencyRefreshHash(state State, task Task) [32]byte {
	dependencies := []struct{ ID, AcceptedTree string }{}
	for _, id := range task.DependsOn {
		for _, dependency := range state.Tasks {
			if dependency.ID == id {
				dependencies = append(dependencies, struct{ ID, AcceptedTree string }{id, dependency.AcceptedTree})
				break
			}
		}
	}
	data, _ := json.Marshal(dependencies)
	return sha256.Sum256(data)
}

func dependencyRefreshPath(ctx context.Context, targetDir string) (string, error) {
	gitDir, err := dependencyGit(ctx, targetDir, "rev-parse", "--absolute-git-dir")
	if err != nil {
		return "", err
	}
	// The journal belongs to this worktree's private Git directory, outside
	// worker files and the product index.
	return filepath.Join(gitDir, "fluke-dependency-base.json"), nil
}

func reconcileDependencyRefresh(ctx context.Context, state State, task Task, targetDir string) (string, error) {
	path, err := dependencyRefreshPath(ctx, targetDir)
	if err != nil {
		return "", err
	}
	root, err := os.OpenRoot(filepath.Dir(path))
	if err != nil {
		return "", err
	}
	defer root.Close()
	f, err := root.Open(filepath.Base(path))
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 {
		return "", errors.New(uiText("registro de actualización de base inválido; revisá el worktree"))
	}
	data, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil {
		return "", err
	}
	var intent dependencyRefreshIntent
	if len(data) > 4096 || json.Unmarshal(data, &intent) != nil || intent.TaskID != task.ID || intent.GoalID != task.GoalID || intent.Branch != task.Branch || !dependencySamePath(intent.Repo, task.Repo) || !dependencySamePath(intent.Worktree, targetDir) || !validGitHash(intent.OldHead) || !validGitHash(intent.NewHead) || intent.RecordedBase != "" && intent.RecordedBase != intent.OldHead {
		return "", errors.New(uiText("registro de actualización de base inválido; revisá el worktree"))
	}
	if task.BaseCommit == intent.NewHead {
		return "", nil // The launch already persisted this base.
	}
	// ponytail: changed journals need human review; add a reconciliation action if interrupted refreshes recur.
	if task.BaseCommit != intent.RecordedBase || intent.Dependencies != dependencyRefreshHash(state, task) {
		return "", errors.New(uiText("el contexto cambió durante una actualización pendiente de base; revisá el worktree"))
	}
	if err = validateOwnedWorktreeContext(ctx, task, targetDir); err != nil {
		return "", err
	}
	head, err := dependencyGit(ctx, targetDir, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	if head == intent.OldHead {
		return "", nil // The interrupted launch had not advanced Git yet.
	}
	if head != intent.NewHead {
		return "", errors.New(uiText("el worktree cambió después de actualizar su base; revisá sus commits sin reescribirlos"))
	}
	if _, err = dependencyGit(ctx, targetDir, "merge-base", "--is-ancestor", intent.OldHead, intent.NewHead); err != nil {
		return "", errors.New(uiText("la actualización pendiente no fue un fast-forward válido"))
	}
	repoHead, err := dependencyGit(ctx, task.Repo, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	if _, err = dependencyGit(ctx, targetDir, "merge-base", "--is-ancestor", intent.NewHead, repoHead); err != nil {
		return "", errors.New(uiText("la base actualizada ya no pertenece al destino integrado; revisá el repositorio"))
	}
	for _, dir := range []string{task.Repo, targetDir} {
		if err = noGitOperation(ctx, dir); err != nil {
			return "", err
		}
	}
	status, err := dependencyGit(ctx, targetDir, append([]string{"status", "--porcelain=v1", "--untracked-files=all"}, deliveryPaths...)...)
	if err != nil {
		return "", err
	}
	if status != "" {
		return "", errors.New(uiText("el worktree cambió después de actualizar su base; conservá sus archivos y revisá la tarea"))
	}
	if err = dependencyReadiness(state, task, targetDir); err != nil {
		return "", err
	}
	return intent.NewHead, nil
}
