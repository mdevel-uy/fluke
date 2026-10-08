package main

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func TestGlobalNavigationEscapesEditorsAndReview(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	repo := t.TempDir()
	state.Orchestrator = &AgentConfig{Provider: "codex", Executable: "codex"}
	_ = state.addTask(repo, "Una tarea", "Un resultado verificable")
	m := newModel(store, state, repo)
	defer m.cleanup()
	for _, code := range []rune{tea.KeyF1, tea.KeyF2, tea.KeyF3, tea.KeyF4} {
		m.openConfig()
		m.githubOpen = true
		m.review.open = true
		m.Update(tea.KeyPressMsg{Code: code})
		if m.view != int(code-tea.KeyF1) || m.config || m.githubOpen || m.review.open {
			t.Fatalf("%v quedó atrapada en un panel", code)
		}
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyF7})
	if !m.review.open || m.review.task.ID != state.Tasks[0].ID {
		t.Fatal("F7 no abre la revisión de la tarea seleccionada")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	if m.review.open {
		t.Fatal("Esc no cierra la revisión")
	}
	m.openConfig()
	m.Update(tea.KeyPressMsg{Code: '2', Mod: tea.ModAlt})
	if m.view != 1 || m.config {
		t.Fatal("Alt+2 no funciona como alternativa a F2")
	}
	if m.View().MouseMode != tea.MouseModeNone {
		t.Fatal("la interfaz captura la selección de texto del terminal")
	}
	m.globalKey("ctrl+x")
	if m.View().MouseMode != tea.MouseModeAllMotion {
		t.Fatal("gestión de ventanas perdió el mouse")
	}
}

func TestDraftAndPreparedCommandsStayVisible(t *testing.T) {
	for _, draft := range []string{"Hola Fluke", "Quiero probar " + strings.Repeat("texto ", 30) + "FINAL"} {
		body := ansi.Strip(brandComposer(draft, 60, true))
		if strings.HasSuffix(draft, "FINAL") {
			if !strings.Contains(body, "FINAL") {
				t.Fatal("long draft hides current typing", body)
			}
		} else if !strings.Contains(body, draft) {
			t.Fatal("short draft disappeared", body)
		}
	}
	if !strings.Contains(ansi.Strip(brandComposer("", 60, true)), "Hablá con Fluke") {
		t.Fatal("empty composer hint disappeared")
	}
	line := "rework t123 | "
	m := &model{width: 140, height: 40, command: &line}
	if !strings.Contains(ansi.Strip(m.footer()), line) {
		t.Fatal("prepared review command disappeared")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	if m.command != nil {
		t.Fatal("Escape didn't cancel prepared command")
	}
	m.command = &line
	line = strings.Repeat("texto ", 50) + "FINAL"
	if !strings.Contains(ansi.Strip(m.footer()), "FINAL") {
		t.Fatal("long command hides current typing")
	}
	for _, text := range []string{"abc", "αβ🔥abcdefgh", "a very long path ending in repo"} {
		for _, width := range []int{1, 4, 30} {
			if ansi.StringWidth(tailText(text, width)) > width {
				t.Fatal("tail overflows display width")
			}
		}
	}
}

func TestProviderSwitchResetsIncompatibleFlagsAndModel(t *testing.T) {
	m := &model{draft: [5]string{"codex", "codex", "codex-model", `["--sandbox","workspace-write"]`, "2"}}
	m.cycleProvider(false)
	if m.draft[0] != "claude" || m.draft[1] != "claude" || m.draft[2] != "" || m.draft[3] != "[]" {
		t.Fatalf("configuración de Codex se filtró a Claude: %v", m.draft)
	}
	m.cycleModel(false)
	if m.draft[2] != "sonnet" {
		t.Fatal("selector de modelos no cambia el valor")
	}
	m.cycleProvider(true)
	if m.draft[0] != "codex" {
		t.Fatal("flecha izquierda no retrocede proveedor")
	}
}

func TestConversationPagingKeepsOlderUsefulMessages(t *testing.T) {
	messages := []ConversationMessage{{Role: "human", Text: "primer pedido"}, {Role: "fluke", Text: "primera respuesta"}, {Role: "human", Text: "último pedido"}, {Role: "fluke", Text: "última respuesta"}}
	latest := ansi.Strip(conversationTranscriptAt(messages, 60, 3, 0))
	older := ansi.Strip(conversationTranscriptAt(messages, 60, 3, 100))
	if !strings.Contains(latest, "última respuesta") || !strings.Contains(older, "primer pedido") {
		t.Fatal("no se puede volver al comienzo del historial")
	}
}
