package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

type githubIssue struct {
	Number int    `json:"number"`
	Title  string `json:"title"`
	Body   string `json:"body"`
	URL    string `json:"url"`
}
type githubSnapshot struct {
	Name    string `json:"nameWithOwner"`
	URL     string `json:"url"`
	Issues  []githubIssue
	Loading bool
	Error   string
}
type githubResult struct {
	Repo       string
	Snapshot   githubSnapshot
	Issue      *githubIssue
	Acceptance string
}

func githubRemote(remote string) (string, error) {
	if strings.HasPrefix(remote, "git@github.com:") {
		remote = "https://github.com/" + strings.TrimPrefix(remote, "git@github.com:")
	}
	u, err := url.Parse(remote)
	if err != nil || u.Hostname() != "github.com" || (u.Scheme != "https" && u.Scheme != "ssh") || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New(uiText("origin debe apuntar a un repositorio de github.com (HTTPS o SSH)"))
	}
	parts := strings.Split(strings.Trim(strings.TrimSuffix(u.Path, ".git"), "/"), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", errors.New(uiText("origin no identifica owner/repositorio"))
	}
	for _, part := range parts {
		for _, c := range part {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.') {
				return "", errors.New(uiText("nombre de repositorio GitHub inválido"))
			}
		}
		if part == "." || part == ".." {
			return "", errors.New(uiText("nombre de repositorio GitHub inválido"))
		}
	}
	return strings.Join(parts, "/"), nil
}

func ghCommand(ctx context.Context, repo string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "gh", args...)
	cmd.Dir = repo
	for _, env := range os.Environ() {
		key, _, _ := strings.Cut(env, "=")
		if !strings.EqualFold(key, "GH_REPO") && !strings.EqualFold(key, "GH_HOST") && !strings.EqualFold(key, "GH_PROMPT_DISABLED") {
			cmd.Env = append(cmd.Env, env)
		}
	}
	cmd.Env = append(cmd.Env, "GH_PROMPT_DISABLED=1", "GH_HOST=github.com")
	return cmd
}
func ghJSON(ctx context.Context, repo string, result any, args ...string) error {
	cmd := ghCommand(ctx, repo, args...)
	output, err := cmd.Output()
	if ctx.Err() != nil {
		return errors.New(uiText("GitHub no respondió a tiempo; presioná r para reintentar"))
	}
	if err != nil {
		// Do not print raw CLI stderr: it can contain remote credentials or configuration.
		return errors.New(uiText("no se pudo consultar GitHub; revisá gh auth login y el acceso al origin"))
	}
	if err := json.Unmarshal(output, result); err != nil {
		return errors.New(uiText("respuesta de GitHub inválida"))
	}
	return nil
}

func readGithub(repo string, number int, acceptance string) githubResult {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return readGithubContext(ctx, repo, number, acceptance)
}
func readGithubContext(ctx context.Context, repo string, number int, acceptance string) githubResult {
	r := githubResult{Repo: repo, Acceptance: acceptance}
	fail := func(err error) githubResult { r.Snapshot.Error = err.Error(); return r }
	if _, err := exec.LookPath("gh"); err != nil {
		return fail(errors.New(uiText("instalá GitHub CLI (gh) y ejecutá gh auth login")))
	}
	remote, err := git(repo, "remote", "get-url", "origin")
	if err != nil {
		return fail(errors.New(uiText("este repo no tiene un origin accesible; configurá git remote add origin URL")))
	}
	name, err := githubRemote(remote)
	if err != nil {
		return fail(err)
	}
	if err = ghJSON(ctx, repo, &r.Snapshot, "repo", "view", name, "--json", "nameWithOwner,url"); err != nil {
		return fail(err)
	}
	if number > 0 {
		issue := githubIssue{}
		if err = ghJSON(ctx, repo, &issue, "issue", "view", strconv.Itoa(number), "--repo", name, "--json", "number,title,body,url"); err != nil {
			return fail(err)
		}
		issue.Title, issue.Body = ansi.Strip(issue.Title), ansi.Strip(issue.Body)
		r.Issue = &issue
	} else {
		if err = ghJSON(ctx, repo, &r.Snapshot.Issues, "issue", "list", "--repo", name, "--state", "open", "--limit", "50", "--json", "number,title,body,url"); err != nil {
			return fail(err)
		}
		for i := range r.Snapshot.Issues {
			r.Snapshot.Issues[i].Title = ansi.Strip(r.Snapshot.Issues[i].Title)
			r.Snapshot.Issues[i].Body = ansi.Strip(r.Snapshot.Issues[i].Body)
		}
	}
	return r
}

func (m *model) queryGithub(number int, acceptance string) tea.Cmd {
	if m.github[m.repo].Loading {
		m.notice = uiText("Consulta GitHub en curso.")
		return nil
	}
	repo := m.repo
	s := m.github[repo]
	s.Loading = true
	s.Error = ""
	m.github[repo] = s
	m.notice = uiText("Consultando GitHub…")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	m.githubCancel[repo] = cancel
	return func() tea.Msg { defer cancel(); return readGithubContext(ctx, repo, number, acceptance) }
}

func (m *model) receiveGithub(r githubResult) {
	delete(m.githubCancel, r.Repo)
	old := m.github[r.Repo]
	if r.Snapshot.Error != "" {
		old.Loading, old.Error = false, r.Snapshot.Error
		m.github[r.Repo] = old
		m.notice = r.Snapshot.Error
		return
	}
	if r.Issue == nil {
		m.github[r.Repo] = r.Snapshot
		m.notice = fmt.Sprintf(uiText("GitHub: %s · %d issues abiertas (máximo 50)."), r.Snapshot.Name, len(r.Snapshot.Issues))
		return
	}
	old.Loading, old.Error = false, ""
	old.Name, old.URL = r.Snapshot.Name, r.Snapshot.URL
	m.github[r.Repo] = old
	for _, task := range m.state.Tasks {
		if task.Repo == r.Repo && task.IssueURL == r.Issue.URL {
			m.notice = uiText("Esta issue ya está vinculada a la tarea ") + task.ID
			return
		}
	}
	next := m.state
	next.Tasks = append([]Task{}, next.Tasks...)
	if err := next.addTask(r.Repo, fmt.Sprintf("#%d %s", r.Issue.Number, r.Issue.Title), r.Acceptance); err != nil {
		m.notice = err.Error()
		return
	}
	task := &next.Tasks[len(next.Tasks)-1]
	task.IssueURL, task.IssueBody = r.Issue.URL, r.Issue.Body
	m.saveEdit(next, uiText("Issue importada como tarea; revisá el alcance antes de iniciar su worker."))
}
