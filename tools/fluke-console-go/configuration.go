package main

import (
	"context"
	"os/exec"
	"strings"

	tea "charm.land/bubbletea/v2"
)

type providerHealthResult struct {
	generation uint64
	health     providerHealth
}
type providerLoginResult struct{ err error }

func (m *model) loginProvider() tea.Cmd {
	a := AgentConfig{Provider: m.draft[0], Executable: strings.TrimSpace(m.draft[1]), Arguments: []string{"login"}}
	if a.Provider == "claude" {
		a.Arguments = []string{"auth", "login"}
	} else if a.Provider != "codex" {
		m.notice = uiText("La autenticación del proveedor custom se administra con su propia CLI.")
		return nil
	}
	argv, err := launchArgv(a, "")
	if err != nil {
		m.notice = uiText("No se pudo abrir el login: ") + err.Error()
		return nil
	}
	// Hand the real terminal to the provider's own login, then restore Fluke.
	// The provider stores credentials; Fluke never copies them into its state.
	return tea.ExecProcess(exec.Command(argv[0], argv[1:]...), func(err error) tea.Msg { return providerLoginResult{err} })
}

func (m *model) invalidateProvider() {
	m.providerGeneration++
	m.provider = providerHealth{}
	m.providerBusy = false
}

func (m *model) checkProvider() tea.Cmd {
	a := AgentConfig{Provider: m.draft[0], Executable: strings.TrimSpace(m.draft[1])}
	if !m.config {
		if m.state.Orchestrator == nil {
			return nil
		}
		a = *m.state.Orchestrator
	}
	m.providerGeneration++
	generation := m.providerGeneration
	m.providerBusy = true
	return func() tea.Msg { return providerHealthResult{generation, probeProvider(context.Background(), a)} }
}

func cycleChoice(choices []string, value string, backwards bool) string {
	if len(choices) == 0 {
		return value
	}
	i := -1
	for n, choice := range choices {
		if choice == value {
			i = n
			break
		}
	}
	if backwards {
		i = (i + len(choices) - 1) % len(choices)
	} else {
		i = (i + 1) % len(choices)
	}
	return choices[i]
}

func (m *model) cycleProvider(backwards bool) {
	m.draft[0] = cycleChoice([]string{"codex", "claude", "custom"}, m.draft[0], backwards)
	if m.draft[0] != "custom" {
		m.draft[1] = m.draft[0]
	}
	// Provider-specific flags and model IDs must not leak into another CLI.
	m.draft[2], m.draft[3] = "", "[]"
	m.modelChoices = providerModelChoices(m.draft[0])
}

func (m *model) cycleModel(backwards bool) {
	m.draft[2] = cycleChoice(m.modelChoices, m.draft[2], backwards)
}

// Ctrl+Enter is an explicit apply action: restart only the current repo's
// orchestrator with the selected config, keeping goal, transcript and workers.
func (m *model) applyConfig() tea.Cmd {
	if !m.home && m.preparing {
		m.notice = uiText("Esperá a que termine la preparación antes de aplicar el modelo.")
		return nil
	}
	// A queued chat can wait indefinitely for a native permission dialog.
	// Restarting cancels that queue through stop/failPendingChat; only an
	// actual in-flight write must finish before its terminal is replaced.
	if s := m.orchestration[m.repo]; !m.home && s != nil && (s.ChatWriting || s.Sending) {
		m.notice = uiText("Esperá a que termine el envío actual antes de reiniciar Fluke.")
		return nil
	}
	if err := m.saveConfig(); err != nil {
		m.notice = err.Error()
		return nil
	}
	if m.repo == "" || m.home {
		m.home, m.view, m.pane = true, 0, 0
		m.notice = localText("Defaults saved for new sessions. Open a project to apply them to its conversation.", "Predeterminados guardados para sesiones nuevas. Abrí un proyecto para aplicarlos a su conversación.")
		return m.checkProvider()
	}
	if m.sessionAlive("fluke:" + m.repo) {
		m.stop("fluke:" + m.repo)
		if m.sessionAlive("fluke:" + m.repo) {
			return nil
		}
	}
	m.view, m.pane = 1, 1
	m.home = false
	return tea.Batch(m.start(""), m.checkProvider())
}

func (m *model) effectiveConfigLabel() string {
	if s := m.orchestration[m.repo]; s != nil && m.sessionAlive("fluke:"+m.repo) {
		a := s.Config
		if a.Provider == "" {
			a.Provider = s.Provider
		}
		return configLabel(&a)
	}
	return configLabel(m.state.Orchestrator)
}
