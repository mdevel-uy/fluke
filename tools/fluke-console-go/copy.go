package main

import "strings"

import tea "charm.land/bubbletea/v2"

func (m *model) copyFocused() tea.Cmd {
	var text string
	switch {
	case m.projects.open:
		text = m.projects.name + "\n" + m.projects.path
	case m.home && m.view == 0:
		if m.pane == 2 {
			for _, item := range m.attentionItems() {
				text += item.Repo + ": " + item.Summary + "\n\n"
			}
		} else {
			for _, repo := range m.state.Projects {
				text += repo + "\n" + m.projectActivity(repo) + "\n\n"
			}
		}
	case m.review.open:
		text = m.review.task.Title + "\n" + strings.Join(m.review.content(max(1, m.width-4)), "\n")
	case m.view == 2 && !m.config && !m.githubOpen:
		if len(m.terminals.Windows) > 0 {
			w := m.terminals.Windows[m.terminals.FocusedWindow]
			text = w.visibleText()
		}
	case m.view == 3 && !m.config && !m.githubOpen:
		if m.pane == 0 {
			text = m.briefText()
		} else if i := m.selectedDecision(); i >= 0 {
			d := m.state.Decisions[i]
			text = d.Question
			if d.Answer != nil {
				text += "\n\n" + *d.Answer
			}
		}
	case m.githubOpen:
		issues := m.github[m.repo].Issues
		if len(issues) > 0 {
			issue := issues[m.githubSelected%len(issues)]
			text = issue.Title + "\n" + issue.URL + "\n" + issue.Body
		}
	default:
		for _, msg := range m.state.Conversations[m.repo] {
			role := "Fluke"
			if msg.Role == "human" {
				role = uiText("Vos")
			}
			text += role + ": " + msg.Text + "\n\n"
		}
		if text == "" {
			goal := m.state.Goals[m.repo]
			text = goal.Objective + "\n" + goal.Acceptance
		}
	}
	text = strings.TrimSpace(reviewText(text))
	if text == "" {
		m.notice = uiText("No hay texto para copiar en este panel. Podés seleccionar texto con el mouse.")
		return nil
	}
	return copyToClipboard(text)
}
