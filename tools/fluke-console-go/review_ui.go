package main

import (
	"fmt"
	"strconv"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

type taskReviewResult struct {
	generation uint64
	data       taskReview
	err        error
}

type reviewPanel struct {
	open               bool
	task               Task
	generation         uint64
	loading            bool
	data               taskReview
	err                error
	scroll             int
	lines              []string
	lineWidth          int
	integration        *integrationPlan
	integrationLoading bool
	publication        *githubPRPlan
	publicationLoading bool
	publicationEditing int
	githubStatus       string
}

func (p *reviewPanel) start(task Task) tea.Cmd {
	if p.task.ID != task.ID {
		p.githubStatus = ""
	}
	p.open = true
	p.task = task
	p.generation++
	p.loading = true
	p.err = nil
	p.data = taskReview{}
	p.scroll = 0
	p.lines = nil
	p.integration, p.integrationLoading = nil, false
	p.publication, p.publicationLoading, p.publicationEditing = nil, false, 0
	if task.ID == "" {
		p.loading = false
		return nil
	}
	generation := p.generation
	return func() tea.Msg {
		data, err := inspectTaskChanges(task)
		return taskReviewResult{generation: generation, data: data, err: err}
	}
}

func (p *reviewPanel) receive(result taskReviewResult) {
	if !p.open || result.generation != p.generation {
		return
	}
	p.loading = false
	p.data, p.err = result.data, result.err
	p.lines = nil
	p.scroll = 0
}

// The caller consumes all keys while the panel is open, keeping them out of
// an agent's terminal. Ctrl+Q remains the app's normal quit action.
func (p *reviewPanel) key(key string, width, height int) tea.Cmd {
	page := max(1, height-8)
	switch key {
	case "esc":
		p.open = false
		p.generation++
	case "r":
		return p.start(p.task)
	case "up":
		p.scroll--
	case "down":
		p.scroll++
	case "pgup":
		p.scroll -= page
	case "pgdown":
		p.scroll += page
	case "home":
		p.scroll = 0
	case "end":
		p.scroll = len(p.content(max(1, width-4)))
	}
	p.scroll = min(max(0, p.scroll), max(0, len(p.content(max(1, width-4)))-page))
	return nil
}

func reviewText(s string) string {
	return strings.ReplaceAll(cleanAgentText(ansi.Strip(s)), "\t", "    ")
}

func (p *reviewPanel) content(width int) []string {
	if p.lines != nil && p.lineWidth == width {
		return p.lines
	}
	p.lineWidth = width
	plain := ""
	switch {
	case p.task.ID == "":
		plain = localText("NO TASK TO REVIEW\n\nF2 shows the project plan.\nOnce a worker delivers, you can review its changes here.", "TODAVÍA NO HAY TAREAS PARA REVISAR\n\nF2 muestra el plan del proyecto.\nCuando haya una entrega, podés revisar sus cambios acá.")
	case p.publicationLoading:
		plain = p.publicationText()
	case p.integrationLoading:
		plain = p.integrationText()
	case p.loading:
		plain = uiText("LEYENDO WORKTREE\n\nObteniendo cambios locales…")
	case p.err != nil:
		plain = uiText("NO SE PUDO REVISAR\n\n") + reviewText(p.err.Error()) + uiText("\n\n[r] Reintentar · [Esc] Volver")
	case p.integration != nil:
		plain = p.integrationText()
	case p.publication != nil:
		plain = p.publicationText()
	default:
		base := p.task.BaseCommit
		if base == "" {
			base = uiText("HEAD (tarea anterior sin base guardada)")
		}
		plain = "BASE / " + reviewText(base) + uiText("\n\nRESUMEN\n") + reviewText(p.data.Summary)
		if p.githubStatus != "" {
			plain = reviewText(p.githubStatus) + "\n\n" + plain
		}
		if strings.TrimSpace(p.data.Summary) == "" {
			plain += uiText("Sin cambios tracked respecto de la base.")
		}
		plain += uiText("\n\nESTADO LOCAL\n") + reviewText(p.data.Status)
		if strings.TrimSpace(p.data.Status) == "" {
			plain += uiText("Worktree limpio.")
		}
		if len(p.data.Untracked) > 0 {
			plain += uiText("\n\nARCHIVOS NUEVOS\n")
			for _, name := range p.data.Untracked {
				plain += reviewText(strconv.Quote(name)) + "\n"
			}
		}
		if p.data.Truncated {
			plain += uiText("\nVISTA PARCIAL / límite de 256 KiB o 200 archivos alcanzado.\nRevisá el resto desde Git antes de aprobar.\n")
		}
		plain += "\nDIFF / BASE → WORKTREE\n" + reviewText(p.data.Diff)
		if strings.TrimSpace(p.data.Diff) == "" {
			plain += uiText("Sin contenido para mostrar.")
		}
	}
	p.lines = nil
	for _, line := range strings.Split(plain, "\n") {
		for _, part := range strings.Split(wrap(line, width), "\n") {
			styled := textStyle.Render(part)
			switch {
			case line == uiText("INTEGRAR ENTREGA"), line == uiText("INTEGRACIÓN VERIFICADA"), line == uiText("PUBLICAR PR BORRADOR"), line == uiText("ACTUALIZAR PR"), line == uiText("PR BORRADOR PUBLICADO"), line == uiText("PR PUBLICADO"):
				styled = strong(part, lime)
			case strings.HasSuffix(line, uiText("[EDITANDO]")):
				styled = strong(part, pink)
			case strings.HasPrefix(line, uiText("Desde:")), strings.HasPrefix(line, uiText("Hacia:")), line == uiText("TÍTULO"), line == uiText("DESCRIPCIÓN"):
				styled = strong(part, cyan)
			case strings.HasPrefix(line, "BASE /"), line == uiText("RESUMEN"), line == uiText("ESTADO LOCAL"), line == uiText("ARCHIVOS NUEVOS"), strings.HasPrefix(line, "DIFF /"), strings.HasPrefix(line, "@@"), strings.HasPrefix(line, "diff --git"), strings.HasPrefix(line, uiText("--- archivo nuevo")):
				styled = accent(part, cyan)
			case strings.HasPrefix(line, "+"):
				styled = accent(part, lime)
			case strings.HasPrefix(line, "-"):
				styled = accent(part, pink)
			case strings.HasPrefix(line, uiText("VISTA PARCIAL")), strings.HasPrefix(line, "["), strings.HasPrefix(line, "Binary files"):
				styled = accent(part, amber)
			case line == uiText("NO SE PUDO REVISAR"):
				styled = accent(part, pink)
			}
			p.lines = append(p.lines, styled)
		}
	}
	return p.lines
}

func (p *reviewPanel) view(width, height int) string {
	width, height = max(1, width), max(1, height)
	page := max(1, height-8)
	lines := p.content(max(1, width-4))
	p.scroll = min(max(0, p.scroll), max(0, len(lines)-page))
	end := min(len(lines), p.scroll+page)
	header := accent(reviewText(p.task.Title), pink) + "\n" + accent(reviewText(p.task.Branch), muted)
	header += "\n" + accent(fmt.Sprintf(uiText("[PgUp/PgDn] Leer  [r] Actualizar  [Esc] Volver  ·  %d–%d/%d"), p.scroll+1, end, len(lines)), cyan)
	if p.task.ID == "" {
		header = accent(localText("[F2] Open project  [Esc] Return", "[F2] Ver proyecto  [Esc] Volver"), cyan)
	}
	if p.task.Status == "awaiting_review" && !p.loading && p.err == nil {
		header += accent(uiText("  [a] Aceptar  [c] Pedir cambios"), lime)
	}
	if p.task.Status == "accepted" && !p.loading && p.err == nil && p.integration == nil && !p.integrationLoading && p.publication == nil && !p.publicationLoading {
		header += accent(uiText("  [m] Integrar  [p] PR borrador  [a] Reaceptar"), lime)
		if p.task.Integration == nil {
			header += accent(uiText("  [c] Pedir cambios"), lime)
		}
	}
	if p.integration != nil && !p.integrationLoading && p.integration.MergedCommit == "" {
		header += accent(uiText("  [Enter] Confirmar integración"), lime)
	}
	if p.publication != nil && !p.publicationLoading && !p.publication.Complete {
		if p.publicationEditing == 0 {
			header += accent(uiText("  [e] Editar  [Enter] Publicar"), lime)
		} else {
			header += accent(uiText("  [Tab] Campo  [Ctrl+S] Vista previa"), amber)
		}
	}
	body := header + "\n" + strings.Join(lines[p.scroll:end], "\n")
	return frame(uiText("F7 / REVISIÓN LOCAL"), body, width, height, pink, true)
}
