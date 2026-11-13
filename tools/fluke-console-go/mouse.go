package main

import (
	tea "charm.land/bubbletea/v2"
	"fmt"
	"github.com/charmbracelet/x/ansi"
	"strings"
)

func (m *model) clickNavigation(mouse tea.Mouse) (bool, tea.Cmd) {
	if m.mouseDisabled || m.setup.open || m.quitting || m.projects.open || mouse.Button != tea.MouseLeft {
		return false, nil
	}
	x, y := m.navOrigin()
	origin := x
	if mouse.Y == y {
		for i, label := range m.tabLabels() {
			width := ansi.StringWidth(label) + 2
			if mouse.X >= x && mouse.X < x+width {
				return m.globalKey(fmt.Sprintf("f%d", i+1))
			}
			x += width + 1
		}
		if !m.shellMode() && mouse.X >= x && mouse.X < x+6 {
			return m.globalKey("ctrl+f")
		}
		if !m.shellMode() && strings.Contains(m.tabs(), "[Ctrl+P]") && mouse.X >= x+7 && mouse.X < x+15 {
			return m.globalKey("ctrl+p")
		}
		bar := ansi.Strip(m.tabs())
		if index := strings.Index(bar, "[Alt+K]"); index >= 0 {
			start := origin + ansi.StringWidth(bar[:index])
			if mouse.X >= start && mouse.X < start+7 {
				return m.globalKey("alt+k")
			}
		}
	}
	return false, nil
}

func (m *model) clickPanel(mouse tea.Mouse) bool {
	if m.mouseDisabled || m.setup.open || m.quitting || m.projects.open || mouse.Button != tea.MouseLeft {
		return false
	}
	if m.config && !m.review.open && mouse.Y >= m.headerRows() {
		row := mouse.Y - m.headerRows()
		if m.configSection == 2 && row >= 5 && row < 5+len(consoleThemes) {
			m.themeSelected = row - 5
			return true
		}
		left := m.width
		offset := 0
		if m.width >= 104 {
			left = m.width * 55 / 100
		} else {
			offset = max(0, 2+m.field*3+2-max(1, m.workspaceHeight()-4))
		}
		if m.configSection == 0 && row == 4 && mouse.X < left && offset == 0 {
			m.themeSelected, m.configSection = themeIndex(m.state.Theme), 2
			return true
		}
	}
	return false
}
