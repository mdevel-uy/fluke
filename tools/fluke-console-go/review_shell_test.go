package main

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func reviewShellModel(t *testing.T, w, h int) *model {
	t.Helper()
	m, _ := shellTestModel(t, w, h)
	m.state.Tasks[0].Status = "awaiting_review"
	m.state.Tasks[0].AgentState = ""
	m.state.Tasks = append(m.state.Tasks, Task{ID: "t4", Repo: m.repo, Title: "Informe mensual", Acceptance: "PDF con totales.", Status: "accepted"})
	m.review.open = true
	m.review.task = m.state.Tasks[1]
	m.review.data = taskReview{Summary: "2 archivos cambiados", Diff: "@@ -1 +1 @@\n-viejo\n+nuevo"}
	return m
}

func TestReviewOverlayListsDeliveriesAndShowsCriteriaFirst(t *testing.T) {
	m := reviewShellModel(t, 140, 40)
	if !m.reviewOverlay() {
		t.Fatal("review should be an overlay in the shell")
	}
	lines := strings.Split(ansi.Strip(m.View().Content), "\n")
	if len(lines) != 40 {
		t.Fatalf("%d lines", len(lines))
	}
	for _, line := range lines {
		if ansi.StringWidth(line) > 140 {
			t.Fatalf("overflow %q", line)
		}
	}
	view := strings.Join(lines, "\n")
	for _, want := range []string{"REVISIÓN", "Exportar pedidos", "Catálogo móvil", "Informe mensual", "CRITERIO DE ACEPTACIÓN", "-viejo", "+nuevo"} {
		if !strings.Contains(view, want) {
			t.Fatalf("missing %q\n%s", want, view)
		}
	}
	if strings.Contains(view, "Importar clientes") {
		t.Fatal("a pending task is not a delivery")
	}
	if strings.Index(view, "CRITERIO DE ACEPTACIÓN") > strings.Index(view, "-viejo") {
		t.Fatal("criteria must come before the diff")
	}
}

func TestReviewOverlayTabMovesBetweenDeliveries(t *testing.T) {
	m := reviewShellModel(t, 140, 40)
	order := []string{}
	for range 3 {
		m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
		order = append(order, m.review.task.ID)
	}
	if strings.Join(order, ",") != "t4,t1,t2" {
		t.Fatalf("tab order %v", order)
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyTab, Mod: tea.ModShift})
	if m.review.task.ID != "t1" {
		t.Fatalf("shift+tab went to %s", m.review.task.ID)
	}
	if !m.review.open {
		t.Fatal("switching delivery closed the review")
	}
}

func TestReviewOverlayScrollUsesVisibleRows(t *testing.T) {
	m := reviewShellModel(t, 140, 30)
	var diff strings.Builder
	for i := 0; i < 120; i++ {
		diff.WriteString("+línea " + strings.Repeat("x", i%7) + "\n")
	}
	m.review.data.Diff = diff.String()
	m.review.lines = nil
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnd})
	view := ansi.Strip(m.View().Content)
	if !strings.Contains(view, "+línea") || strings.Contains(view, "CRITERIO DE ACEPTACIÓN") {
		t.Fatalf("End did not reach the last page\n%s", view)
	}
	lines := m.review.content(m.reviewDimsW() - 4)
	if m.review.scroll > len(lines)-1 || m.review.scroll < len(lines)-m.workspaceHeight() {
		t.Fatalf("scroll %d of %d lines", m.review.scroll, len(lines))
	}
}

func TestReviewKeepsFullFrameWhenNarrow(t *testing.T) {
	m := reviewShellModel(t, 80, 30)
	if m.reviewOverlay() {
		t.Fatal("narrow terminals keep the single-panel review")
	}
	if !strings.Contains(ansi.Strip(m.View().Content), "F7 / REVISIÓN LOCAL") {
		t.Fatal("legacy review frame missing")
	}
}
