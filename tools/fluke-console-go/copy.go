package main

import "strings"

import tea "charm.land/bubbletea/v2"

func (m *model) copyFocused() tea.Cmd {
	var text string
	switch {
	case m.review.open:
		text = m.review.task.Title + "\n" + strings.Join(m.review.content(max(1, m.width-4)), "\n")
	case m.view == 2 && !m.config && !m.githubOpen:
		if len(m.terminals.Windows) > 0 {
			w := m.terminals.Windows[m.terminals.FocusedWindow]
			text = w.visibleText()
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
