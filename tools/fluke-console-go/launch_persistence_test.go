package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLaunchPersistenceChild(t *testing.T) {
	marker := os.Getenv("FLUKE_LAUNCH_TEST_MARKER")
	if marker == "" {
		t.Skip("child process fixture")
	}
	data, err := os.ReadFile(os.Getenv("FLUKE_LAUNCH_TEST_STATE"))
	var state State
	if err != nil || json.Unmarshal(data, &state) != nil || len(state.Tasks) != 1 {
		t.Fatal("state was not durable before child code", err)
	}
	task := state.Tasks[0]
	if task.Status != "running" || task.BaseCommit != strings.Repeat("a", 40) || task.AgentRun != strings.Repeat("b", 32) || task.NativeSession == nil || task.NativeSession.ID != "12345678-1234-4234-8234-123456789abc" {
		t.Fatal("child ran before its contract/session was saved")
	}
	if err := os.WriteFile(marker, []byte("durable"), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestLaunchStoresContractBeforeChildAndSaveFailureStopsStartup(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "durable", true: "save-failure"}[fail], func(t *testing.T) {
			store, state, err := openStore(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer store.lock.Close()
			repo := t.TempDir()
			state.addTask(repo, "Worker", "Resultado revisado")
			state.Tasks[0].BaseCommit, state.Tasks[0].Worktree = strings.Repeat("a", 40), &repo
			m := newModel(store, state, repo)
			defer m.cleanup()
			marker := filepath.Join(t.TempDir(), "started.txt")
			t.Setenv("FLUKE_LAUNCH_TEST_MARKER", marker)
			t.Setenv("FLUKE_LAUNCH_TEST_STATE", filepath.Join(store.dir, "state.json"))
			self, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			config := AgentConfig{Provider: "custom", Executable: self}
			native := &NativeSession{ID: "12345678-1234-4234-8234-123456789abc", InitialRun: strings.Repeat("b", 32), Config: AgentConfig{Provider: "claude", Executable: "claude"}}
			if fail {
				if err := os.Mkdir(filepath.Join(store.dir, "state.json"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			m.Update(launchResult{taskID: state.Tasks[0].ID, repo: repo, path: repo, name: "Worker", argv: []string{self, "-test.run=^TestLaunchPersistenceChild$"}, baseCommit: state.Tasks[0].BaseCommit, runID: strings.Repeat("b", 32), config: config, nativeSession: native})
			if fail {
				if len(m.terminals.Windows) != 0 || m.state.Tasks[0].AgentRun != "" || m.state.Tasks[0].Status != "pending" || !strings.Contains(m.notice, "No se pudo guardar") {
					t.Fatal("failed save started or changed worker", m.notice)
				}
				return
			}
			deadline := time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) {
				if data, err := os.ReadFile(marker); err == nil && string(data) == "durable" {
					return
				}
				time.Sleep(20 * time.Millisecond)
			}
			t.Fatal("child did not confirm its durable contract")
		})
	}
}
