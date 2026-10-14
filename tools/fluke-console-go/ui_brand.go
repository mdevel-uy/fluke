package main

import (
	"charm.land/lipgloss/v2"
	"fmt"
	"github.com/charmbracelet/x/ansi"
	"image/color"
	"path/filepath"
	"strings"
)

// Keep title/body coordinates shared with hit testing; only floating panels need an outline.
func panelFrame(title, body string, w, h int, ink color.Color, focused, outlined bool) string {
	if w < 4 || h < 4 {
		return fit(body, w, h)
	}
	ink = foreground
	marker := "  "
	if focused {
		ink = pink
		marker = "› "
	}
	inside := w - 2
	left, right := " ", " "
	top, bottom := strings.Repeat(" ", w), strings.Repeat(" ", w)
	if outlined {
		left, right = accent("│", borderInk), accent("│", borderInk)
		top = accent("┌"+strings.Repeat("─", inside)+"┐", borderInk)
		bottom = accent("└"+strings.Repeat("─", inside)+"┘", borderInk)
	}
	lines := []string{
		top,
		left + fit(accent(marker+title, ink), inside, 1) + right,
		left + accent(strings.Repeat("─", inside), borderInk) + right,
	}
	for _, line := range strings.Split(fit(body, inside-2, h-4), "\n") {
		lines = append(lines, left+" "+line+" "+right)
	}
	lines = append(lines, bottom)
	return strings.Join(lines, "\n")
}

var brandLogo = [...]string{
	" ▄█▀▀  ██   ▄▄ ▄▄ ██ ▄▄  ▄▄▄ ",
	"▀██▀   ██   ██ ██ ███▀  ██▄██",
	" ██    ██▄▄ ▀███▀ ██▀█▄ ▀█▄▄▄",
}

// Navigation always occupies row 1, regardless of terminal width.
func (m *model) brandHeader(tabs string) string {
	w := max(1, m.width)
	pending := 0
	for _, decision := range m.state.Decisions {
		if decision.Answer == nil {
			pending++
		}
	}
	label := filepath.Base(m.repo)
	if m.home {
		label = fmt.Sprintf(localText("%d projects", "%d proyectos"), len(m.state.Projects))
		if len(m.state.Projects) == 1 {
			label = localText("1 project", "1 proyecto")
		}
	}
	if !m.home && m.state.PausedProjects[m.repo] {
		label += localText(" · paused", " · en pausa")
	}
	right := fmt.Sprintf("%d/%d workers", m.liveWorkers(), m.state.MaxWorkers)
	if pending > 0 {
		right += fmt.Sprintf(localText(" · %d to decide", " · %d por decidir"), pending)
	}
	left := strong(" fluke", cyan) + accent("  /  ", borderInk) + label
	if !m.home && m.repo != "" && w >= 100 {
		identity := cleanAgentText(m.effectiveConfigLabel())
		if ansi.StringWidth(left)+ansi.StringWidth(identity)+ansi.StringWidth(right)+7 <= w {
			left += accent("  ·  "+identity, muted)
		}
	}
	if w < 64 {
		right = fmt.Sprintf("%d/%d", m.liveWorkers(), m.state.MaxWorkers)
	}
	space := max(1, w-ansi.StringWidth(right)-2)
	line := fit(ansi.Truncate(left, space, "…"), space, 1) + " " + accent(right, attentionInk(pending))
	return fit(line+"\n"+tabs+"\n"+rule(w, borderInk), w, 3)
}

// brandTranscriptLines returns all visible conversation lines, rather than
// cutting the history here: the app can page through the same styled transcript.
func brandTranscriptLines(messages []ConversationMessage, w int) []string {
	lines := []string{}
	for index, msg := range messages {
		label, ink := "Fluke", pink
		if msg.Role == "human" {
			label, ink = localText("You", "Vos"), muted
		}
		gutter, continuation := "", ""
		if w >= 22 {
			gutter = strong(fmt.Sprintf("%-5s", label), ink) + "   "
			continuation = "        "
		} else {
			lines = append(lines, strong(label, ink))
		}
		parts := strings.Split(wrap(reviewText(msg.Text), max(1, w-ansi.StringWidth(gutter))), "\n")
		for i, part := range parts {
			prefix := continuation
			if i == 0 {
				prefix = gutter
			}
			lines = append(lines, prefix+part)
		}
		if msg.Delivery == "pending" {
			lines = append(lines, continuation+accent(uiText("Pendiente de envío…"), amber))
		} else if msg.Delivery == "uncertain" {
			lines = append(lines, continuation+accent(uiText("Envío incierto · revisá F3"), amber))
		}
		if index < len(messages)-1 {
			lines = append(lines, "")
		}
	}
	return lines
}

func brandComposer(draft string, w int, focused bool) string {
	if w < 8 {
		return fit("> "+draft, w, 3)
	}
	ink := muted
	if focused {
		ink = cyan
	}
	prompt := tailText(strings.ReplaceAll(draft, "\n", " "), w-6)
	input := strong("> ", ink) + prompt
	if focused {
		input += strong("▌", cyan)
	}
	if draft == "" {
		input += accent(tailText(uiText("Hablá con Fluke…"), w-6), muted)
	}
	return accent("┌"+strings.Repeat("─", w-2)+"┐", ink) + "\n" + accent("│", ink) + fit(" "+input, w-2, 1) + accent("│", ink) + "\n" + accent("└"+strings.Repeat("─", w-2)+"┘", ink)
}

func strong(s string, c color.Color) string {
	return lipgloss.NewStyle().Foreground(c).Background(ground).Bold(true).Render(s)
}
func attentionInk(n int) color.Color {
	if n > 0 {
		return amber
	}
	return muted
}
func tailText(s string, w int) string {
	w = max(1, w)
	if ansi.StringWidth(s) <= w {
		return s
	}
	if w == 1 {
		return "…"
	}
	cut := ansi.StringWidth(s) - w + 1
	tail := ansi.TruncateLeft(s, cut, "…")
	for ansi.StringWidth(tail) > w {
		cut++
		tail = ansi.TruncateLeft(s, cut, "…")
	}
	return tail
}
func shortBranch(s string) string {
	return strings.TrimPrefix(s, "codex/fluke/")[:min(9, len(strings.TrimPrefix(s, "codex/fluke/")))]
}
func workerCapacity(live, limit, width int) string {
	used := min(width, (live*width+max(1, limit)-1)/max(1, limit))
	return accent("WORKERS ", cyan) + strong(fmt.Sprintf("%d/%d ", live, limit), lime) + accent(strings.Repeat("━", used), lime) + accent(strings.Repeat("─", max(0, width-used)), muted)
}
func missionFlow(t Task, w int) string {
	left := (w - 8) * 27 / 100
	middle := (w - 8) * 43 / 100
	right := w - 8 - left - middle
	workerInk := statusInk(taskAgentStatus(t))
	provider := strings.ToUpper(t.AgentProvider)
	if provider == "" {
		provider = uiText("POR INICIAR")
	}
	worker := strong(provider, cyan) + "\n" + accent(shortBranch(t.Branch), muted) + "\n" + strong(status(taskAgentStatus(t)), workerInk)
	contract := strong(uiText("ACORDADO"), lime) + "\n" + uiText("Criterio definido")
	review := accent(uiText("Esperando entrega"), muted) + "\n\n" + accent(uiText("Decisión humana"), cyan)
	if t.Status == "awaiting_review" {
		review = strong(uiText("PARA REVISAR"), pink) + "\n" + accent(uiText("F7 · abrir diff"), cyan)
	}
	if t.Status == "accepted" {
		review = strong(uiText("ACEPTADA"), lime) + "\n" + accent(uiText("F7 · integrar"), cyan)
	}
	if t.Integration != nil && t.Integration.MergedCommit != "" {
		review = strong(uiText("INTEGRADA"), lime) + "\n" + accent(t.Integration.TargetBranch, cyan)
	}
	arrow := accent(" -->", muted)
	return lipgloss.JoinHorizontal(lipgloss.Center, frame(uiText("ALCANCE"), contract, left, 7, cyan, false), arrow, frame("WORKER", worker, middle, 7, workerInk, false), arrow, frame(uiText("REVISIÓN"), review, right, 7, cyan, false))
}

func projectFlow(goal ProjectGoal, tasks []Task, w int) string {
	pending, running, review, accepted, integrated := 0, 0, 0, 0, 0
	for _, t := range tasks {
		if t.GoalID != "" && t.GoalID != goal.ID {
			continue
		}
		switch t.Status {
		case "pending", "interrupted":
			pending++
		case "running":
			running++
		case "awaiting_review":
			review++
		case "accepted":
			if t.Integration != nil && t.Integration.MergedCommit != "" {
				integrated++
			} else {
				accepted++
			}
		}
	}
	left := (w - 8) * 27 / 100
	middle := (w - 8) * 43 / 100
	right := w - 8 - left - middle
	plan := strong(uiText("ALCANCE ACORDADO"), lime) + "\n" + fmt.Sprintf(uiText("%d tareas pendientes"), pending)
	execution := strong(fmt.Sprintf(uiText("%d WORKERS ACTIVOS"), running), cyan) + "\n" + uiText("Un worker por tarea")
	delivery := accent(uiText("Esperando entregas"), muted) + "\n" + accent(uiText("Revisión humana"), cyan)
	if review > 0 {
		delivery = strong(fmt.Sprintf(uiText("%d PARA REVISAR"), review), pink) + "\n" + accent(uiText("F7 · abrir diff"), cyan)
	} else if accepted > 0 {
		delivery = strong(fmt.Sprintf(uiText("%d PARA INTEGRAR"), accepted), lime) + "\n" + accent(uiText("F7 · confirmar merge"), cyan)
	} else if integrated > 0 {
		delivery = strong(fmt.Sprintf(uiText("%d INTEGRADAS"), integrated), lime) + "\n" + accent(uiText("Cambios en la base"), cyan)
	}
	arrow := accent(" -->", muted)
	return lipgloss.JoinHorizontal(lipgloss.Center, frame("PLAN", plan, left, 6, cyan, false), arrow, frame(uiText("EJECUCIÓN"), execution, middle, 6, cyan, false), arrow, frame(uiText("ENTREGA"), delivery, right, 6, cyan, false))
}
