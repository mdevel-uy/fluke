package main

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

func TestSplashFramesMoveAndStayWithinTerminal(t *testing.T) {
	for _, size := range [][2]int{{140, 40}, {100, 36}, {80, 24}, {40, 20}} {
		m := &model{width: size[0], height: size[1], setup: firstRun{open: true}}
		first := m.setupView()
		m.setup.frame = 12
		second := m.setupView()
		if first == second {
			t.Fatal("splash frame did not change")
		}
		for _, view := range []string{first, second} {
			rows := strings.Split(view, "\n")
			if len(rows) != size[1] {
				t.Fatalf("%v: %d rows", size, len(rows))
			}
			for _, row := range rows {
				if ansi.StringWidth(row) > size[0] {
					t.Fatalf("%v: row too wide", size)
				}
			}
			if !strings.Contains(ansi.Strip(view), "ENTER") {
				t.Fatalf("%v: hidden start action\n%s", size, ansi.Strip(view))
			}
		}
	}
	if splashMark(80, 14, 0) != splashMark(80, 14, 0) {
		t.Fatal("frame is not deterministic")
	}
	if ansi.Strip(splashMark(80, 14, 0)) == ansi.Strip(splashMark(80, 14, 12)) {
		t.Fatal("only color moved; geometry should move too")
	}
}

func BenchmarkSplash(b *testing.B) {
	m := &model{width: 140, height: 40, setup: firstRun{open: true}}
	for i := 0; i < b.N; i++ {
		m.setup.frame = i
		_ = m.setupView()
	}
}

func TestSetupSignalPreservesLayoutAndConfigurationData(t *testing.T) {
	previous := uiLanguage()
	t.Cleanup(func() { _ = setUILanguage(previous) })
	for _, language := range []string{"en", "es"} {
		_ = setUILanguage(language)
		for _, size := range [][2]int{{100, 36}, {40, 20}, {3, 4}} {
			for step := 0; step <= 6; step++ {
				m := &model{width: size[0], height: size[1], setup: firstRun{open: true, step: step}}
				for _, pulse := range []int{0, 40, 41, 42, 70, 72, 73} {
					m.setup.frame = pulse
					view := m.setupFrame("FLUKE / INITIAL SETUP", "repo /private/project\nmodel custom-model\nauth ABCD-1234", "[Enter] Continue")
					rows := strings.Split(view, "\n")
					if len(rows) != size[1] {
						t.Fatalf("step %d frame %d changed height", step, pulse)
					}
					for _, row := range rows {
						if ansi.StringWidth(row) != size[0] {
							t.Fatalf("step %d frame %d changed width", step, pulse)
						}
					}
					if size[0] == 100 {
						plain := ansi.Strip(view)
						for _, value := range []string{"/private/project", "custom-model", "ABCD-1234", "[Enter] Continue"} {
							if !strings.Contains(plain, value) {
								t.Fatalf("frame %d corrupted configuration data %q", pulse, value)
							}
						}
					}
				}
			}
		}
		m := &model{width: 100, height: 36, setup: firstRun{open: true}}
		plain := ansi.Strip(m.setupView())
		for _, removed := range []string{"NEW GAME", "NUEVA PARTIDA", "IN PLAY", "EN JUEGO", "[P]"} {
			if strings.Contains(plain, removed) {
				t.Fatalf("removed wording remains: %q", removed)
			}
		}
	}
	if setupSignalText("FLUKE / SETUP", 40) == "FLUKE / SETUP" || setupSignalText("FLUKE / SETUP", 42) != "FLUKE / SETUP" {
		t.Fatal("title corruption did not recover")
	}
	m := &model{width: 100, height: 36, setup: firstRun{open: true, step: 1}}
	baseline := m.setupFrame("TITLE", "body", "keys")
	m.setup.frame = 70
	if baseline == m.setupFrame("TITLE", "body", "keys") {
		t.Fatal("interference did not change the frame")
	}
}
