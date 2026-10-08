package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type githubPRFixtureState struct {
	BaseBranch, BaseHead, HeadBranch, RemoteHead string
	PRs                                          []githubPR
	Pushes, Creates, Edits                       int
	Title, Body                                  string
	CreateArgs                                   []string
}

func init() {
	file := os.Getenv("FLUKE_PR_FIXTURE")
	if file == "" {
		return
	}
	name := strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe")
	if name != "gh" && name != "git" {
		return
	}
	data, err := os.ReadFile(file)
	if err != nil {
		os.Exit(20)
	}
	var state githubPRFixtureState
	if json.Unmarshal(data, &state) != nil {
		os.Exit(21)
	}
	args := os.Args[1:]
	save := func() {
		data, _ := json.Marshal(state)
		if os.WriteFile(file, data, 0600) != nil {
			os.Exit(22)
		}
	}
	if name == "git" {
		push := -1
		for i, arg := range args {
			if arg == "push" {
				push = i
			}
		}
		if push < 0 {
			cmd := exec.Command(os.Getenv("FLUKE_PR_REAL_GIT"), args...)
			cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
			if err := cmd.Run(); err != nil {
				if exit, ok := err.(*exec.ExitError); ok {
					os.Exit(exit.ExitCode())
				}
				os.Exit(23)
			}
			os.Exit(0)
		}
		if os.Getenv("GIT_TERMINAL_PROMPT") != "0" || os.Getenv("GH_HOST") != "github.com" || os.Getenv("GH_REPO") != "" {
			os.Exit(24)
		}
		wantPrefix := []string{"--porcelain", "--no-force", "--no-follow-tags", "https://github.com/example/demo.git"}
		if len(args[push+1:]) != 5 {
			os.Exit(25)
		}
		for i, value := range wantPrefix {
			if args[push+1+i] != value {
				os.Exit(26)
			}
		}
		head, ref, ok := strings.Cut(args[len(args)-1], ":")
		if !ok || !validGitHash(head) || ref != "refs/heads/"+state.HeadBranch || state.HeadBranch == state.BaseBranch {
			os.Exit(27)
		}
		state.Pushes++
		if os.Getenv("FLUKE_PR_PUSH_FAIL") != "1" {
			state.RemoteHead = head
			for i := range state.PRs {
				state.PRs[i].Head = head
			}
		}
		save()
		if os.Getenv("FLUKE_PR_PUSH_FAIL") == "1" || os.Getenv("FLUKE_PR_PUSH_UNCERTAIN") == "1" {
			fmt.Fprint(os.Stderr, "secret remote credential")
			os.Exit(28)
		}
		os.Exit(0)
	}
	if os.Getenv("GH_REPO") != "" || os.Getenv("GH_HOST") != "github.com" || os.Getenv("GH_PROMPT_DISABLED") != "1" {
		os.Exit(29)
	}
	if os.Getenv("FLUKE_PR_READ_FAIL") == "1" {
		fmt.Fprint(os.Stderr, "secret gh credential")
		os.Exit(30)
	}
	flag := func(key string) string {
		for i, arg := range args {
			if arg == key && i+1 < len(args) {
				return args[i+1]
			}
		}
		return ""
	}
	if len(args) >= 2 && args[0] == "repo" && args[1] == "view" {
		json.NewEncoder(os.Stdout).Encode(map[string]any{"nameWithOwner": "example/demo", "url": "https://github.com/example/demo", "defaultBranchRef": map[string]string{"name": state.BaseBranch}})
	} else if len(args) >= 2 && args[0] == "api" && args[1] == "user" {
		json.NewEncoder(os.Stdout).Encode(map[string]string{"login": "fixture-user"})
	} else if len(args) >= 2 && args[0] == "issue" && args[1] == "list" {
		json.NewEncoder(os.Stdout).Encode([]githubIssue{{Number: 12, Title: "Exportar JSON", Body: "Exportación revisada con ejemplo verificable.", URL: "https://github.com/example/demo/issues/12"}})
	} else if len(args) >= 2 && args[0] == "api" {
		branch := ""
		if strings.HasSuffix(args[1], "/"+state.BaseBranch) {
			branch = state.BaseBranch
		} else if strings.HasSuffix(args[1], "/"+strings.ReplaceAll(state.HeadBranch, "/", "%2F")) {
			branch = state.HeadBranch
		}
		head := state.RemoteHead
		if branch == state.BaseBranch {
			head = state.BaseHead
		}
		refs := []map[string]any{}
		if branch != "" && head != "" {
			refs = append(refs, map[string]any{"ref": "refs/heads/" + branch, "object": map[string]string{"sha": head}})
		}
		json.NewEncoder(os.Stdout).Encode(refs)
	} else if len(args) >= 2 && args[0] == "pr" && args[1] == "list" {
		if flag("--repo") != "example/demo" || flag("--head") != state.HeadBranch || flag("--base") != state.BaseBranch || flag("--state") != "all" {
			os.Exit(31)
		}
		if state.PRs == nil {
			state.PRs = []githubPR{}
		}
		json.NewEncoder(os.Stdout).Encode(state.PRs)
	} else if len(args) >= 2 && args[0] == "pr" && args[1] == "view" {
		if len(state.PRs) != 1 || args[2] != state.PRs[0].URL {
			os.Exit(35)
		}
		json.NewEncoder(os.Stdout).Encode(state.PRs[0])
	} else if len(args) >= 2 && args[0] == "pr" && args[1] == "edit" {
		if len(state.PRs) != 1 || args[2] != state.PRs[0].URL || flag("--repo") != "example/demo" || flag("--body-file") != "-" {
			os.Exit(36)
		}
		body, _ := io.ReadAll(os.Stdin)
		state.Edits++
		if os.Getenv("FLUKE_PR_EDIT_FAIL") != "1" {
			state.Title, state.Body = flag("--title"), string(body)
			state.PRs[0].Title, state.PRs[0].Body = state.Title, state.Body
		}
		save()
		if os.Getenv("FLUKE_PR_EDIT_FAIL") == "1" || os.Getenv("FLUKE_PR_EDIT_UNCERTAIN") == "1" {
			fmt.Fprint(os.Stderr, "secret edit response")
			os.Exit(37)
		}
	} else if len(args) >= 2 && args[0] == "pr" && args[1] == "create" {
		if flag("--repo") != "example/demo" || flag("--head") != state.HeadBranch || flag("--base") != state.BaseBranch || flag("--body-file") != "-" || state.RemoteHead == "" || !strings.Contains(strings.Join(args, " "), "--draft") {
			os.Exit(32)
		}
		body, _ := io.ReadAll(os.Stdin)
		state.Title, state.Body, state.CreateArgs = flag("--title"), string(body), args
		state.Creates++
		pr := githubPR{Number: 42, URL: "https://github.com/example/demo/pull/42", State: "OPEN", Draft: true, HeadBranch: state.HeadBranch, Head: state.RemoteHead, BaseBranch: state.BaseBranch, Title: state.Title, Body: state.Body}
		state.PRs = append(state.PRs, pr)
		save()
		if os.Getenv("FLUKE_PR_CREATE_UNCERTAIN") == "1" {
			fmt.Fprint(os.Stderr, "secret response lost after create")
			os.Exit(33)
		}
		fmt.Fprintln(os.Stdout, pr.URL)
	} else {
		os.Exit(34)
	}
	os.Exit(0)
}

func setupGithubPRFixture(t *testing.T, task Task) (string, githubPRFixtureState) {
	t.Helper()
	realGit, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	dependencyTestGit(t, task.Repo, "remote", "add", "origin", "https://github.com/example/demo.git")
	bin := t.TempDir()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"git", "gh"} {
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		if err = os.WriteFile(filepath.Join(bin, name), data, 0700); err != nil {
			t.Fatal(err)
		}
	}
	file := filepath.Join(bin, "remote.json")
	state := githubPRFixtureState{BaseBranch: "main", BaseHead: task.BaseCommit, HeadBranch: task.Branch}
	writeGithubPRFixture(t, file, state)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FLUKE_PR_REAL_GIT", realGit)
	t.Setenv("FLUKE_PR_FIXTURE", file)
	t.Setenv("GH_HOST", "wrong.invalid")
	t.Setenv("GH_REPO", "wrong/repo")
	return file, state
}

func writeGithubPRFixture(t *testing.T, file string, state githubPRFixtureState) {
	t.Helper()
	data, err := json.Marshal(state)
	if err != nil || os.WriteFile(file, data, 0600) != nil {
		t.Fatal("cannot save GitHub PR fixture", err)
	}
}

func readGithubPRFixture(t *testing.T, file string) githubPRFixtureState {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var state githubPRFixtureState
	if err = json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func TestGithubPRPublishesExactAcceptedTreeAndReconciles(t *testing.T) {
	for _, committed := range []bool{false, true} {
		t.Run(map[bool]string{false: "commit", true: "committed"}[committed], func(t *testing.T) {
			task := acceptedDelivery(t, committed)
			task.Title = "Resultado C:\\Users\\private\\worker-output.log"
			file, _ := setupGithubPRFixture(t, task)
			before := dependencyTestGit(t, *task.Worktree, "diff", "--cached")
			plan, err := inspectGithubPullRequest(task)
			if err != nil || plan.Commit == committed || !validStoredGithubPRPlan(task, plan) || plan.Pushed || plan.URL != "" {
				t.Fatal("incorrect preview", plan, err)
			}
			if strings.Contains(plan.Title, "private") || strings.Contains(plan.Body, task.Repo) || strings.Contains(plan.Body, *task.Worktree) {
				t.Fatal("automatic PR copy exposed local paths", plan)
			}
			if dependencyTestGit(t, *task.Worktree, "diff", "--cached") != before || readGithubPRFixture(t, file).Pushes != 0 {
				t.Fatal("preview mutated Git")
			}
			if _, err = publishGithubPullRequest(task, plan); err == nil {
				t.Fatal("published without durable confirmation")
			}
			plan.Title, plan.Body = "Exportá JSON · prueba", "Salida validada.\n\nUnicode: ñ y \"comillas\".\n"
			plan.Started = true
			published, err := publishGithubPullRequest(task, plan)
			if err != nil || !published.Pushed || published.URL != "https://github.com/example/demo/pull/42" || published.Commit || !published.Draft {
				t.Fatal("publication failed", published, err)
			}
			remote := readGithubPRFixture(t, file)
			if remote.Pushes != 1 || remote.Creates != 1 || remote.RemoteHead != published.SourceHead || remote.Title != plan.Title || remote.Body != plan.Body {
				t.Fatal("incorrect published snapshot", remote)
			}
			if dependencyTestGit(t, *task.Worktree, "rev-parse", "HEAD^{tree}") != task.AcceptedTree || dependencyTestGit(t, task.Repo, "rev-parse", "HEAD") != task.BaseCommit {
				t.Fatal("publication changed base or accepted files")
			}
			if !committed && dependencyTestGit(t, *task.Worktree, "log", "-1", "--format=%s") != "Fluke: "+plan.Title {
				t.Fatal("published commit didn't use the human-reviewed title")
			}
			if tracked := dependencyTestGit(t, *task.Worktree, "ls-files", ".fluke-task.md", ".fluke-worker-contract.md"); tracked != "" {
				t.Fatal("internal helper committed", tracked)
			}
			// The journal can lag both commit and network writes after a crash.
			recovered, err := reconcileGithubPullRequest(task, plan)
			if err != nil || recovered.SourceHead != published.SourceHead || !recovered.Pushed || recovered.URL != published.URL {
				t.Fatal("lost response recovery failed", recovered, err)
			}
			if after := readGithubPRFixture(t, file); after.Pushes != 1 || after.Creates != 1 {
				t.Fatal("reconciliation wrote to GitHub")
			}
		})
	}
}

func TestGithubPRExistingDraftUpdatesWithoutDuplicate(t *testing.T) {
	task := acceptedDelivery(t, false)
	file, remote := setupGithubPRFixture(t, task)
	remote.RemoteHead = dependencyTestGit(t, *task.Worktree, "rev-parse", "HEAD")
	remote.PRs = []githubPR{{Number: 42, URL: "https://github.com/example/demo/pull/42", State: "OPEN", Draft: true, HeadBranch: task.Branch, Head: remote.RemoteHead, BaseBranch: "main", Title: "Existing title", Body: "Human notes preserved"}}
	writeGithubPRFixture(t, file, remote)
	plan, err := inspectGithubPullRequest(task)
	if err != nil || plan.URL == "" || plan.Pushed || !plan.Commit {
		t.Fatal(plan, err)
	}
	if plan.Title != "Existing title" || plan.Body != "Human notes preserved" {
		t.Fatal("existing human notes weren't preserved in preview", plan)
	}
	plan.Title, plan.Body = "Reviewed new title", "New human review\n\nIncludes corrections."
	plan.Started = true
	published, err := publishGithubPullRequest(task, plan)
	if err != nil || !published.Pushed || !published.Complete || published.URL != plan.URL {
		t.Fatal(published, err)
	}
	if after := readGithubPRFixture(t, file); after.Pushes != 1 || after.Creates != 0 || after.Edits != 1 || after.Title != plan.Title || after.Body != plan.Body {
		t.Fatal("created a duplicate PR", after)
	}
}

func TestGithubPREditUncertainResultIsVerifiedWithoutReplay(t *testing.T) {
	for _, failure := range []string{"FLUKE_PR_EDIT_UNCERTAIN", "FLUKE_PR_EDIT_FAIL"} {
		t.Run(failure, func(t *testing.T) {
			task := acceptedDelivery(t, true)
			file, remote := setupGithubPRFixture(t, task)
			remote.RemoteHead = dependencyTestGit(t, *task.Worktree, "rev-parse", "HEAD")
			remote.PRs = []githubPR{{Number: 42, URL: "https://github.com/example/demo/pull/42", State: "OPEN", Draft: false, HeadBranch: task.Branch, Head: remote.RemoteHead, BaseBranch: "main", Title: "Original title", Body: "Original human notes"}}
			writeGithubPRFixture(t, file, remote)
			plan, err := inspectGithubPullRequest(task)
			if err != nil || !plan.Complete || !plan.Pushed || plan.Draft {
				t.Fatal(plan, err)
			}
			plan.Title, plan.Body, plan.Started, plan.Complete = "Edited title", "Human approved description\n\nUpdated validation.", true, false
			t.Setenv(failure, "1")
			result, err := publishGithubPullRequest(task, plan)
			if failure == "FLUKE_PR_EDIT_UNCERTAIN" {
				if err != nil || !result.Complete || result.Draft {
					t.Fatal("lost edit response wasn't verified", result, err)
				}
			} else if err == nil || result.Complete || !result.Pushed || strings.Contains(err.Error(), "secret") {
				t.Fatal("failed edit falsely confirmed or leaked credentials", result, err)
			}
			_, _ = reconcileGithubPullRequest(task, result)
			if after := readGithubPRFixture(t, file); after.Pushes != 0 || after.Creates != 0 || after.Edits != 1 || after.PRs[0].Draft {
				t.Fatal("edit retry wrote without permission or changed draft state", after)
			}
		})
	}
}

func TestCommitAcceptedDeliveryDoesNotCommitPreparedInternalFiles(t *testing.T) {
	task := acceptedDelivery(t, false)
	before := dependencyTestGit(t, *task.Worktree, "rev-parse", "HEAD")
	dependencyTestGit(t, *task.Worktree, "add", "-f", ".fluke-task.md")
	if _, err := commitAcceptedDelivery(task); err == nil || !strings.Contains(err.Error(), "índice") {
		t.Fatal("committed staged internal metadata", err)
	}
	if dependencyTestGit(t, *task.Worktree, "rev-parse", "HEAD") != before {
		t.Fatal("internal files reached a commit")
	}
	if _, err := os.Stat(filepath.Join(*task.Worktree, "new.txt")); err != nil {
		t.Fatal("accepted files were lost", err)
	}
}

func TestGithubPRChangedPreviewAndUnacceptedHooksCannotPush(t *testing.T) {
	for _, change := range []string{"source", "remote", "base", "hook", "origin", "private-origin", "base-is-head", "metadata", "draft"} {
		t.Run(change, func(t *testing.T) {
			task := acceptedDelivery(t, false)
			file, remote := setupGithubPRFixture(t, task)
			if change == "metadata" || change == "draft" {
				remote.RemoteHead = dependencyTestGit(t, *task.Worktree, "rev-parse", "HEAD")
				remote.PRs = []githubPR{{Number: 42, URL: "https://github.com/example/demo/pull/42", State: "OPEN", Draft: true, HeadBranch: task.Branch, Head: remote.RemoteHead, BaseBranch: "main", Title: "Existing title", Body: "Human notes"}}
				writeGithubPRFixture(t, file, remote)
			}
			plan, err := inspectGithubPullRequest(task)
			if err != nil {
				t.Fatal(err)
			}
			plan.Started = true
			switch change {
			case "source":
				_ = os.WriteFile(filepath.Join(*task.Worktree, "new.txt"), []byte("changed after preview"), 0600)
			case "remote":
				remote.RemoteHead = plan.SourceHead
				writeGithubPRFixture(t, file, remote)
			case "base":
				remote.BaseHead = plan.SourceHead
				writeGithubPRFixture(t, file, remote)
			case "hook":
				hooks := t.TempDir()
				dependencyTestGit(t, task.Repo, "config", "core.hooksPath", filepath.ToSlash(hooks))
				_ = os.WriteFile(filepath.Join(hooks, "post-commit"), []byte("#!/bin/sh\nprintf unaccepted > product.txt\n"), 0700)
			case "origin":
				dependencyTestGit(t, task.Repo, "remote", "set-url", "--push", "origin", "https://gitlab.com/example/demo.git")
			case "private-origin":
				dependencyTestGit(t, task.Repo, "remote", "set-url", "origin", "https://private-token@github.com/example/demo.git")
			case "base-is-head":
				remote.BaseBranch = task.Branch
				writeGithubPRFixture(t, file, remote)
			case "metadata":
				remote.PRs[0].Body = "Concurrent human update"
				writeGithubPRFixture(t, file, remote)
			case "draft":
				remote.PRs[0].Draft = false
				writeGithubPRFixture(t, file, remote)
			}
			if _, err = publishGithubPullRequest(task, plan); err == nil || strings.Contains(err.Error(), "private-token") {
				t.Fatal("published changed or private snapshot", err)
			}
			if after := readGithubPRFixture(t, file); after.Pushes != 0 || after.Creates != 0 {
				t.Fatal("invalid preview wrote to remote", after)
			}
		})
	}
}

func TestGithubPRUncertainWritesReconcileWithoutReplay(t *testing.T) {
	for _, failure := range []string{"FLUKE_PR_PUSH_UNCERTAIN", "FLUKE_PR_CREATE_UNCERTAIN", "FLUKE_PR_PUSH_FAIL"} {
		t.Run(failure, func(t *testing.T) {
			task := acceptedDelivery(t, true)
			file, _ := setupGithubPRFixture(t, task)
			plan, err := inspectGithubPullRequest(task)
			if err != nil {
				t.Fatal(err)
			}
			plan.Started = true
			t.Setenv(failure, "1")
			result, err := publishGithubPullRequest(task, plan)
			if failure == "FLUKE_PR_CREATE_UNCERTAIN" {
				if err != nil || result.URL == "" {
					t.Fatal("didn't reconcile create with lost response", result, err)
				}
			} else if err == nil || strings.Contains(err.Error(), "secret") {
				t.Fatal("unconfirmed push accepted or leaked credentials", err)
			}
			before := readGithubPRFixture(t, file)
			reconciled, err := reconcileGithubPullRequest(task, result)
			if failure == "FLUKE_PR_PUSH_FAIL" {
				if err == nil {
					t.Fatal("missing remote falsely confirmed")
				}
			} else if err != nil || !reconciled.Pushed {
				t.Fatal("successful remote push wasn't reconciled", reconciled, err)
			}
			after := readGithubPRFixture(t, file)
			if before.Pushes != after.Pushes || before.Creates != after.Creates || after.Pushes != 1 || after.Creates > 1 {
				t.Fatal("ambiguous operation replayed", before, after)
			}
		})
	}
}

func TestGithubPRRejectsClosedForeignAndMissingBase(t *testing.T) {
	for _, invalid := range []string{"closed", "remote-foreign", "missing-base", "internal-files", "gh-error"} {
		t.Run(invalid, func(t *testing.T) {
			task := acceptedDelivery(t, true)
			file, remote := setupGithubPRFixture(t, task)
			switch invalid {
			case "closed":
				remote.RemoteHead = dependencyTestGit(t, *task.Worktree, "rev-parse", "HEAD")
				remote.PRs = []githubPR{{Number: 42, URL: "https://github.com/example/demo/pull/42", State: "CLOSED", Draft: true, HeadBranch: task.Branch, Head: remote.RemoteHead, BaseBranch: "main"}}
			case "remote-foreign":
				remote.RemoteHead = strings.Repeat("f", 40)
			case "missing-base":
				remote.BaseHead = strings.Repeat("f", 40)
			case "internal-files":
				dependencyTestGit(t, *task.Worktree, "add", "-f", ".fluke-task.md")
				dependencyTestGit(t, *task.Worktree, "commit", "-m", "incorrect metadata")
				task.AcceptedTree = dependencyTestGit(t, *task.Worktree, "rev-parse", "HEAD^{tree}")
			case "gh-error":
				t.Setenv("FLUKE_PR_READ_FAIL", "1")
			}
			writeGithubPRFixture(t, file, remote)
			if _, err := inspectGithubPullRequest(task); err == nil || strings.Contains(err.Error(), "secret") {
				t.Fatal("invalid remote preview accepted or leaked secrets", err)
			}
		})
	}
}
