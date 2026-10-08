package main

import (
	tea "charm.land/bubbletea/v2"
	"github.com/hinshun/vt10x"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLiveOrchestratorAndWorker(t *testing.T) {
	if os.Getenv("FLUKE_LIVE_ORCHESTRATOR") != "codex" {
		t.Skip("set FLUKE_LIVE_ORCHESTRATOR=codex for real orchestration")
	}
	repo := testRepo(t)
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	state.Language = "en"
	previousLanguage := uiLanguage()
	_ = setUILanguage("en")
	t.Cleanup(func() { _ = setUILanguage(previousLanguage) })
	state.Projects = []string{repo}
	state.MaxWorkers = 1
	a := AgentConfig{Provider: "codex", Executable: "codex.cmd", Arguments: []string{"--no-daemon", "--no-alt-screen", "--sandbox", "workspace-write", "--ask-for-approval", "never"}}
	state.Orchestrator = &a
	_ = state.setGoal(repo, "Entrega mínima autorizada", "Crear result.txt con exactamente FLUKE_ORCHESTRATED seguido de un salto de línea. Verificar su contenido. Sin commits, merge ni dependencias nuevas.")
	m := newModel(store, state, repo)
	m.chatDraft[repo] = "Organizá el objetivo acordado: creá una única tarea dentro de su alcance usando create_task y el goal_id actual. Su worker crea result.txt y verifica su contenido. Terminá el turno y esperá el aviso de Fluke. Cuando el contexto muestre awaiting_review, pedí revisión humana usando ask con question=Review delivery FLUKE_ORCHESTRATED. No implementes la tarea vos ni hagas merge."
	defer m.cleanup()
	m.width, m.height = 140, 40
	m.terminals.width, m.terminals.height = 140, 30
	launch := m.start("")
	if launch == nil {
		t.Fatal(m.notice)
	}
	result := launch().(launchResult)

	m.Update(result)
	notifiedReady := false
	readyObserved := false
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
		} else {
			if wake, ok := msg.(orchestratorWakeResult); ok && wake.Err == nil && len(m.state.Tasks) > 0 && m.state.Tasks[0].Status == "awaiting_review" {
				notifiedReady = true
			}
			m.Update(msg)
		}
	}
	trusted, hooks := map[string]bool{}, map[string]bool{}
	nextPoll, nextLog := time.Time{}, time.Time{}
	deadline := time.Now().Add(180 * time.Second)
	for time.Now().Before(deadline) {
		for _, w := range m.terminals.Windows {
			text := w.screen.String()
			if !hooks[w.ID] && strings.Contains(text, "Hooks need review") && strings.Contains(text, "Continue without trusting") {
				_, _ = w.writer.Write([]byte(terminalEscape()))
				hooks[w.ID] = true
			}
			if !trusted[w.ID] && (strings.Contains(text, "Yes, I trust this folder") || strings.Contains(text, "Yes, trust") || (strings.Contains(text, "Trust this folder?") && strings.Contains(text, "1. Trust and continue"))) {
				_ = w.sendPrompt("")
				trusted[w.ID] = true
			}
		}
		if time.Now().After(nextPoll) {
			m.observeWorkers(true)
			m.reconcile()
			m.pollOrchestrators()
			runCmd(m.drainQueue())
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
				phase = m.state.Tasks[0].Status
			}
			t.Logf("workers=%d task=%s seq=%d decisions=%d", m.liveWorkers(), phase, m.orchestration[repo].Seq, len(m.state.Decisions))
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
			if detectAgentState("codex", title, screen) != "idle" || !strings.Contains(strings.ToLower(message), "review") {
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
			if os.Getenv("FLUKE_CONSOLE_CAPTURE_DIR") != "" {
				captureLiveModel(t, m)
			}
			t.Log("Verified real orchestrator queue -> isolated worker -> ready -> automatic notification -> concise Fluke conversation acknowledges human review")
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	for _, w := range m.terminals.Windows {
		t.Log(w.ID, w.screen.String())
	}
	t.Fatal("orchestration timed out")
}

func captureLiveModel(t *testing.T, m *model) {
	t.Helper()
	for _, v := range []struct {
		view int
		name string
	}{{0, "go-live-global"}, {1, "go-live-proyecto"}} {
		m.view = v.view
		m.pane = 0
		if m.view == 0 {
			m.pane = 1
		}
		screen := vt10x.New(vt10x.WithSize(m.width, m.height))
		_, _ = screen.Write([]byte(strings.ReplaceAll(m.View().Content, "\n", "\r\n")))
		captureNativeScreen(t, screen, v.name)
	}
}
