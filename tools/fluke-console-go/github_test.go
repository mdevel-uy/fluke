package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The copied test binary behaves as gh, exercising real argv/process handling
// without credentials or network calls in the regular suite.
func init() {
	if os.Getenv("FLUKE_GH_FIXTURE") != "1" || !strings.HasPrefix(filepath.Base(os.Args[0]), "gh") {
		return
	}
	if os.Getenv("FLUKE_GH_FAIL") == "1" {
		fmt.Fprint(os.Stderr, "secret fixture credential")
		os.Exit(1)
	}
	args := os.Args[1:]
	if os.Getenv("GH_REPO") != "" || os.Getenv("GH_HOST") != "github.com" || os.Getenv("GH_PROMPT_DISABLED") != "1" {
		os.Exit(2)
	}
	for _, arg := range args {
		if strings.Contains(arg, "wrong") {
			os.Exit(3)
		}
	}
	issue := githubIssue{Number: 12, Title: "\x1b[31mExport JSON\x1b[0m", Body: "Export valid JSON", URL: "https://github.com/example/demo/issues/12"}
	if len(args) >= 2 && args[0] == "api" && args[1] == "user" {
		fmt.Fprint(os.Stdout, `{"login":"fixture-user"}`)
		os.Exit(0)
	}
	if len(args) >= 2 && args[0] == "auth" {
		if args[1] == "login" {
			token, _ := io.ReadAll(os.Stdin)
			if string(token) != "fixture-token\n" || strings.Contains(strings.Join(args, " "), "fixture-token") {
				os.Exit(4)
			}
		}
		os.Exit(0)
	}
	if len(args) >= 2 && args[0] == "repo" {
		json.NewEncoder(os.Stdout).Encode(githubSnapshot{Name: "example/demo", URL: "https://github.com/example/demo"})
	} else if len(args) >= 2 && args[1] == "list" {
		json.NewEncoder(os.Stdout).Encode([]githubIssue{issue})
	} else {
		json.NewEncoder(os.Stdout).Encode(issue)
	}
	os.Exit(0)
}

func TestGithubReadImportAndIsolation(t *testing.T) {
	for _, remote := range []string{"https://github.com/example/demo.git", "git@github.com:example/demo.git", "ssh://git@github.com/example/demo.git"} {
		name, err := githubRemote(remote)
		if err != nil || name != "example/demo" {
			t.Fatalf("%s: %s %v", remote, name, err)
		}
	}
	for _, remote := range []string{"https://gitlab.com/example/demo", "https://github.com/example/demo/issues", "https://github.com/../demo", "https://github.com/example/demo?token=secret"} {
		if _, err := githubRemote(remote); err == nil {
			t.Fatalf("accepted %s", remote)
		}
	}
	setupGithubFixture(t)
	var err error
	repo := t.TempDir()
	if _, err = git(repo, "init"); err != nil {
		t.Fatal(err)
	}
	if _, err = git(repo, "remote", "add", "origin", "git@github.com:example/demo.git"); err != nil {
		t.Fatal(err)
	}
	r := readGithub(repo, 0, "")
	if r.Snapshot.Error != "" || len(r.Snapshot.Issues) != 1 || r.Snapshot.Issues[0].Title != "Export JSON" {
		t.Fatalf("%+v", r)
	}
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	m := newModel(store, state, t.TempDir())
	defer m.cleanup()
	m.receiveGithub(r)
	if m.github[repo].Name != "example/demo" || m.github[m.repo].Name != "" {
		t.Fatal("GitHub result crossed projects")
	}
	r = readGithub(repo, 12, "Valid JSON and tested write errors")
	m.receiveGithub(r)
	if len(m.state.Tasks) != 1 || m.state.Tasks[0].Repo != repo || m.state.Tasks[0].IssueBody != "Export valid JSON" {
		t.Fatalf("%+v", m.state.Tasks)
	}
	m.receiveGithub(r)
	if len(m.state.Tasks) != 1 {
		t.Fatal("duplicate issue imported")
	}
	t.Setenv("FLUKE_GH_FAIL", "1")
	failed := readGithub(repo, 0, "")
	if failed.Snapshot.Error == "" || strings.Contains(failed.Snapshot.Error, "secret") {
		t.Fatal("CLI error leaked credentials")
	}
	m.receiveGithub(failed)
	if len(m.github[repo].Issues) != 1 || m.github[repo].Loading {
		t.Fatal("failed refresh lost last successful result")
	}
	r.Issue.URL += "-other"
	if err = os.Remove(filepath.Join(store.dir, "state.json")); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(filepath.Join(store.dir, "state.json"), 0700); err != nil {
		t.Fatal(err)
	}
	m.receiveGithub(r)
	if len(m.state.Tasks) != 1 || !strings.Contains(m.notice, "No se pudo guardar") {
		t.Fatal("failed import changed local state")
	}
}

func setupGithubFixture(t *testing.T) {
	t.Helper()
	bin := t.TempDir()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	name := "gh"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if err = os.WriteFile(filepath.Join(bin, name), data, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FLUKE_GH_FIXTURE", "1")
	t.Setenv("GH_REPO", "wrong/repo")
	t.Setenv("GH_HOST", "wrong.invalid")
}

func TestGithubLiveRead(t *testing.T) {
	repo := os.Getenv("FLUKE_GITHUB_LIVE_REPO")
	if repo == "" {
		t.Skip("optional read-only integration with an authenticated gh session")
	}
	r := readGithub(repo, 0, "")
	if r.Snapshot.Error != "" || r.Snapshot.Name == "" {
		t.Fatalf("GitHub: %+v", r.Snapshot)
	}
	t.Logf("Connected %s; %d open issues", r.Snapshot.Name, len(r.Snapshot.Issues))
}
