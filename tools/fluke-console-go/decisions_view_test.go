package main

import (
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func TestDecisionsWithoutDuplicateChat(t *testing.T) {
	for _, width := range []int{44, 80, 140} {
		t.Run(fmt.Sprint(width), func(t *testing.T) {
			m := projectTestModel(t)
			m.repo, m.home, m.width, m.height = t.TempDir(), false, width, 40
			m.chatDraft[m.repo] = "draft to preserve"
			m.state.Conversations = map[string][]ConversationMessage{m.repo: {{Role: "fluke", Text: "PRIVATE CHAT TRANSCRIPT"}}}
			m.Update(tea.KeyPressMsg{Code: tea.KeyF4})
			view := ansi.Strip(m.decisionsView(width, 28))
			if !strings.Contains(view, uiText("Sin decisiones pendientes.")) || strings.Contains(view, "00") || strings.Contains(view, "[Enter]") {
				t.Fatalf("misleading empty decision view: %s", view)
			}
			for _, state := range []string{"pending", "answered", "proposal"} {
				d := Decision{Repo: m.repo, Question: "Choose CSV or JSON?"}
				want := "answer 1 "
				if state == "answered" {
					answer := "JSON"
					d.Answer, want = &answer, "amend 1 "
				}
				if state == "proposal" {
					d.ProposedTitle, want = "Export data", "approve 1"
				}
				m.state.Decisions = []Decision{d}
				m.state.Tasks = []Task{{ID: "unrelated", Repo: m.repo, Title: "UNRELATED TASK"}}
				for _, key := range []tea.KeyPressMsg{{Code: tea.KeyTab}, {Code: tea.KeyTab, Mod: tea.ModShift}} {
					m.Update(key)
					m.Update(tea.PasteMsg{Content: "accidental paste"})
					m.Update(tea.KeyPressMsg{Code: 'x', Text: "x"})
					if m.pane != 0 || m.chatDraft[m.repo] != "draft to preserve" {
						t.Fatal("F4 focused or edited an invisible chat")
					}
				}
				view = ansi.Strip(m.decisionsView(width, 28))
				for _, hidden := range []string{"PRIVATE CHAT TRANSCRIPT", "UNRELATED TASK", "[Send]", "[Enviar]", "[Connection]", "[Conexión]", "[Pin]", "[Fijar]"} {
					if strings.Contains(view, hidden) {
						t.Fatalf("F4 exposes %q: %s", hidden, view)
					}
				}
				if !strings.Contains(view, d.Question) || !strings.Contains(view, "[Enter]") {
					t.Fatal("decision or action missing", view)
				}
				for _, line := range strings.Split(view, "\n") {
					if ansi.StringWidth(line) > width {
						t.Fatal("decision view exceeds terminal width", line)
					}
				}
				m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
				if m.command == nil || *m.command != want {
					t.Fatalf("%s: Enter did not open %q: %v", state, want, m.command)
				}
				m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
			}
			m.Update(tea.KeyPressMsg{Code: tea.KeyF2})
			if m.view != 1 || m.pane != 1 || m.chatDraft[m.repo] != "draft to preserve" {
				t.Fatal("project chat lost its draft or focus")
			}
		})
	}
}
