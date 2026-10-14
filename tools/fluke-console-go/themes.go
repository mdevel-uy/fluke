package main

import (
	"fmt"
	"image/color"
	"strings"

	"charm.land/lipgloss/v2"
)

type consoleTheme struct {
	ID, Name, DescriptionEN, DescriptionES                            string
	Background, Foreground, Structure, Focus, Success, Warning, Muted string
}

var consoleThemes = []consoleTheme{
	{"neon", "Fluke", "Graphite with soft blue and lavender accents.", "Grafito con acentos suaves de azul y lavanda.", "#15151e", "#e2e0ec", "#a5b9dd", "#b6a1ed", "#a5c4a0", "#dfbe86", "#9493a7"},
	{"amber", "Amber CRT", "Warm phosphor on a dark screen.", "Fósforo cálido sobre pantalla oscura.", "#171008", "#ffe6bb", "#ffc16a", "#fff0b3", "#c6db8a", "#ffab70", "#b6a082"},
	{"phosphor", "Phosphor", "Green terminal, restrained highlights.", "Terminal verde, acentos contenidos.", "#07140d", "#dcf5df", "#83e6a0", "#c7f58a", "#70e3aa", "#ead184", "#8aaf96"},
	{"midnight", "Midnight", "Deep blue for long work sessions.", "Azul profundo para sesiones largas.", "#0b1526", "#e2eaf7", "#83b9fa", "#c7adfa", "#8ddbb7", "#f2cc87", "#93a6c3"},
	{"gentle", "Gentle", "Ink, soft blue and rose. Inspired by Gentle Shell.", "Tinta, azul suave y rosa. Inspirado en Gentle Shell.", "#080b12", "#edf0f5", "#93b9cd", "#d49aac", "#b9cc91", "#dfc18e", "#939dad"},
	{"paper", "Paper", "Warm paper, dark ink, daylight contrast.", "Papel cálido, tinta oscura, luz de día.", "#f4efe4", "#292d35", "#245d78", "#81436b", "#286443", "#835016", "#656268"},
}

func themeIndex(id string) int {
	for i, theme := range consoleThemes {
		if theme.ID == id {
			return i
		}
	}
	return 0
}

// One palette per console process, shared by the shell and default VT colors.
func applyTheme(id string) {
	p := consoleThemes[themeIndex(id)]
	ground, foreground = lipgloss.Color(p.Background), lipgloss.Color(p.Foreground)
	cyan, pink = lipgloss.Color(p.Structure), lipgloss.Color(p.Focus)
	lime, amber, muted = lipgloss.Color(p.Success), lipgloss.Color(p.Warning), lipgloss.Color(p.Muted)
	br, bg, bb, _ := ground.RGBA()
	fr, fg, fb, _ := muted.RGBA()
	borderInk = color.RGBA{uint8((br*3 + fr) / 4 >> 8), uint8((bg*3 + fg) / 4 >> 8), uint8((bb*3 + fb) / 4 >> 8), 255}
	textStyle = lipgloss.NewStyle().Foreground(foreground).Background(ground)
	splashInks = []color.Color{ground, muted, cyan, cyan, lime, foreground}
	if p.ID == "neon" {
		splashInks[1], splashInks[2], splashInks[4] = lipgloss.Color("#574084"), lipgloss.Color("#247d8f"), lipgloss.Color("#a2fbff")
	}
}

func (m *model) themeView(w, h int) string {
	lines := []string{m.configNav(w - 4), ""}
	for i, theme := range consoleThemes {
		label := "  " + theme.Name
		if theme.ID == consoleThemes[themeIndex(m.state.Theme)].ID {
			label += localText(" · saved", " · guardado")
		}
		ink := muted
		if i == m.themeSelected {
			label, ink = "> "+strings.TrimSpace(label), pink
		}
		lines = append(lines, accent(label, ink))
	}
	p := consoleThemes[m.themeSelected]
	lines = append(lines, "", wrap(localText(p.DescriptionEN, p.DescriptionES), max(1, w-4)), "",
		accent(localText("Running", "En curso"), lime)+"  "+accent(localText("Waiting", "En espera"), amber)+"  "+accent(localText("Review", "Revisar"), pink))
	return frame(localText("APPEARANCE / THEMES", "APARIENCIA / TEMAS"), strings.Join(lines, "\n"), w, h, cyan, true)
}

func themeVTColor(c color.Color, prefix string) string {
	r, g, b, _ := c.RGBA()
	return fmt.Sprintf("%s;2;%d;%d;%d", prefix, r>>8, g>>8, b>>8)
}

func themeCanvas(content string) string {
	reset := "\x1b[0;" + themeVTColor(foreground, "38") + ";" + themeVTColor(ground, "48") + "m"
	return strings.NewReplacer("\x1b[0m", reset, "\x1b[m", reset).Replace(content)
}
