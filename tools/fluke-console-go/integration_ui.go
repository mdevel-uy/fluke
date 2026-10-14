package main

import (
	"errors"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
)

type deliveryIntegrationResult struct {
	task       Task
	plan       integrationPlan
	generation uint64
	done       bool
	prepared   bool
	err        error
}

func (m *model) previewIntegration(id string) tea.Cmd {
	if m.integratingTaskID != "" || m.acceptingTaskID != "" || m.publishingTaskID != "" {
		m.notice = uiText("Esperá a que termine la aceptación o integración actual.")
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
			m.notice = uiText("La entrega debe estar aceptada y su worker detenido antes de integrar.")
			return nil
		}
		m.closePanels()
		p := &m.review
		p.open, p.task, p.integrationLoading = true, task, true
		p.loading, p.err, p.integration = false, nil, nil
		p.lines, p.scroll = nil, 0
		generation := p.generation
		m.notice = uiText("Preparando la vista previa de integración…")
		return func() tea.Msg {
			plan, err := inspectIntegration(task)
			if err == nil && task.Integration != nil && task.Integration.Started && task.Integration.MergedCommit == "" && task.Integration.TargetBranch != plan.TargetBranch {
				return deliveryIntegrationResult{task: task, generation: generation, err: errors.New(uiText("volvé a la rama de destino de la integración pendiente: ") + task.Integration.TargetBranch)}
			}
			return deliveryIntegrationResult{task: task, plan: plan, generation: generation, err: err}
		}
	}
	m.notice = uiText("No existe esa tarea en el proyecto actual.")
	return nil
}

func (m *model) confirmIntegration() tea.Cmd {
	p := m.review.integration
	if p == nil || m.integratingTaskID != "" || m.acceptingTaskID != "" || m.publishingTaskID != "" {
		return nil
	}
	for i, task := range m.state.Tasks {
		if task.ID != p.TaskID {
			continue
		}
		if task.Status != "accepted" || task.AcceptedTree != p.Tree || m.sessionAlive(task.ID) {
			m.notice = uiText("La entrega cambió; prepará otra vista previa antes de integrar.")
			return nil
		}
		approved := *p
		approved.Started = true
		next := m.state
		next.Tasks = append([]Task{}, next.Tasks...)
		next.Tasks[i].Integration = &approved
		next.Tasks[i].Note = uiText("Integración autorizada por el usuario; verificando Git.")
		if !m.saveEdit(next, uiText("Integrando la entrega…")) {
			return nil
		}
		m.integratingTaskID = task.ID
		m.review.integrationLoading, m.review.lines = true, nil
		generation := m.review.generation
		return func() tea.Msg {
			plan, err := prepareIntegration(task, approved)
			return deliveryIntegrationResult{task: task, plan: plan, generation: generation, prepared: true, err: err}
		}
	}
	return nil
}

func (m *model) receiveIntegration(v deliveryIntegrationResult) tea.Cmd {
	if !v.prepared && !v.done {
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
	if v.prepared {
		if m.integratingTaskID != v.task.ID {
			return nil
		}
		if v.err == nil && v.plan.MergedCommit == "" {
			next := m.state
			next.Tasks = append([]Task{}, next.Tasks...)
			plan := v.plan
			plan.Started = true
			for i, task := range next.Tasks {
				if task.ID == v.task.ID {
					next.Tasks[i].Integration = &plan
				}
			}
			if !m.saveEdit(next, uiText("Commit verificado. Integrando los cambios previstos…")) {
				m.integratingTaskID = ""
				return nil
			}
			return func() tea.Msg {
				merged, err := finishIntegration(v.task, plan)
				return deliveryIntegrationResult{task: v.task, plan: merged, generation: v.generation, done: true, err: err}
			}
		}
		v.done = true
	}
	if v.done {
		if m.integratingTaskID != v.task.ID {
			return nil
		}
		m.integratingTaskID = ""
	}
	if v.done || v.err == nil && v.plan.MergedCommit != "" {
		next := m.state
		next.Tasks = append([]Task{}, next.Tasks...)
		for i, task := range next.Tasks {
			if task.ID != v.task.ID {
				continue
			}
			if validGitHash(v.plan.Tree) && validGitHash(v.plan.TargetHead) && validGitHash(v.plan.SourceHead) {
				plan := v.plan
				plan.Started = true
				if plan.ExpectedTree == "" && task.Integration != nil {
					plan.ExpectedTree = task.Integration.ExpectedTree
				}
				next.Tasks[i].Integration = &plan
			}
			next.Tasks[i].Note = uiText("Integrada en ") + v.plan.TargetBranch + uiText(". Rama y worktree conservados.")
			if v.err != nil {
				next.Tasks[i].Note = conciseAgentMessage(v.err.Error())
			}
		}
		message := uiText("Entrega integrada y verificada en ") + v.plan.TargetBranch + uiText(". Fluke actualiza las dependencias.")
		if v.err != nil {
			message = uiText("Integración pendiente: ") + conciseAgentMessage(v.err.Error())
		}
		m.saveEdit(next, message)
		m.dependencyChecked = time.Time{}
	}
	if m.review.open && m.review.generation == v.generation {
		m.review.integrationLoading, m.review.err, m.review.lines, m.review.scroll = false, v.err, nil, 0
		if v.err == nil {
			m.review.integration = &v.plan
			if !v.done && v.plan.MergedCommit == "" {
				m.notice = uiText("Revisá los cambios y la rama de destino. Enter autoriza la integración local.")
			}
		} else {
			m.review.integration = nil
			m.notice = conciseAgentMessage(v.err.Error())
		}
	}
	if v.done || v.plan.MergedCommit != "" {
		return tea.Batch(m.drainQueue(), m.scheduleWorkerTick())
	}
	return nil
}

func (p *reviewPanel) integrationText() string {
	if p.integrationLoading {
		return uiText("INTEGRACIÓN\n\nComprobando Git y los archivos aceptados…")
	}
	plan := p.integration
	if plan.MergedCommit != "" {
		return uiText("INTEGRACIÓN VERIFICADA\n\nDestino: ") + reviewText(plan.TargetBranch) + "\nCommit: " + plan.MergedCommit + uiText("\n\nLos cambios ya están incluidos en el destino.\nLas ramas y worktrees se conservan.")
	}
	text := uiText("INTEGRAR ENTREGA\n\n") + reviewText(p.task.Title) + uiText("\n\nDesde: ") + reviewText(p.task.Branch) + uiText("\nHacia: ") + reviewText(plan.TargetBranch) + uiText("\nRepositorio: ") + reviewText(p.task.Repo)
	if plan.Commit {
		text += uiText("\n\nSe creará un commit con los archivos aceptados.\nMensaje: Fluke: ") + reviewText(strings.Join(strings.Fields(p.task.Title), " "))
	}
	text += uiText("\n\nSe integrará la rama mediante merge local.\n\nRESUMEN\n") + reviewText(plan.Summary) + uiText("\n[Enter] Confirmar integración · [Esc] Volver\n")
	return text
}
