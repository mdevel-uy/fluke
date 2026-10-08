package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

type projectEditor struct {
	open, creating, busy, pathEdited bool
	name, path                       string
	field                            int
	generation                       uint64
	cancel                           context.CancelFunc
}

type projectResult struct {
	generation uint64
	repo       string
	err        error
}

func (m *model) openProjectEditor(creating bool) {
	m.closePanels()
	m.projects = projectEditor{open: true, creating: creating, generation: m.projects.generation + 1}
	m.notice = ""
	if creating {
		m.suggestProjectPath()
	}
}

func (m *model) suggestProjectPath() {
	if m.projects.pathEdited {
		return
	}
	name := strings.TrimSpace(m.projects.name)
	name = strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsNumber(r) || r == '-' || r == '_' {
			return r
		}
		return '-'
	}, name)
	name = strings.Trim(name, "-")
	if name == "" {
		name = "new-project"
	}
	home, err := os.UserHomeDir()
	if err == nil {
		m.projects.path = filepath.Join(home, "Projects", name)
	}
}

func (m *model) pasteProjectField(text string) {
	p := &m.projects
	if p.busy {
		return
	}
	text = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, text)
	if p.creating && p.field == 0 {
		if len([]rune(p.name+text)) <= 120 {
			p.name += text
			m.suggestProjectPath()
		}
	} else if len(p.path)+len(text) <= 4096 {
		p.path += text
		p.pathEdited = true
	}
}

func (m *model) projectEditorKey(v tea.KeyPressMsg) tea.Cmd {
	p := &m.projects
	key := v.String()
	if key == "esc" {
		if p.busy {
			p.cancel()
			m.notice = localText("Cancelling…", "Cancelando…")
		} else {
			p.open = false
		}
		return nil
	}
	if p.busy {
		return nil
	}
	switch key {
	case "tab", "shift+tab", "up", "down":
		if p.creating {
			p.field = 1 - p.field
		}
	case "ctrl+u", "backspace":
		field := &p.path
		if p.creating && p.field == 0 {
			field = &p.name
		} else {
			p.pathEdited = true
		}
		if key == "ctrl+u" {
			*field = ""
		} else if runes := []rune(*field); len(runes) > 0 {
			*field = string(runes[:len(runes)-1])
		}
		m.suggestProjectPath()
	case "enter":
		if p.creating && p.field == 0 {
			p.field = 1
			return nil
		}
		if strings.TrimSpace(p.path) == "" || p.creating && strings.TrimSpace(p.name) == "" {
			m.notice = localText("Enter a name and a destination folder.", "Indicá el nombre y la carpeta de destino.")
			return nil
		}
		path, err := expandUserPath(p.path)
		if err != nil {
			m.notice = err.Error()
			return nil
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		p.busy, p.cancel = true, cancel
		generation, name, creating := p.generation, p.name, p.creating
		m.notice = localText("Preparing project…", "Preparando proyecto…")
		return func() tea.Msg {
			defer cancel()
			if creating {
				repo, err := createProject(ctx, path, name)
				return projectResult{generation, repo, err}
			}
			repo, err := dependencyGit(ctx, path, "rev-parse", "--show-toplevel")
			if err != nil {
				err = fmt.Errorf("%s: %w", localText("Choose an existing Git repository", "Elegí un repositorio Git existente"), err)
			}
			if err == nil {
				repo = filepath.Clean(repo)
			}
			return projectResult{generation, repo, err}
		}
	default:
		m.pasteProjectField(v.Text)
	}
	return nil
}

func (m *model) receiveProject(v projectResult) {
	p := &m.projects
	if !p.open || v.generation != p.generation {
		return
	}
	if p.cancel != nil {
		p.cancel()
		p.cancel = nil
	}
	p.busy = false
	if v.err != nil {
		m.notice = v.err.Error()
		if p.creating && v.repo != "" {
			m.notice += " · " + localText("Folder retained: ", "Carpeta conservada: ") + v.repo
		}
		return
	}
	for _, repo := range m.state.Projects {
		if dependencySamePath(repo, v.repo) {
			v.repo = repo
			break
		}
	}
	next := m.state
	found := false
	for _, repo := range next.Projects {
		if repo == v.repo {
			found = true
			break
		}
	}
	if !found {
		next.Projects = append(append([]string{}, next.Projects...), v.repo)
	}
	if !m.saveEdit(next, localText("Project ready. Tell Fluke what you want to build.", "Proyecto listo. Contale a Fluke qué querés construir.")) {
		m.notice += " · " + localText("Repository retained: ", "Repositorio conservado: ") + v.repo
		return
	}
	p.open = false
	m.repo, m.home, m.view, m.selected, m.chatScroll = v.repo, false, 1, 0, 0
	m.pane = 1
}

func (m *model) homeKey(v tea.KeyPressMsg) tea.Cmd {
	items := len(m.state.Projects)
	if m.pane == 2 {
		items = len(m.attentionItems())
	}
	switch v.String() {
	case "n":
		m.openProjectEditor(true)
	case "o":
		m.openProjectEditor(false)
	case "tab", "shift+tab":
		if m.pane == 2 {
			m.pane = 0
		} else {
			m.pane = 2
		}
		m.selected = 0
	case "down", "j":
		if items > 0 {
			m.selected = (m.selected + 1) % items
		}
	case "up", "k":
		if items > 0 {
			m.selected = (m.selected + items - 1) % items
		}
	case "enter", "c":
		if items == 0 {
			return nil
		}
		if m.pane == 2 {
			m.openAttention(m.selected % items)
			return nil
		}
		m.repo, m.home, m.view, m.pane, m.chatScroll = m.state.Projects[m.selected%items], false, 1, 0, 0
		m.selected = 0
		if v.String() == "c" {
			m.pane = 1
		}
		m.notice = localText("Project open. F1 returns to all projects.", "Proyecto abierto. F1 vuelve a todos los proyectos.")
	}
	return nil
}

func (m *model) projectActivity(repo string) string {
	counts := map[string]int{}
	for _, t := range m.state.Tasks {
		if t.Repo != repo {
			continue
		}
		counts["total"]++
		if t.Status == "running" && !t.Paused {
			counts["running"]++
		}
		if t.Queued {
			counts["queued"]++
		}
		if t.Status == "awaiting_review" {
			counts["review"]++
		}
	}
	return fmt.Sprintf(localText("%d tasks · %d running · %d queued · %d to review", "%d tareas · %d en curso · %d en cola · %d a revisar"), counts["total"], counts["running"], counts["queued"], counts["review"])
}

func (m *model) homeProjects(w, h int) string {
	content := strong(localText("[N] NEW PROJECT", "[N] NUEVO PROYECTO"), lime) + "\n" + accent(localText("[O] Open a repository", "[O] Abrir un repositorio"), cyan) + "\n\n"
	if len(m.state.Projects) == 0 {
		return content + wrap(localText("Start from an idea. Create your first project, then agree on a goal with Fluke.", "Empezá por una idea. Creá tu primer proyecto y acordá un objetivo con Fluke."), w)
	}
	selected := m.selected % len(m.state.Projects)
	if m.pane == 2 {
		selected = -1
	}
	page := max(1, (h-8)/5)
	start := max(0, selected-page+1)
	for i := start; i < len(m.state.Projects) && i < start+page; i++ {
		repo := m.state.Projects[i]
		ink, marker := cyan, "  "
		if i == selected {
			ink, marker = pink, "› "
		}
		content += strong(marker+filepath.Base(repo), ink) + "\n" + accent(tailText(repo, w), muted) + "\n" + wrap(m.projectActivity(repo), w) + "\n\n"
	}
	if len(m.state.Projects) > page {
		content += accent(localText("↑/↓ more projects", "↑/↓ más proyectos"), muted)
	}
	return content
}

func (m *model) homeView(w, h int) string {
	if w < 92 {
		if m.pane == 2 {
			return frame(localText("ACROSS YOUR PROJECTS / ATTENTION", "TODOS TUS PROYECTOS / ATENCIÓN"), m.attentionContent(w-4), w, h, cyan, true)
		}
		return frame(localText("YOUR PROJECTS", "TUS PROYECTOS"), m.homeProjects(w-4, h), w, h, cyan, true)
	}
	left := w * 40 / 100
	right := w - left - 1
	if m.pane == 2 {
		return lipgloss.JoinHorizontal(lipgloss.Top, frame(localText("YOUR PROJECTS", "TUS PROYECTOS"), m.homeProjects(left-4, h), left, h, cyan, false), " ", frame(localText("GLOBAL ATTENTION", "ATENCIÓN GLOBAL"), m.attentionContent(right-4), right, h, cyan, true))
	}
	body := strong(localText("ONE PLACE TO KEEP WORK MOVING", "UN LUGAR PARA SEGUIR TODO EL TRABAJO"), cyan) + "\n\n"
	if len(m.state.Projects) > 0 {
		repo := m.state.Projects[m.selected%len(m.state.Projects)]
		if m.pane == 2 {
			repo = m.repo
		}
		if repo != "" {
			body += strong(filepath.Base(repo), pink) + "\n" + wrap(m.projectActivity(repo), right-4) + "\n\n"
			if goal := m.state.Goals[repo]; goal.ID != "" {
				body += strong(localText("AGREED GOAL", "OBJETIVO ACORDADO"), lime) + "\n" + fit(wrap(goal.Objective, right-4), right-4, 3) + "\n\n"
			}
		}
	} else {
		body += wrap(localText("Projects keep their own goals, tasks and conversations. Workers share the limit you chose, and keep running while you move between projects.", "Cada proyecto conserva sus objetivos, tareas y conversaciones. Los workers comparten el límite que elegiste y siguen trabajando cuando cambiás de proyecto."), right-4) + "\n\n"
	}
	alerts := len(m.attentionItems())
	body += strong(fmt.Sprintf(localText("%d ITEMS NEED YOUR ATTENTION", "%d ELEMENTOS NECESITAN TU ATENCIÓN"), alerts), attentionInk(alerts)) + "\n" + accent(localText("[Tab] See alerts from every project", "[Tab] Ver alertas de todos los proyectos"), cyan) + "\n\n" + workerCapacity(m.liveWorkers(), m.state.MaxWorkers, 8)
	return lipgloss.JoinHorizontal(lipgloss.Top, frame(localText("YOUR PROJECTS", "TUS PROYECTOS"), m.homeProjects(left-4, h), left, h, cyan, m.pane == 0), " ", frame(localText("GLOBAL OVERVIEW", "VISTA GLOBAL"), wrap(body, right-4), right, h, cyan, m.pane == 2))
}

func (m *model) projectEditorView(w, h int) string {
	p := &m.projects
	title := localText("OPEN PROJECT", "ABRIR PROYECTO")
	body := wrap(localText("Open an existing Git repository. Its tasks and sessions stay together here.", "Abrí un repositorio Git existente. Sus tareas y sesiones quedan juntas acá."), w-4) + "\n\n"
	if p.creating {
		title = localText("CREATE PROJECT", "CREAR PROYECTO")
		body = wrap(localText("Give your idea a home. Fluke creates a new folder and initializes Git with an empty commit.", "Dale un lugar a tu idea. Fluke crea una carpeta nueva e inicia Git con un commit vacío."), w-4) + "\n\n"
		body += strong(localText("NAME", "NOMBRE"), cyan) + "\n" + projectField(p.name, p.field == 0 && !p.busy, w-4) + "\n\n"
	}
	body += strong(localText("DESTINATION FOLDER", "CARPETA DE DESTINO"), cyan) + "\n" + projectField(p.path, (!p.creating || p.field == 1) && !p.busy, w-4) + "\n\n"
	if p.busy {
		body += strong(localText("PREPARING…  [Esc] Cancel", "PREPARANDO…  [Esc] Cancelar"), amber)
	} else if p.creating {
		body += wrap(localText("Choose a folder that does not exist yet. Existing folders are preserved. GitHub can be connected later from F5.", "Elegí una carpeta que todavía no exista. Las carpetas existentes se conservan. Podés conectar GitHub después desde F5."), w-4)
	}
	if h < 18 {
		body = ""
		if p.creating && p.field == 0 {
			body = strong(localText("NAME", "NOMBRE"), cyan) + "\n" + projectField(p.name, !p.busy, w-4)
		} else {
			body = strong(localText("DESTINATION FOLDER", "CARPETA DE DESTINO"), cyan) + "\n" + projectField(p.path, !p.busy, w-4)
		}
		if p.busy {
			body += "\n" + strong(localText("PREPARING…", "PREPARANDO…"), amber)
		}
	}
	return frame(title, body, w, h, pink, true)
}

func projectField(value string, focused bool, w int) string {
	if focused {
		return tailText(value, max(1, w-1)) + strong("▌", cyan)
	}
	return tailText(value, w)
}
