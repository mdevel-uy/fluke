package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNativeSessionBindingSurvivesRestartAndUsesChosenModel(t *testing.T) {
	repo := t.TempDir()
	run := strings.Repeat("a", 32)
	config := AgentConfig{Provider: "claude", Executable: "claude", Model: "initial"}
	fresh, session, err := prepareNativeConfig(config, nil, repo, run)
	if err != nil || session == nil || !validStoredNativeSession(*session) {
		t.Fatal(session, err)
	}
	if !strings.Contains(strings.Join(fresh.Arguments, " "), "--session-id "+session.ID) {
		t.Fatal("fresh Claude ID not assigned")
	}
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	_ = state.addTask(repo, "Task", "Acceptance")
	state.Tasks[0].NativeSession, state.Tasks[0].Status = session, "running"
	state = withOrchestratorSession(state, repo, session)
	if err = store.save(state); err != nil {
		t.Fatal(err)
	}
	_ = store.lock.Close()
	reopened, restored, err := openStore(store.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.lock.Close()
	if restored.Tasks[0].Status != "interrupted" || restored.Tasks[0].NativeSession.ID != session.ID || restored.OrchestratorSessions[repo].ID != session.ID {
		t.Fatal("durable binding lost")
	}
	config.Model = "chosen"
	resume, recovered, err := prepareNativeConfig(config, restored.Tasks[0].NativeSession, repo, strings.Repeat("b", 32))
	if err != nil || recovered.ID != session.ID || recovered.InitialRun != run {
		t.Fatal(recovered, err)
	}
	argv, err := resume.argv()
	if err != nil || !strings.Contains(strings.Join(argv, " "), "--model chosen") || !strings.Contains(strings.Join(argv, " "), "--resume "+session.ID) {
		t.Fatal("resume lost model or UUID", argv, err)
	}
	if session.Config.Model != "initial" {
		t.Fatal("resume mutated old config")
	}
}

func TestMissingCodexBindingDoesNotChooseAnotherSession(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	id, _ := newNativeSessionID()
	config := AgentConfig{Provider: "codex", Executable: "codex"}
	saved := &NativeSession{ID: id, InitialRun: strings.Repeat("c", 32), Config: config}
	_, session, err := prepareNativeConfig(config, saved, t.TempDir(), strings.Repeat("d", 32))
	if err == nil || session != nil || !strings.Contains(err.Error(), ":fresh") {
		t.Fatal("missing exact session silently replaced", err)
	}
	if _, err = os.Stat(filepath.Join(home, "sessions")); !os.IsNotExist(err) {
		t.Fatal("recovery created another session")
	}
}

func TestSessionMapEditsDoNotChangeOtherProjects(t *testing.T) {
	repo, other := t.TempDir(), t.TempDir()
	id, _ := newNativeSessionID()
	session := NativeSession{ID: id, InitialRun: strings.Repeat("e", 32), Config: AgentConfig{Provider: "claude", Executable: "claude"}}
	state := State{OrchestratorSessions: map[string]NativeSession{repo: session, other: session}}
	next := withOrchestratorSession(state, repo, nil)
	if len(state.OrchestratorSessions) != 2 || len(next.OrchestratorSessions) != 1 || next.OrchestratorSessions[other].ID != id {
		t.Fatal("session reset altered another project")
	}
}
