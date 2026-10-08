package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/charmbracelet/x/xpty"
	"github.com/hinshun/vt10x"
	"golang.org/x/sys/windows"
)

func TestNativeWindowsConfigAndTwoWorkers(t *testing.T) {
	binary := os.Getenv("FLUKE_CONSOLE_TEST_BINARY")
	if binary == "" {
		t.Skip("build native executable and set FLUKE_CONSOLE_TEST_BINARY")
	}
	root := t.TempDir()
	repo := filepath.Join(root, "Atlas Console")
	os.Mkdir(repo, 0700)
	if _, err := git(repo, "init", "--initial-branch=main"); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(repo, "seed.txt"), []byte("seed"), 0600)
	git(repo, "add", "seed.txt")
	if _, err := git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "seed"); err != nil {
		t.Fatal(err)
	}
	dependencyTestGit(t, repo, "config", "user.name", "Native Test")
	dependencyTestGit(t, repo, "config", "user.email", "test@example.invalid")
	dependencyTestGit(t, repo, "config", "commit.gpgsign", "false")
	dependencyTestGit(t, repo, "config", "core.hooksPath", "")
	githubName := ""
	prFixture := ""
	if live := os.Getenv("FLUKE_GITHUB_LIVE_REPO"); live != "" {
		remote, err := git(live, "remote", "get-url", "origin")
		if err != nil {
			t.Fatal(err)
		}
		githubName, err = githubRemote(remote)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = git(repo, "remote", "add", "origin", remote); err != nil {
			t.Fatal(err)
		}
	}
	if os.Getenv("FLUKE_CONSOLE_TEST_PR") == "1" && githubName == "" {
		base := dependencyTestGit(t, repo, "rev-parse", "HEAD")
		prFixture, _ = setupGithubPRFixture(t, Task{Repo: repo, BaseCommit: base, Branch: "codex/fluke/fixture"})
		githubName = "example/demo"
	}
	dir := filepath.Join(root, "state")
	store, state, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	state.Language = "es"
	state.Orchestrator = &AgentConfig{Provider: "codex", Executable: "codex", Arguments: []string{}}
	if err := store.save(state); err != nil {
		t.Fatal(err)
	}
	store.lock.Close()
	pty, err := xpty.NewPty(140, 40)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(binary, "--repo", repo, "--state-dir", dir)
	if os.Getenv("FLUKE_CONSOLE_TEST_LAUNCHER") == "1" {
		launcher, err := filepath.Abs("open-fluke.ps1")
		if err != nil {
			t.Fatal(err)
		}
		cmd = exec.Command("powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, "-Repo", repo, "-StateDir", dir, "-Here")
	}
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	if err = pty.Start(cmd); err != nil {
		pty.Close()
		t.Fatal(err)
	}
	defer func() { exec.Command("taskkill", "/PID", fmt.Sprint(cmd.Process.Pid), "/T", "/F").Run(); pty.Close() }()
	done := make(chan error, 1)
	go func() { _, err := cmd.Process.Wait(); done <- err }()
	var mu sync.Mutex
	var output strings.Builder
	outer := vt10x.New(vt10x.WithSize(140, 40))
	go func() {
		buf := make([]byte, 32768)
		queryTail := ""
		for {
			n, err := pty.Read(buf)
			if n > 0 {
				if outer != nil {
					_, _ = outer.Write(buf[:n])
				}
				mu.Lock()
				output.Write(buf[:n])
				mu.Unlock()
				queries := queryTail + string(buf[:n])
				requests := strings.Count(queries, "\x1b[6n")
				queryTail = queries[max(0, len(queries)-3):]
				for i := 0; i < requests; i++ {
					pty.Write([]byte("\x1b[1;1R"))
				}
			}
			if err != nil {
				return
			}
		}
	}()
	screen := func() string { return outer.String() }
	wait := func(marker string) {
		t.Helper()
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			if strings.Contains(screen(), marker) {
				return
			}
			select {
			case err := <-done:
				t.Fatalf("console exited: %v\n%s", err, screen())
			default:
			}
			time.Sleep(25 * time.Millisecond)
		}
		t.Fatalf("missing %q\n%s", marker, screen())
	}
	input := func(s string) {
		t.Helper()
		if _, err := pty.Write([]byte(s)); err != nil {
			t.Fatal(err)
		}
	}
	wait("FLUKE SIGUE EL PROYECTO")
	input("\x1b[15~")
	wait("CONFIGURACIÓN")
	// Exercise Windows Terminal's Win32 input protocol, including navigation
	// out of an editor. Legacy xterm F-key sequences alone missed this path.
	for i, marker := range []string{"VISTA GLOBAL", "MISIÓN /", "SESIONES / TERMINALES", "DECISIONES HUMANAS", "CONFIGURACIÓN"} {
		input(fmt.Sprintf("\x1b[%d;%d;0;1;0;1_", 112+i, 59+i))
		wait(marker)
	}
	outer.Lock()
	border := outer.Cell(0, 0)
	outer.Unlock()
	if uint32(border.FG) != 0x20e9ef {
		t.Fatalf("se perdió la paleta neón al heredar NO_COLOR: %#x", border.FG)
	}
	if outer != nil {
		captureNativeScreen(t, outer, "go-configuracion")
	}
	input("\x1b[C\x1b[C\t\x15powershell.exe\t\t\x15")
	input(`["-NoLogo","-NoProfile","-Command","Set-Content -Encoding UTF8 result.json '{\"format\":\"pretty\"}'; Write-Output 'FLUKE_GO_READY'; Write-Output ''; Get-Content -Encoding UTF8 .fluke-task.md; Start-Sleep -Seconds 60"]`)
	input("\x13")
	wait("Configuración guardada")
	input(":goal Exportar datos del proyecto | Exportación JSON válida, documentada y con un ejemplo verificable\r")
	wait("Objetivo acordado")
	input(":task Exportación JSON | Exporta datos válidos y maneja errores de escritura\r")
	wait("Tarea creada")
	input(":task Documentación CLI | Documenta el contrato y los ejemplos del comando\r")
	time.Sleep(200 * time.Millisecond)
	input(":task Ejemplo de uso | Ejecuta el comando sobre un archivo de ejemplo\r")
	time.Sleep(200 * time.Millisecond)
	input(":decision Integrar cambios después de revisar?\r")
	wait("Decisión registrada")
	readState := func() State {
		t.Helper()
		b, err := os.ReadFile(filepath.Join(dir, "state.json"))
		// The external observer can briefly collide with MoveFileEx's replacement.
		deadline := time.Now().Add(time.Second)
		for errors.Is(err, windows.ERROR_SHARING_VIOLATION) && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
			b, err = os.ReadFile(filepath.Join(dir, "state.json"))
		}
		if err != nil {
			t.Fatal(err)
		}
		var s State
		if err := json.Unmarshal(b, &s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	saved := readState()
	if saved.Orchestrator.Provider != "custom" || saved.Orchestrator.Executable != "powershell.exe" || len(saved.Tasks) != 3 {
		t.Fatalf("unexpected state %+v", saved)
	}
	// The configuration editor previously displayed the same marker as an argument.
	mu.Lock()
	output.Reset()
	mu.Unlock()
	input(":start " + saved.Tasks[0].ID + "\r")
	wait("FLUKE_GO_READY")
	input("\x18")
	wait("VENTANAS: arrastrá")
	input(":start " + saved.Tasks[1].ID + "\r")
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if readState().Tasks[1].Status == "running" {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	saved = readState()
	if saved.Tasks[0].Status != "running" || saved.Tasks[1].Status != "running" {
		t.Fatalf("workers not running: %+v\n%s", saved.Tasks, screen())
	}
	input("\x18")
	time.Sleep(150 * time.Millisecond)
	input("m")
	wait("MENSAJE →")
	input("Revisar el caso de entrada vacía")
	wait("entrada vacía")
	captureNativeScreen(t, outer, "go-worker-message")
	input(terminalEscape())
	time.Sleep(150 * time.Millisecond)
	if len(readState().Decisions) != 1 {
		t.Fatal("canceling worker message sent an instruction")
	}
	input(":start " + saved.Tasks[2].ID + "\r")
	wait("Límite de workers alcanzado")
	if os.Getenv("FLUKE_CONSOLE_MEASURE") == "1" {
		measure := func() struct{ Memory, CPU float64 } {
			var sample struct{ Memory, CPU float64 }
			command := fmt.Sprintf("Get-Process -Id %d | Select-Object @{Name='Memory';Expression={$_.WorkingSet64}},@{Name='CPU';Expression={$_.TotalProcessorTime.TotalMilliseconds}} | ConvertTo-Json -Compress", cmd.Process.Pid)
			data, err := exec.Command("powershell.exe", "-NoProfile", "-Command", command).Output()
			if err != nil {
				t.Fatal(err)
			}
			if err = json.Unmarshal(data, &sample); err != nil {
				t.Fatal(err)
			}
			return sample
		}
		before := measure()
		start := time.Now()
		time.Sleep(5 * time.Second)
		after := measure()
		t.Logf("Fluke process only, two idle PTYs: working set %.1f MiB, CPU %.1f ms over %.2f s (%.3f%% of one core)", after.Memory/1048576, after.CPU-before.CPU, time.Since(start).Seconds(), (after.CPU-before.CPU)/time.Since(start).Seconds()/10)
	}
	if capture := os.Getenv("FLUKE_CONSOLE_CAPTURE_DIR"); capture != "" {
		os.MkdirAll(capture, 0700)
		mu.Lock()
		os.WriteFile(filepath.Join(capture, "go-two-workers.ansi"), []byte(output.String()), 0600)
		mu.Unlock()
		captureNativeScreen(t, outer, "go-sesiones")
		input("\x1bOP")
		wait("VISTA GLOBAL")
		captureNativeScreen(t, outer, "go-global")
		input("\x1bOQ")
		wait("CONTEXTO")
		captureNativeScreen(t, outer, "go-proyecto")
		input("\x1bOS")
		wait("DECISIONES HUMANAS")
		captureNativeScreen(t, outer, "go-decisiones")
	}
	input("\x1b[117;64;0;1;0;1_") // Windows F6
	if githubName == "" {
		if _, err := exec.LookPath("gh"); err != nil {
			wait("instalá GitHub CLI")
		} else {
			wait("este repo no tiene un origin accesible")
		}
	} else {
		wait("GitHub: " + githubName)
	}
	if outer != nil {
		captureNativeScreen(t, outer, "go-github")
	}
	input("\x1b")
	time.Sleep(150 * time.Millisecond)
	input("\x1b[15~")
	time.Sleep(150 * time.Millisecond)
	if githubName != "" {
		input("\x07") // Configuración > GitHub, without changing real credentials.
		wait("Conectado como")
		if outer != nil {
			captureNativeScreen(t, outer, "go-config-github")
		}
		input("\x0f") // Back to orchestrator settings.
	}
	input("\x1b")
	time.Sleep(150 * time.Millisecond)
	// Simulated worker reports through the real app's file contract and timer.
	worker := readState().Tasks[0]
	reportPath := workerSignalPath(*worker.Worktree, worker.ID, worker.AgentRun, "state")
	report := workerReport{Version: 1, RunID: worker.AgentRun, Seq: 1, Status: "needs_response", Message: "Elegir formato de exportación", Question: "¿Conservar JSON como formato de salida?"}
	if err := atomicJSON(reportPath, report); err != nil {
		t.Fatal(err)
	}
	input("\x1bOS")
	deadline = time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && len(readState().Decisions) < 2 {
		time.Sleep(25 * time.Millisecond)
	}
	input("\x1b[B")
	wait(report.Question)
	if outer != nil {
		captureNativeScreen(t, outer, "go-worker-pregunta")
	}
	input("\x0banswer 2 Sí, conservar JSON\r")
	wait("Respuesta guardada")
	answer := readState().Decisions[1]
	if answer.Answer == nil || !strings.Contains(*answer.Answer, "conservar JSON") || answer.Continuation != "pending" {
		t.Fatal("worker answer not durably queued", answer)
	}
	report.Seq = 2
	report.Status = "ready"
	report.Message = "Entrega simulada para validar el flujo de revisión"
	report.Question = ""
	report.Evidence = []string{"result.json"}
	if err := atomicJSON(reportPath, report); err != nil {
		t.Fatal(err)
	}
	input("\x1bOP")
	input("\t") // The global home opens alerts in its attention panel.
	wait("PARA REVISAR")
	input("\x0bstart " + saved.Tasks[2].ID + "\r")
	wait("Límite de workers alcanzado")
	if outer != nil {
		captureNativeScreen(t, outer, "go-worker-entrega")
	}
	input("\x0bqueue " + saved.Tasks[2].ID + "\r")
	wait("Cola actualizada")
	input("\x1b[118;65;0;1;0;1_") // Windows F7
	wait("F7 / REVISIÓN LOCAL")
	wait("ESTADO LOCAL")
	wait("archivo nuevo")
	captureNativeScreen(t, outer, "go-review")
	input("c")
	wait("COMANDO > rework")
	input("\x1b[112;59;0;1;0;1_") // F1 also leaves a prepared command.
	wait("TUS PROYECTOS")
	input("\x1b[118;65;0;1;0;1_")
	wait("ESTADO LOCAL")
	input(terminalEscape())
	wait("VISTA GLOBAL")
	input("\x1b[118;65;0;1;0;1_")
	wait("ESTADO LOCAL")
	input("a")
	wait("COMANDO > accept")
	input(terminalEnter())
	deadline = time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		next := readState()
		if next.Tasks[0].Status == "accepted" && next.Tasks[2].Status == "running" {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if next := readState(); next.Tasks[0].Status != "accepted" || next.Tasks[2].Status != "running" {
		t.Fatalf("aceptar no liberó el cupo para la cola: %+v\n%s", next.Tasks, screen())
	}
	if prFixture != "" {
		task := readState().Tasks[0]
		remote := readGithubPRFixture(t, prFixture)
		remote.HeadBranch = task.Branch
		writeGithubPRFixture(t, prFixture, remote)
		input("\x1b[118;65;0;1;0;1_")
		wait("ESTADO LOCAL")
		input("p")
		wait("PUBLICAR PR BORRADOR")
		captureNativeScreen(t, outer, "go-pr-previa")
		input(terminalEscape())
		wait("VISTA GLOBAL")
		if remote := readGithubPRFixture(t, prFixture); remote.Pushes != 0 || remote.Creates != 0 {
			t.Fatal("cancelar publicó un PR", remote)
		}
		input("\x1b[118;65;0;1;0;1_")
		wait("ESTADO LOCAL")
		input("p")
		wait("PUBLICAR PR BORRADOR")
		input("e\x15Exportación JSON revisada\t\x15")
		input("\x1b[200~Exporta JSON válido.\r\n\r\nValidación: archivo y flujo de revisión comprobados.\x1b[201~")
		wait("DESCRIPCIÓN [EDITANDO]")
		wait("archivo y flujo de revisión comprobados.")
		captureNativeScreen(t, outer, "go-pr-editar")
		input("\x13")
		wait("vista previa")
		input(terminalEnter())
		wait("PR BORRADOR PUBLICADO")
		captureNativeScreen(t, outer, "go-pr-publicado")
		remote = readGithubPRFixture(t, prFixture)
		if remote.Pushes != 1 || remote.Creates != 1 || remote.Title != "Exportación JSON revisada" || strings.Contains(remote.Body, "\r") || !strings.Contains(remote.Body, "\n\nValidación:") {
			t.Fatal("PR no conservó el título/cuerpo revisados", remote)
		}
		if next := readState(); next.Tasks[0].Publication == nil || !next.Tasks[0].Publication.Complete {
			t.Fatal("PR nativo no quedó verificado")
		}
		if _, err := os.Stat(filepath.Join(repo, "result.json")); !os.IsNotExist(err) {
			t.Fatal("publicar PR integró sin confirmación")
		}
		input(terminalEscape())
		wait("VISTA GLOBAL")
	}
	input("\x1b[118;65;0;1;0;1_")
	wait("ESTADO LOCAL")
	input("m")
	wait("INTEGRAR ENTREGA")
	wait("Confirmar integración")
	captureNativeScreen(t, outer, "go-integracion")
	input(terminalEscape())
	wait("VISTA GLOBAL")
	if _, err = os.Stat(filepath.Join(repo, "result.json")); !os.IsNotExist(err) {
		t.Fatal("cancelar ejecutó la integración")
	}
	input("\x1b[118;65;0;1;0;1_")
	wait("ESTADO LOCAL")
	input("m")
	wait("INTEGRAR ENTREGA")
	input(terminalEnter())
	wait("INTEGRACIÓN VERIFICADA")
	if next := readState(); next.Tasks[0].Integration == nil || next.Tasks[0].Integration.MergedCommit == "" {
		t.Fatal("merge nativo no quedó guardado")
	}
	if _, err = os.Stat(filepath.Join(repo, "result.json")); err != nil {
		t.Fatal("merge nativo no incluyó el archivo nuevo", err)
	}
	captureNativeScreen(t, outer, "go-integrada")
	input("\x11")
	wait("detener sus sesiones")
	input("s")
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("console failed to terminate workers")
	}
	saved = readState()
	if saved.Tasks[0].Status != "accepted" || saved.Tasks[1].Status != "interrupted" || saved.Tasks[2].Status != "interrupted" {
		t.Fatal(saved.Tasks)
	}
	for _, task := range saved.Tasks[:2] {
		if task.Worktree == nil {
			t.Fatal("missing worktree")
		}
		if _, err := os.Stat(filepath.Join(*task.Worktree, ".fluke-task.md")); err != nil {
			t.Fatal(err)
		}
	}
}

func captureNativeScreen(t *testing.T, screen vt10x.Terminal, name string) {
	t.Helper()
	dir := os.Getenv("FLUKE_CONSOLE_CAPTURE_DIR")
	if dir == "" {
		return
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	// A marker can arrive halfway through a renderer frame over ConPTY.
	previous, stable := screen.String(), 0
	deadline := time.Now().Add(time.Second)
	for stable < 4 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
		current := screen.String()
		if current == previous {
			stable++
		} else {
			previous, stable = current, 0
		}
	}
	screen.Lock()
	cols, rows := screen.Size()
	type cell struct {
		X, Y   int
		Text   string
		FG, BG uint32
		Mode   int16
	}
	cells := make([]cell, 0, cols*rows)
	for y := 0; y < rows; y++ {
		for x := 0; x < cols; x++ {
			c := screen.Cell(x, y)
			cells = append(cells, cell{x, y, string(c.Char), uint32(c.FG), uint32(c.BG), c.Mode})
		}
	}
	screen.Unlock()
	data, err := json.Marshal(struct {
		Cols, Rows int
		Cells      []cell
	}{cols, rows, cells})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, name+".json"), data, 0600); err != nil {
		t.Fatal(err)
	}
}
