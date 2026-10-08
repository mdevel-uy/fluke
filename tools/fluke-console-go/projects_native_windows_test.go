package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/xpty"
	"github.com/hinshun/vt10x"
)

func TestNativeWindowsProjects(t *testing.T) {
	binary := os.Getenv("FLUKE_CONSOLE_TEST_BINARY")
	if binary == "" {
		t.Skip("set FLUKE_CONSOLE_TEST_BINARY to the native executable")
	}
	realPath := os.Getenv("PATH")
	fixture, fixtureFile := makeHarnessDiscoveryFixture(t, "codex")
	t.Setenv("PATH", fixture+string(os.PathListSeparator)+realPath)
	root := t.TempDir()
	existing := filepath.Join(root, "Existing Project")
	if err := os.Mkdir(existing, 0700); err != nil {
		t.Fatal(err)
	}
	dependencyTestGit(t, existing, "init", "--initial-branch=main")
	dependencyTestGit(t, existing, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "-c", "core.hooksPath="+os.DevNull, "commit", "--allow-empty", "-m", "seed")
	dir := filepath.Join(root, "state")
	store, state, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	state.Language = "en"
	state.Orchestrator = &AgentConfig{Provider: "codex", Executable: filepath.Join(fixture, "codex.exe"), Arguments: []string{}}
	state.Tasks = []Task{{ID: "t123", Repo: existing, Title: "Retained project task", Acceptance: "Keep existing work", Status: "pending", Branch: "codex/fluke/t123"}}
	state.Conversations = map[string][]ConversationMessage{existing: {{Role: "human", Text: "Retained conversation sentinel"}}}
	if err := store.save(state); err != nil {
		t.Fatal(err)
	}
	store.lock.Close()
	pty, err := xpty.NewPty(140, 40)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(binary, "--state-dir", dir, "--lang", "en")
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	if err := pty.Start(cmd); err != nil {
		pty.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = exec.Command("taskkill", "/PID", fmt.Sprint(cmd.Process.Pid), "/T", "/F").Run()
		_ = pty.Close()
	})
	done := make(chan error, 1)
	go func() {
		result, err := cmd.Process.Wait()
		if err == nil && !result.Success() {
			err = fmt.Errorf("console exit: %s", result)
		}
		done <- err
	}()
	screen := vt10x.New(vt10x.WithSize(140, 40))
	go func() {
		buf := make([]byte, 32768)
		tail := ""
		for {
			n, err := pty.Read(buf)
			if n > 0 {
				_, _ = screen.Write(buf[:n])
				queries := tail + string(buf[:n])
				for range strings.Count(queries, "\x1b[6n") {
					_, _ = pty.Write([]byte("\x1b[1;1R"))
				}
				tail = queries[max(0, len(queries)-3):]
			}
			if err != nil {
				return
			}
		}
	}()
	input := func(keys string) {
		t.Helper()
		if _, err := pty.Write([]byte(keys)); err != nil {
			t.Fatal(err)
		}
	}
	wait := func(marker string) {
		t.Helper()
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			if strings.Contains(screen.String(), marker) {
				return
			}
			select {
			case err := <-done:
				t.Fatalf("console exited: %v\n%s", err, screen.String())
			default:
			}
			time.Sleep(25 * time.Millisecond)
		}
		t.Fatalf("missing %q\n%s", marker, screen.String())
	}
	wait("YOUR PROJECTS")
	wait("GLOBAL OVERVIEW")
	captureNativeScreen(t, screen, "go-projects-global")
	input("n")
	wait("CREATE PROJECT")
	input("New Project\r")
	wait("DESTINATION FOLDER")
	created := filepath.Join(root, "New Project")
	input("\x15" + created)
	captureNativeScreen(t, screen, "go-projects-create")
	input("\r")
	wait("Project ready. Tell Fluke what you want to build.")
	if branch := dependencyTestGit(t, created, "symbolic-ref", "--short", "HEAD"); branch != "main" {
		t.Fatalf("branch = %q", branch)
	}
	if tree := dependencyTestGit(t, created, "ls-tree", "HEAD"); tree != "" {
		t.Fatalf("initial tree is not empty: %s", tree)
	}
	input("\x1b[18~")
	wait("NO TASK TO REVIEW")
	input(terminalEscape())
	wait("FLUKE FOLLOWS THE PROJECT")
	input("\x1bOP")
	wait("YOUR PROJECTS")
	input("o")
	wait("OPEN PROJECT")
	input("\x15" + existing + "\r")
	wait("Retained conversation")
	input("\x1bOP")
	wait("YOUR PROJECTS")
	input("\x1b[A\r")
	wait("MISSION / NEW PROJECT")
	input("\x1bOP")
	wait("YOUR PROJECTS")
	input("\x1b[B\r")
	wait("Retained project task")
	input("\x1bOP")
	wait("YOUR PROJECTS")
	captureNativeScreen(t, screen, "go-projects-multiple")
	input("c")
	wait("Retained conversation")
	data, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	var saved State
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if len(saved.Tasks) != 1 || saved.Tasks[0].Title != "Retained project task" || len(saved.Conversations[existing]) != 1 || saved.Conversations[existing][0].Text != "Retained conversation sentinel" {
		t.Fatal("project switching changed retained task or conversation")
	}
	var discovery harnessDiscoveryFixture
	data, err = os.ReadFile(fixtureFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &discovery); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(discovery.Executed); !os.IsNotExist(err) {
		t.Fatal("project navigation invoked provider inference")
	}
}
