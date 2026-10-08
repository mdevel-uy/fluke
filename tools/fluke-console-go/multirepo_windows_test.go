package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTwoReposShareCapacityAndKeepWorkerContext(t *testing.T) {
	repoA := testRepo(t)
	repoB := testRepo(t)
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	state.MaxWorkers = 1
	state.Orchestrator = &AgentConfig{Provider: "custom", Executable: "powershell.exe", Arguments: []string{"-NoLogo", "-NoProfile", "-Command", "Write-Output 'WORKER_READY'; Start-Sleep -Seconds 30"}}
	m := newModel(store, state, repoA)
	defer m.cleanup()
	m.execute("task A | acceptance A")
	a := m.state.Tasks[0].ID
	launch := m.start(a)
	if launch == nil {
		t.Fatal(m.notice)
	}
	m.Update(launch())
	m.execute("repo " + repoB)
	m.execute("task B | acceptance B")
	b := m.state.Tasks[1].ID
	if m.start(b) != nil || !strings.Contains(m.notice, "Límite") {
		t.Fatal("second repo bypassed limit", m.notice)
	}
	if m.state.Tasks[0].Repo != repoA || m.state.Tasks[1].Repo != repoB || m.projectTasks()[0].ID != b {
		t.Fatal("lost repo association")
	}
	firstWorktree := *m.state.Tasks[0].Worktree
	m.stop(a)
	if m.state.Tasks[0].Status != "interrupted" {
		t.Fatal("worker not interrupted")
	}
	launch = m.start(b)
	if launch == nil {
		t.Fatal(m.notice)
	}
	m.Update(launch())
	if m.state.Tasks[1].Status != "running" || m.liveWorkers() != 1 {
		t.Fatal("didn't reuse released slot", m.notice)
	}
	secondWorktree := *m.state.Tasks[1].Worktree
	if firstWorktree == secondWorktree {
		t.Fatal("shared checkout")
	}
	window := m.terminals.Windows[0]
	deadline := time.Now().Add(10 * time.Second)
	for !strings.Contains(window.screen.String(), "WORKER_READY") && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.Contains(window.screen.String(), "WORKER_READY") {
		t.Fatal("second worker produced no output")
	}
	m.cleanup()
	store.lock.Close()
	recovered, after, err := openStore(store.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.lock.Close()
	if len(after.Tasks) != 2 || after.Tasks[1].Status != "interrupted" || *after.Tasks[1].Worktree != secondWorktree {
		t.Fatal("recovery lost task or checkout")
	}
}

func TestQueuedWorkersKeepConversationAndNativeFocus(t *testing.T) {
	repo := testRepo(t)
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	state.Orchestrator = &AgentConfig{Provider: "custom", Executable: "powershell.exe", Arguments: []string{"-NoProfile", "-Command", "Start-Sleep -Seconds 30"}}
	for _, title := range []string{"First", "Second", "Third"} {
		_ = state.addTask(repo, title, "Verified")
	}
	state.MaxWorkers = 3
	m := newModel(store, state, repo)
	defer m.cleanup()
	m.view, m.pane = 0, 1
	m.chatDraft[repo] = "Una pregunta para Fluke"
	m.state.Tasks[0].Queued = true
	m.Update(m.drainQueue()())
	if m.view != 0 || m.pane != 1 || m.chatDraft[repo] != "Una pregunta para Fluke" || !m.sessionAlive(state.Tasks[0].ID) {
		t.Fatal("background worker stole conversation", m.notice)
	}
	m.view = 2
	m.terminals.Mode = terminalMode
	m.terminals.FocusWindow(0)
	first := m.terminals.Windows[0].ID
	m.state.Tasks[1].Queued = true
	m.Update(m.drainQueue()())
	if m.terminals.Windows[m.terminals.FocusedWindow].ID != first || m.terminals.Mode != terminalMode {
		t.Fatal("background worker stole native input")
	}
	m.Update(m.start(state.Tasks[2].ID)())
	if m.view != 2 || m.terminals.Windows[m.terminals.FocusedWindow].ID != m.sessions[state.Tasks[2].ID] {
		t.Fatal("explicit start didn't enter requested worker")
	}
}

func TestInitialRequestSurvivesLaunchSaveFailure(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	repo := t.TempDir()
	state.Orchestrator = &AgentConfig{Provider: "codex", Executable: "codex", Arguments: []string{}}
	m := newModel(store, state, repo)
	defer m.cleanup()
	m.chatDraft[repo] = "Este es el pedido inicial"
	if err = os.Mkdir(filepath.Join(store.dir, "state.json"), 0700); err != nil {
		t.Fatal(err)
	}
	m.Update(launchResult{repo: repo, path: repo, argv: []string{"powershell.exe", "-NoProfile", "-Command", "Start-Sleep -Seconds 60"}, runID: "run", provider: "codex", submittedDraft: m.chatDraft[repo], orchestrationDir: t.TempDir()})
	if m.chatDraft[repo] != "Este es el pedido inicial" || m.sessionAlive("fluke:"+repo) {
		t.Fatal("failed launch lost request or kept a session")
	}
	state.Orchestrator = &AgentConfig{Provider: "custom", Executable: "powershell.exe", Arguments: []string{}}
	m.state = state
	if m.start("") != nil || m.chatDraft[repo] == "" {
		t.Fatal("custom silently consumed unsupported conversation")
	}
}
