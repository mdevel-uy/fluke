package main

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func validateTaskDependencies(state State, task Task) error {
	byID := make(map[string]Task, len(state.Tasks)+1)
	for _, existing := range state.Tasks {
		if _, duplicate := byID[existing.ID]; duplicate {
			return errors.New(uiText("hay IDs de tarea repetidos en el estado"))
		}
		byID[existing.ID] = existing
	}
	byID[task.ID] = task // Validate an edited dependency list before saving it.
	visiting, visited := map[string]bool{}, map[string]bool{}
	var visit func(Task) error
	visit = func(current Task) error {
		if visiting[current.ID] {
			return errors.New(uiText("las dependencias forman un ciclo"))
		}
		if visited[current.ID] {
			return nil
		}
		if len(current.DependsOn) > 32 {
			return errors.New(uiText("una tarea admite hasta 32 dependencias"))
		}
		visiting[current.ID] = true
		seen := map[string]bool{}
		for _, id := range current.DependsOn {
			if !validID(id) {
				return errors.New(uiText("ID de dependencia inválido"))
			}
			if id == current.ID {
				return errors.New(uiText("una tarea no puede depender de sí misma"))
			}
			if seen[id] {
				return errors.New(uiText("la dependencia está repetida"))
			}
			seen[id] = true
			dependency, exists := byID[id]
			if !exists {
				return fmt.Errorf(uiText("no existe la dependencia %s"), id)
			}
			goal := state.Goals[current.Repo]
			historical := goal.ID != "" && current.GoalID != "" && current.GoalID != goal.ID
			if dependency.Repo != current.Repo || dependency.GoalID != current.GoalID && !historical {
				return errors.New(uiText("las dependencias deben pertenecer al mismo repositorio y objetivo"))
			}
			if err := visit(dependency); err != nil {
				return err
			}
		}
		delete(visiting, current.ID)
		visited[current.ID] = true
		return nil
	}
	return visit(task)
}

func dependencySamePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func dependencyGit(ctx context.Context, dir string, args ...string) (string, error) {
	out, truncated, err := reviewGit(ctx, dir, 4096, args...)
	if truncated && err == nil {
		err = errors.New(uiText("respuesta Git demasiado larga para validar la dependencia"))
	}
	return strings.TrimSpace(out), err
}

func validateOwnedWorktree(task Task, path string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return validateOwnedWorktreeContext(ctx, task, path)
}

func validateOwnedWorktreeContext(ctx context.Context, task Task, path string) error {
	if !validID(task.ID) || task.Branch != "codex/fluke/"+task.ID || !filepath.IsAbs(path) || !filepath.IsAbs(task.Repo) || task.Worktree != nil && !dependencySamePath(*task.Worktree, path) {
		return errors.New(uiText("la tarea no tiene un worktree válido"))
	}
	branch, err := dependencyGit(ctx, path, "symbolic-ref", "--short", "HEAD")
	if err != nil {
		return err
	}
	root, err := dependencyGit(ctx, path, "rev-parse", "--show-toplevel")
	if err != nil {
		return err
	}
	common, err := dependencyGit(ctx, path, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return err
	}
	origin, err := dependencyGit(ctx, task.Repo, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return err
	}
	if branch != task.Branch || !dependencySamePath(root, path) || !dependencySamePath(common, origin) {
		return errors.New(uiText("el worktree no corresponde a esta tarea"))
	}
	return nil
}

// Acceptance is not integration: dispatch only against a HEAD containing each
// clean dependency branch's committed changes. This never commits or merges.
func dependencyReadiness(state State, task Task, targetDir string) error {
	if err := validateTaskDependencies(state, task); err != nil {
		return err
	}
	if len(task.DependsOn) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if !filepath.IsAbs(targetDir) {
		return errors.New(uiText("destino de dependencias inválido"))
	}
	if dependencySamePath(targetDir, task.Repo) {
		root, err := dependencyGit(ctx, targetDir, "rev-parse", "--show-toplevel")
		if err != nil || !dependencySamePath(root, targetDir) {
			return errors.New(uiText("el destino no corresponde al repositorio de la tarea"))
		}
	} else if err := validateOwnedWorktreeContext(ctx, task, targetDir); err != nil {
		return err
	}
	byID := make(map[string]Task, len(state.Tasks))
	for _, existing := range state.Tasks {
		byID[existing.ID] = existing
	}
	paths := []string{"--", ".", ":(top,exclude).fluke/**", ":(top,exclude).fluke-task.md", ":(top,exclude).fluke-worker-contract.md", ":(top,exclude).fluke-worker/**"}
	for _, id := range task.DependsOn {
		dependency := byID[id]
		blocked := func(reason string) error { return fmt.Errorf("dependencia %s: %s", id, reason) }
		if dependency.Status != "accepted" {
			return blocked(uiText("la entrega todavía no fue aceptada"))
		}
		if dependency.Integration != nil && dependency.Integration.Started && dependency.Integration.MergedCommit == "" {
			return blocked(uiText("su integración sigue pendiente de verificar en F7"))
		}
		if dependency.Worktree == nil {
			return blocked(uiText("falta el worktree para verificar la entrega"))
		}
		if err := validateOwnedWorktreeContext(ctx, dependency, *dependency.Worktree); err != nil {
			return blocked(err.Error())
		}
		base := dependency.BaseCommit
		if _, err := hex.DecodeString(base); err != nil || len(base) != 40 && len(base) != 64 {
			return blocked(uiText("el commit base falta o es inválido; revisá la entrega"))
		}
		status, err := dependencyGit(ctx, *dependency.Worktree, append([]string{"status", "--porcelain=v1", "--untracked-files=all"}, paths...)...)
		if err != nil {
			return blocked(err.Error())
		}
		if status != "" {
			return blocked(uiText("hay cambios sin commit en su worktree"))
		}
		tip, err := dependencyGit(ctx, *dependency.Worktree, "rev-parse", "--verify", "refs/heads/"+dependency.Branch+"^{commit}")
		if err != nil {
			return blocked(uiText("no se pudo resolver la rama de la entrega"))
		}
		tree, err := dependencyGit(ctx, *dependency.Worktree, "rev-parse", tip+"^{tree}")
		if err != nil || !validGitHash(dependency.AcceptedTree) || tree != dependency.AcceptedTree {
			return blocked(uiText("la rama contiene cambios sin aceptación vigente; revisá y aceptá de nuevo en F7"))
		}
		if strings.EqualFold(tip, base) {
			return blocked(uiText("la rama no tiene cambios comprometidos desde el commit base"))
		}
		if _, err := dependencyGit(ctx, *dependency.Worktree, "merge-base", "--is-ancestor", base, tip); err != nil {
			return blocked(uiText("el commit base no pertenece al historial de la entrega"))
		}
		changed, err := dependencyGit(ctx, *dependency.Worktree, append([]string{"diff", "--name-only", "--no-ext-diff", "--no-textconv", base, tip}, paths...)...)
		if err != nil {
			return blocked(err.Error())
		}
		if changed == "" {
			return blocked(uiText("la entrega no contiene cambios de producto verificables"))
		}
		if _, err := dependencyGit(ctx, targetDir, "merge-base", "--is-ancestor", tip, "HEAD"); err != nil {
			return blocked(uiText("su commit todavía no está integrado en el HEAD de destino; integrá la rama y actualizá el worktree. Squash requiere verificación manual y aún no está soportado"))
		}
	}
	return nil
}

// Queue probes stay read-only; a worker launch may advance only its clean,
// untouched base to a destination that already contains accepted prerequisites.
func dependencyRefreshCommit(state State, task Task, targetDir string) (string, string, error) {
	if len(task.DependsOn) == 0 || dependencySamePath(targetDir, task.Repo) {
		return "", "", dependencyReadiness(state, task, task.Repo)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tip, err := dependencyGit(ctx, task.Repo, "rev-parse", "HEAD")
	if err != nil {
		return "", "", err
	}
	if err := dependencyReadiness(state, task, task.Repo); err != nil {
		return "", "", err
	}
	if err := validateOwnedWorktreeContext(ctx, task, targetDir); err != nil {
		return "", "", err
	}
	if recovered, err := reconcileDependencyRefresh(ctx, state, task, targetDir); err != nil || recovered != "" {
		return recovered, recovered, err
	}
	if err := dependencyReadiness(state, task, targetDir); err == nil {
		return "", "", nil
	}
	for _, dir := range []string{task.Repo, targetDir} {
		if err := noGitOperation(ctx, dir); err != nil {
			return "", "", err
		}
	}
	head, err := dependencyGit(ctx, targetDir, "rev-parse", "HEAD")
	if err != nil {
		return "", "", err
	}
	if task.BaseCommit != "" && (!validGitHash(task.BaseCommit) || head != task.BaseCommit) {
		return "", "", errors.New(uiText("el worker ya tiene commits propios; actualizá sus dependencias manualmente sin reescribir su trabajo"))
	}
	status, err := dependencyGit(ctx, targetDir, append([]string{"status", "--porcelain=v1", "--untracked-files=all"}, deliveryPaths...)...)
	if err != nil {
		return "", "", err
	}
	if status != "" {
		return "", "", errors.New(uiText("el worktree tiene cambios locales; conservalos y actualizá sus dependencias manualmente"))
	}
	if _, err = dependencyGit(ctx, targetDir, "merge-base", "--is-ancestor", head, tip); err != nil {
		return "", "", errors.New(uiText("el worktree y el repositorio divergieron; actualizá sus dependencias manualmente"))
	}
	metadata, err := dependencyGit(ctx, targetDir, "diff", "--name-only", head, tip, "--", ".fluke", ".fluke-task.md", ".fluke-worker-contract.md", ".fluke-worker")
	if err != nil {
		return "", "", err
	}
	if metadata != "" {
		return "", "", errors.New(uiText("la actualización modifica archivos internos de Fluke; revisá la rama de destino"))
	}
	current, err := dependencyGit(ctx, task.Repo, "rev-parse", "HEAD")
	if err != nil {
		return "", "", err
	}
	if current != tip {
		return "", "", errors.New(uiText("el repositorio cambió durante la verificación; reintentá el inicio"))
	}
	return tip, head, nil
}

func dependencyDispatchReadiness(state State, task Task, targetDir string) error {
	_, _, err := dependencyRefreshCommit(state, task, targetDir)
	return err
}

func refreshDependencyWorktree(state State, task Task, targetDir string) (string, error) {
	tip, expectedHead, err := dependencyRefreshCommit(state, task, targetDir)
	if err != nil || tip == "" {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	head, err := dependencyGit(ctx, targetDir, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	if head != expectedHead {
		return "", errors.New(uiText("el worktree cambió durante la verificación; reintentá el inicio"))
	}
	if head == tip {
		return tip, nil // A saved intent proved the previous launch completed Git.
	}
	path, err := dependencyRefreshPath(ctx, targetDir)
	if err != nil {
		return "", err
	}
	intent := dependencyRefreshIntent{TaskID: task.ID, GoalID: task.GoalID, Branch: task.Branch, Repo: task.Repo, Worktree: targetDir, RecordedBase: task.BaseCommit, OldHead: head, NewHead: tip, Dependencies: dependencyRefreshHash(state, task)}
	if err = atomicJSON(path, intent); err != nil {
		return "", fmt.Errorf(uiText("no se pudo guardar la actualización de base: %w"), err)
	}
	// Updating a clean base must not run hooks or autostash local files.
	if _, err = dependencyGit(ctx, targetDir, "-c", "core.hooksPath="+os.DevNull, "-c", "merge.autostash=false", "merge", "--ff-only", "--no-edit", "--no-overwrite-ignore", tip); err != nil {
		return "", fmt.Errorf(uiText("no se pudo actualizar la base del worker: %w"), err)
	}
	if err = dependencyReadiness(state, task, targetDir); err != nil {
		return "", err
	}
	current, err := dependencyGit(ctx, targetDir, "rev-parse", "HEAD")
	if err != nil || current != tip {
		return "", errors.New(uiText("el worktree cambió durante la actualización; revisá sus commits"))
	}
	return tip, nil
}
