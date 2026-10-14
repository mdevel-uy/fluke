package main

import (
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

type configTab struct {
	section int
	label   string
}

func configTabs(w int) []configTab {
	labels := []string{localText("Agent", "Agente"), localText("Connection", "Conexión"), "GitHub", localText("Theme", "Tema"), localText("Text", "Texto")}
	if ansi.StringWidth(strings.Join(labels, " "))+2*len(labels) > w {
		labels = []string{"CLI", localText("Link", "Conex."), "GH", localText("Theme", "Tema"), localText("Text", "Texto")}
	}
	tabs := make([]configTab, len(labels))
	sections := []int{0, 4, 1, 2, 3}
	for i := range labels {
		tabs[i] = configTab{sections[i], "[" + labels[i] + "]"}
	}
	return tabs
}

func (m *model) configNav(w int) string {
	parts := []string{}
	for _, tab := range configTabs(w) {
		if m.configSection == tab.section {
			parts = append(parts, strong(tab.label, pink))
		} else {
			parts = append(parts, accent(tab.label, muted))
		}
	}
	return strings.Join(parts, " ")
}

func (m *model) cycleConfigSection(direction int) tea.Cmd {
	tabs := configTabs(m.width - 4)
	for i, tab := range tabs {
		if tab.section == m.configSection {
			return m.selectConfigSection(tabs[(i+direction+len(tabs))%len(tabs)].section)
		}
	}
	return nil
}

func (m *model) selectConfigSection(section int) tea.Cmd {
	m.authConfirm = false
	if section != 1 && m.auth.Busy {
		m.cancelGithubAuth()
	}
	m.configSection = section
	if section == 2 {
		m.themeSelected = themeIndex(m.state.Theme)
	}
	if m.store == nil {
		return nil // The demo previews settings without probing real accounts.
	}
	if section == 1 {
		return m.refreshGithubAuth()
	}
	if section == 4 {
		return tea.Batch(m.checkProvider(), m.probeConnections())
	}
	return nil
}

func (m *model) configTabClick(mouse tea.Mouse) (bool, tea.Cmd) {
	if !m.config || m.review.open || mouse.Y != m.headerRows()+3 {
		return false, nil
	}
	// In a short agent form, its first visible line may be a scrolled field.
	if m.configSection == 0 && m.width < 104 && max(0, 2+m.field*3+2-max(1, m.workspaceHeight()-4)) > 0 {
		return false, nil
	}
	w := m.width
	if m.configSection == 0 && w >= 104 {
		w = w * 55 / 100
	}
	x := 2
	for _, tab := range configTabs(w - 4) {
		end := x + ansi.StringWidth(tab.label)
		if mouse.X >= x && mouse.X < end {
			return true, m.selectConfigSection(tab.section)
		}
		x = end + 1
	}
	return false, nil
}

func (m *model) connectionView(w, h int) string {
	if m.shellMode() && w >= 90 && h >= 16 {
		return m.connectionsShell(w, h)
	}
	body := m.configNav(w-4) + "\n\n"
	body += accent(localText("Ctrl+L · Sign in   Ctrl+R · Check", "Ctrl+L · Conectar   Ctrl+R · Comprobar"), cyan) + "\n"
	body += accent(wrap(localText("Credentials stay in the provider CLI.", "Las credenciales quedan en la CLI del proveedor."), w-4), muted) + "\n\n"
	body += m.providerStatusContent(max(1, w-4))
	if h >= 24 {
		body += "\n\n" + wrap(localText("Saved: ", "Guardado: ")+configLabel(m.state.Orchestrator), w-4)
		body += "\n" + wrap(localText("Current session: ", "Sesión actual: ")+m.effectiveConfigLabel(), w-4)
		if !m.sessionAlive("fluke:" + m.repo) {
			body += "\n" + accent(uiText("Sin sesión iniciada"), muted)
		}
	}
	return frame(localText("SETTINGS / CONNECTION", "CONFIGURACIÓN / CONEXIÓN"), body, w, h, cyan, true)
}

func (m *model) typographyView(w, h int) string {
	if h < 24 || w < 64 {
		body := m.configNav(w-4) + "\n\n"
		body += wrap(localText("Font and size belong to your terminal.", "Fuente y tamaño: los define tu terminal."), w-4) + "\n\n"
		body += strong("Windows Terminal", cyan) + "\n" + wrap(localText("Settings → Profile → Appearance", "Configuración → Perfil → Apariencia"), w-4) + "\n\n"
		body += strong("Linux / macOS", cyan) + "\n" + wrap(localText("Terminal settings → Font", "Ajustes del terminal → Fuente"), w-4) + "\n\n"
		body += wrap(localText("Monospace + Unicode: Aa 01 Il ─ │ ┌ ┐", "Monoespaciada + Unicode: Aa 01 Il ─ │ ┌ ┐"), w-4)
		return frame(localText("SETTINGS / TEXT", "CONFIGURACIÓN / TEXTO"), body, w, h, cyan, true)
	}
	paragraphs := []string{
		m.configNav(w - 4),
		"",
		strong(localText("Text that stays readable", "Texto que se lee cómodo"), cyan),
		localText("The host terminal controls the font and size. Fluke uses its monospace cells, bold text and Unicode borders.", "El terminal anfitrión controla la fuente y el tamaño. Fluke usa sus celdas monoespaciadas, negrita y bordes Unicode."),
		"",
		strong("Windows Terminal", cyan),
		localText("Settings → your profile → Appearance → Font face / Font size.", "Configuración → tu perfil → Apariencia → Tipo y tamaño de fuente."),
		"",
		strong("Linux / macOS", cyan),
		localText("Open the settings of the terminal running Fluke. Choose a monospace font with Unicode box-drawing support.", "Abrí los ajustes del terminal que ejecuta Fluke. Elegí una fuente monoespaciada con soporte para bordes Unicode."),
		"",
		localText("Preview:  Aa Bb 01 Il  {} []  →  ─ │ ┌ ┐ └ ┘", "Muestra:  Aa Bb 01 Il  {} []  →  ─ │ ┌ ┐ └ ┘"),
	}
	for i := 3; i < len(paragraphs); i++ {
		paragraphs[i] = wrap(paragraphs[i], max(1, w-4))
	}
	return frame(localText("SETTINGS / TEXT", "CONFIGURACIÓN / TEXTO"), strings.Join(paragraphs, "\n"), w, h, cyan, true)
}
