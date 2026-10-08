package main

import (
	"errors"
	"strings"

	tea "charm.land/bubbletea/v2"
)

type githubPRResult struct {
	task       Task
	plan       githubPRPlan
	generation uint64
	published  bool
	err        error
}

func (m *model) previewPullRequest(id string) tea.Cmd {
	if m.publishingTaskID != "" || m.integratingTaskID != "" || m.acceptingTaskID != "" {
		m.notice = uiText("Esperá a que termine la operación de entrega actual.")
		return nil
	}
	for _, task := range m.state.Tasks {
		if task.ID != id || task.Repo != m.repo {
			continue
		}
		if err := checkTaskSpecs(task, m.state.Goals[task.Repo]); err != nil {
			m.notice = err.Error()
			return nil
		}
		if task.Status != "accepted" || m.sessionAlive(id) {
			m.notice = uiText("Primero revisá y aceptá la entrega en F7.")
			return nil
		}
		m.closePanels()
		p := &m.review
		p.open, p.task, p.publicationLoading = true, task, true
		p.loading, p.err, p.publication, p.publicationEditing = false, nil, nil, 0
		p.integration, p.integrationLoading, p.lines, p.scroll = nil, false, nil, 0
		generation := p.generation
		m.notice = uiText("Preparando el PR borrador y comprobando GitHub…")
		return func() tea.Msg {
			plan, err := inspectGithubPullRequest(task)
			if err == nil && task.Publication != nil && task.Publication.Tree == plan.Tree {
				if plan.Title != task.Publication.Title || plan.Body != task.Publication.Body {
					plan.Complete = false
				}
				plan.Title, plan.Body = task.Publication.Title, task.Publication.Body
			}
			return githubPRResult{task: task, plan: plan, generation: generation, err: err}
		}
	}
	m.notice = uiText("No existe esa tarea en el proyecto actual.")
	return nil
}

func (m *model) confirmPullRequest() tea.Cmd {
	p := m.review.publication
	if p == nil || p.Complete || m.publishingTaskID != "" || m.integratingTaskID != "" || m.acceptingTaskID != "" {
		return nil
	}
	for i, task := range m.state.Tasks {
		if task.ID != p.TaskID {
			continue
		}
		if task.Status != "accepted" || task.AcceptedTree != p.Tree || m.sessionAlive(task.ID) {
			m.notice = uiText("La entrega cambió. Prepará otra vista previa del PR.")
			return nil
		}
		approved := *p
		approved.Started = true
		approved.Complete = false
		if !validStoredGithubPRPlan(task, approved) {
			m.notice = uiText("Completá un título y una descripción válidos antes de publicar.")
			return nil
		}
		next := m.state
		next.Tasks = append([]Task{}, next.Tasks...)
		next.Tasks[i].Publication = &approved
		next.Tasks[i].Note = uiText("Publicación del PR borrador autorizada por el usuario.")
		if !m.saveEdit(next, uiText("Publicando el PR borrador…")) {
			return nil
		}
		m.publishingTaskID = task.ID
		m.review.publicationLoading, m.review.lines = true, nil
		generation := m.review.generation
		return func() tea.Msg {
			plan, err := publishGithubPullRequest(task, approved)
			return githubPRResult{task: task, plan: plan, generation: generation, published: true, err: err}
		}
	}
	return nil
}

func (m *model) receivePullRequest(v githubPRResult) tea.Cmd {
	if !v.published {
		if !m.review.open || m.review.generation != v.generation {
			return nil
		}
		current := false
		for _, task := range m.state.Tasks {
			if task.ID == v.task.ID && task.Status == "accepted" && task.AcceptedTree == v.task.AcceptedTree && task.Branch == v.task.Branch {
				current = true
			}
		}
		if !current {
			return nil
		}
	}
	if v.published {
		if m.publishingTaskID != v.task.ID {
			return nil
		}
		m.publishingTaskID = ""
		if v.err == nil && (!v.plan.Complete || !validStoredGithubPRPlan(v.task, v.plan)) {
			v.err = errors.New(uiText("no se pudo verificar el PR publicado; consultá de nuevo GitHub"))
		}
	}
	if v.published || v.err == nil && v.plan.Complete {
		next := m.state
		next.Tasks = append([]Task{}, next.Tasks...)
		for i, task := range next.Tasks {
			if task.ID != v.task.ID {
				continue
			}
			if validStoredGithubPRPlan(task, v.plan) {
				plan := v.plan
				plan.Started = true
				next.Tasks[i].Publication = &plan
			}
			next.Tasks[i].Note = uiText("PR publicado: ") + v.plan.URL
			if v.err != nil {
				next.Tasks[i].Note = conciseAgentMessage(v.err.Error())
			}
		}
		message := uiText("PR publicado y verificado: ") + v.plan.URL
		if v.err != nil {
			message = uiText("Publicación pendiente: ") + conciseAgentMessage(v.err.Error())
		}
		m.saveEdit(next, message)
	}
	if m.review.open && m.review.generation == v.generation {
		m.review.publicationLoading, m.review.err, m.review.lines, m.review.scroll = false, v.err, nil, 0
		if v.err == nil {
			m.review.publication = &v.plan
			if !v.published && !v.plan.Complete {
				m.notice = uiText("Revisá título y descripción. Enter publica la rama y crea un PR borrador en GitHub.")
				if v.plan.URL != "" {
					m.notice = uiText("Revisá los cambios. Enter publica la rama y actualiza este PR existente en GitHub.")
				}
			}
		} else {
			m.review.publication = nil
			m.notice = conciseAgentMessage(v.err.Error())
		}
	}
	return nil
}

func (p *reviewPanel) publicationText() string {
	if p.publicationLoading {
		return uiText("PR BORRADOR\n\nComprobando GitHub y los archivos aceptados…")
	}
	plan := p.publication
	if plan.Complete {
		heading := uiText("PR BORRADOR PUBLICADO")
		if !plan.Draft {
			heading = uiText("PR PUBLICADO")
		}
		return heading + "\n\n" + plan.URL + uiText("\n\nRepositorio: ") + plan.RepoName + uiText("\nDesde: ") + plan.HeadBranch + uiText("\nHacia: ") + plan.BaseBranch + uiText("\n\nLa entrega conserva su rama y worktree.")
	}
	heading, confirm := uiText("PUBLICAR PR BORRADOR"), uiText("Publicar borrador")
	if plan.URL != "" {
		heading, confirm = uiText("ACTUALIZAR PR"), uiText("Actualizar PR")
	}
	text := heading + uiText("\n\nRepositorio: ") + plan.RepoName + uiText("\nDesde: ") + plan.HeadBranch + uiText("\nHacia: ") + plan.BaseBranch
	if plan.Commit {
		text += uiText("\n\nSe creará un commit con los archivos aceptados.")
	}
	title, body, titleLabel, bodyLabel := plan.Title, plan.Body, uiText("TÍTULO"), uiText("DESCRIPCIÓN")
	if p.publicationEditing == 1 {
		titleLabel, title = uiText("TÍTULO [EDITANDO]"), title+" ▌"
	}
	if p.publicationEditing == 2 {
		bodyLabel, body = uiText("DESCRIPCIÓN [EDITANDO]"), body+" ▌"
	}
	action := uiText("Se publicará esta rama en origin y se creará un PR borrador.")
	if plan.URL != "" {
		action = uiText("Se publicará esta rama en origin y se actualizará el PR existente:\n") + plan.URL
		if !plan.Draft {
			action += uiText("\nEste PR ya está listo para revisión; conservará ese estado.")
		}
	}
	text += "\n" + action + "\n\n" + titleLabel + "\n" + title + "\n\n" + bodyLabel + "\n" + body
	return text + uiText("\n\n[e] Editar título/descripción · [Enter] ") + confirm + uiText(" · [Esc] Volver")
}

func (p *reviewPanel) editPublication(text string) {
	if p.publication == nil || p.publicationEditing == 0 {
		return
	}
	text = reviewText(strings.ReplaceAll(text, "\r\n", "\n"))
	field, limit := &p.publication.Body, 16000
	if p.publicationEditing == 1 {
		field, limit = &p.publication.Title, 256
		text = strings.ReplaceAll(text, "\n", " ")
	}
	if len(*field)+len(text) <= limit {
		*field += text
	}
	p.publication.Complete = false
	p.lines = nil
}

func (p *reviewPanel) followPublicationCaret(width, height int) {
	if p.publication == nil || p.publicationEditing == 0 {
		return
	}
	label, field := uiText("TÍTULO [EDITANDO]"), p.publication.Title
	if p.publicationEditing == 2 {
		label, field = uiText("DESCRIPCIÓN [EDITANDO]"), p.publication.Body
	}
	prefix, _, _ := strings.Cut(p.publicationText(), label+"\n")
	line := len(strings.Split(wrap(prefix+label+"\n"+field+" ▌", max(1, width-4)), "\n")) - 1
	p.scroll = max(0, line-max(1, height-8)+1)
}

func (m *model) publicationKey(v tea.KeyPressMsg) tea.Cmd {
	p := &m.review
	key := v.String()
	if p.publicationEditing != 0 {
		switch key {
		case "esc", "ctrl+s", "ctrl+enter":
			p.publicationEditing, p.lines, p.scroll = 0, nil, 0
			m.notice = uiText("Revisá el PR. Enter confirma su publicación en GitHub.")
		case "tab", "shift+tab":
			p.publicationEditing = 3 - p.publicationEditing
		case "enter":
			if p.publicationEditing == 1 {
				p.publicationEditing = 2
			} else {
				p.editPublication("\n")
			}
		case "backspace", "ctrl+u":
			field := &p.publication.Body
			if p.publicationEditing == 1 {
				field = &p.publication.Title
			}
			runes := []rune(*field)
			if key == "ctrl+u" {
				*field = ""
			} else if len(runes) > 0 {
				*field = string(runes[:len(runes)-1])
			}
		default:
			p.editPublication(v.Text)
		}
		p.lines = nil
		p.followPublicationCaret(m.width, m.workspaceHeight())
		return nil
	}
	if key == "enter" && p.publication != nil {
		return m.confirmPullRequest()
	}
	if key == "e" && p.publication != nil && !p.publication.Complete && !p.publicationLoading {
		p.publicationEditing, p.lines, p.scroll = 1, nil, 0
		p.followPublicationCaret(m.width, m.workspaceHeight())
		m.notice = uiText("Editá el título o descripción. Ctrl+S vuelve a la vista previa; luego Enter publica.")
		return nil
	}
	if key == "r" {
		if !p.publicationLoading {
			return m.previewPullRequest(p.task.ID)
		}
		return nil
	}
	return p.key(key, m.width, m.workspaceHeight())
}
