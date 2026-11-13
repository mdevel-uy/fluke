package main

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/x/ansi"
)

// Decisions as a two-pane overlay: this project's decisions on the left, the
// selected one (question, answer, session context) on the right.
func (m *model) decisionsView(w, h int) string {
	var indexes []int
	for i, d := range m.state.Decisions {
		if d.Repo == m.repo {
			indexes = append(indexes, i)
		}
	}
	if !m.shellMode() || w < 90 || len(indexes) == 0 {
		return m.decisionsPanels(w, h)
	}
	lw := 30
	if w >= 120 {
		lw = 36
	}
	inner := lw - 1
	selected := m.selected % len(indexes)
	lines := []string{" " + accent(localText("DECISIONS", "DECISIONES"), muted)}
	selectedLine := 0
	for pos, idx := range indexes {
		d := m.state.Decisions[idx]
		glyph, ink, word := "?", pink, localText("pending", "pendiente")
		switch {
		case d.Answer != nil:
			glyph, ink, word = "✓", lime, localText("answered", "respondida")
		case d.Assistance:
			glyph, word = "◇", localText("technical help", "ayuda técnica")
		case d.ProposedTitle != "":
			word = localText("proposal", "propuesta")
		}
		for _, t := range m.state.Tasks {
			if d.TaskID != "" && t.ID == d.TaskID {
				word += " · " + t.Title
				break
			}
		}
		mark := "  "
		question := ansi.Truncate(strings.Join(strings.Fields(cleanAgentText(d.Question)), " "), max(1, inner-9), "…")
		title := accent(question, foreground)
		if pos == selected {
			mark = "› "
			selectedLine = len(lines)
			title = strong(question, foreground)
		}
		lines = append(lines,
			" "+accent(mark, pink)+accent(glyph, ink)+" "+accent(fmt.Sprintf("%02d ", pos+1), muted)+title,
			"      "+accent(ansi.Truncate(word, max(1, inner-7), "…"), muted))
	}
	start := 0
	if len(lines) > h {
		start = max(0, min(selectedLine-h/2, len(lines)-h))
	}
	left := make([]string, h)
	sep := accent("│", borderInk)
	for i := range left {
		body := ""
		if start+i < len(lines) {
			body = lines[start+i]
		}
		left[i] = fit(body, inner, 1) + sep
	}
	right := strings.Split(fit(m.decisionsPanels(w-lw, h), w-lw, h), "\n")
	out := make([]string, h)
	for i := range out {
		out[i] = left[i] + right[i]
	}
	return strings.Join(out, "\n")
}
