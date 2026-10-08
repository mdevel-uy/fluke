package main

import (
	"context"
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

func TestNativeWindowsFirstRunEnglish(t *testing.T) {
	binary := os.Getenv("FLUKE_CONSOLE_TEST_BINARY")
	if binary == "" {
		t.Skip("build native executable and set FLUKE_CONSOLE_TEST_BINARY")
	}
	realPath := os.Getenv("PATH")
	fixtureDir, expectedExecutable, expectedModel := "", "", ""
	realHarness := os.Getenv("FLUKE_CONSOLE_TEST_REAL_HARNESS")
	var chosen discoveredHarness
	if realHarness == "" {
		fixtureDir, _ = makeHarnessDiscoveryFixture(t, "codex")
		expectedExecutable = filepath.Join(fixtureDir, "codex.exe")
		t.Setenv("PATH", fixtureDir+string(os.PathListSeparator)+realPath)
	} else {
		if realHarness != "codex" && realHarness != "claude" {
			t.Fatal("real harness must be codex or claude")
		}
		for _, h := range detectHarnesses() {
			if h.ID == realHarness {
				chosen = probeDiscoveredHarness(context.Background(), h)
				break
			}
		}
		if !chosen.Usable || !chosen.AuthKnown || !chosen.Authenticated {
			t.Fatalf("real harness is not ready: %s", chosen.Message)
		}
		expectedExecutable, expectedModel = chosen.Executable, chosen.RecommendedModel
		t.Logf("real installed %s %s; native input; no inference", chosen.Name, chosen.Version)
	}
	repo := filepath.Join(t.TempDir(), "First Run Project")
	if err := os.Mkdir(repo, 0700); err != nil {
		t.Fatal(err)
	}
	dependencyTestGit(t, repo, "init", "--initial-branch=main")
	dir := filepath.Join(t.TempDir(), "state")
	launch := func(arguments ...string) (func(string), func(string), vt10x.Terminal, <-chan error) {
		t.Helper()
		pty, err := xpty.NewPty(140, 40)
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(binary, arguments...)
		if os.Getenv("FLUKE_CONSOLE_TEST_LAUNCHER") == "1" {
			launcher, err := filepath.Abs("open-fluke.ps1")
			if err != nil {
				t.Fatal(err)
			}
			launchArgs := []string{"-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, "-Repo", repo, "-StateDir", dir, "-Here"}
			for i := 0; i < len(arguments); i++ {
				if arguments[i] == "--lang" && i+1 < len(arguments) {
					launchArgs = append(launchArgs, "-Language", arguments[i+1])
				}
				if arguments[i] == "--setup" {
					launchArgs = append(launchArgs, "-Setup")
				}
			}
			cmd = exec.Command("powershell.exe", launchArgs...)
		}
		cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
		if err = pty.Start(cmd); err != nil {
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
		return input, wait, screen, done
	}
	input, wait, screen, done := launch("--repo", repo, "--state-dir", dir, "--lang", "en", "--setup")
	wait("INITIAL SETUP")
	wait("START")
	// Motion must be visible on a real terminal before a full second elapses.
	before := screen.String()
	deadline := time.Now().Add(900 * time.Millisecond)
	for screen.String() == before && time.Now().Before(deadline) {
		time.Sleep(25 * time.Millisecond)
	}
	if screen.String() == before {
		t.Fatal("splash did not animate within one second")
	}
	if os.Getenv("FLUKE_CONSOLE_CAPTURE_MOTION") == "1" {
		for i := 0; i < 16; i++ {
			captureNativeScreen(t, screen, fmt.Sprintf("go-setup-motion-%02d", i))
			time.Sleep(45 * time.Millisecond)
		}
	}
	wait("local discovery complete")
	captureNativeScreen(t, screen, "go-setup-00")
	enter := "\r"
	if realHarness != "" {
		enter = "\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_"
	}
	input(enter)
	wait("YOUR HARNESSES")
	if realHarness != "" {
		wait("local discovery complete")
		for n := 0; !strings.Contains(screen.String(), "› "+chosen.Name) && n < 24; n++ {
			input("j")
			time.Sleep(75 * time.Millisecond)
		}
		wait("› " + chosen.Name)
	}
	wait("ready · signed in")
	captureNativeScreen(t, screen, "go-setup-01")
	input(enter)
	wait("THE ORCHESTRATOR")
	captureNativeScreen(t, screen, "go-setup-02")
	input(enter)
	wait("03 / GITHUB")
	captureNativeScreen(t, screen, "go-setup-03")
	input("\t\r")
	wait("YOUR PROJECT")
	input("\r")
	wait("YOUR CREW")
	input("\x152\r")
	wait("WORKSPACE READY")
	captureNativeScreen(t, screen, "go-setup-06")
	input("\r")
	wait("FLUKE / OVERVIEW")
	wait("SESSIONS")
	input("\x11")
	wait("Quit Fluke")
	input("y")
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("console did not quit cleanly")
	}
	store, saved, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	store.lock.Close()
	expectedProvider := "codex"
	if realHarness != "" {
		expectedProvider = realHarness
	}
	if saved.Language != "en" || saved.Setup == nil || !saved.Setup.Complete || saved.MaxWorkers != 2 || saved.Orchestrator == nil || saved.Orchestrator.Provider != expectedProvider || saved.Orchestrator.Executable != expectedExecutable || saved.Orchestrator.Model != expectedModel || len(saved.Projects) != 1 || !strings.EqualFold(filepath.Clean(saved.Projects[0]), filepath.Clean(repo)) {
		t.Fatalf("first-run choices not persisted: %+v", saved)
	}
	input, wait, screen, done = launch("--repo", repo, "--state-dir", dir)
	wait("FLUKE / OVERVIEW")
	if strings.Contains(screen.String(), "INITIAL SETUP") {
		t.Fatal("completed setup reopened")
	}
	input("\x11")
	wait("Quit Fluke")
	input("y")
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("reopened console did not quit cleanly")
	}
	if fixtureDir != "" {
		if _, err := os.Stat(filepath.Join(fixtureDir, "unexpected-execution")); !os.IsNotExist(err) {
			t.Fatal("setup performed inference or an unexpected harness command")
		}
	}
}
