package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
)

type setupProgress struct {
	Step      int    `json:"step"`
	Complete  bool   `json:"complete,omitempty"`
	RepoDraft string `json:"repo_draft,omitempty"`
	LocalOnly bool   `json:"local_only,omitempty"`
}

type firstRun struct {
	open, scanning, selecting, repoBusy                  bool
	step, frame, selected, modelSelected, checked, total int
	generation, repoGeneration                           uint64
	harnesses                                            []discoveredHarness
	reason, repoDraft, limitDraft                        string
	githubLocal                                          bool
	modelEditing                                         bool
	modelDraft                                           string
	cancel                                               context.CancelFunc
}

type setupPulse struct{ generation uint64 }
type setupDetected struct {
	generation uint64
	harnesses  []discoveredHarness
}
type setupProbed struct {
	generation uint64
	index      int
	harness    discoveredHarness
}
type setupRepoResult struct {
	generation  uint64
	repo, draft string
	err         error
}

func localText(en, es string) string {
	if uiLanguage() == "es" {
		return es
	}
	return en
}

func (m *model) beginSetup(initial string, restart bool) {
	step := 0
	if !restart && m.state.Setup != nil && !m.state.Setup.Complete {
		step = m.state.Setup.Step
		if m.state.Setup.RepoDraft != "" {
			initial = m.state.Setup.RepoDraft
		}
	}
	if step >= 5 && initial != "" && !dependencySamePath(m.repo, initial) {
		step = 4 // Recheck the chosen repository when setup resumes from another folder.
	}
	m.closePanels()
	m.setup = firstRun{open: true, step: step, repoDraft: initial, selected: -1, limitDraft: strconv.Itoa(m.state.MaxWorkers)}
	if !restart && m.state.Setup != nil {
		m.setup.githubLocal = m.state.Setup.LocalOnly
	}
	m.notice = ""
	if step >= 2 && m.state.Orchestrator != nil {
		a := m.state.Orchestrator
		m.setup.harnesses = []discoveredHarness{{ID: a.Provider, Executable: a.Executable, Usable: true, Models: []string{a.Model}}}
		m.setup.selected = 0
	}
}

func (m *model) setupPulse() tea.Cmd {
	if !m.setup.open {
		return nil
	}
	generation := m.setup.generation
	return tea.Tick(125*time.Millisecond, func(time.Time) tea.Msg { return setupPulse{generation} })
}

func (m *model) scanHarnesses() tea.Cmd {
	if m.setup.cancel != nil {
		m.setup.cancel()
	}
	m.setup.generation++
	m.setup.scanning, m.setup.checked, m.setup.total = true, 0, 0
	generation := m.setup.generation
	return func() tea.Msg { return setupDetected{generation, detectHarnesses()} }
}

func (m *model) receiveSetupDetected(v setupDetected) tea.Cmd {
	if !m.setup.open || v.generation != m.setup.generation {
		return nil
	}
	m.setup.harnesses, m.setup.total = v.harnesses, len(v.harnesses)
	ctx, cancel := context.WithCancel(context.Background())
	m.setup.cancel = cancel
	var commands []tea.Cmd
	for i, h := range v.harnesses {
		if h.Executable == "" || h.Installed && !h.Usable {
			m.setup.checked++
			continue
		}
		commands = append(commands, func() tea.Msg { return setupProbed{v.generation, i, probeDiscoveredHarness(ctx, h)} })
	}
	if len(commands) == 0 {
		m.setup.scanning = false
		m.recommendSetupHarness()
	}
	return tea.Batch(commands...)
}

func (m *model) recommendSetupHarness() {
	index, reason := recommendHarness(m.setup.harnesses, readOmarchyDefault())
	m.setup.reason = reason
	if !m.setup.selecting {
		m.setup.selected = index
	}
	if a := m.state.Orchestrator; a != nil && !m.setup.selecting {
		for i, h := range m.setup.harnesses {
			if h.ID == a.Provider && h.Usable {
				m.setup.selected = i
				break
			}
		}
	}
	m.setup.modelSelected = 0
	if m.setup.selected >= 0 && m.setup.selected < len(m.setup.harnesses) {
		h := m.setup.harnesses[m.setup.selected]
		wanted := h.RecommendedModel
		if a := m.state.Orchestrator; a != nil && a.Provider == h.ID && a.Model != "" {
			wanted = a.Model
		}
		found := false
		for i, id := range h.Models {
			if id == wanted {
				m.setup.modelSelected = i
				found = true
				break
			}
		}
		if wanted != "" && !found {
			m.setup.harnesses[m.setup.selected].Models = append(h.Models, wanted)
			m.setup.modelSelected = len(h.Models)
		}
	}
}

func (m *model) saveSetupStep(step int) bool {
	next := m.state
	next.Setup = &setupProgress{Step: step, RepoDraft: m.setup.repoDraft, LocalOnly: m.setup.githubLocal}
	next.Language = uiLanguage()
	if !m.saveEdit(next, "") {
		return false
	}
	m.setup.step = step
	return true
}

func expandUserPath(path string) (string, error) {
	path = strings.Trim(strings.TrimSpace(path), "\"")
	if path == "~" || strings.HasPrefix(path, "~/") || strings.HasPrefix(path, "~\\") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		path = filepath.Join(home, strings.TrimLeft(path[1:], "/\\"))
	}
	return filepath.Abs(path)
}

func (m *model) checkSetupRepo() tea.Cmd {
	if m.setup.repoBusy {
		return nil
	}
	path, err := expandUserPath(m.setup.repoDraft)
	if err != nil {
		m.notice = err.Error()
		return nil
	}
	m.setup.repoBusy = true
	m.setup.repoGeneration++
	generation, draft := m.setup.repoGeneration, m.setup.repoDraft
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		repo, err := dependencyGit(ctx, path, "rev-parse", "--show-toplevel")
		if err != nil {
			err = fmt.Errorf("%s", localText("Choose an existing Git repository. Your files were not changed.", "Elegí un repositorio Git existente. Tus archivos se conservan."))
		}
		return setupRepoResult{generation, filepath.Clean(repo), draft, err}
	}
}

func (m *model) setupKey(v tea.KeyPressMsg) tea.Cmd {
	p := &m.setup
	key := v.String()
	if key == "esc" && p.modelEditing {
		p.modelEditing = false
		return nil
	}
	if key == "esc" && p.step > 0 {
		p.repoGeneration++
		p.repoBusy = false
		if p.step == 3 && m.auth.Busy {
			m.cancelGithubAuth()
			return nil
		}
		m.saveSetupStep(p.step - 1)
		return nil
	}
	if key == "ctrl+l" && p.step == 0 {
		language := "en"
		if uiLanguage() == "en" {
			language = "es"
		}
		next := m.state
		next.Language = language
		if m.saveEdit(next, "") {
			_ = setUILanguage(language)
		}
		return nil
	}
	switch p.step {
	case 0:
		if key == "enter" || key == " " {
			m.saveSetupStep(1)
		}
	case 1:
		if key == "enter" && p.scanning {
			m.notice = localText("Checking your harnesses… You can keep choosing with ↑/↓.", "Comprobando tus harnesses… Podés seguir eligiendo con ↑/↓.")
		}
		if key == "r" {
			return m.scanHarnesses()
		}
		if key == "up" || key == "k" || key == "down" || key == "j" {
			p.selecting = true
			direction := 1
			if key == "up" || key == "k" {
				direction = -1
			}
			for n := 0; n < len(p.harnesses); n++ {
				p.selected = (p.selected + direction + len(p.harnesses)) % len(p.harnesses)
				if p.harnesses[p.selected].Executable != "" {
					break
				}
			}
		}
		if key == "enter" && !p.scanning {
			if p.selected < 0 || p.selected >= len(p.harnesses) {
				m.notice = localText("No compatible harness found. Install one, then press R to scan again.", "No se encontró un harness compatible. Instalá uno y presioná R para volver a buscar.")
				return nil
			}
			h := p.harnesses[p.selected]
			if !h.Usable {
				m.notice = uiText(h.Message)
				return nil
			}
			next := m.state
			a := AgentConfig{Provider: h.ID, Executable: h.Executable, Arguments: []string{}}
			if next.Orchestrator != nil && next.Orchestrator.Provider == h.ID {
				a.Model = next.Orchestrator.Model
				a.Arguments = next.Orchestrator.Arguments
			}
			next.Orchestrator = &a
			if !m.saveEdit(next, "") {
				return nil
			}
			m.recommendSetupHarness()
			m.saveSetupStep(2)
		}
	case 2:
		if p.selected < 0 || p.selected >= len(p.harnesses) {
			m.notice = localText("Go back and scan your harnesses first.", "Volvé atrás para detectar tus harnesses.")
			return nil
		}
		h := p.harnesses[p.selected]
		if !p.modelEditing && key == "ctrl+l" {
			m.draft[0], m.draft[1] = h.ID, h.Executable
			return m.loginProvider()
		}
		if !p.modelEditing && key == "r" {
			return m.scanHarnesses()
		}
		if key == "m" && !p.modelEditing {
			p.modelEditing = true
			p.modelDraft = ""
			return nil
		}
		if p.modelEditing {
			switch key {
			case "enter":
				id := strings.TrimSpace(p.modelDraft)
				if id == "" || strings.ContainsAny(id, "\x00\r\n\x1b") {
					return nil
				}
				p.harnesses[p.selected].Models = append(h.Models, id)
				p.modelSelected = len(h.Models)
				p.modelEditing = false
			case "backspace":
				r := []rune(p.modelDraft)
				if len(r) > 0 {
					p.modelDraft = string(r[:len(r)-1])
				}
			case "ctrl+u":
				p.modelDraft = ""
			default:
				if len(p.modelDraft)+len(v.Text) <= 100 {
					p.modelDraft += v.Text
				}
			}
			return nil
		}
		if len(h.Models) > 0 {
			if key == "up" || key == "k" {
				p.modelSelected = (p.modelSelected + len(h.Models) - 1) % len(h.Models)
			}
			if key == "down" || key == "j" {
				p.modelSelected = (p.modelSelected + 1) % len(h.Models)
			}
		}
		if key == "enter" {
			if p.scanning || !h.Usable || h.AuthKnown && !h.Authenticated || m.state.Orchestrator == nil {
				m.notice = localText("Wait for scanning or sign in to your harness first.", "Esper\u00e1 la b\u00fasqueda o inici\u00e1 sesi\u00f3n en tu harness primero.")
				return nil
			}
			next := m.state
			a := *next.Orchestrator
			if len(h.Models) > 0 {
				a.Model = h.Models[p.modelSelected%len(h.Models)]
			}
			next.Orchestrator = &a
			if m.saveEdit(next, "") && m.saveSetupStep(3) {
				return m.refreshGithubAuth()
			}
		}
	case 3:
		if key == "tab" || key == "up" || key == "down" || key == "j" || key == "k" {
			p.githubLocal = !p.githubLocal
		}
		if key == "o" && m.auth.Code != "" {
			return openGithubDevice()
		}
		if key == "r" {
			return m.refreshGithubAuth()
		}
		if key == "enter" {
			if p.githubLocal || m.auth.Username != "" {
				if m.auth.Busy {
					m.cancelGithubAuth()
				}
				m.saveSetupStep(4)
			} else {
				return m.connectGithub()
			}
		}
	case 4:
		if p.repoBusy {
			return nil
		}
		switch key {
		case "enter":
			if strings.TrimSpace(p.repoDraft) == "" {
				if m.saveSetupStep(5) {
					m.repo = ""
				}
				return nil
			}
			return m.checkSetupRepo()
		case "ctrl+u":
			p.repoDraft = ""
		case "backspace":
			r := []rune(p.repoDraft)
			if len(r) > 0 {
				p.repoDraft = string(r[:len(r)-1])
			}
		default:
			if !p.repoBusy && len(p.repoDraft)+len(v.Text) <= 4096 {
				p.repoDraft += v.Text
			}
		}
	case 5:
		if key == "up" || key == "k" || key == "down" || key == "j" {
			n, _ := strconv.Atoi(p.limitDraft)
			if key == "up" || key == "k" {
				n++
			} else {
				n--
			}
			p.limitDraft = strconv.Itoa(min(64, max(1, n)))
		} else if key == "backspace" {
			if len(p.limitDraft) > 0 {
				p.limitDraft = p.limitDraft[:len(p.limitDraft)-1]
			}
		} else if key == "ctrl+u" {
			p.limitDraft = ""
		} else if key != "enter" && strings.Trim(v.Text, "0123456789") == "" && len(p.limitDraft)+len(v.Text) <= 2 {
			p.limitDraft += v.Text
		}
		if key == "enter" {
			n, err := strconv.Atoi(p.limitDraft)
			if err != nil || n < 1 || n > 64 {
				m.notice = localText("Choose between 1 and 64 workers.", "Elegí entre 1 y 64 workers.")
				return nil
			}
			next := m.state
			next.MaxWorkers = n
			if m.saveEdit(next, "") {
				m.saveSetupStep(6)
			}
		}
	case 6:
		if key == "enter" {
			if m.state.Orchestrator == nil {
				m.notice = localText("Choose a harness first.", "Elegí un harness primero.")
				return nil
			}
			next := m.state
			next.Setup = &setupProgress{Step: 6, Complete: true}
			next.Language = uiLanguage()
			if m.saveEdit(next, localText("Ready. Tell Fluke what you want to achieve.", "Listo. Contale a Fluke qué querés lograr.")) {
				p.open = false
				if p.cancel != nil {
					p.cancel()
				}
				m.view, m.pane = 1, 1
				m.home = m.repo == ""
				if m.home {
					m.view = 0
					m.pane = 0
					m.notice = localText("Ready. Press N to create a project or O to open one.", "Listo. Presioná N para crear un proyecto u O para abrir uno.")
				}
				return tea.Batch(m.checkProvider(), m.drainQueue(), m.scheduleWorkerTick(), m.queryPublishedPR("", false), m.scheduleGithubFollowup())
			}
		}
	}
	return nil
}
