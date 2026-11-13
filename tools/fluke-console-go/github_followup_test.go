package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func init() {
	file := os.Getenv("FLUKE_FOLLOWUP_FIXTURE")
	if file == "" || strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe") != "gh" {
		return
	}
	if os.Getenv("GH_HOST") != "github.com" || os.Getenv("GH_REPO") != "" || !reflect.DeepEqual(os.Args[1:6], []string{"pr", "view", "7", "--repo", "example/demo"}) {
		os.Exit(40)
	}
	if os.Getenv("FLUKE_FOLLOWUP_FAIL") == "1" {
		os.Stderr.WriteString("secret credential")
		os.Exit(41)
	}
	if os.Getenv("FLUKE_FOLLOWUP_WAIT") == "1" {
		time.Sleep(time.Minute)
		os.Exit(42)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		os.Exit(43)
	}
	os.Stdout.Write(data)
	os.Exit(0)
}

func followupFixture(t *testing.T) (Task, githubPRFollowup, string) {
	t.Helper()
	task := acceptedDelivery(t, true)
	dependencyTestGit(t, task.Repo, "remote", "add", "origin", "https://github.com/example/demo.git")
	head := dependencyTestGit(t, *task.Worktree, "rev-parse", "HEAD")
	plan := githubPRPlan{TaskID: task.ID, RepoName: "example/demo", RemoteURL: "https://github.com/example/demo.git", BaseBranch: "main", BaseHead: task.BaseCommit, HeadBranch: task.Branch, SourceHead: head, RemoteHead: head, Tree: task.AcceptedTree, Title: "Delivery", Body: "Reviewed delivery", Pushed: true, Complete: true, Number: 7, URL: "https://github.com/example/demo/pull/7"}
	task.Publication = &plan
	snapshot := githubPRFollowup{githubPR: githubPR{Number: 7, URL: plan.URL, State: "OPEN", HeadBranch: task.Branch, Head: head, BaseBranch: "main"}, ReviewDecision: "REVIEW_REQUIRED", MergeState: "BLOCKED", Checks: []githubPRCheck{{Type: "CheckRun", Name: "test", Status: "COMPLETED", Conclusion: "SUCCESS"}}}
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
	file := filepath.Join(bin, "response.json")
	writeFollowupFixture(t, file, snapshot)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FLUKE_FOLLOWUP_FIXTURE", file)
	t.Setenv("GH_REPO", "wrong/repo")
	t.Setenv("GH_HOST", "wrong.invalid")
	return task, snapshot, file
}

func writeFollowupFixture(t *testing.T, file string, snapshot githubPRFollowup) {
	t.Helper()
	data, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestGithubPRFollowupReadAndRetain(t *testing.T) {
	task, _, file := followupFixture(t)
	r := readGithubPRFollowupContext(context.Background(), task)
	if r.Snapshot.Error != "" || r.Snapshot.CheckedAt.IsZero() || githubPRChecksSummary(r.Snapshot.Checks) != "passed" {
		t.Fatalf("read: %+v", r)
	}
	old := r.Snapshot
	t.Setenv("FLUKE_FOLLOWUP_FAIL", "1")
	r = readGithubPRFollowupContext(context.Background(), task)
	retained, ok := applyGithubPRFollowup(task, old, r)
	if !ok || retained.Error == "" || retained.CheckedAt != old.CheckedAt || retained.State != "OPEN" || strings.Contains(retained.Error, "secret") {
		t.Fatalf("cache: %+v", retained)
	}
	t.Setenv("FLUKE_FOLLOWUP_FAIL", "")
	if err := os.WriteFile(file, []byte(strings.Repeat("x", 131073)), 0600); err != nil {
		t.Fatal(err)
	}
	if r = readGithubPRFollowupContext(context.Background(), task); r.Snapshot.Error == "" {
		t.Fatal("accepted oversized response")
	}
}

func TestGithubPRFollowupAssociationsAndMerged(t *testing.T) {
	task, snapshot, file := followupFixture(t)
	snapshot.State = "MERGED"
	snapshot.MergeCommit = &struct {
		OID string `json:"oid"`
	}{task.BaseCommit}
	writeFollowupFixture(t, file, snapshot)
	r := readGithubPRFollowupContext(context.Background(), task)
	if r.Snapshot.Error != "" || task.Status != "accepted" {
		t.Fatalf("merged: %+v", r)
	}
	changed := task
	plan := *task.Publication
	plan.Number++
	changed.Publication = &plan
	if _, ok := applyGithubPRFollowup(changed, githubPRFollowup{}, r); ok {
		t.Fatal("accepted stale publication")
	}
	for _, mutate := range []func(*githubPRFollowup){func(s *githubPRFollowup) { s.URL = "https://github.com/evil/demo/pull/7" }, func(s *githubPRFollowup) { s.Head = strings.Repeat("a", 40) }, func(s *githubPRFollowup) { s.IsCrossRepository = true }, func(s *githubPRFollowup) { s.MergeCommit = nil }} {
		bad := snapshot
		mutate(&bad)
		writeFollowupFixture(t, file, bad)
		if r = readGithubPRFollowupContext(context.Background(), task); r.Snapshot.Error == "" {
			t.Fatal("accepted changed association/state")
		}
	}
	dependencyTestGit(t, task.Repo, "remote", "set-url", "origin", "https://github.com/evil/demo.git")
	if r = readGithubPRFollowupContext(context.Background(), task); r.Snapshot.Error == "" {
		t.Fatal("accepted changed origin")
	}
}

func TestGithubPRFollowupCancellation(t *testing.T) {
	task, _, _ := followupFixture(t)
	t.Setenv("FLUKE_FOLLOWUP_WAIT", "1")
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	start := time.Now()
	r := readGithubPRFollowupContext(ctx, task)
	if r.Snapshot.Error == "" || time.Since(start) > 4*time.Second {
		t.Fatalf("unbounded cancellation: %+v", r)
	}
}

func TestGithubPRFollowupEnglishError(t *testing.T) {
	previous := uiLanguage()
	t.Cleanup(func() { _ = setUILanguage(previous) })
	if err := setUILanguage("en"); err != nil {
		t.Fatal(err)
	}
	r := readGithubPRFollowupContext(context.Background(), Task{})
	if r.Snapshot.Error != "the task has no valid published PR" {
		t.Fatalf("untranslated error: %q", r.Snapshot.Error)
	}
}

func TestGithubPRFollowupTerminalMissingMergeState(t *testing.T) {
	task, snapshot, file := followupFixture(t)
	for _, state := range []string{"CLOSED", "MERGED"} {
		snapshot.State, snapshot.MergeState = state, ""
		if state == "MERGED" {
			snapshot.MergeCommit = &struct {
				OID string `json:"oid"`
			}{task.BaseCommit}
		}
		writeFollowupFixture(t, file, snapshot)
		r := readGithubPRFollowupContext(context.Background(), task)
		if r.Snapshot.Error != "" || r.Snapshot.MergeState != "UNKNOWN" {
			t.Fatalf("terminal: %+v", r.Snapshot)
		}
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		data = []byte(strings.Replace(string(data), `"mergeStateStatus":""`, `"mergeStateStatus":null`, 1))
		if err = os.WriteFile(file, data, 0600); err != nil {
			t.Fatal(err)
		}
		if r = readGithubPRFollowupContext(context.Background(), task); r.Snapshot.Error != "" || r.Snapshot.MergeState != "UNKNOWN" {
			t.Fatalf("null terminal: %+v", r.Snapshot)
		}
	}
	snapshot.State, snapshot.MergeCommit = "OPEN", nil
	writeFollowupFixture(t, file, snapshot)
	if r := readGithubPRFollowupContext(context.Background(), task); r.Snapshot.Error == "" {
		t.Fatal("accepted open PR without merge state")
	}
}

func TestGithubPRChecksSummary(t *testing.T) {
	for _, tt := range []struct {
		checks []githubPRCheck
		want   string
	}{
		{nil, "none"}, {[]githubPRCheck{{Type: "CheckRun", Status: "IN_PROGRESS"}}, "pending"}, {[]githubPRCheck{{Type: "StatusContext", State: "ERROR"}}, "failed"}, {[]githubPRCheck{{Type: "CheckRun", Status: "COMPLETED", Conclusion: "SKIPPED"}}, "passed"}, {[]githubPRCheck{{Type: "FutureCheck"}}, "unknown"}, {[]githubPRCheck{{Type: "StatusContext", State: "NEW_STATE"}}, "unknown"},
	} {
		if got := githubPRChecksSummary(tt.checks); got != tt.want {
			t.Fatalf("%+v: %s != %s", tt.checks, got, tt.want)
		}
	}
}
