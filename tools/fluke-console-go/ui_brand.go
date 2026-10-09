package main

import (
	"charm.land/lipgloss/v2"
	"fmt"
	"github.com/charmbracelet/x/ansi"
	"image/color"
	"path/filepath"
	"strings"
)

// neonFrame follows the approved console: ink on the dark canvas, a quiet cyan
// outline, and one stronger magenta outline for the panel that owns the focus.
// It keeps frame's dimensions so navigation and terminal coordinates stay valid.
func neonFrame(title, body string, w, h int, ink color.Color, focused bool) string {
	if w < 4 || h < 4 {
		return fit(body, w, h)
	}
	left, right, topLeft, topRight, bottomLeft, bottomRight, horizontal := "│", "│", "┌", "┐", "└", "┘", "─"
	if focused {
		ink = pink
		left, right, topLeft, topRight, bottomLeft, bottomRight, horizontal = "┃", "┃", "┏", "┓", "┗", "┛", "━"
	}
	inside := w - 2
	outline := func(first, last string) string { return accent(first+strings.Repeat(horizontal, inside)+last, ink) }
	lines := []string{
		outline(topLeft, topRight),
		accent(left, ink) + fit(" "+strong(strings.ToUpper(title), ink), inside, 1) + accent(right, ink),
		accent(left, ink) + accent(strings.Repeat("─", inside), ink) + accent(right, ink),
	}
	for _, line := range strings.Split(fit(body, inside-2, h-4), "\n") {
		lines = append(lines, accent(left, ink)+" "+line+" "+accent(right, ink))
	}
	lines = append(lines, outline(bottomLeft, bottomRight))
	return strings.Join(lines, "\n")
}

var brandLogo = [...]string{
	"█▀▀ █   █ █ █▄▀ █▀▀",
	"█▀  █▄▄ █▄█ █ █ ██▄",
	"",
}

// The two lobes meet at the bottom, like the whale tail in fluke-icon.svg.
const brandTail = "▙▟"

// brandHeader is exactly six terminal rows; tabs are supplied by the app so
// visual navigation and its mouse targets share the same source.
func (m *model) brandHeader(tabs string) string {
	w := max(1, m.width)
	logo := brandLogo
	pending := 0
	for _, decision := range m.state.Decisions {
		if decision.Answer == nil {
			pending++
		}
	}
	infoWidth := max(1, w-24)
	info := []string{
		strong(uiText("TU PROYECTO, EN VIVO"), cyan) + accent("  /  LOCAL", muted),
		strong(uiText("PROYECTO: ")+filepath.Base(m.repo), cyan) + accent("  ·  "+tailText(m.repo, max(1, infoWidth-ansi.StringWidth(filepath.Base(m.repo))-15)), muted),
		workerCapacity(m.liveWorkers(), m.state.MaxWorkers, 8) + accent(fmt.Sprintf(uiText("   %d decisiones pendientes"), pending), attentionInk(pending)),
	}
	if m.home {
		info[0] = strong(localText("ALL YOUR PROJECTS, IN MOTION", "TODOS TUS PROYECTOS, EN MARCHA"), cyan)
		info[1] = strong(fmt.Sprintf(localText("%d PROJECTS", "%d PROYECTOS"), len(m.state.Projects)), cyan) + accent(localText("  ·  [N] Create  [O] Open", "  ·  [N] Crear  [O] Abrir"), muted)
	}
	if !m.home && m.state.PausedProjects[m.repo] {
		info[0] = strong(uiText("PROYECTO EN PAUSA"), amber) + accent(uiText("  /  FLUKE DISPONIBLE"), cyan)
	}
	lines := []string{accent("┌"+strings.Repeat("─", max(0, w-2))+"┐", cyan)}
	for i, row := range logo {
		line := strong(" "+fit(row, 19, 1), cyan) + "  " + ansi.Truncate(info[i], infoWidth, "…")
		lines = append(lines, accent("│", cyan)+fit(line, w-2, 1)+accent("│", cyan))
	}
	lines = append(lines, accent("│", cyan)+fit(tabs, w-2, 1)+accent("│", cyan), accent("└"+strings.Repeat("─", max(0, w-2))+"┘", cyan))
	return strings.Join(lines, "\n")
}

// brandTranscriptLines returns all visible conversation lines, rather than
// cutting the history here: the app can page through the same styled transcript.
func brandTranscriptLines(messages []ConversationMessage, w int) []string {
	lines := []string{}
	for _, msg := range messages {
		label, ink := "FLUKE", pink
		if msg.Role == "human" {
			label, ink = uiText("VOS"), cyan
		}
		gutter, continuation := "", ""
		if w >= 22 {
			gutter = strong(fmt.Sprintf("%-5s", label), ink) + accent(" │ ", ink)
			continuation = "      " + accent("│ ", ink)
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
		lines = append(lines, "")
	}
	return lines
}

// Wrap the draft itself before styling so spaces, explicit newlines and the
// insertion point survive resizing. Reserve one cell for the end cursor.
func composerLines(draft string, w int) []string {
	return strings.Split(ansi.Hardwrap(draft, max(1, w-6), true), "\n")
}

func brandComposer(draft string, w int, focused bool) string {
	return brandComposerRows(draft, w, focused, len(composerLines(draft, w)))
}

func brandComposerRows(draft string, w int, focused bool, rows int) string {
	if w < 8 {
		return fit("> "+draft, w, max(1, rows)+2)
	}
	ink := muted
	if focused {
		ink = cyan
	}
	lines := composerLines(draft, w)
	start := max(0, len(lines)-max(1, rows))
	top := "┌" + strings.Repeat("─", w-2) + "┐"
	if start > 0 {
		top = "┌…" + strings.Repeat("─", w-3) + "┐"
	}
	out := []string{accent(top, ink)}
	for i := start; i < len(lines); i++ {
		prefix := "  "
		if i == 0 {
			prefix = "> "
		}
		input := strong(prefix, ink) + lines[i]
		if focused && i == len(lines)-1 {
			input += strong("▌", cyan)
		}
		if draft == "" {
			input += accent(tailText(uiText("Hablá con Fluke…"), w-6), muted)
		}
		out = append(out, accent("│", ink)+fit(" "+input, w-2, 1)+accent("│", ink))
	}
	out = append(out, accent("└"+strings.Repeat("─", w-2)+"┘", ink))
	return strings.Join(out, "\n")
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
