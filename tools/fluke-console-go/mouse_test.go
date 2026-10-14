package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/hinshun/vt10x"
)

func TestVisibleTabMatchesPanelAndMouseAtEveryWidth(t *testing.T) {
	previous := uiLanguage()
	t.Cleanup(func() { setUILanguage(previous) })
	m := projectTestModel(t)
	m.repo = t.TempDir()
	for _, language := range []string{"es", "en"} {
		setUILanguage(language)
		for _, width := range []int{44, 60, 76, 80, 88, 100, 104, 119, 120, 140} {
			m.width, m.height = width, 36
			if ansi.StringWidth(m.tabs()) > m.navBudget() {
				t.Fatalf("tabs clipped at %d", width)
			}
			// The header's lead text and label variant depend on state, so the
			// position of a tab is looked up again after each click.
			tabAt := func(tab int) (int, int) {
				x, y := m.navOrigin()
				for i, label := range m.tabLabels() {
					if i == tab {
						break
					}
					x += ansi.StringWidth(label) + 3
				}
				return x, y
			}
			for tab := 0; tab < 7; tab++ {
				x, y := tabAt(tab)
				m.Update(tea.MouseClickMsg{X: x + 1, Y: y, Button: tea.MouseLeft})
				if m.activeTab() != tab {
					t.Fatalf("click F%d at %d selected %d", tab+1, width, m.activeTab()+1)
				}
				x, y = tabAt(tab)
				screen := vt10x.New(vt10x.WithSize(width, 36))
				screen.Write([]byte(strings.ReplaceAll(m.View().Content, "\n", "\r\n")))
				if screen.Cell(x+1, y).BG != vt10x.Color(0xb6a1ed) {
					t.Fatalf("F%d not highlighted at %d", tab+1, width)
				}
			}
		}
	}
	m.globalKey("f5")
	m.Update(tea.KeyPressMsg{Code: 'g', Mod: tea.ModCtrl})
	if m.activeTab() != 4 || m.configSection != 1 {
		t.Fatal("GitHub connection should remain in F5")
	}
	m.repo = ""
	m.globalKey("f6")
	if m.activeTab() != 4 || !m.config {
		t.Fatal("GitHub without a project must highlight its F5 connection screen")
	}
}

func TestFloatingChatMouseFocusDoesNotEditUnderlyingPanel(t *testing.T) {
	m := projectTestModel(t)
	m.repo = t.TempDir()
	m.width, m.height = 140, 40
	m.openConfig()
	m.globalKey("ctrl+f")
	if !m.floatingVisible() {
		t.Fatal("chat did not open")
	}
	draft := m.draft
	m.Update(tea.KeyPressMsg{Code: 'h', Text: "hola"})
	m.Update(tea.PasteMsg{Content: " Fluke"})
	if m.chatDraft[m.repo] != "hola Fluke" || m.draft != draft {
		t.Fatal("chat input leaked to config")
	}
	r := m.floating.bounds
	m.Update(tea.MouseClickMsg{X: r.x + 6, Y: m.headerRows() + r.y + 1, Button: tea.MouseLeft})
	m.Update(tea.MouseMotionMsg{X: r.x - 4, Y: m.headerRows() + r.y + 4, Button: tea.MouseLeft})
	m.Update(tea.MouseReleaseMsg{X: r.x - 4, Y: m.headerRows() + r.y + 4, Button: tea.MouseLeft})
	if m.floating.bounds.x != r.x-10 || m.floating.bounds.y != r.y+3 || m.floating.gesture != nil {
		t.Fatal("chat drag failed")
	}
	r = m.floating.bounds
	m.Update(tea.MouseClickMsg{X: r.x + r.w - 1, Y: m.headerRows() + r.y + r.h - 1, Button: tea.MouseLeft})
	m.Update(tea.MouseReleaseMsg{X: r.x + r.w - 9, Y: m.headerRows() + r.y + r.h - 4, Button: tea.MouseLeft})
	if m.floating.bounds.w != r.w-8 || m.floating.bounds.h != r.h-3 {
		t.Fatal("chat resize failed")
	}
	m.globalKey("f6")
	if !m.floatingVisible() || m.floating.focused || m.activeTab() != 5 {
		t.Fatal("navigation lost chat or focus isolation")
	}
	m.globalKey("ctrl+b")
	if m.View().MouseMode != tea.MouseModeNone {
		t.Fatal("selection mode did not release mouse")
	}
	m.globalKey("ctrl+b")
	m.Update(tea.WindowSizeMsg{Width: 44, Height: 24})
	m.View()
	r = m.floating.bounds
	if r.x+r.w > 44 || r.y+r.h > m.workspaceHeight() {
		t.Fatal("chat escaped small screen")
	}
	m.Update(tea.MouseClickMsg{X: r.x + r.w - 4, Y: m.headerRows() + r.y + 1, Button: tea.MouseLeft})
	if m.floating.open || m.chatDraft[m.repo] != "hola Fluke" {
		t.Fatal("close lost draft or stayed open")
	}
}

func TestResizeKeepsOppositeEdgeAndBounds(t *testing.T) {
	r := rectangle{10, 5, 60, 20}
	next := dragRectangle(r, 999, 999, edgeLeft|edgeTop, 120, 40, 20, 6)
	if next != (rectangle{50, 19, 20, 6}) {
		t.Fatal(next)
	}
	next = dragRectangle(r, -999, -999, edgeLeft|edgeTop, 120, 40, 20, 6)
	if next != (rectangle{0, 0, 70, 25}) {
		t.Fatal(next)
	}
}

func TestFloatingCursorAndSavedBounds(t *testing.T) {
	m := projectTestModel(t)
	m.repo = t.TempDir()
	m.width, m.height = 140, 40
	m.toggleFloatingChat()
	m.floating.bounds = rectangle{50, 3, 60, 18}
	m.floating.focused = false
	for _, test := range []struct {
		x, y    int
		covered bool
	}{{2, 2, false}, {50, 3, true}, {109, 20, true}, {110, 20, false}, {50, 21, false}} {
		if m.floatingHidesCursor(tea.NewCursor(test.x, test.y)) != test.covered {
			t.Fatalf("cursor %d,%d", test.x, test.y)
		}
	}
	m.floating.focused = true
	if !m.floatingHidesCursor(tea.NewCursor(2, 2)) {
		t.Fatal("chat focus left worker caret visible")
	}
	if !m.saveFloatingChat() {
		t.Fatal(m.notice)
	}
	dir := m.store.dir
	m.store.lock.Close()
	store, state, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	reopened := newModel(store, state, m.repo)
	defer reopened.cleanup()
	if !reopened.floating.open || reopened.floating.focused || reopened.floating.bounds != m.floating.bounds {
		t.Fatal("saved window was not restored")
	}
	home := newModel(store, state, "")
	defer home.cleanup()
	if home.floatingVisible() {
		t.Fatal("restored chat had no project target")
	}
	reopened.toggleFloatingChat()
	if reopened.state.ChatWindow != nil {
		t.Fatal("closed window still saved as pinned")
	}
}

func TestFloatingWindowDoesNotForgetPinWhenSavingFails(t *testing.T) {
	m := projectTestModel(t)
	m.repo = t.TempDir()
	m.toggleFloatingChat()
	before := m.floating
	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	m.store.dir = filepath.Join(file, "unwritable")
	m.toggleFloatingChat()
	if !m.floating.open || m.floating.bounds != before.bounds || m.state.ChatWindow == nil {
		t.Fatal("failed close forgot pin")
	}
}
