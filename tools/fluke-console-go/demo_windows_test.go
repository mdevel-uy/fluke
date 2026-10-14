package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/xpty"
	"github.com/hinshun/vt10x"
)

func TestDemoNavigationAndIsolation(t *testing.T) {
	previous := uiLanguage()
	setUILanguage("es")
	t.Cleanup(func() { setUILanguage(previous); applyTheme("") })
	d, err := newDemo()
	if err != nil {
		t.Fatal(err)
	}
	defer d.close()
	m := d.app
	if len(m.state.Projects) != 3 || len(m.state.Tasks) != 8 || m.store != nil || d.Init() != nil {
		t.Fatal("demo must start offline with 3 projects and 8 tasks")
	}
	for _, size := range [][2]int{{140, 40}, {80, 30}, {44, 24}} {
		d.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		for project, repo := range m.state.Projects {
			d.navigate("f1")
			m.selected = project
			d.navigate("f2")
			if m.repo != repo {
				t.Fatal("wrong project selected")
			}
			for _, key := range []string{"f1", "f2", "f3", "f4", "f5"} {
				d.navigate(key)
				view := d.View().Content
				if !strings.Contains(view, "DEMO") {
					t.Fatal("simulation label missing")
				}
				if len(strings.Split(view, "\n")) != size[1] {
					t.Fatal("vertical overflow", size, len(strings.Split(view, "\n")))
				}
				for _, line := range strings.Split(ansi.Strip(view), "\n") {
					if ansi.StringWidth(line) > size[0] {
						t.Fatal("horizontal overflow")
					}
				}
			}
			d.navigate("f3")
			want := 3
			if project == 1 {
				want = 2
			}
			if len(m.terminals.visibleWindows()) != want {
				t.Fatal("worker filtering", project, len(m.terminals.visibleWindows()))
			}
			for _, key := range []tea.KeyPressMsg{{Code: 'z', Text: "z"}, {Code: tea.KeyTab}, {Code: 'z', Text: "z"}, {Code: 't', Text: "t"}, {Code: 'p', Text: "p"}} {
				d.Update(key)
			}
			for _, key := range []tea.KeyPressMsg{{Code: tea.KeyEnter}, {Code: 'm', Text: "m"}, {Code: ':', Text: ":"}, {Code: 'f', Mod: tea.ModCtrl}, {Code: 'a', Text: "a"}} {
				if _, cmd := d.Update(key); cmd != nil {
					t.Fatal("demo produced executable command")
				}
			}
			d.Update(tea.PasteMsg{Content: "do not execute"})
			if m.command != nil || m.preparing || m.workerMessageID != "" || len(m.chatDraft) != 0 {
				t.Fatal("demo accepted live work")
			}
		}
	}
	for _, w := range m.terminals.Windows {
		if w.Cmd != nil || w.group != nil || w.writer != nil {
			t.Fatal("demo started a process")
		}
	}
	d.Update(tea.WindowSizeMsg{Width: 140, Height: 40})
	d.navigate("f3")
	if m.terminals.tiled {
		m.terminals.ToggleTiling()
	}
	w := m.terminals.Windows[m.terminals.FocusedWindow]
	w.x, w.y, w.w, w.h = 2, 2, 55, 14
	m.terminals.layout()
	x, y := w.x+5, w.y+m.headerRows()+1
	d.Update(tea.MouseClickMsg{X: x, Y: y, Button: tea.MouseLeft})
	d.Update(tea.MouseMotionMsg{X: x + 8, Y: y + 3, Button: tea.MouseLeft})
	d.Update(tea.MouseReleaseMsg{X: x + 8, Y: y + 3, Button: tea.MouseLeft})
	if w.x != 10 || w.y != 5 {
		t.Fatal("demo window cannot be dragged", w.x, w.y)
	}
}

func TestDemoGentleSettingsNeverConnectOrPersist(t *testing.T) {
	t.Cleanup(func() { applyTheme("") })
	d, err := newDemo()
	if err != nil {
		t.Fatal(err)
	}
	defer d.close()
	m := d.app
	if m.state.Theme != "gentle" {
		t.Fatal("demo should preview Gentle by default")
	}
	for _, action := range []string{"connection", "github", "models", "typography", "theme"} {
		d.Update(tea.KeyPressMsg{Code: 'k', Mod: tea.ModAlt})
		d.Update(tea.PasteMsg{Content: action})
		for i, target := range m.switchTargets() {
			if target.action == "ctrl+k" {
				t.Fatal("demo offered the live command editor")
			}
			if target.action == action {
				m.switcher.selected = i
				break
			}
		}
		if _, cmd := d.Update(tea.KeyPressMsg{Code: tea.KeyEnter}); cmd != nil {
			t.Fatal("demo navigation dispatched real work")
		}
		if !m.config || m.switcher != nil || m.providerBusy || m.auth.Busy || m.store != nil {
			t.Fatalf("%s did not open an offline settings preview", action)
		}
		for _, key := range []tea.KeyPressMsg{{Code: 'l', Mod: tea.ModCtrl}, {Code: 'r', Mod: tea.ModCtrl}, {Code: 's', Mod: tea.ModCtrl}} {
			if _, cmd := d.Update(key); cmd != nil {
				t.Fatal("demo dispatched sign-in, probing or persistence")
			}
		}
	}
}

func TestNativeWindowsDemo(t *testing.T) {
	binary := os.Getenv("FLUKE_CONSOLE_TEST_BINARY")
	if binary == "" {
		t.Skip("set FLUKE_CONSOLE_TEST_BINARY")
	}
	root := t.TempDir()
	state := filepath.Join(root, "must-not-exist")
	pty, err := xpty.NewPty(140, 40)
	if err != nil {
		t.Fatal(err)
	}
	defer pty.Close()
	cmd := exec.Command(binary, "--demo", "--state-dir", state)
	if os.Getenv("FLUKE_CONSOLE_TEST_LAUNCHER") == "1" {
		cmd = exec.Command("powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", filepath.Join(filepath.Dir(binary), "open-fluke.ps1"), "-Demo", "-StateDir", state, "-Here")
	}
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	if err := pty.Start(cmd); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = exec.Command("taskkill", "/PID", fmt.Sprint(cmd.Process.Pid), "/T", "/F").Run() }()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	screen := vt10x.New(vt10x.WithSize(140, 40))
	go func() {
		buf := make([]byte, 32768)
		tail := ""
		for {
			n, err := pty.Read(buf)
			if n > 0 {
				_, _ = screen.Write(buf[:n])
				queries := tail + string(buf[:n])
				for range strings.Count(queries, "\x1b[6n") {
					_, _ = pty.Write([]byte("\x1b[1;1R"))
				}
				tail = queries[max(0, len(queries)-3):]
			}
			if err != nil {
				return
			}
		}
	}()
	wait := func(marker string) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			if strings.Contains(screen.String(), marker) {
				return
			}
			select {
			case err := <-done:
				t.Fatalf("demo exited: %v", err)
			default:
			}
			time.Sleep(25 * time.Millisecond)
		}
		t.Fatalf("missing %q\n%s", marker, screen.String())
	}
	input := func(keys string) {
		t.Helper()
		if _, err := pty.Write([]byte(keys)); err != nil {
			t.Fatal(err)
		}
	}
	wait("03-Pulso")
	wait("DEMO · 3 proyectos")
	captureNativeScreen(t, screen, "go-demo-global")
	input("\x10pulso claude")
	wait("IR A / 1 RESULTADOS")
	captureNativeScreen(t, screen, "go-demo-quick-switch")
	input("\r")
	wait("SESIÓN SIMULADA")
	wait("03-Pulso")
	input("\x10fluke mercado\r")
	wait("La exportación")
	input("\x1bOP")
	input("i")
	wait("Trabajo observado")
	captureNativeScreen(t, screen, "go-demo-balance")
	input("\x1bOQ")
	wait("La exportación")
	captureNativeScreen(t, screen, "go-demo-chat")
	input("\x1bOR")
	wait("SESIÓN SIMULADA")
	captureNativeScreen(t, screen, "go-demo-workers")
	input("z\t")
	wait("2/3")
	captureNativeScreen(t, screen, "go-demo-worker-zoom")
	input("z\x1bOP\x1b[B\x1bOS")
	wait("¿Email o WhatsApp")
	captureNativeScreen(t, screen, "go-demo-decision")
	input("\x1bOR")
	wait("Agenda sin superposiciones")
	captureNativeScreen(t, screen, "go-demo-turnos")
	input("\x1b[15~")
	wait("Amber CRT")
	input("\x1b[B\r")
	input("\x11")
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("demo did not exit")
	}
	if _, err := os.Stat(state); !os.IsNotExist(err) {
		t.Fatal("demo touched the requested state directory")
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatal("demo wrote project files", entries, err)
	}
}
