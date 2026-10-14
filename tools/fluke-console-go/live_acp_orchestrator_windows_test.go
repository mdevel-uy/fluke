package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
)

// The orchestrator itself on OpenCode: it reads its contract, creates the one
// task of the agreed goal, Fluke starts an OpenCode worker for it, and when the
// delivery is ready the orchestrator is woken and asks for human review. It
// spends the quota of the model configured in OpenCode (two agents), so it only
// runs with FLUKE_LIVE_ACP_BIN pointing at a built fluke-console binary.
func TestLiveACPOrchestratorEndToEnd(t *testing.T) {
	bin := os.Getenv("FLUKE_LIVE_ACP_BIN")
	if bin == "" {
		t.Skip("set FLUKE_LIVE_ACP_BIN to a built fluke-console binary for a real OpenCode orchestration")
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
	state.MaxWorkers = 1
	state.Orchestrator = &AgentConfig{Provider: "opencode", Executable: "opencode", Arguments: []string{}}
	if err := state.setGoal(repo, "Entrega mínima autorizada", "Crear result.txt con exactamente FLUKE_ORCHESTRATED seguido de un salto de línea. Verificar su contenido. Sin commits, merge ni dependencias nuevas."); err != nil {
		t.Fatal(err)
	}

	m := newModel(store, state, repo)
	defer m.cleanup()
	m.chatDraft[repo] = "Organizá el objetivo acordado: creá una única tarea dentro de su alcance usando create_task y el goal_id actual. Su worker crea result.txt y verifica su contenido. Terminá el turno y esperá el aviso de Fluke. Cuando el contexto muestre awaiting_review, pedí revisión humana usando ask con question=Review delivery FLUKE_ORCHESTRATED. No implementes la tarea vos ni hagas merge."
	m.width, m.height = 140, 40
	m.terminals.width, m.terminals.height = 140, 30
	launch := m.start("")
	if launch == nil {
		t.Fatal(m.notice)
	}
	result := launch().(launchResult)
	if result.err != nil {
		t.Fatal(result.err)
	}
	if !strings.Contains(strings.Join(result.argv, " "), "--channel="+result.orchestrationDir) {
		t.Fatalf("the orchestrator was not given its channel: %v", result.argv)
	}
	m.Update(result)

	notifiedReady, readyObserved := false, false
	var reportSeqBeforeReady uint64
	var runCmd func(tea.Cmd)
	runCmd = func(cmd tea.Cmd) {
		if cmd == nil {
			return
		}
		msg := cmd()
		if batch, ok := msg.(tea.BatchMsg); ok {
			for _, child := range batch {
				runCmd(child)
			}
			return
		}
		if wake, ok := msg.(orchestratorWakeResult); ok && wake.Err == nil && len(m.state.Tasks) > 0 && m.state.Tasks[0].Status == "awaiting_review" {
			notifiedReady = true
		}
		m.Update(msg)
	}

	began := time.Now()
	deadline := began.Add(6 * time.Minute)
	nextPoll, nextLog := time.Time{}, time.Time{}
	answered := map[string]int{}
	for time.Now().Before(deadline) {
		// The person's part: allow each request once, as pressing 1 in F3 would.
		for key, id := range m.sessions {
			w := m.terminalFor(key)
			if w == nil || id == "" {
				continue
			}
			title, screen := w.agentSignals()
			if detectAgentState("opencode", title, screen) == "blocked" && strings.Contains(screen, "Permission requested") && answered[key] < 25 {
				t.Logf("permission #%d for %s: %s", answered[key]+1, key, permissionRequestText(screen))
				_, _ = w.writer.Write([]byte("1\r"))
				answered[key]++
				time.Sleep(1200 * time.Millisecond)
			}
		}
		if time.Now().After(nextPoll) {
			m.observeWorkers(true)
			m.reconcile()
			m.pollOrchestrators()
			runCmd(m.drainQueue())
			runCmd(m.continueAnsweredWorkers())
			nextPoll = time.Now().Add(time.Second)
		}
		if !readyObserved && len(m.state.Tasks) > 0 && m.state.Tasks[0].Status == "awaiting_review" {
			readyObserved = true
			reportSeqBeforeReady = m.orchestration[repo].ReportSeq
		}
		runCmd(m.wakeOrchestrators())
		if m.liveWorkers() > 1 {
			t.Fatal("capacity exceeded")
		}
		if time.Now().After(nextLog) {
			phase := "planificación"
			if len(m.state.Tasks) > 0 {
				phase = m.state.Tasks[0].Status + "/" + m.state.Tasks[0].AgentState
			}
			total := 0
			for _, n := range answered {
				total += n
			}
			t.Logf("t=%ds phase=%s workers=%d seq=%d permissions=%d", int(time.Since(began).Seconds()), phase, m.liveWorkers(), m.orchestration[repo].Seq, total)
			nextLog = time.Now().Add(15 * time.Second)
		}
		if len(m.state.Tasks) > 0 && notifiedReady && m.orchestration[repo].ReportSeq > reportSeqBeforeReady && m.state.Tasks[0].Status == "awaiting_review" {
			ow := m.terminalFor("fluke:" + repo)
			title, screen := ow.agentSignals()
			message := ""
			for _, msg := range m.state.Conversations[repo] {
				if msg.Role == "fluke" {
					message = msg.Text
				}
			}
			if detectAgentState("opencode", title, screen) != "idle" || !strings.Contains(strings.ToLower(message), "review") && !strings.Contains(strings.ToLower(message), "revis") {
				time.Sleep(100 * time.Millisecond)
				continue
			}
			data, err := os.ReadFile(filepath.Join(*m.state.Tasks[0].Worktree, "result.txt"))
			if err != nil || string(data) != "FLUKE_ORCHESTRATED\n" {
				t.Fatal("acceptance failed", string(data), err)
			}
			if _, err = os.Stat(filepath.Join(repo, "result.txt")); !os.IsNotExist(err) {
				t.Fatal("orchestrator modified main checkout")
			}
			total := 0
			for _, n := range answered {
				total += n
			}
			t.Logf("Verified: OpenCode orchestrator -> task -> OpenCode worker -> ready -> notification -> human review requested in %ds with %d permission answers", int(time.Since(began).Seconds()), total)
			t.Logf("Fluke said: %q", message)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	for key := range m.sessions {
		if w := m.terminalFor(key); w != nil {
			_, screen := w.agentSignals()
			t.Logf("%s:\n%s", key, tailLines(screen, 20))
		}
	}
	task := "no task"
	if len(m.state.Tasks) > 0 {
		task = m.state.Tasks[0].Status + "/" + m.state.Tasks[0].AgentState
	}
	t.Fatalf("orchestration timed out; task=%s decisions=%d", task, len(m.state.Decisions))
}

// What the last permission request on a screen asks for, on one line.
func permissionRequestText(screen string) string {
	var lines []string
	for _, l := range strings.Split(screen, "\n") {
		if strings.TrimSpace(l) != "" {
			lines = append(lines, strings.TrimSpace(l))
		}
	}
	for i := len(lines) - 1; i >= 0; i-- {
		if !strings.Contains(lines[i], "Permission requested:") {
			continue
		}
		var parts []string
		for j := i; j < len(lines) && !strings.HasPrefix(lines[j], "1)"); j++ {
			parts = append(parts, lines[j])
		}
		text := strings.Join(parts, " ")
		if len(text) > 240 {
			text = text[:240] + "…"
		}
		return text
	}
	return ""
}
