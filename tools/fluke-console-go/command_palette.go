package main

import tea "charm.land/bubbletea/v2"

// Discoverable entry points only: selecting a result never starts or stops work.
func (m *model) commandTargets() []switchTarget {
	config := localText("Settings", "Configuración")
	views := localText("Views", "Vistas")
	targets := []switchTarget{
		{label: localText("Agent and model", "Agente y modelo"), detail: config + " · F5 · " + configLabel(m.state.Orchestrator), action: "models"},
		{label: localText("Connections and usage", "Conexiones y consumo"), detail: config + localText(" · CLI status, sign-in and reported usage", " · Estado de CLI, inicio de sesión y consumo reportado"), action: "connection"},
		{label: localText("GitHub connection", "Conexión de GitHub"), detail: config + localText(" · Account and browser sign-in", " · Cuenta e inicio desde el navegador"), action: "github"},
		{label: localText("Appearance and themes", "Apariencia y temas"), detail: config + " · " + consoleThemes[themeIndex(m.state.Theme)].Name, action: "theme"},
		{label: localText("Terminal typography", "Tipografía del terminal"), detail: config + localText(" · Font, size and Unicode", " · Fuente, tamaño y Unicode"), action: "typography"},
		{label: localText("Projects", "Proyectos"), detail: views + " · F1", action: "f1"},
		{label: localText("Find a project or worker", "Buscar proyecto o worker"), detail: views + " · Ctrl+P", action: "ctrl+p"},
	}
	if m.repo != "" {
		targets = append(targets,
			switchTarget{label: localText("Project conversation", "Conversación del proyecto"), detail: views + " · F2", action: "f2"},
			switchTarget{label: localText("Worker terminals", "Terminales de workers"), detail: views + " · F3", action: "f3"},
			switchTarget{label: localText("Pending decisions", "Decisiones pendientes"), detail: views + " · F4", action: "f4"},
		)
	}
	if m.store != nil {
		targets = append(targets, switchTarget{label: localText("Write a command", "Escribir un comando"), detail: localText("Advanced · Ctrl+K · review before running", "Avanzado · Ctrl+K · revisar antes de ejecutar"), action: "ctrl+k"})
	}
	return targets
}

func (m *model) openCommandTarget(action string) tea.Cmd {
	section := 0
	switch action {
	case "models":
	case "connection":
		section = 4
	case "github":
		section = 1
	case "theme":
		section = 2
	case "typography":
		section = 3
	default:
		_, cmd := m.globalKey(action)
		return cmd
	}
	if !m.config {
		m.closePanels()
		m.openConfig()
	}
	m.floating.focused = false
	cmd := m.selectConfigSection(section)
	if action == "models" {
		m.field = 2
	} else if action == "connection" {
		m.field = 0
	}
	if section == 0 && m.store != nil {
		return m.checkProvider()
	}
	return cmd
}
