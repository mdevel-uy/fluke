package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
)

// A whole task through Fluke with a real model: worktree, contract, an
// OpenCode worker behind the ACP front-end, the worker's own report, and the
// review data. It spends the quota of the model configured in OpenCode, so it
// only runs when FLUKE_LIVE_ACP_BIN points to a built fluke-console binary.
func TestLiveACPWorkerEndToEnd(t *testing.T) {
	bin := os.Getenv("FLUKE_LIVE_ACP_BIN")
	if bin == "" {
		t.Skip("set FLUKE_LIVE_ACP_BIN to a built fluke-console binary for a real OpenCode task")
	}
	previousSelf := selfExecutable
	selfExecutable = func() (string, error) { return bin, nil }
	t.Cleanup(func() { selfExecutable = previousSelf })

	repo := testRepo(t)
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	previousLanguage := uiLanguage()
	_ = setUILanguage("es")
	t.Cleanup(func() { _ = setUILanguage(previousLanguage) })
	state.Language = "es"
	state.Projects = []string{repo}
	state.Orchestrator = &AgentConfig{Provider: "codex", Executable: "codex", Arguments: []string{}}
	if err := state.setGoal(repo, "Documentar la prueba", "NOTAS.md existe con el título y la línea acordada."); err != nil {
		t.Fatal(err)
	}
	if err := state.addTask(repo, "Crear NOTAS.md", "NOTAS.md contiene en su primera línea exactamente '# Notas' y en la segunda 'Fluke y OpenCode por ACP'. Verificá su contenido leyendo el archivo."); err != nil {
		t.Fatal(err)
	}
	state.Tasks[0].WorkerConfig = &AgentConfig{Provider: "opencode", Executable: "opencode", Arguments: []string{}}
	taskID := state.Tasks[0].ID

	m := newModel(store, state, repo)
	defer m.cleanup()
	m.width, m.height = 140, 40
	m.terminals.width, m.terminals.height = 140, 30
	start := m.start(taskID)
	if start == nil {
		t.Fatal(m.notice)
	}
	m.Update(start().(launchResult))
	if m.terminalFor(taskID) == nil {
		t.Fatalf("no worker window; notice=%q", m.notice)
	}

	var runCmd func(tea.Cmd)
	runCmd = func(cmd tea.Cmd) {
		if cmd == nil {
			return
		}
		if batch, ok := cmd().(tea.BatchMsg); ok {
			for _, child := range batch {
				runCmd(child)
			}
		}
	}
	began := time.Now()
	deadline := began.Add(3 * time.Minute)
	nextLog := time.Time{}
	answered := 0
	for time.Now().Before(deadline) {
		m.observeWorkers(true)
		m.reconcile()
		runCmd(m.drainQueue())
		task := m.state.Tasks[0]
		if w := m.terminalFor(taskID); w != nil {
			title, screen := w.agentSignals()
			// The person's part: allow each request once, as pressing 1 in F3 would.
			if detectAgentState("opencode", title, screen) == "blocked" && strings.Contains(screen, "Permission requested") && answered < 12 {
				_, _ = w.writer.Write([]byte("1\r"))
				answered++
				time.Sleep(1500 * time.Millisecond)
			}
		}
		if time.Now().After(nextLog) {
			tail := ""
			if w := m.terminalFor(taskID); w != nil {
				_, screen := w.agentSignals()
				tail = tailLines(screen, 3)
			}
			t.Logf("t=%ds status=%s agent=%s permissions_answered=%d\n%s", int(time.Since(began).Seconds()), task.Status, task.AgentState, answered, tail)
			nextLog = time.Now().Add(15 * time.Second)
		}
		if task.Status == "awaiting_review" {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	task := m.state.Tasks[0]
	t.Logf("final: status=%s state=%s run=%s", task.Status, task.AgentState, task.AgentRun)
	t.Logf("report: %q", task.AgentMessage)
	t.Logf("evidence: %v", task.AgentEvidence)
	if w := m.terminalFor(taskID); w != nil {
		title, screen := w.agentSignals()
		t.Logf("title=%q\nscreen tail:\n%s", title, tailLines(screen, 18))
	}
	if task.Status != "awaiting_review" {
		t.Fatalf("the task never reached review: %s / %s", task.Status, task.AgentState)
	}

	data, err := os.ReadFile(filepath.Join(*task.Worktree, "NOTAS.md"))
	if err != nil {
		t.Fatal(err)
	}
	if lines := strings.Split(strings.TrimSpace(strings.ReplaceAll(string(data), "\r\n", "\n")), "\n"); len(lines) < 2 || lines[0] != "# Notas" || lines[1] != "Fluke y OpenCode por ACP" {
		t.Fatalf("NOTAS.md has the wrong content: %q", data)
	}
	if _, err := os.Stat(filepath.Join(repo, "NOTAS.md")); !os.IsNotExist(err) {
		t.Fatal("the worker touched the main checkout")
	}
	review, err := inspectTaskChanges(task)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(review.Diff+strings.Join(review.Untracked, "\n")+review.Status, "NOTAS.md") {
		t.Fatalf("review does not show the change: %+v", review)
	}
}

func tailLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n "), "\n")
	var kept []string
	for _, l := range lines {
		if strings.TrimSpace(l) != "" {
			kept = append(kept, l)
		}
	}
	if len(kept) > n {
		kept = kept[len(kept)-n:]
	}
	return strings.Join(kept, "\n")
}
