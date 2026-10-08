package main

import (
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
)

// Navigation belongs to the app, including while editing configuration or
// looking at an issue. Modal editors must never swallow these shortcuts.
func (m *model) globalKey(key string) (bool, tea.Cmd) {
	if strings.HasPrefix(key, "alt+") && len(key) == 5 && key[4] >= '1' && key[4] <= '7' {
		key = "f" + key[4:]
	}
	if m.home && !m.config && !m.githubOpen && !m.review.open && !m.projects.open && m.view == 0 && m.pane == 0 && len(m.state.Projects) > 0 && (key == "f2" || key == "f3" || key == "f4" || key == "f6" || key == "f7") {
		m.repo = m.state.Projects[m.selected%len(m.state.Projects)]
		m.selected, m.chatScroll = 0, 0
	}
	switch key {
	case "f1", "f2", "f3", "f4":
		m.closePanels()
		m.view = int(key[1] - '1')
		m.home = m.view == 0
		if m.view == 1 && m.repo == "" {
			m.home, m.view = true, 0
			m.notice = localText("Create or open a project first: N / O.", "Primero creá o abrí un proyecto: N / O.")
		}
		m.selected = 0
		m.pane = 0
		if m.view == 0 {
			for i, repo := range m.state.Projects {
				if repo == m.repo {
					m.selected = i
				}
			}
		}
		if m.view == 3 {
			local := 0
			for _, decision := range m.state.Decisions {
				if decision.Repo != m.repo {
					continue
				}
				if decision.Answer == nil {
					m.selected = local
					break
				}
				local++
			}
		}
		if m.view == 2 && m.sessionAlive("fluke:"+m.repo) {
			m.focus("fluke:" + m.repo)
		}
		return true, nil
	case "f5":
		m.closePanels()
		m.openConfig()
		return true, m.checkProvider()
	case "ctrl+y":
		return true, m.copyFocused()
	case "ctrl+k":
		m.closePanels()
		line := ""
		m.command = &line
		return true, nil
	case "ctrl+x":
		m.closePanels()
		m.view = 2
		m.terminals.Mode = windowMode
		return true, nil
	case "f6":
		m.closePanels()
		if m.repo == "" {
			m.openConfig()
			m.configSection = 1
			return true, m.refreshGithubAuth()
		}
		m.githubOpen = true
		return true, m.queryGithub(0, "")
	case "f7":
		if m.review.open {
			return true, nil
		}
		task := Task{}
		if m.view == 3 {
			if index := m.selectedDecision(); index >= 0 {
				for _, candidate := range m.projectTasks() {
					if candidate.ID == m.state.Decisions[index].TaskID {
						task = candidate
						break
					}
				}
			}
		} else if m.view == 2 {
			for _, candidate := range m.state.Tasks {
				if w := m.terminalFor(candidate.ID); w != nil && len(m.terminals.Windows) > 0 && w == m.terminals.Windows[m.terminals.FocusedWindow] {
					task = candidate
					break
				}
			}
		} else if tasks := m.projectTasks(); len(tasks) > 0 {
			task = tasks[m.selected%len(tasks)]
		}
		if task.Repo != "" {
			m.repo = task.Repo
		}
		m.closePanels()
		return true, m.review.start(task)
	}
	return false, nil
}

func (m *model) closePanels() {
	if !m.projects.busy {
		m.projects.open = false
	}
	m.closeWorkerMessage()
	m.terminals.endMouse()
	m.config = false
	m.githubOpen = false
	m.command = nil
	m.review.open = false
	m.review.generation++
	m.review.integration, m.review.publication = nil, nil
	m.review.integrationLoading, m.review.publicationLoading, m.review.publicationEditing = false, false, 0
	m.authConfirm = false
	if m.auth.Busy {
		m.cancelGithubAuth()
	}
}

func (m *model) sessionSummary() (string, string) {
	w := m.terminalFor("fluke:" + m.repo)
	if w == nil {
		if m.preparing && !m.preparingWorker {
			return uiText("INICIANDO"), uiText("Preparando la conversación…")
		}
		return uiText("SIN SESIÓN"), uiText("Enter inicia Fluke · F5 configura el modelo")
	}
	if w.ProcessExited() {
		return uiText("DESCONECTADO"), uiText("La sesión terminó · Enter vuelve a iniciar")
	}
	s := m.orchestration[m.repo]
	if s == nil {
		return uiText("INICIANDO"), uiText("Esperando al proveedor…")
	}
	title, screen := w.agentSignals()
	switch detectAgentState(s.Provider, title, screen) {
	case "blocked":
		if limit := providerLimitMessage(s.Provider, screen); limit != "" {
			return uiText("NECESITA TU ATENCIÓN"), limit
		}
		return uiText("NECESITA TU ATENCIÓN"), uiText("F3 abre la autorización o pregunta de la CLI")
	case "working":
		if !s.ReplyStarted.IsZero() {
			return uiText("TRABAJANDO"), fmt.Sprintf(localText("Waiting for %s's reply · %ds · F3 opens the session", "Esperando la respuesta de %s · %ds · F3 abre la sesión"), s.Provider, int(time.Since(s.ReplyStarted).Seconds()))
		}
		return uiText("TRABAJANDO"), uiText("Fluke está procesando el pedido")
	case "idle":
		if s.ChatSending {
			return uiText("ENVIANDO"), uiText("Tu mensaje está guardado y pendiente de entrega")
		}
		if !s.ReplyStarted.IsZero() {
			return localText("AWAITING REPLY", "ESPERANDO RESPUESTA"), localText("CLI is idle; F3 shows its reply or any permission request", "La CLI está en espera; F3 muestra su respuesta o permisos pendientes")
		}
		return uiText("DISPONIBLE"), uiText("Fluke espera tu próximo mensaje")
	default:
		return uiText("ESPERANDO CLI"), uiText("F3 muestra el arranque y cualquier error de conexión")
	}
}

func configLabel(a *AgentConfig) string {
	if a == nil {
		return uiText("Sin configurar")
	}
	name := a.Model
	if name == "" {
		name = localText("default", "predeterminado")
	}
	return fmt.Sprintf("%s / %s", a.Provider, name)
}
