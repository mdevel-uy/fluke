package main

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

func TestDecisionsOverlayListsProjectDecisions(t *testing.T) {
	m, other := shellTestModel(t, 140, 40)
	m.view = 3
	m.state.Decisions = []Decision{
		{Number: 1, Repo: m.repo, TaskID: "t1", Question: "¿Email o WhatsApp para los recordatorios?"},
		{Number: 2, Repo: m.repo, Question: "¿Formato de salida?", Answer: new(string)},
		{Number: 3, Repo: other, Question: "DE OTRO PROYECTO"},
	}
	*m.state.Decisions[1].Answer = "JSON"
	lines := strings.Split(ansi.Strip(m.View().Content), "\n")
	if len(lines) != 40 {
		t.Fatalf("%d lines", len(lines))
	}
	for _, l := range lines {
		if ansi.StringWidth(l) > 140 {
			t.Fatalf("overflow %q", l)
		}
	}
	view := strings.Join(lines, "\n")
	for _, want := range []string{"DECISIONES", "Email o WhatsApp", "Formato de salida", "pendiente", "respondida", "Exportar pedidos"} {
		if !strings.Contains(view, want) {
			t.Fatalf("missing %q\n%s", want, view)
		}
	}
	if strings.Contains(view, "DE OTRO PROYECTO") {
		t.Fatal("another project's decision leaked into the list")
	}
}
