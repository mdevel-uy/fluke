package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Git add treats ignored literal exclusions as explicit ignored paths. The
// single-character glob preserves the exact helper names without that error.
var deliveryPaths = []string{"--", ".", ":(top,glob,exclude).fluk[e]/**", ":(top,glob,exclude).fluk[e]-task.md", ":(top,glob,exclude).fluk[e]-worker-contract.md", ":(top,glob,exclude).fluk[e]-worker/**"}

type integrationPlan struct {
	TaskID       string `json:"task_id"`
	TargetBranch string `json:"target_branch"`
	TargetHead   string `json:"target_head"`
	SourceHead   string `json:"source_head"`
	Tree         string `json:"tree"`
	Commit       bool   `json:"commit"`
	Started      bool   `json:"started,omitempty"`
	MergedCommit string `json:"merged_commit,omitempty"`
	ExpectedTree string `json:"expected_tree,omitempty"`
	Summary      string `json:"-"`
}

func validGitHash(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for _, c := range value {
		if !strings.ContainsRune("0123456789abcdef", c) {
			return false
		}
	}
	return true
}

// A temporary index snapshots tracked and new files without changing the user's index.
func deliveryTree(ctx context.Context, task Task) (string, error) {
	if task.Worktree == nil {
		return "", errors.New(uiText("falta el worktree de la entrega"))
	}
	if err := validateOwnedWorktreeContext(ctx, task, *task.Worktree); err != nil {
		return "", err
	}
	index, err := os.CreateTemp("", "fluke-delivery-index-*")
	if err != nil {
		return "", err
	}
	name := index.Name()
	index.Close()
	os.Remove(name) // read-tree expects an absent or valid Git index.
	defer os.Remove(name)
	defer os.Remove(name + ".lock")
	read := func(args ...string) (string, error) {
		cmd := exec.CommandContext(ctx, "git", append([]string{"-C", *task.Worktree, "-c", "core.fsmonitor=false"}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_INDEX_FILE="+name)
		cmd.WaitDelay = 2 * time.Second
		out, stderr := &reviewOutput{remaining: 4096}, &reviewOutput{remaining: 2048}
		cmd.Stdout, cmd.Stderr = out, stderr
		if err := cmd.Run(); err != nil {
			return "", fmt.Errorf("snapshot Git: %s (%w)", strings.TrimSpace(stderr.text.String()), err)
		}
		if out.truncated {
			return "", errors.New("respuesta Git demasiado larga")
		}
		return strings.TrimSpace(out.text.String()), nil
	}
	if _, err = read("read-tree", "HEAD"); err != nil {
		return "", err
	}
	if _, err = read(append([]string{"add", "-A"}, deliveryPaths...)...); err != nil {
		return "", err
	}
	return read("write-tree")
}

func noGitOperation(ctx context.Context, dir string) error {
	for _, name := range []string{"MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_START"} {
		path, err := dependencyGit(ctx, dir, "rev-parse", "--path-format=absolute", "--git-path", name)
		if err != nil {
			return err
		}
		if _, err = os.Lstat(path); err == nil {
			return errors.New(uiText("hay una operación Git pendiente en ") + dir + uiText("; resolvela antes de integrar"))
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func inspectIntegration(task Task) (integrationPlan, error) {
	plan := integrationPlan{TaskID: task.ID}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if task.Status != "accepted" || !validGitHash(task.AcceptedTree) {
		return plan, errors.New(uiText("primero revisá y aceptá esta entrega en F7"))
	}
	tree, err := deliveryTree(ctx, task)
	if err != nil {
		return plan, err
	}
	if tree != task.AcceptedTree {
		return plan, errors.New(uiText("la entrega cambió después de aceptarla; actualizá F7 y volvé a revisar/aceptar"))
	}
	plan.Tree = tree
	for _, dir := range []string{task.Repo, *task.Worktree} {
		if err = noGitOperation(ctx, dir); err != nil {
			return plan, err
		}
	}
	root, err := dependencyGit(ctx, task.Repo, "rev-parse", "--show-toplevel")
	if err != nil || !dependencySamePath(root, task.Repo) {
		return plan, errors.New(uiText("el destino ya no corresponde al repositorio del proyecto"))
	}
	plan.TargetBranch, err = dependencyGit(ctx, task.Repo, "symbolic-ref", "--short", "HEAD")
	if err != nil || plan.TargetBranch == task.Branch {
		return plan, errors.New(uiText("seleccioná una rama de destino distinta de la entrega, sin HEAD detached"))
	}
	status, err := dependencyGit(ctx, task.Repo, append([]string{"status", "--porcelain=v1", "--untracked-files=all"}, deliveryPaths...)...)
	if err != nil {
		return plan, err
	}
	if status != "" {
		return plan, errors.New(uiText("el repositorio de destino tiene cambios locales; guardalos antes de integrar"))
	}
	plan.TargetHead, err = dependencyGit(ctx, task.Repo, "rev-parse", "HEAD")
	if err != nil {
		return plan, err
	}
	plan.SourceHead, err = dependencyGit(ctx, *task.Worktree, "rev-parse", "HEAD")
	if err != nil {
		return plan, err
	}
	headTree, err := dependencyGit(ctx, *task.Worktree, "rev-parse", "HEAD^{tree}")
	if err != nil {
		return plan, err
	}
	plan.Commit = headTree != tree
	if !validGitHash(task.BaseCommit) {
		return plan, errors.New(uiText("falta un commit base válido; esta tarea necesita revisión manual de Git"))
	}
	if _, err = dependencyGit(ctx, *task.Worktree, "merge-base", "--is-ancestor", task.BaseCommit, plan.SourceHead); err != nil {
		return plan, errors.New(uiText("el historial de la entrega cambió; revisá la rama antes de integrar"))
	}
	metadata, err := dependencyGit(ctx, *task.Worktree, "diff", "--name-only", task.BaseCommit, tree, "--", ".fluke", ".fluke-task.md", ".fluke-worker-contract.md", ".fluke-worker")
	if err != nil || metadata != "" {
		return plan, errors.New(uiText("la rama incluye archivos internos de Fluke; retiralos del commit antes de integrar"))
	}
	if !plan.Commit {
		if _, err = dependencyGit(ctx, task.Repo, "merge-base", "--is-ancestor", plan.SourceHead, plan.TargetHead); err == nil {
			if saved := task.Integration; saved != nil && saved.Started {
				merge := saved.MergedCommit
				if merge == "" {
					// ponytail: a later destination commit needs manual reconciliation until recovery tracks the exact merge commit.
					merge = plan.TargetHead
				}
				actual, e := dependencyGit(ctx, task.Repo, "rev-parse", merge+"^{tree}")
				if e != nil || saved.ExpectedTree == "" || actual != saved.ExpectedTree {
					return plan, errors.New(uiText("el destino contiene cambios fuera del merge previsto; revisá Git antes de certificar la integración"))
				}
				plan.ExpectedTree, plan.MergedCommit = saved.ExpectedTree, merge
				return plan, nil
			}
			plan.MergedCommit = plan.TargetHead
			plan.ExpectedTree, err = dependencyGit(ctx, task.Repo, "rev-parse", plan.TargetHead+"^{tree}")
			if err != nil {
				return plan, err
			}
			return plan, nil // Reconcile a merge completed before a crash or outside Fluke.
		}
	}
	if plan.Summary, _, err = reviewGit(ctx, *task.Worktree, 16*1024, "diff", "--stat", "--no-ext-diff", "--no-textconv", task.BaseCommit, tree); err != nil {
		return plan, err
	}
	if strings.TrimSpace(plan.Summary) == "" {
		return plan, errors.New(uiText("la entrega no contiene cambios de producto para integrar"))
	}
	return plan, nil
}

// Only called after the human confirms a durable plan. Recheck before every mutation.
func prepareIntegration(task Task, approved integrationPlan) (integrationPlan, error) {
	current, err := inspectIntegration(task)
	if err != nil {
		return current, err
	}
	if current.TargetBranch != approved.TargetBranch || current.TargetHead != approved.TargetHead || current.SourceHead != approved.SourceHead || current.Tree != approved.Tree {
		return current, errors.New(uiText("la rama o los archivos cambiaron desde la vista previa; revisá y confirmá de nuevo"))
	}
	if current.MergedCommit != "" {
		return current, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if current.Commit {
		if _, err = commitAcceptedDelivery(task); err != nil {
			return current, err
		}
		current, err = inspectIntegration(task)
		if err != nil {
			return current, err // A hook changing the delivery invalidates its approval.
		}
		if current.TargetHead != approved.TargetHead || current.TargetBranch != approved.TargetBranch || current.Commit {
			return current, errors.New(uiText("el destino o la entrega cambiaron al crear el commit; revisá de nuevo"))
		}
	}
	output, truncated, err := reviewGit(ctx, task.Repo, 8192, "merge-tree", "--write-tree", "--name-only", current.TargetHead, current.SourceHead)
	if err != nil {
		return current, fmt.Errorf(uiText("no se pudo preparar un merge limpio; el destino se conserva. Resolvé/revisá estos conflictos antes de integrar:\n%s\n%w"), output, err)
	}
	tree, _, _ := strings.Cut(output, "\n")
	if truncated || !validGitHash(strings.TrimSpace(tree)) {
		return current, errors.New(uiText("no se pudo verificar el árbol del merge previsto"))
	}
	current.ExpectedTree = strings.TrimSpace(tree)
	return current, nil
}

func finishIntegration(task Task, approved integrationPlan) (integrationPlan, error) {
	current, err := inspectIntegration(task)
	if err != nil {
		return current, err
	}
	if current.SourceHead != approved.SourceHead || current.TargetHead != approved.TargetHead || current.TargetBranch != approved.TargetBranch || current.Tree != approved.Tree || current.Commit || !validGitHash(approved.ExpectedTree) {
		return current, errors.New(uiText("la rama o los archivos cambiaron antes del merge; revisá de nuevo"))
	}
	current.ExpectedTree = approved.ExpectedTree
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if _, _, err = reviewGit(ctx, task.Repo, 8192, "merge", "--no-ff", "--no-edit", current.SourceHead); err != nil {
		conflicts, _, _ := reviewGit(ctx, task.Repo, 8192, "diff", "--name-only", "--diff-filter=U")
		return current, fmt.Errorf(uiText("integración pendiente en %s; los cambios y conflictos se conservan. %s\n%w"), task.Repo, conflicts, err)
	}
	current.Started = true
	task.Integration = &current
	verified, err := inspectIntegration(task)
	if err != nil {
		return current, fmt.Errorf(uiText("el merge dejó cambios fuera de la integración verificable; revisá el destino. Sus dependencias siguen bloqueadas: %w"), err)
	}
	if verified.TargetBranch != current.TargetBranch || verified.SourceHead != current.SourceHead || verified.Commit || verified.MergedCommit == "" || verified.ExpectedTree != current.ExpectedTree {
		return current, errors.New(uiText("el merge incluyó cambios fuera de los archivos previstos, posiblemente de un hook; revisá el destino. La integración no se certifica y sus dependencias siguen bloqueadas"))
	}
	current.MergedCommit = verified.MergedCommit
	return current, nil
}
