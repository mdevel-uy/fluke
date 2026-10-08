package main

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

func TestReviewPanelGenerationAndScroll(t *testing.T) {
	var panel reviewPanel
	old := panel.start(Task{ID: "t123", Title: "Original"})
	panel.start(Task{ID: "t456", Title: "Actual"})
	panel.receive(old().(taskReviewResult))
	if !panel.loading || panel.err != nil {
		t.Fatal("un resultado obsoleto reemplazó la revisión actual")
	}
	panel.receive(taskReviewResult{generation: panel.generation, data: taskReview{Diff: strings.Repeat("+change\n", 60)}})
	if panel.loading {
		t.Fatal("el resultado actual no se aplicó")
	}
	panel.key("pgdown", 80, 20)
	if panel.scroll != 12 {
		t.Fatalf("scroll de página = %d", panel.scroll)
	}
	panel.key("end", 80, 20)
	if panel.scroll != len(panel.content(76))-12 {
		t.Fatal("End no desplazó al final")
	}
	panel.key("home", 80, 20)
	if panel.scroll != 0 {
		t.Fatal("Home no volvió al comienzo")
	}
	generation := panel.generation
	if cmd := panel.key("r", 80, 20); cmd == nil || !panel.loading || panel.generation <= generation {
		t.Fatal("r no programó una nueva lectura asíncrona")
	}
	panel.key("esc", 80, 20)
	panel.receive(taskReviewResult{generation: panel.generation - 1, data: taskReview{Diff: "stale"}})
	if panel.open || panel.data.Diff == "stale" {
		t.Fatal("se aplicó un resultado después de cerrar")
	}
}

func TestReviewPanelSanitizesAndFits(t *testing.T) {
	panel := reviewPanel{open: true, task: Task{Title: "Title\x1b[31mRED\x1b[0m\x07", Branch: "codex/fluke/t123"}, data: taskReview{
		Summary: "file | 2 ++", Status: "?? new.txt", Untracked: []string{"new.txt"},
		Diff: "+safe\x1b]52;c;stolen\x07\n-deleted\n@@ hunk @@\n", Truncated: true,
	}}
	if text := reviewText(panel.data.Diff); strings.ContainsAny(text, "\x1b\x07") || strings.Contains(text, "stolen") {
		t.Fatalf("controles de terminal no filtrados: %q", text)
	}
	for _, size := range [][2]int{{80, 24}, {34, 12}, {8, 5}, {2, 2}} {
		view := panel.view(size[0], size[1])
		lines := strings.Split(view, "\n")
		if len(lines) != size[1] {
			t.Fatalf("%v: alto %d", size, len(lines))
		}
		for _, line := range lines {
			if ansi.StringWidth(line) > size[0] {
				t.Fatalf("%v: ancho excedido: %q", size, line)
			}
		}
	}
	text := ansi.Strip(panel.view(100, 40))
	for _, want := range []string{"F7 / REVISIÓN LOCAL", "RESUMEN", "ESTADO LOCAL", "ARCHIVOS NUEVOS", "VISTA PARCIAL", "+safe", "-deleted"} {
		if !strings.Contains(text, want) {
			t.Fatalf("falta %q en revisión", want)
		}
	}
}
