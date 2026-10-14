package main

import (
	"fmt"
	"path/filepath"
	"strings"
	"unicode"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

type quickSwitcher struct {
	query    string
	selected int
	commands bool
}

type switchTarget struct{ repo, taskID, label, detail, action string }

func (m *model) switchTargets() []switchTarget {
	var targets []switchTarget
	if m.switcher.commands {
		targets = m.commandTargets()
	}
	for _, repo := range m.state.Projects {
		if m.switcher.commands {
			break
		}
		targets = append(targets, switchTarget{repo: repo, label: "FLUKE / " + filepath.Base(repo), detail: localText("Project chat", "Chat del proyecto") + " · " + repo})
		for _, task := range m.state.Tasks {
			if task.Repo != repo {
				continue
			}
			provider := task.AgentProvider
			if provider == "" && task.WorkerConfig != nil {
				provider = task.WorkerConfig.Provider
			}
			targets = append(targets, switchTarget{repo: repo, taskID: task.ID, label: task.Title, detail: filepath.Base(repo) + " · " + provider + " · " + status(taskAgentStatus(task))})
		}
	}
	query := strings.Fields(strings.ToLower(m.switcher.query))
	var filtered []switchTarget
	for _, target := range targets {
		text := strings.ToLower(target.label + " " + target.detail + " " + target.taskID + " " + target.action)
		match := true
		for _, word := range query {
			if !strings.Contains(text, word) {
				match = false
				break
			}
		}
		if match {
			filtered = append(filtered, target)
		}
	}
	return filtered
}

func (m *model) switchPage() (targets []switchTarget, start, count int) {
	targets = m.switchTargets()
	m.switcher.selected = max(0, min(m.switcher.selected, len(targets)-1))
	count = max(1, (m.workspaceHeight()-7)/2)
	start = max(0, m.switcher.selected-count+1)
	return
}

func (m *model) openSwitchTarget() tea.Cmd {
	targets, _, _ := m.switchPage()
	if len(targets) == 0 {
		return nil
	}
	target := targets[m.switcher.selected]
	if target.action != "" {
		m.switcher = nil
		return m.openCommandTarget(target.action)
	}
	m.closePanels()
	m.repo, m.home, m.view, m.pane, m.selected = target.repo, false, 1, 1, 0
	m.chatScroll, m.taskScroll, m.insights = 0, 0, false
	m.hideFlukeTerminals()
	if target.taskID != "" {
		m.pane = 0
		for i, task := range m.projectTasks() {
			if task.ID == target.taskID {
				m.selected = i
				break
			}
		}
		if m.sessionAlive(target.taskID) {
			m.view = 2
			m.focus(target.taskID)
			m.terminals.Mode = windowMode
		}
	}
	return nil
}

func (m *model) switcherText(text string) {
	text = strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return ' '
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, text)
	runes := []rune(m.switcher.query + text)
	m.switcher.query = string(runes[:min(200, len(runes))])
	m.switcher.selected = 0
}

func (m *model) switcherInput(msg tea.Msg) (bool, tea.Cmd) {
	if m.setup.open || m.quitting || m.projects.busy {
		return false, nil
	}
	if key, ok := msg.(tea.KeyPressMsg); ok && (key.String() == "ctrl+p" || key.String() == "alt+k") {
		return m.globalKey(key.String())
	}
	if m.switcher == nil {
		return false, nil
	}
	switch v := msg.(type) {
	case tea.KeyPressMsg:
		key := v.String()
		if key == "ctrl+q" || key == "ctrl+c" || len(key) == 2 && key[0] == 'f' && key[1] >= '1' && key[1] <= '7' || strings.HasPrefix(key, "alt+") && len(key) == 5 && key[4] >= '1' && key[4] <= '7' {
			m.switcher = nil
			return false, nil
		}
		switch key {
		case "esc":
			m.switcher = nil
		case "enter":
			return true, m.openSwitchTarget()
		case "down", "tab":
			m.switcher.selected++
		case "up", "shift+tab":
			m.switcher.selected = max(0, m.switcher.selected-1)
		case "ctrl+u":
			m.switcher.query, m.switcher.selected = "", 0
		case "backspace":
			runes := []rune(m.switcher.query)
			if len(runes) > 0 {
				m.switcher.query = string(runes[:len(runes)-1])
				m.switcher.selected = 0
			}
		default:
			if v.Text != "" {
				m.switcherText(v.Text)
			}
		}
		return true, nil
	case tea.PasteMsg:
		m.switcherText(v.Content)
		return true, nil
	case tea.MouseClickMsg:
		if !m.mouseDisabled && v.Button == tea.MouseLeft {
			targets, start, count := m.switchPage()
			row := v.Y - m.headerRows() - 6
			if row >= 0 && row < count*2 && start+row/2 < len(targets) && v.X >= 2 && v.X < m.width-2 {
				m.switcher.selected = start + row/2
				return true, m.openSwitchTarget()
			}
		}
		return true, nil
	case tea.MouseWheelMsg:
		if !m.mouseDisabled {
			if v.Button == tea.MouseWheelUp {
				m.switcher.selected = max(0, m.switcher.selected-1)
			} else {
				m.switcher.selected++
			}
		}
		return true, nil
	case tea.MouseMotionMsg, tea.MouseReleaseMsg:
		return true, nil
	}
	return false, nil
}

func (m *model) switcherView(w, h int) string {
	targets, start, count := m.switchPage()
	inside := max(1, w-4)
	prompt := localText("Search project, task or provider", "Buscá proyecto, tarea o proveedor")
	title := localText("QUICK SWITCH / %d RESULTS", "IR A / %d RESULTADOS")
	if m.switcher.commands {
		prompt = localText("Find a view or setting", "Buscá una vista o un ajuste")
		title = localText("COMMANDS / %d RESULTS", "COMANDOS / %d RESULTADOS")
	}
	body := accent(prompt, cyan) + "\n" + accent("> "+tailText(m.switcher.query, max(1, inside-3))+"▌", pink) + "\n\n"
	if len(targets) == 0 {
		body += localText("No matches. Ctrl+U clears the search.", "Sin coincidencias. Ctrl+U limpia la búsqueda.")
	}
	for i := start; i < min(len(targets), start+count); i++ {
		marker, ink := "  ", cyan
		if i == m.switcher.selected {
			marker, ink = "> ", pink
		}
		body += accent(ansi.Truncate(marker+cleanAgentText(targets[i].label), inside, "…"), ink) + "\n" + accent(ansi.Truncate("  "+cleanAgentText(targets[i].detail), inside, "…"), muted) + "\n"
	}
	return frame(fmt.Sprintf(title, len(targets)), body, w, h, cyan, true)
}
