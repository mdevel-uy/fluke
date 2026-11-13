package main

import (
	"path/filepath"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

type floatingChat struct {
	open, focused bool
	bounds        rectangle
	gesture       *mouseGesture
}

type chatWindowSettings struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

func (m *model) saveFloatingChat() bool {
	next := m.state
	next.ChatWindow = nil
	if m.floating.open {
		r := m.floating.bounds
		next.ChatWindow = &chatWindowSettings{r.x, r.y, r.w, r.h}
	}
	return m.saveEdit(next, localText("Fluke window saved · Ctrl+F opens / closes", "Ventana de Fluke guardada · Ctrl+F abre / cierra"))
}

func (m *model) toggleFloatingChat() {
	if m.floating.open {
		previous := m.floating
		m.floating = floatingChat{}
		if !m.saveFloatingChat() {
			m.floating = previous
		}
		return
	}
	if m.repo == "" && len(m.state.Projects) > 0 {
		m.repo = m.state.Projects[m.selected%len(m.state.Projects)]
	}
	if m.repo == "" {
		m.notice = localText("Open a project before opening Fluke's chat.", "Abrí un proyecto antes de abrir el chat de Fluke.")
		return
	}
	w, h := min(66, m.width), min(20, m.workspaceHeight())
	m.floating = floatingChat{open: true, focused: true, bounds: rectangle{max(0, m.width-w-2), 0, w, h}}
	if !m.saveFloatingChat() {
		m.floating = floatingChat{}
		return
	}
	m.notice = localText("Fluke stays above your workspace · Ctrl+F closes · Esc releases focus", "Fluke queda sobre tu espacio · Ctrl+F cierra · Esc libera el foco")
}

func (m *model) floatingVisible() bool {
	return m.floating.open && m.repo != "" && !m.setup.open && !m.projects.open && !m.quitting && m.command == nil && m.workerMessageID == "" && m.review.publication == nil && m.review.integration == nil
}

func (m *model) clampFloatingChat() {
	r := &m.floating.bounds
	r.w, r.h = min(m.width, max(28, r.w)), min(m.workspaceHeight(), max(12, r.h))
	r.x, r.y = max(0, min(r.x, m.width-r.w)), max(0, min(r.y, m.workspaceHeight()-r.h))
}

func (m *model) floatingChatView(body string) string {
	m.clampFloatingChat()
	r := m.floating.bounds
	content := m.chatBody(r.w, r.h, m.floating.focused)
	title := "FLUKE / " + filepath.Base(m.repo)
	window := panelFrame(title, content, r.w, r.h, cyan, m.floating.focused, true)
	// Keep the close target visible even when the project name is long.
	layers := []*lipgloss.Layer{
		lipgloss.NewLayer(body),
		lipgloss.NewLayer(textStyle.Render(window)).X(r.x).Y(r.y),
		lipgloss.NewLayer(accent("[x]", pink)).X(r.x + r.w - 5).Y(r.y + 1),
	}
	return lipgloss.NewCompositor(layers...).Render()
}

func (m *model) floatingMouse(mouse tea.Mouse, phase string) bool {
	if m.mouseDisabled || !m.floatingVisible() || m.terminals.gesture != nil {
		return false
	}
	m.clampFloatingChat()
	r := m.floating.bounds
	mouse.Y -= m.headerRows()
	inside := mouse.X >= r.x && mouse.X < r.x+r.w && mouse.Y >= r.y && mouse.Y < r.y+r.h
	if phase == "wheel" {
		if !inside {
			return false
		}
		if mouse.Button == tea.MouseWheelUp {
			m.scrollChat(3)
		} else {
			m.scrollChat(-3)
		}
		return true
	}
	if phase == "click" {
		if !inside {
			m.floating.focused = false
			return false
		}
		if mouse.Button != tea.MouseLeft {
			return true
		}
		m.floating.focused = true
		if mouse.Y == r.y+1 && mouse.X >= r.x+r.w-5 && mouse.X <= r.x+r.w-3 {
			m.toggleFloatingChat()
			return true
		}
		edge := 0
		if mouse.X == r.x {
			edge |= edgeLeft
		}
		if mouse.X == r.x+r.w-1 {
			edge |= edgeRight
		}
		if mouse.Y == r.y {
			edge |= edgeTop
		}
		if mouse.Y == r.y+r.h-1 {
			edge |= edgeBottom
		}
		if edge != 0 || mouse.Y == r.y+1 {
			m.floating.gesture = &mouseGesture{startX: mouse.X, startY: mouse.Y, initial: r, edge: edge}
		}
		return true
	}
	if g := m.floating.gesture; g != nil {
		m.floating.bounds = dragRectangle(g.initial, mouse.X-g.startX, mouse.Y-g.startY, g.edge, m.width, m.workspaceHeight(), 28, 12)
		if phase == "release" {
			m.floating.gesture = nil
			m.saveFloatingChat()
		}
		return true
	}
	return inside
}

func (m *model) floatingHidesCursor(cursor *tea.Cursor) bool {
	if cursor == nil || !m.floatingVisible() {
		return false
	}
	r := m.floating.bounds
	return m.floating.focused || cursor.X >= r.x && cursor.X < r.x+r.w && cursor.Y >= r.y && cursor.Y < r.y+r.h
}

// Keep the opposite resize edge anchored, even when dragging past minimum size.
func dragRectangle(r rectangle, dx, dy, edge, width, height, minWidth, minHeight int) rectangle {
	minWidth, minHeight = min(minWidth, width), min(minHeight, height)
	if edge == 0 {
		r.x = max(0, min(r.x+dx, width-r.w))
		r.y = max(0, min(r.y+dy, height-r.h))
		return r
	}
	if edge&edgeLeft != 0 {
		right := r.x + r.w
		r.x = max(0, min(r.x+dx, right-minWidth))
		r.w = right - r.x
	}
	if edge&edgeRight != 0 {
		r.w = max(minWidth, min(r.w+dx, width-r.x))
	}
	if edge&edgeTop != 0 {
		bottom := r.y + r.h
		r.y = max(0, min(r.y+dy, bottom-minHeight))
		r.h = bottom - r.y
	}
	if edge&edgeBottom != 0 {
		r.h = max(minHeight, min(r.h+dy, height-r.y))
	}
	return r
}
