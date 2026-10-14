package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	tea "charm.land/bubbletea/v2"
)

type workerTick struct{}
type workerReport struct {
	Version             int          `json:"version"`
	RunID               string       `json:"run_id"`
	Seq                 uint64       `json:"seq"`
	Status              string       `json:"status"`
	Message             string       `json:"message"`
	Question            string       `json:"question,omitempty"`
	Evidence            []string     `json:"evidence,omitempty"`
	ReviewSeq           uint64       `json:"review_feedback_seq,omitempty"`
	HumanInstructionSeq uint64       `json:"human_instruction_seq,omitempty"`
	NativeSessionID     string       `json:"native_session_id,omitempty"`
	HelpRequested       bool         `json:"help_requested,omitempty"`
	Usage               *WorkerUsage `json:"usage,omitempty"`
}

func atomicJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".report-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return replaceFile(f.Name(), path)
}

func workerSignalPath(worktree, taskID, runID, kind string) string {
	return filepath.Join(worktree, ".fluke-worker", taskID+"-"+runID+"-"+kind+".json")
}

func prepareWorkerContract(worktree, taskID string) (string, error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	runID := hex.EncodeToString(random[:])
	signalDir := filepath.Join(worktree, ".fluke-worker")
	if info, err := os.Lstat(signalDir); err == nil && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
		return "", errors.New(uiText("directorio de reportes inválido"))
	}
	if err := os.MkdirAll(signalDir, 0700); err != nil {
		return "", err
	}
	// A shared info/exclude keeps helper files out of every linked worktree.
	exclude, err := git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude")
	if err != nil {
		return "", err
	}
	if err = os.MkdirAll(filepath.Dir(exclude), 0700); err != nil {
		return "", err
	}
	previous, err := os.ReadFile(exclude)
	if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	const pattern = "/.fluke-worker-contract.md\n/.fluke-worker/"
	if !strings.Contains("\n"+string(previous)+"\n", "\n"+pattern+"\n") {
		f, e := os.OpenFile(exclude, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
		if e != nil {
			return "", e
		}
		_, e = f.WriteString("\n" + pattern + "\n")
		closeErr := f.Close()
		if e != nil {
			return "", e
		}
		if closeErr != nil {
			return "", closeErr
		}
	}
	example, _ := json.Marshal(workerReport{Version: 1, RunID: runID, Seq: 1, Status: "working", Message: "Comenzando la tarea"})
	output, _ := json.Marshal(workerSignalPath(worktree, taskID, runID, "state"))
	answer, _ := json.Marshal(workerSignalPath(worktree, taskID, runID, "answer"))
	body := fmt.Sprintf(`# Contrato de comunicación con Fluke

Leé .fluke-task.md y las instrucciones del repositorio antes de actuar. Sos el único responsable de llevar esta tarea completa desde el análisis hasta una entrega verificable. No cambies el alcance ni hagas merge, push o publicación.

Método de trabajo:
1. Convertí la aceptación en una lista concreta de resultados; inspeccioná implementación, callers, pruebas y convenciones existentes. Reutilizá lo que ya existe. En una sesión retomada reconciliá archivos y decisiones antes de repetir acciones.
2. Resolvé decisiones técnicas rutinarias por tu cuenta dentro del alcance. Implementá el recorrido completo, incluidos errores, estados vacíos, accesibilidad y tamaños pequeños cuando aplique. No te detengas en un plan ni dejes al humano el trabajo autorizado.
3. Verificá cada criterio con las comprobaciones permitidas por el repositorio. Si prohíbe builds/tests, respetalo y describí qué evidencia sí pudiste obtener. Nunca declares una prueba pasada si no la ejecutaste.
4. Ante un fallo, investigá la causa y probá una corrección concreta. Si seguís bloqueado, explicá qué intentaste, evidencia, impacto y el próximo paso que necesitás. Pedí ayuda técnica a Fluke con blocked + help_requested=true + question. No repitas indefinidamente la misma acción ni esperes en bucles de shell.
5. Antes de finalizar, revisá el diff y cada criterio. Entregá un resumen de resultado, verificaciones con sus resultados, archivos de evidencia y límites restantes. Un bloqueo no es una entrega ready. Terminá el turno después de ready o de pedir ayuda; Fluke te despertará con contexto nuevo.

Reportá en el archivo local excluido de Git %s (ruta expresada como JSON, decodificar antes de usarla).
Escribí un archivo temporal en la misma carpeta y renombralo al destino para evitar lecturas parciales. No uses stdout como canal de estado.
Formato inicial:
%s

Conservá version=1 y run_id. Incrementá seq en cada reporte, incluso después de una nueva intervención humana.
- working: estás trabajando; message describe brevemente el avance.
- needs_response: necesitás una decisión de producto o alcance; question contiene una pregunta concreta. Reportala en el archivo, hacé la pregunta como mensaje final y terminá el turno. No uses AskUserQuestion, request_user_input ni un diálogo interactivo de preguntas: Fluke recoge la respuesta en su panel. No adivines la respuesta.
- blocked: no podés continuar; message explica causa, intentos y evidencia. Para ayuda técnica del orquestador incluí help_requested=true y question con el paso que necesitás. Para decisiones de producto/alcance usá needs_response; no delegues aprobaciones humanas ni permisos a Fluke.
- ready: entrega para revisión humana, nunca aprobación. message resume cambios, verificaciones y limitaciones; evidence es una lista de rutas relativas a archivos reales del worktree que respaldan la entrega. Reportá ready solo después de verificar la aceptación.

Consumo opcional: usage={"input_tokens":123,"output_tokens":45,"cost_usd":0.01,"source":"usage.json"} contiene totales acumulados SOLO de esta ejecución run_id, respaldados por un archivo real del worktree con datos del proveedor. Si no tenés mediciones fiables o no podés separar esta ejecución de una sesión retomada, omití usage. No estimes tokens ni inventes tarifas; omití cost_usd si la CLI no informa dólares. Los totales no pueden disminuir. Fluke los muestra como reportados, no como facturación verificada.
Si una respuesta tiene answered_by="fluke", es orientación técnica del orquestador; no es una aprobación humana. Validá la solución contra el brief y reportá otra vez si no destraba la tarea.

Al comenzar, si está presente CODEX_SESSION_ID (o CODEX_THREAD_ID), obtené esa variable exacta mediante una herramienta local y agregá native_session_id con su UUID en los reportes. Permite recuperar tu historial al reiniciar. Omitilo si no existe; no inventes IDs ni vuelques otras variables de entorno.

Las respuestas aparecen en %s con run_id, seq, question y answer. Antes de continuar después de una pregunta, leé ese archivo y comprobá que run_id y seq coincidan con tu pregunta. Si Fluke indica entrega pendiente de revisión, no hagas merge.
Si ese archivo contiene review_feedback=true, answer son correcciones humanas de una entrega y seq identifica el reporte revisado. Corregí dentro del alcance aprobado. En tu próxima entrega ready incluí review_feedback_seq con esa seq; incrementá también la seq normal del reporte. Sin esa confirmación la entrega no vuelve a revisión. Si cambia el alcance/producto, pedí una decisión al orquestador.
Las aprobaciones de comandos/permisos de la CLI se responden directamente en la terminal; no las confundas con decisiones de producto.
Si answer contiene direct_instruction=true o supersedes, es una intervención humana o una corrección de respuesta guardada. Conservá el alcance acordado y consultá al orquestador si lo cambia. human_instruction_seq identifica esa instrucción; incluilo con el mismo valor en tu próxima entrega ready. Las correcciones reemplazan la respuesta cuyo number global coincide con supersedes, conservando su historia. Los números globales no son índices del contexto filtrado. No confundas la seq de esa pregunta antigua con la identidad de la nueva instrucción.
`, output, example, answer)
	path := filepath.Join(worktree, ".fluke-worker-contract.md")
	if info, e := os.Lstat(path); e == nil && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
		return "", errors.New(uiText("contrato local inválido"))
	}
	return runID, os.WriteFile(path, []byte(body), 0600)
}

func readWorkerReport(path string, task Task) (workerReport, error) {
	var report workerReport
	f, err := os.Open(path)
	if err != nil {
		return report, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 16384 {
		return report, errors.New(uiText("reporte inválido o demasiado grande"))
	}
	data, err := io.ReadAll(io.LimitReader(f, 16385))
	if err != nil {
		return report, err
	}
	if len(data) > 16384 {
		return report, errors.New("reporte demasiado grande")
	}
	if err = json.Unmarshal(data, &report); err != nil {
		return report, err
	}
	if report.Version != 1 || report.RunID != task.AgentRun || report.Seq <= task.AgentSeq {
		return report, errors.New(uiText("reporte anterior o de otra ejecución"))
	}
	if strings.TrimSpace(report.Message) == "" && report.Status == "needs_response" && strings.TrimSpace(report.Question) != "" {
		report.Message = report.Question
	}
	if strings.TrimSpace(report.Message) == "" {
		return report, errors.New("falta resumen")
	}
	if report.HelpRequested && (report.Status != "blocked" || strings.TrimSpace(report.Question) == "") {
		return report, errors.New("technical help requires a blocked report and a concrete question")
	}
	if report.Usage != nil {
		if err := validateWorkerUsage(*report.Usage, task); err != nil {
			return report, err
		}
	}
	switch report.Status {
	case "working", "blocked":
	case "needs_response":
		if strings.TrimSpace(report.Question) == "" {
			return report, errors.New("falta pregunta")
		}
	case "ready":
		if task.Worktree == nil || len(report.Evidence) == 0 {
			return report, errors.New("falta evidencia")
		}
		root, err := filepath.EvalSymlinks(*task.Worktree)
		if err != nil {
			return report, err
		}
		for _, name := range report.Evidence {
			if !filepath.IsLocal(name) {
				return report, errors.New("evidencia fuera del worktree")
			}
			path, err := filepath.EvalSymlinks(filepath.Join(root, name))
			if err != nil {
				return report, err
			}
			rel, err := filepath.Rel(root, path)
			if err != nil || !filepath.IsLocal(rel) {
				return report, errors.New("evidencia fuera del worktree")
			}
			info, err := os.Stat(path)
			if err != nil || !info.Mode().IsRegular() {
				return report, errors.New(uiText("evidencia inválida"))
			}
		}
	default:
		return report, errors.New(uiText("estado de reporte desconocido"))
	}
	return report, nil
}

// Herdr distinguishes CLI readiness from task acceptance. Titles are signals,
// not proof of success. Only inspect current bottom rows for approval dialogs.
// ponytail: a small conservative fallback; use native hooks for CLIs without OSC titles.
func detectAgentState(provider, title, screen string) string {
	if provider == "opencode" {
		return acpTitleState(title)
	}
	if provider != "codex" && provider != "claude" {
		return "unknown"
	}
	full := strings.ToLower(screen)
	if providerLimitMessage(provider, screen) != "" {
		return "blocked"
	}
	if strings.Contains(full, "hooks need review") && strings.Contains(full, "continue without trusting") {
		return "blocked"
	}
	if (strings.Contains(full, "trust this folder?") && strings.Contains(full, "trust and continue")) || (strings.Contains(full, "trust") && strings.Contains(full, "yes, i trust this folder")) {
		return "blocked"
	}
	lines := strings.Split(strings.TrimSpace(full), "\n")
	lower := strings.Join(lines[max(0, len(lines)-12):], "\n")
	if strings.Contains(title, "Action Required") {
		return "blocked"
	}
	for _, marker := range []string{"press enter to confirm or esc to cancel", "enter to confirm", "enter to select", "enter to submit answer", "enter to submit all", "allow command?", "do you want to proceed?"} {
		if strings.Contains(lower, marker) {
			return "blocked"
		}
	}
	for _, r := range title {
		if (r >= 0x2800 && r <= 0x28ff) || (provider == "claude" && r >= 0x25d0 && r <= 0x25d3) {
			return "working"
		}
	}
	if strings.Contains(lower, "esc to interrupt") {
		return "working"
	}
	// ConPTY's shell wrapper sets a title before the agent starts.
	lowerTitle := strings.ToLower(title)
	shellTitle := strings.Contains(lowerTitle, "cmd.exe") || strings.Contains(lowerTitle, "powershell.exe") || strings.Contains(lowerTitle, "pwsh.exe")
	if strings.TrimSpace(title) != "" && !shellTitle {
		return "idle"
	}
	return "unknown"
}

func providerLimitMessage(provider, screen string) string {
	full := strings.ToLower(screen)
	if provider == "claude" && strings.Contains(full, "you've hit your session limit") && strings.Contains(full, "stop and wait for limit to reset") {
		return uiText("Límite de uso de Claude. F3 muestra el aviso y la hora de restablecimiento.")
	}
	return ""
}

func (w *terminalWindow) agentSignals() (string, string) {
	w.screen.Lock()
	defer w.screen.Unlock()
	cols, rows := w.screen.Size()
	var bottom strings.Builder
	for y := 0; y < rows; y++ {
		for x := 0; x < cols; x++ {
			r := w.screen.Cell(x, y).Char
			if r == 0 {
				r = ' '
			}
			bottom.WriteRune(r)
		}
		bottom.WriteByte('\n')
	}
	return w.screen.Title(), bottom.String()
}

func (m *model) observeWorkers(readReports bool) {
	if readReports {
		m.enforceTaskSpecs()
	}
	for i, task := range m.state.Tasks {
		if task.Status == "accepted" || task.Paused || taskScopeError(m.state, task) != nil {
			continue
		}
		if task.AgentRun == "" || task.Worktree == nil || m.terminalFor(task.ID) == nil {
			continue
		}
		next := m.state
		next.Tasks = append([]Task{}, next.Tasks...)
		t := &next.Tasks[i]
		var report workerReport
		err := os.ErrNotExist
		if readReports || (task.Status == "running" && !m.sessionAlive(task.ID)) {
			report, err = readWorkerReport(workerSignalPath(*task.Worktree, task.ID, task.AgentRun, "state"), task)
		}
		if err == nil {
			if report.Status == "ready" {
				if instruction, exists := m.latestWorkerInstruction(task); exists && (instruction.Continuation != "sent" || report.HumanInstructionSeq != instruction.HumanInstructionSeq) {
					continue
				}
				if review, exists := m.latestReviewFeedback(task); exists && (review.Continuation != "sent" || report.ReviewSeq != review.Seq) {
					continue // A result predating the human feedback cannot be accepted.
				}
			}
			if task.AgentConfig != nil {
				t.NativeSession = capturedCodexSession(*task.AgentConfig, report.NativeSessionID, *task.Worktree, task.AgentRun, task.NativeSession)
			}
			t.AgentSeq, t.AgentState, t.AgentMessage = report.Seq, report.Status, report.Message
			t.AgentEvidence = report.Evidence
			if report.Usage != nil {
				t.Metrics = t.Metrics.withUsage(task.AgentRun, *report.Usage)
			}
			if report.Status == "ready" {
				if task.Status != "awaiting_review" {
					t.Metrics.Deliveries++
				}
				t.Status = "awaiting_review"
			} else {
				t.Status = "running"
			}
			if strings.TrimSpace(report.Question) != "" && (report.Status == "needs_response" || report.Status == "blocked") {
				next.Decisions = append([]Decision{}, next.Decisions...)
				question := cleanAgentText(report.Question)
				found := false
				for j := range next.Decisions {
					d := &next.Decisions[j]
					if d.TaskID == task.ID && d.RunID == task.AgentRun && d.Answer == nil && d.Question == question {
						d.Seq = report.Seq
						d.Assistance = report.HelpRequested
						found = true
						break
					}
				}
				if !found {
					next.Decisions = append(next.Decisions, Decision{Repo: task.Repo, TaskID: task.ID, RunID: task.AgentRun, Seq: report.Seq, Question: question, Assistance: report.HelpRequested})
				}
			}
		} else {
			if task.Status != "running" || !m.sessionAlive(task.ID) {
				continue
			}
			title, bottom := m.terminalFor(task.ID).agentSignals()
			observed := detectAgentState(task.AgentProvider, title, bottom)
			message := task.AgentMessage
			if limit := providerLimitMessage(task.AgentProvider, bottom); limit != "" {
				message = limit
			} else if task.AgentSeq == 0 && strings.HasPrefix(message, uiText("Límite de uso de ")) {
				message = ""
			}
			if observed == "unknown" && task.AgentSeq > 0 {
				continue
			}
			if observed == "idle" && (task.AgentState == "working" || task.AgentState == "turn_finished") {
				observed = "turn_finished"
			}
			// Explicit questions/results persist until a newer structured report.
			if task.AgentState == "needs_response" || (task.AgentSeq > 0 && task.AgentState == "blocked") {
				continue
			}
			if observed == task.AgentState && message == task.AgentMessage {
				continue
			}
			t.AgentState, t.AgentMessage = observed, message
		}
		if err := m.store.save(next); err != nil {
			m.notice = uiText("No se pudo guardar el reporte: ") + err.Error()
			continue
		}
		m.state = next
		if err == nil && report.Status == "needs_response" {
			m.notice = uiText("El worker pide una decisión · F4 para responder.")
		}
		if err == nil && report.Status == "ready" {
			m.notice = uiText("Entrega disponible para revisión humana · F2 para ver el resultado.")
		}
		m.refreshProjectContexts()
	}
}

func (m *model) scheduleWorkerTick() tea.Cmd {
	if m.workerTickPending || !m.coordinationPending() {
		return nil
	}
	m.workerTickPending = true
	return tea.Tick(time.Second, func(time.Time) tea.Msg { return workerTick{} })
}

func taskAgentStatus(t Task) string {
	if t.Status == "accepted" && t.Integration != nil && t.Integration.MergedCommit != "" {
		return "integrated"
	}
	if t.Paused {
		if t.Status == "running" {
			return "pausing"
		}
		if t.Status == "pending" || t.Status == "interrupted" {
			return "paused"
		}
	}
	if t.Status == "pending" && t.Queued {
		if len(t.DependsOn) > 0 {
			return "waiting_dependencies"
		}
		return "queued"
	}
	if t.Status != "running" {
		return t.Status
	}
	switch t.AgentState {
	case "working", "idle", "turn_finished", "blocked", "needs_response":
		return t.AgentState
	}
	return t.Status
}

// Keep control characters from structured reports out of the UI.
func cleanAgentText(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return -1
		}
		return r
	}, s)
}

func (m *model) selectedDecision() int {
	var indexes []int
	for i, d := range m.state.Decisions {
		if d.Repo == m.repo {
			indexes = append(indexes, i)
		}
	}
	if len(indexes) == 0 {
		return -1
	}
	return indexes[m.selected%len(indexes)]
}

func projectContextPath(dir, repo string) string {
	hash := sha256.Sum256([]byte(repo))
	return filepath.Join(dir, "contexts", fmt.Sprintf("project-%x.json", hash[:12]))
}

func (m *model) refreshProjectContexts() {
	m.refreshWorkerContexts()
	m.refreshOrchestrators(true)
	for repo, goal := range m.state.Goals {
		data, _ := json.MarshalIndent(goal, "", "  ")
		if err := writeBrief(filepath.Join(repo, ".fluke", "specs", goal.ID+".json"), string(data)); err != nil {
			m.notice = uiText("Objetivo guardado; no se pudo escribir su spec en el repo: ") + err.Error()
		}
	}
	for _, repo := range m.state.Projects {
		path := projectContextPath(m.store.dir, repo)
		if _, err := os.Stat(path); err != nil {
			continue
		}
		if err := atomicJSON(path, m.state); err != nil {
			m.notice = uiText("Estado guardado; no se pudo actualizar el contexto del orquestador: ") + err.Error()
		}
	}
}
