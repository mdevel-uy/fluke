package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/x/ansi"
)

type githubPRPlan struct {
	TaskID      string `json:"task_id"`
	RepoName    string `json:"repo_name"`
	RemoteURL   string `json:"remote_url"`
	BaseBranch  string `json:"base_branch"`
	BaseHead    string `json:"base_head"`
	HeadBranch  string `json:"head_branch"`
	SourceHead  string `json:"source_head"`
	Tree        string `json:"tree"`
	RemoteHead  string `json:"remote_head,omitempty"`
	Title       string `json:"title"`
	Body        string `json:"body"`
	Commit      bool   `json:"commit"`
	Started     bool   `json:"started,omitempty"`
	Pushed      bool   `json:"pushed,omitempty"`
	Complete    bool   `json:"complete,omitempty"`
	ContentHash string `json:"content_hash,omitempty"`
	Draft       bool   `json:"draft"`
	Number      int    `json:"number,omitempty"`
	URL         string `json:"url,omitempty"`
	Summary     string `json:"-"`
}

type githubPR struct {
	Number            int    `json:"number"`
	URL               string `json:"url"`
	State             string `json:"state"`
	Draft             bool   `json:"isDraft"`
	HeadBranch        string `json:"headRefName"`
	Head              string `json:"headRefOid"`
	BaseBranch        string `json:"baseRefName"`
	IsCrossRepository bool   `json:"isCrossRepository"`
	Title             string `json:"title"`
	Body              string `json:"body"`
}

func validPRBranch(branch string) bool {
	if branch == "" || strings.HasPrefix(branch, "-") || strings.HasPrefix(branch, ".") || strings.HasPrefix(branch, "/") || strings.HasSuffix(branch, "/") || strings.HasSuffix(branch, ".") || strings.Contains(branch, "..") || strings.Contains(branch, "//") || strings.Contains(branch, "/.") || strings.Contains(branch, "@{") || branch == "@" {
		return false
	}
	for _, component := range strings.Split(branch, "/") {
		if strings.HasSuffix(component, ".lock") {
			return false
		}
	}
	for _, c := range branch {
		if c <= ' ' || c == 127 || strings.ContainsRune("~^:?*[\\", c) {
			return false
		}
	}
	return true
}

func validPRText(title, body string) bool {
	if strings.TrimSpace(title) == "" || len(title) > 512 || len(body) > 16384 || strings.TrimSpace(body) == "" {
		return false
	}
	for _, c := range title {
		if c < ' ' || c == 127 {
			return false
		}
	}
	for _, c := range body {
		if c < ' ' && c != '\n' && c != '\t' || c == 127 {
			return false
		}
	}
	return true
}

func validGithubPRURL(name, value string, number int) bool {
	return number > 0 && value == "https://github.com/"+name+"/pull/"+strconv.Itoa(number)
}

func validStoredGithubPRPlan(task Task, plan githubPRPlan) bool {
	name, err := githubPRRemote(plan.RemoteURL)
	if err != nil || !strings.EqualFold(name, plan.RepoName) || task.ID != plan.TaskID || task.Branch != plan.HeadBranch || plan.HeadBranch != "codex/fluke/"+task.ID || !validPRBranch(plan.BaseBranch) || plan.BaseBranch == plan.HeadBranch {
		return false
	}
	if !validGitHash(plan.BaseHead) || !validGitHash(plan.SourceHead) || !validGitHash(plan.Tree) || plan.RemoteHead != "" && !validGitHash(plan.RemoteHead) || plan.ContentHash != "" && (len(plan.ContentHash) != 64 || !validGitHash(plan.ContentHash)) {
		return false
	}
	if !validPRText(plan.Title, plan.Body) || plan.Pushed && (plan.Commit || plan.RemoteHead != plan.SourceHead) || plan.Complete && (!plan.Pushed || plan.URL == "") {
		return false
	}
	return plan.URL == "" && plan.Number == 0 || validGithubPRURL(plan.RepoName, plan.URL, plan.Number)
}

func githubPRRemote(remote string) (string, error) {
	name, err := githubRemote(remote)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(remote, "git@github.com:") {
		return name, nil
	}
	u, err := url.Parse(remote)
	if err != nil || u.Port() != "" || u.Scheme == "https" && u.User != nil || u.Scheme == "ssh" && u.User != nil && u.User.String() != "git" {
		return "", errors.New(uiText("usá un origin GitHub sin credenciales en la URL ni puertos personalizados"))
	}
	return name, nil
}

func githubPRRef(ctx context.Context, task Task, name, branch string) (string, error) {
	var refs []struct {
		Ref    string `json:"ref"`
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	if err := ghJSON(ctx, task.Repo, &refs, "api", "repos/"+name+"/git/matching-refs/heads/"+url.PathEscape(branch)); err != nil {
		return "", err
	}
	for _, ref := range refs {
		if ref.Ref == "refs/heads/"+branch {
			if !validGitHash(ref.Object.SHA) {
				return "", errors.New(uiText("GitHub devolvió una referencia inválida"))
			}
			return ref.Object.SHA, nil
		}
	}
	return "", nil
}

func githubPRExisting(ctx context.Context, task Task, plan githubPRPlan) (*githubPR, error) {
	var prs []githubPR
	if err := ghJSON(ctx, task.Repo, &prs, "pr", "list", "--repo", plan.RepoName, "--head", plan.HeadBranch, "--base", plan.BaseBranch, "--state", "all", "--limit", "100", "--json", "number,url,state,isDraft,headRefName,headRefOid,baseRefName,isCrossRepository"); err != nil {
		return nil, err
	}
	if len(prs) >= 100 {
		return nil, errors.New(uiText("demasiados PRs para verificar esta rama; revisá GitHub manualmente"))
	}
	var result *githubPR
	for i := range prs {
		pr := &prs[i]
		if pr.IsCrossRepository || pr.HeadBranch != plan.HeadBranch || pr.BaseBranch != plan.BaseBranch {
			continue
		}
		if !validGithubPRURL(plan.RepoName, pr.URL, pr.Number) || !validGitHash(pr.Head) || pr.Head != plan.RemoteHead {
			return nil, errors.New(uiText("el PR o su rama remota cambiaron; revisá GitHub de nuevo"))
		}
		if pr.State != "OPEN" || result != nil {
			return nil, errors.New(uiText("esta rama ya tiene un PR cerrado, fusionado o ambiguo; revisalo en GitHub antes de publicar"))
		}
		result = pr
	}
	return result, nil
}

func inspectGithubPullRequest(task Task) (githubPRPlan, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return inspectGithubPullRequestContext(ctx, task)
}

func inspectGithubPullRequestContext(ctx context.Context, task Task) (githubPRPlan, error) {
	plan := githubPRPlan{TaskID: task.ID, HeadBranch: task.Branch, Draft: true}
	if task.Status != "accepted" || !validGitHash(task.AcceptedTree) || task.Worktree == nil || !validGitHash(task.BaseCommit) {
		return plan, errors.New(uiText("primero revisá y aceptá la entrega en F7"))
	}
	var err error
	if plan.Tree, err = deliveryTree(ctx, task); err != nil {
		return plan, err
	}
	if plan.Tree != task.AcceptedTree {
		return plan, errors.New(uiText("la entrega cambió desde la aceptación; revisá y aceptá de nuevo"))
	}
	for _, dir := range []string{task.Repo, *task.Worktree} {
		if err = noGitOperation(ctx, dir); err != nil {
			return plan, err
		}
	}
	plan.SourceHead, err = dependencyGit(ctx, *task.Worktree, "rev-parse", "HEAD")
	if err != nil {
		return plan, err
	}
	headTree, err := dependencyGit(ctx, *task.Worktree, "rev-parse", "HEAD^{tree}")
	if err != nil {
		return plan, err
	}
	plan.Commit = headTree != plan.Tree
	plan.RemoteURL, err = dependencyGit(ctx, task.Repo, "remote", "get-url", "--push", "--all", "origin")
	if err != nil || strings.Contains(plan.RemoteURL, "\n") {
		return plan, errors.New(uiText("origin debe tener un único destino de push"))
	}
	plan.RepoName, err = githubPRRemote(plan.RemoteURL)
	if err != nil {
		return plan, err
	}
	fetchURL, err := dependencyGit(ctx, task.Repo, "remote", "get-url", "origin")
	fetchName, remoteErr := githubPRRemote(fetchURL)
	if err != nil || remoteErr != nil || !strings.EqualFold(fetchName, plan.RepoName) {
		return plan, errors.New(uiText("los destinos de lectura y push de origin deben ser el mismo repositorio GitHub"))
	}
	var repo struct {
		Name   string `json:"nameWithOwner"`
		Branch struct {
			Name string `json:"name"`
		} `json:"defaultBranchRef"`
	}
	if err = ghJSON(ctx, task.Repo, &repo, "repo", "view", plan.RepoName, "--json", "nameWithOwner,defaultBranchRef"); err != nil {
		return plan, err
	}
	if !strings.EqualFold(repo.Name, plan.RepoName) || !validPRBranch(repo.Branch.Name) || repo.Branch.Name == task.Branch {
		return plan, errors.New(uiText("GitHub no devolvió una rama base válida y distinta de la entrega"))
	}
	plan.RepoName, plan.BaseBranch = repo.Name, repo.Branch.Name
	plan.BaseHead, err = githubPRRef(ctx, task, plan.RepoName, plan.BaseBranch)
	if err != nil || !validGitHash(plan.BaseHead) {
		return plan, errors.New(uiText("no se pudo verificar la rama base de GitHub"))
	}
	mergeBase, err := dependencyGit(ctx, *task.Worktree, "merge-base", plan.BaseHead, plan.SourceHead)
	if err != nil {
		return plan, errors.New(uiText("falta el historial de la base remota; ejecutá git fetch origin y revisá de nuevo"))
	}
	if mergeBase != task.BaseCommit {
		return plan, errors.New(uiText("el PR incluiría cambios fuera de la base revisada; revisá o actualizá esta tarea antes de publicar"))
	}
	metadata, err := dependencyGit(ctx, *task.Worktree, "diff", "--name-only", mergeBase, plan.Tree, "--", ".fluke", ".fluke-task.md", ".fluke-worker-contract.md", ".fluke-worker")
	if err != nil || metadata != "" {
		return plan, errors.New(uiText("la entrega incluye archivos internos de Fluke; retiralos del commit antes de publicar"))
	}
	var truncated bool
	plan.Summary, truncated, err = reviewGit(ctx, *task.Worktree, 8192, "diff", "--stat", "--no-ext-diff", "--no-textconv", mergeBase, plan.Tree)
	if err != nil || truncated || strings.TrimSpace(plan.Summary) == "" {
		return plan, errors.New(uiText("no hay una entrega acotada de producto para publicar; revisá F7"))
	}
	plan.RemoteHead, err = githubPRRef(ctx, task, plan.RepoName, plan.HeadBranch)
	if err != nil {
		return plan, err
	}
	if plan.RemoteHead != "" && plan.RemoteHead != plan.SourceHead {
		if _, err = dependencyGit(ctx, *task.Worktree, "merge-base", "--is-ancestor", plan.RemoteHead, plan.SourceHead); err != nil {
			return plan, errors.New(uiText("la rama remota tiene cambios ajenos a esta entrega; no se sobrescribe"))
		}
	}
	plan.Title = strings.Join(strings.Fields(ansi.Strip(task.Title)), " ")
	if plan.Title == "" || len(plan.Title) > 512 || strings.Contains(plan.Title, task.Repo) || strings.Contains(plan.Title, *task.Worktree) {
		plan.Title = "Entrega revisada en Fluke"
	}
	for _, word := range strings.Fields(plan.Title) {
		word = strings.Trim(word, "`\"'(<>")
		if strings.HasPrefix(word, "/") || len(word) > 2 && word[1] == ':' && (word[2] == '\\' || word[2] == '/') {
			plan.Title = "Entrega revisada en Fluke"
			break
		}
	}
	plan.Body = "Implementa la entrega revisada y aceptada en Fluke.\n\nCambios:\n\n```text\n" + ansi.Strip(strings.TrimSpace(plan.Summary)) + "\n```\n\nValidación: revisión humana de los cambios."
	if !validPRText(plan.Title, plan.Body) {
		return plan, errors.New(uiText("título o descripción del PR inválidos"))
	}
	existing, err := githubPRExisting(ctx, task, plan)
	if err != nil {
		return plan, err
	}
	if existing != nil {
		plan.Number, plan.URL, plan.Draft = existing.Number, existing.URL, existing.Draft
		var details githubPR
		if err = ghJSON(ctx, task.Repo, &details, "pr", "view", plan.URL, "--repo", plan.RepoName, "--json", "number,url,state,isDraft,headRefName,headRefOid,baseRefName,isCrossRepository,title,body"); err != nil {
			return plan, err
		}
		if details.Number != plan.Number || details.URL != plan.URL || details.Head != plan.RemoteHead || details.HeadBranch != plan.HeadBranch || details.BaseBranch != plan.BaseBranch || details.IsCrossRepository || details.State != "OPEN" {
			return plan, errors.New(uiText("el PR existente cambió durante la consulta; revisá de nuevo"))
		}
		body := details.Body
		if strings.TrimSpace(body) == "" {
			body = plan.Body
		}
		if !validPRText(details.Title, body) {
			return plan, errors.New(uiText("el título o la descripción existentes exceden el editor de Fluke; revisalos directamente en GitHub"))
		}
		plan.Title, plan.Body = details.Title, body
		plan.ContentHash = fmt.Sprintf("%x", sha256.Sum256([]byte(details.Title+"\x00"+details.Body)))
	}
	plan.Pushed = !plan.Commit && plan.RemoteHead == plan.SourceHead
	plan.Complete = plan.Pushed && plan.URL != "" && plan.ContentHash == fmt.Sprintf("%x", sha256.Sum256([]byte(plan.Title+"\x00"+plan.Body)))
	return plan, nil
}

// Shared with local integration: configured commit hooks run, then the accepted tree is checked again.
func commitAcceptedDelivery(task Task) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if task.Status != "accepted" || !validGitHash(task.AcceptedTree) || task.Worktree == nil || !validGitHash(task.BaseCommit) {
		return "", errors.New(uiText("la entrega no tiene una aceptación válida"))
	}
	tree, err := deliveryTree(ctx, task)
	if err != nil || tree != task.AcceptedTree {
		return "", errors.New(uiText("la entrega cambió después de aceptarla; revisá y aceptá de nuevo"))
	}
	for _, dir := range []string{task.Repo, *task.Worktree} {
		if err = noGitOperation(ctx, dir); err != nil {
			return "", err
		}
	}
	head, err := dependencyGit(ctx, *task.Worktree, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	if _, err = dependencyGit(ctx, *task.Worktree, "merge-base", "--is-ancestor", task.BaseCommit, head); err != nil {
		return "", errors.New(uiText("el historial cambió desde la base revisada"))
	}
	metadata, err := dependencyGit(ctx, *task.Worktree, "diff", "--name-only", task.BaseCommit, tree, "--", ".fluke", ".fluke-task.md", ".fluke-worker-contract.md", ".fluke-worker")
	if err != nil || metadata != "" {
		return "", errors.New(uiText("la entrega incluye archivos internos de Fluke"))
	}
	headTree, err := dependencyGit(ctx, *task.Worktree, "rev-parse", "HEAD^{tree}")
	if err != nil {
		return "", err
	}
	if headTree != tree {
		if _, _, err = reviewGit(ctx, *task.Worktree, 4096, append([]string{"add", "-A"}, deliveryPaths...)...); err != nil {
			return "", err
		}
		staged, e := dependencyGit(ctx, *task.Worktree, "write-tree")
		if e != nil || staged != task.AcceptedTree {
			return "", errors.New(uiText("el índice incluye cambios fuera de la entrega aceptada; revisá los archivos preparados antes de crear el commit"))
		}
		if _, _, err = reviewGit(ctx, *task.Worktree, 4096, "commit", "-m", "Fluke: "+strings.Join(strings.Fields(task.Title), " ")); err != nil {
			return "", fmt.Errorf(uiText("no se pudo crear el commit; sus archivos se conservan: %w"), err)
		}
	}
	tree, err = deliveryTree(ctx, task)
	if err != nil || tree != task.AcceptedTree {
		return "", errors.New(uiText("la entrega cambió durante el commit, posiblemente por un hook; revisá y aceptá de nuevo"))
	}
	actual, err := dependencyGit(ctx, *task.Worktree, "rev-parse", "HEAD^{tree}")
	if err != nil || actual != tree {
		return "", errors.New(uiText("el commit no contiene exactamente la entrega aceptada"))
	}
	return dependencyGit(ctx, *task.Worktree, "rev-parse", "HEAD")
}

func sameGithubPRSnapshot(a, b githubPRPlan) bool {
	return a.TaskID == b.TaskID && a.RepoName == b.RepoName && a.RemoteURL == b.RemoteURL && a.BaseBranch == b.BaseBranch && a.BaseHead == b.BaseHead && a.HeadBranch == b.HeadBranch && a.SourceHead == b.SourceHead && a.Tree == b.Tree && a.RemoteHead == b.RemoteHead && a.Commit == b.Commit && a.URL == b.URL && a.Number == b.Number && a.ContentHash == b.ContentHash && a.Draft == b.Draft
}

// Called only after the human confirms and the plan's Started intent is saved.
func publishGithubPullRequest(task Task, approved githubPRPlan) (githubPRPlan, error) {
	if !approved.Started || !validStoredGithubPRPlan(task, approved) {
		return approved, errors.New(uiText("falta guardar y confirmar la publicación del PR"))
	}
	current, err := inspectGithubPullRequest(task)
	if err != nil {
		return approved, err
	}
	if !sameGithubPRSnapshot(current, approved) {
		return approved, errors.New(uiText("la entrega, origin o GitHub cambiaron desde la vista previa; revisá y confirmá de nuevo"))
	}
	current.Title, current.Body, current.Started, current.Complete = approved.Title, approved.Body, true, false
	if current.Commit {
		commitTask := task
		commitTask.Title = approved.Title
		head, e := commitAcceptedDelivery(commitTask)
		err = e
		if err != nil {
			return current, err
		}
		current.SourceHead = head
		checked, e := inspectGithubPullRequest(task)
		expected := approved
		expected.SourceHead, expected.Commit = head, false
		if e != nil || !sameGithubPRSnapshot(checked, expected) {
			return current, errors.New(uiText("la entrega o GitHub cambiaron durante el commit; revisá de nuevo antes de publicar"))
		}
		current.Commit = false
	}
	if !current.Pushed {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		cmd := exec.CommandContext(ctx, "git", "-C", *task.Worktree, "-c", "credential.helper=", "-c", "credential.https://github.com.helper=!gh auth git-credential", "-c", "credential.interactive=false", "-c", "push.followTags=false", "push", "--porcelain", "--no-force", "--no-follow-tags", current.RemoteURL, current.SourceHead+":refs/heads/"+current.HeadBranch)
		for _, env := range os.Environ() {
			key, _, _ := strings.Cut(env, "=")
			if !strings.EqualFold(key, "GIT_TERMINAL_PROMPT") && !strings.EqualFold(key, "GH_HOST") && !strings.EqualFold(key, "GH_REPO") && !strings.EqualFold(key, "GCM_INTERACTIVE") {
				cmd.Env = append(cmd.Env, env)
			}
		}
		cmd.Env = append(cmd.Env, "GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=Never", "GH_HOST=github.com", "GH_PROMPT_DISABLED=1")
		cmd.WaitDelay = 2 * time.Second
		cmd.Stdout, cmd.Stderr = &reviewOutput{remaining: 4096}, &reviewOutput{remaining: 2048}
		err = cmd.Run()
		cancel()
		if err != nil {
			// An interrupted push may have succeeded: reconciliation is read-only and never retries a write.
			return current, errors.New(uiText("el push no quedó confirmado; consultá de nuevo el PR y su rama antes de reintentar. Los archivos se conservan"))
		}
	}
	verified, err := inspectGithubPullRequest(task)
	expected := current
	expected.RemoteHead = current.SourceHead
	if err != nil || !sameGithubPRSnapshot(verified, expected) {
		return current, errors.New(uiText("el push o la entrega no pudieron verificarse; consultá de nuevo GitHub antes de publicar"))
	}
	current.Pushed, current.RemoteHead = true, current.SourceHead
	if verified.URL != "" {
		current.URL, current.Number, current.Draft = verified.URL, verified.Number, verified.Draft
		if verified.Title == current.Title && verified.Body == current.Body {
			current.Complete = true
			return current, nil
		}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		cmd := ghCommand(ctx, task.Repo, "pr", "edit", current.URL, "--repo", current.RepoName, "--title", current.Title, "--body-file", "-")
		cmd.Stdin = strings.NewReader(current.Body)
		cmd.Stdout, cmd.Stderr = &reviewOutput{remaining: 4096}, &reviewOutput{remaining: 2048}
		cmd.WaitDelay = 2 * time.Second
		_ = cmd.Run() // The read below decides whether an ambiguous edit actually succeeded.
		cancel()
		return reconcileGithubPullRequest(task, current)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	cmd := ghCommand(ctx, task.Repo, "pr", "create", "--repo", current.RepoName, "--head", current.HeadBranch, "--base", current.BaseBranch, "--draft", "--title", current.Title, "--body-file", "-", "--no-maintainer-edit")
	cmd.Stdin = strings.NewReader(current.Body)
	cmd.Stdout, cmd.Stderr = &reviewOutput{remaining: 4096}, &reviewOutput{remaining: 2048}
	cmd.WaitDelay = 2 * time.Second
	err = cmd.Run()
	cancel()
	// A CLI timeout or lost response is resolved by the same exact branch lookup, never by a second create.
	recovered, verifyErr := reconcileGithubPullRequest(task, current)
	if verifyErr != nil || recovered.URL == "" || !recovered.Complete {
		if err != nil {
			return current, errors.New(uiText("GitHub no confirmó la creación; la rama puede estar publicada. Consultá el PR antes de reintentar"))
		}
		return current, errors.New(uiText("no se pudo verificar el PR creado; consultá GitHub antes de reintentar"))
	}
	return recovered, nil
}

func reconcileGithubPullRequest(task Task, saved githubPRPlan) (githubPRPlan, error) {
	if !validStoredGithubPRPlan(task, saved) {
		return saved, errors.New(uiText("la publicación guardada es inválida"))
	}
	current, err := inspectGithubPullRequest(task)
	if err != nil {
		return saved, err
	}
	if current.RepoName != saved.RepoName || current.RemoteURL != saved.RemoteURL || current.BaseBranch != saved.BaseBranch || current.Tree != saved.Tree || current.Commit || current.Draft != saved.Draft || saved.Number != 0 && current.Number != saved.Number {
		return saved, errors.New(uiText("la entrega o el destino cambiaron; la publicación necesita revisión manual"))
	}
	if current.RemoteHead != current.SourceHead {
		return saved, errors.New(uiText("la entrega aceptada todavía no está confirmada en la rama remota"))
	}
	if current.URL != "" && (current.Title != saved.Title || current.Body != saved.Body) {
		saved.SourceHead, saved.RemoteHead, saved.Pushed, saved.Complete = current.SourceHead, current.SourceHead, true, false
		saved.URL, saved.Number, saved.Draft, saved.Commit = current.URL, current.Number, current.Draft, false
		return saved, errors.New(uiText("la rama está publicada, pero el título o la descripción no quedaron confirmados; revisá el PR antes de reintentar"))
	}
	current.Title, current.Body, current.Started, current.Pushed = saved.Title, saved.Body, saved.Started, true
	current.Complete = current.URL != ""
	return current, nil
}
