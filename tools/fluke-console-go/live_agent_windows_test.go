package main

import (
	tea "charm.land/bubbletea/v2"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Opt-in: uses the installed CLI, its existing login and real model usage.
// Runs inside a temporary repo/worktree, through Fluke's actual PTY runtime.
func TestLiveAgentContract(t *testing.T) {
	provider := os.Getenv("FLUKE_LIVE_PROVIDER")
	if provider == "" {
		t.Skip("set FLUKE_LIVE_PROVIDER=codex or claude to use a real agent")
	}
	if provider != "codex" && provider != "claude" {
		t.Fatal("unsupported live provider")
	}
	repo := testRepo(t)
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	state.Projects = []string{repo}
	args := []string{}
	if provider == "codex" {
		args = []string{"--no-daemon", "--no-alt-screen", "--sandbox", "workspace-write", "--ask-for-approval", "never", "-c", "check_for_update_on_startup=false"}
	}
	if provider == "claude" {
		args = []string{"--permission-mode", "acceptEdits", "--no-chrome", "--allowedTools", "Bash,Read,Write,Edit"}
	}
	state.Orchestrator = &AgentConfig{Provider: provider, Executable: provider + ".cmd", Arguments: args}
	state.addTask(repo, "Validar decisión y entrega", "Primero preguntá al humano si prefiere formato compact o pretty para result.json; no elijas por tu cuenta ni implementes antes de la respuesta. Después escribí result.json con exactamente una propiedad format cuyo valor sea la elección recibida, y verificá leyendo/parsing el archivo. Sin dependencias, commits ni merge. Reportá la pregunta y la entrega según el contrato.")
	m := newModel(store, state, repo)
	defer m.cleanup()
	m.width, m.height = 140, 40
	m.terminals.width, m.terminals.height = 140, 30
	id := state.Tasks[0].ID
	launch := m.start(id)
	if launch == nil {
		t.Fatal(m.notice)
	}
	m.Update(launch())
	w := m.terminalFor(id)
	if w == nil {
		t.Fatal(m.notice)
	}
	var runCmd func(tea.Cmd)
	runCmd = func(cmd tea.Cmd) {
		if cmd == nil {
			return
		}
		msg := cmd()
		if batch, ok := msg.(tea.BatchMsg); ok {
			for _, next := range batch {
				runCmd(next)
			}
		} else {
			m.Update(msg)
		}
	}
	states := map[string]bool{}
	trusted := false
	lastTrustAttempt := time.Time{}
	hooksSkipped := false
	wait := func(expected string) {
		t.Helper()
		deadline := time.Now().Add(180 * time.Second)
		started := time.Now()
		nextReport, nextLog := time.Time{}, time.Time{}
		for time.Now().Before(deadline) {
			readReport := time.Now().After(nextReport)
			m.observeWorkers(readReport)
			runCmd(m.continueAnsweredWorkers())
			if readReport {
				nextReport = time.Now().Add(time.Second)
			}
			current := m.state.Tasks[0]
			states[current.AgentState] = true
			if current.AgentState == expected {
				return
			}
			if time.Now().After(nextLog) {
				title, _ := w.agentSignals()
				t.Logf("%s: state=%s, report_seq=%d, title=%q", provider, current.AgentState, current.AgentSeq, cleanAgentText(title))
				nextLog = time.Now().Add(15 * time.Second)
			}
			text := w.screen.String()
			if !hooksSkipped && strings.Contains(text, "Hooks need review") && strings.Contains(text, "Continue without trusting") {
				_, _ = w.writer.Write([]byte(terminalEscape()))
				hooksSkipped = true
				t.Log("skipped unreviewed user hooks for this validation")
			}
			if time.Since(lastTrustAttempt) > time.Second && (strings.Contains(text, "Yes, I trust this folder") || strings.Contains(text, "Yes, trust") || (strings.Contains(text, "Trust this folder?") && strings.Contains(text, "1. Trust and continue"))) {
				_ = w.sendPrompt("")
				trusted = true
				lastTrustAttempt = time.Now()
				t.Log("accepted trust prompt for the generated temporary repository")
			}
			if current.AgentSeq == 0 && current.AgentState == "blocked" && trusted && time.Since(started) > 30*time.Second {
				t.Fatalf("startup still blocked: %s", text)
			}
			if w.ProcessExited() {
				t.Fatalf("agent exited before %s: %s", expected, text)
			}
			time.Sleep(100 * time.Millisecond)
		}
		t.Fatalf("no %s report after 180s; screen:\n%s", expected, w.screen.String())
	}
	wait("needs_response")
	if len(m.state.Decisions) != 1 || m.state.Decisions[0].TaskID != id {
		t.Fatal("question not correlated")
	}
	t.Logf("%s: question received: %s", provider, m.state.Decisions[0].Question)
	m.execute("answer 1 pretty")
	if m.state.Decisions[0].Answer == nil {
		t.Fatal(m.notice)
	}
	wait("ready")
	worktree := *m.state.Tasks[0].Worktree
	data, err := os.ReadFile(filepath.Join(worktree, "result.json"))
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]string
	if err := json.Unmarshal(data, &result); err != nil || len(result) != 1 || result["format"] != "pretty" {
		t.Fatal("acceptance failed", string(data), err)
	}
	if m.state.Tasks[0].Status != "awaiting_review" || m.liveWorkers() != 1 {
		t.Fatal("task accepted or slot freed prematurely")
	}
	t.Logf("%s: result verified, seq=%d; observed states=%v; summary=%s", provider, m.state.Tasks[0].AgentSeq, states, m.state.Tasks[0].AgentMessage)
	if os.Getenv("FLUKE_LIVE_RECOVERY") == "1" {
		original := m.state.Tasks[0]
		if original.NativeSession == nil || !validStoredNativeSession(*original.NativeSession) {
			report, reportErr := readWorkerReportForRecoveryTest(original)
			home, _ := codexSessionHome()
			verifyErr := verifyCodexNativeSession(home, report.NativeSessionID, worktree, original.AgentRun)
			t.Fatalf("native identity not captured: report_id=%q report_error=%v verification=%v", report.NativeSessionID, reportErr, verifyErr)
		}
		m.cleanup()
		_ = store.lock.Close()
		var restored State
		store, restored, err = openStore(store.dir)
		if err != nil {
			t.Fatal(err)
		}
		defer store.lock.Close()
		m = newModel(store, restored, repo)
		defer m.cleanup()
		m.width, m.height = 140, 40
		m.terminals.width, m.terminals.height = 140, 30
		launch = m.start(id)
		if launch == nil {
			t.Fatal(m.notice)
		}
		m.Update(launch())
		w = m.terminalFor(id)
		if w == nil {
			t.Fatal(m.notice)
		}
		trusted, hooksSkipped = false, false
		wait("ready")
		current := m.state.Tasks[0]
		if current.NativeSession == nil || current.NativeSession.ID != original.NativeSession.ID || current.NativeSession.InitialRun != original.NativeSession.InitialRun || current.AgentRun == original.AgentRun {
			t.Fatal("recovery changed the native identity or reused an old contract")
		}
		data, err = os.ReadFile(filepath.Join(worktree, "result.json"))
		result = map[string]string{}
		if err != nil || json.Unmarshal(data, &result) != nil || result["format"] != "pretty" {
			t.Fatal("recovery lost the validated result", err)
		}
		if len(m.state.Decisions) != 1 {
			t.Fatal("recovery repeated an answered question")
		}
		t.Logf("%s: console reopen resumed exact native UUID with a new contract; result and answered decision preserved", provider)
	}
	if os.Getenv("FLUKE_LIVE_REWORK") == "1" {
		beforeReview, runID := m.state.Tasks[0].AgentSeq, m.state.Tasks[0].AgentRun
		runCmd(m.requestTaskChanges(id, `En la revisión faltó un ejemplo verificable del mismo formato. Agregá review-example.json con exactamente una propiedad format=pretty, comprobá leyendo/parsing ese archivo y conservá result.json sin cambios. Es una corrección de esta entrega, sin commits ni merge.`))
		wait("ready")
		data, err = os.ReadFile(filepath.Join(worktree, "review-example.json"))
		result = map[string]string{}
		if err != nil || json.Unmarshal(data, &result) != nil || len(result) != 1 || result["format"] != "pretty" {
			t.Fatal("correction not verified", err, string(data))
		}
		current := m.state.Tasks[0]
		if current.AgentRun != runID || current.AgentSeq <= beforeReview || current.Status != "awaiting_review" {
			t.Fatal("correction didn't use same worker / fresh report")
		}
		reportData, err := os.ReadFile(workerSignalPath(worktree, id, runID, "state"))
		var report workerReport
		if err != nil || json.Unmarshal(reportData, &report) != nil || report.ReviewSeq != beforeReview {
			t.Fatal("missing explicit feedback acknowledgment", err)
		}
		t.Logf("%s: human correction verified in the same worker, seq=%d, review_feedback_seq=%d", provider, current.AgentSeq, report.ReviewSeq)
	}
	if os.Getenv("FLUKE_LIVE_MESSAGES") == "1" {
		before, runID := m.state.Tasks[0].AgentSeq, m.state.Tasks[0].AgentRun
		runCmd(m.amendDecision("1 compact"))
		wait("ready")
		data, err = os.ReadFile(filepath.Join(worktree, "result.json"))
		result = map[string]string{}
		if err != nil || json.Unmarshal(data, &result) != nil || len(result) != 1 || result["format"] != "compact" {
			t.Fatal("corrected answer not applied", err, string(data))
		}
		report, err := readWorkerReportForRecoveryTest(m.state.Tasks[0])
		if err != nil || report.HumanInstructionSeq != 2 || m.state.Tasks[0].AgentRun != runID || m.state.Tasks[0].AgentSeq <= before {
			t.Fatal("amended answer not acknowledged by same worker", report, err)
		}
		if len(m.state.Decisions) != 2 || *m.state.Decisions[0].Answer != "pretty" || m.state.Decisions[1].Supersedes != 1 {
			t.Fatal("original answer/history lost")
		}
		t.Logf("%s: corrected answer applied and independently verified; human_instruction_seq=%d", provider, report.HumanInstructionSeq)
		before = m.state.Tasks[0].AgentSeq
		runCmd(m.sendWorkerMessage(id, "Verificá otra vez que result.json contiene exactamente una propiedad format=compact. Conservá ese formato y el alcance; no agregues archivos, commits ni merge. Confirmá esta intervención usando human_instruction_seq en tu próximo reporte ready."))
		wait("ready")
		report, err = readWorkerReportForRecoveryTest(m.state.Tasks[0])
		if err != nil || report.HumanInstructionSeq != 3 || m.state.Tasks[0].AgentSeq <= before || m.state.Tasks[0].AgentRun != runID {
			t.Fatal("direct worker message not acknowledged", report, err)
		}
		contextData, _ := json.Marshal(m.orchestratorContext(repo))
		if !strings.Contains(string(contextData), "direct_instruction") {
			t.Fatal("orchestrator did not receive direct instruction")
		}
		t.Logf("%s: direct worker message applied in same native session; human_instruction_seq=%d", provider, report.HumanInstructionSeq)
	}
	m.stop(id)
	if m.state.Tasks[0].Status != "awaiting_review" || m.liveWorkers() != 0 {
		t.Fatal("closing worker lost result")
	}
}

func readWorkerReportForRecoveryTest(task Task) (workerReport, error) {
	data, err := os.ReadFile(workerSignalPath(*task.Worktree, task.ID, task.AgentRun, "state"))
	var report workerReport
	if err == nil {
		err = json.Unmarshal(data, &report)
	}
	return report, err
}
