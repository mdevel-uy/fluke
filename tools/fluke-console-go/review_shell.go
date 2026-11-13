package main

import (
	"fmt"
	"path/filepath"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// Review as a two-pane overlay: the project's deliveries on the left, the
// selected delivery (criteria and evidence first, then the diff) on the right.
// Integration and PR publication keep rendering inside the right pane.

func (m *model) reviewOverlay() bool {
	return m.shellMode() && m.width >= 90 && m.workspaceHeight() >= 14 && m.review.task.ID != ""
}

func (m *model) reviewListWidth() int {
	if m.width >= 120 {
		return 32
	}
	return 26
}

// Width and legacy-equivalent height for everything that scrolls or follows a
// caret in the review panel; the panel's key handling is written for the full
// frame (three header rows and a title), so the overlay reports a taller one.
func (m *model) reviewDimsW() int {
	if m.reviewOverlay() {
		return m.width - m.reviewListWidth()
	}
	return m.width
}

func (m *model) reviewDimsH() int {
	if m.reviewOverlay() {
		return m.workspaceHeight() + 4
	}
	return m.workspaceHeight()
}

// Deliveries of the current project that can be reviewed, plus the task that is open.
func (m *model) reviewTasks() []Task {
	var out []Task
	seen := map[string]bool{}
	add := func(t Task) {
		if !seen[t.ID] {
			seen[t.ID] = true
			out = append(out, t)
		}
	}
	for _, t := range m.state.Tasks {
		if t.Repo == m.repo && (t.Status == "awaiting_review" || t.Status == "accepted") {
			add(t)
		}
	}
	if m.review.task.ID != "" {
		current := m.review.task
		for _, t := range m.state.Tasks {
			if t.ID == current.ID {
				current = t
			}
		}
		add(current)
	}
	return out
}

func (m *model) reviewMove(delta int) tea.Cmd {
	tasks := m.reviewTasks()
	if len(tasks) < 2 {
		return nil
	}
	at := 0
	for i, t := range tasks {
		if t.ID == m.review.task.ID {
			at = i
		}
	}
	return m.review.start(tasks[(at+delta+len(tasks))%len(tasks)])
}

func (m *model) reviewView(w, h int) string {
	if !m.reviewOverlay() {
		return m.review.view(w, h)
	}
	p := &m.review
	lw := m.reviewListWidth()
	dw := w - lw
	rows := max(1, h-1)
	page := max(1, rows-3)
	lines := p.content(max(1, dw-4))
	p.scroll = min(max(0, p.scroll), max(0, len(lines)-page))
	end := min(len(lines), p.scroll+page)

	bar := strong(localText(" REVIEW", " REVISIÓN"), pink) + accent("  ·  F7", muted)
	position := ""
	if len(lines) > page {
		position = fmt.Sprintf("%d–%d/%d  ", p.scroll+1, end, len(lines))
	}
	right := accent(position+localText("Esc back", "Esc volver")+" ", muted)
	gap := max(1, w-ansi.StringWidth(bar)-ansi.StringWidth(right))
	out := []string{fit(bar+strings.Repeat(" ", gap)+right, w, 1)}

	list := m.reviewList(lw, rows)
	detail := make([]string, 0, rows)
	detail = append(detail, strong(reviewText(p.task.Title), pink))
	var meta []string
	if p.task.Branch != "" {
		meta = append(meta, reviewText(p.task.Branch))
	}
	meta = append(meta, shellStatusWord(taskAgentStatus(p.task)))
	if model := taskModelLabel(p.task); model != "—" {
		meta = append(meta, model)
	}
	detail = append(detail, accent(strings.Join(meta, "  ·  "), muted), "")
	detail = append(detail, lines[p.scroll:end]...)
	for i := 0; i < rows; i++ {
		left := strings.Repeat(" ", lw)
		if i < len(list) {
			left = list[i]
		}
		body := ""
		if i < len(detail) {
			body = detail[i]
		}
		out = append(out, left+" "+fit(body, max(1, dw-3), 1)+" ")
	}
	return strings.Join(out, "\n")
}

// Left pane: two rows per delivery (title, then state and model), with a
// separator on its right edge.
func (m *model) reviewList(w, rows int) []string {
	tasks := m.reviewTasks()
	inner := max(4, w-1)
	var lines []string
	selectedLine := 0
	lines = append(lines, " "+accent(strings.ToUpper(filepath.Base(m.repo)), muted))
	for _, t := range tasks {
		glyph, ink := taskGlyph(t)
		selected := t.ID == m.review.task.ID
		mark, title := "  ", accent(ansi.Truncate(t.Title, max(1, inner-6), "…"), foreground)
		if selected {
			mark = "› "
			selectedLine = len(lines)
			title = strong(ansi.Truncate(t.Title, max(1, inner-6), "…"), foreground)
		}
		meta := shellStatusWord(taskAgentStatus(t))
		if model := taskModelLabel(t); model != "—" {
			meta += " · " + model
		}
		lines = append(lines,
			" "+accent(mark, pink)+accent(glyph, ink)+" "+title,
			"     "+accent(ansi.Truncate(meta, max(1, inner-6), "…"), muted))
	}
	hint := localText("One delivery to review.", "Una entrega para revisar.")
	if len(tasks) > 1 {
		hint = localText("[Tab] next delivery", "[Tab] siguiente entrega")
	}
	lines = append(lines, "", " "+accent(hint, muted))
	start := 0
	if len(lines) > rows {
		start = max(0, min(selectedLine-rows/2, len(lines)-rows))
	}
	sep := accent("│", borderInk)
	out := make([]string, rows)
	for i := range out {
		body := ""
		if start+i < len(lines) {
			body = lines[start+i]
		}
		out[i] = fit(body, inner, 1) + sep
	}
	return out
}
