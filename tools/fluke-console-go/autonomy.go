package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
)

// Apply only to the orchestrator's launch copy, never the workers' defaults.
func autonomousFlukeConfig(a AgentConfig, repo string) (AgentConfig, error) {
	if a.Provider != "claude" && a.Provider != "codex" {
		return a, fmt.Errorf("autonomous Fluke requires a supported provider: Codex or Claude")
	}
	args := []string{}
	settings := map[string]any{}
	for i := 0; i < len(a.Arguments); i++ {
		arg := a.Arguments[i]
		key, value, inline := strings.Cut(arg, "=")
		valued := a.Provider == "claude" && (key == "--permission-mode" || key == "--settings") || a.Provider == "codex" && (key == "--sandbox" || key == "-s" || key == "--ask-for-approval" || key == "-a")
		if valued {
			if !inline {
				i++
				if i >= len(a.Arguments) {
					return a, fmt.Errorf("missing value for %s", key)
				}
				value = a.Arguments[i]
			}
			if key == "--settings" {
				data := []byte(value)
				if !strings.HasPrefix(strings.TrimSpace(value), "{") {
					var err error
					if !filepath.IsAbs(value) {
						value = filepath.Join(repo, value)
					}
					data, err = os.ReadFile(value)
					if err != nil {
						return a, err
					}
				}
				var existing map[string]any
				if err := json.Unmarshal(data, &existing); err != nil {
					return a, fmt.Errorf("Claude settings: %w", err)
				}
				for k, v := range existing {
					settings[k] = v
				}
			}
			continue
		}
		if key == "--dangerously-skip-permissions" || key == "--allow-dangerously-skip-permissions" || key == "--dangerously-bypass-approvals-and-sandbox" || key == "--dangerously-bypass-hook-trust" || key == "--yolo" || key == "--full-auto" {
			continue
		}
		args = append(args, arg)
	}
	if a.Provider == "claude" {
		settings["skipDangerousModePermissionPrompt"] = true
		data, _ := json.Marshal(settings)
		args = append(args, "--dangerously-skip-permissions", "--settings", string(data))
	} else {
		args = append(args, "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "-c", "projects."+strconv.Quote(repo)+".trust_level=\"trusted\"")
	}
	a.Arguments = args
	return a, nil
}

type startupTrustResult struct {
	repo, runID string
	err         error
}

func startupTrustPrompt(provider, repo, screen string) bool {
	normalize := func(s string) string {
		return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(s), "\\", "/"))
	}
	want, found := normalize(repo), false
	lines := strings.Split(screen, "\n")
	for i := range lines {
		candidate := ""
		for j := i; j < len(lines) && len(candidate) <= len(want); j++ {
			candidate += normalize(lines[j])
			if candidate == want {
				found = true
				break
			}
		}
		if found {
			break
		}
	}
	if !found {
		return false
	}
	lower := strings.ToLower(screen)
	switch provider {
	case "claude":
		return strings.Contains(lower, "accessing workspace:") && strings.Contains(lower, "yes, i trust this folder")
	case "codex":
		return strings.Contains(lower, "trust this folder?") && strings.Contains(lower, "1. trust and continue")
	}
	return false
}

func (m *model) trustAutonomousStarts() tea.Cmd {
	var cmds []tea.Cmd
	for repo, s := range m.orchestration {
		if !s.AutonomousStartup || s.TrustSending {
			continue
		}
		w := m.terminalFor("fluke:" + repo)
		if w == nil || w.ProcessExited() {
			s.AutonomousStartup = false
			continue
		}
		title, screen := w.agentSignals()
		if s.ReportSeq > 0 || detectAgentState(s.Provider, title, screen) == "working" {
			s.AutonomousStartup = false
			continue
		}
		if s.TrustAttempts >= 3 {
			s.AutonomousStartup = false
			continue
		}
		if !startupTrustPrompt(s.Provider, repo, screen) || w.userInputPending.Load() {
			s.TrustSeenAt = time.Time{}
			continue
		}
		if s.TrustSeenAt.IsZero() {
			s.TrustSeenAt = time.Now()
			continue
		}
		if time.Since(s.TrustSeenAt) < time.Second {
			continue
		}
		s.TrustSending = true
		s.TrustAttempts++
		s.TrustSeenAt = time.Now()
		provider, runID := s.Provider, s.RunID
		cmds = append(cmds, func() tea.Msg {
			w.promptMu.Lock()
			defer w.promptMu.Unlock()
			_, screen := w.agentSignals()
			if !startupTrustPrompt(provider, repo, screen) {
				return startupTrustResult{repo, runID, errAutomaticDeferred}
			}
			// The user enabled autonomous access for this launch's exact repository.
			_, err := w.writer.Write([]byte(terminalEnter()))
			return startupTrustResult{repo, runID, err}
		})
	}
	return tea.Batch(cmds...)
}
