package main

import (
	tea "charm.land/bubbletea/v2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type orchestratorSession struct {
	RunID, Dir, Provider string
	Config               AgentConfig
	ChatSeq              uint64
	ChatWriting          bool
	PendingChat          *chatSentResult
	ChatSending          bool
	ReplyStarted         time.Time
	ReportSeq            uint64
	Seq                  uint64
	PendingAck           *orchestratorAck
	Hash                 [32]byte
	Notify, Sending      bool
	IdleSince            time.Time
	nativeReplies        *nativeReplyReader
	nativePrepared       bool
	nativeAwaiting       bool
}
type orchestratorCommand struct {
	Version    int      `json:"version"`
	RunID      string   `json:"run_id"`
	Seq        uint64   `json:"seq"`
	Action     string   `json:"action"`
	GoalID     string   `json:"goal_id,omitempty"`
	TaskID     string   `json:"task_id,omitempty"`
	Question   string   `json:"question,omitempty"`
	Title      string   `json:"title,omitempty"`
	Acceptance string   `json:"acceptance,omitempty"`
	DependsOn  []string `json:"depends_on,omitempty"`
}
type orchestratorAck struct {
	Version int    `json:"version"`
	RunID   string `json:"run_id"`
	Seq     uint64 `json:"seq"`
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}
type orchestratorWakeResult struct {
	Repo, RunID string
	Err         error
}

func (m *model) orchestratorContext(repo string) any {
	tasks := []Task{}
	decisions := []Decision{}
	blocked := map[string]string{}
	prs := map[string]*githubPRStatus{}
	checksCurrent := m.dependencyHash == dependencyStateHash(m.state)
	for _, t := range m.state.Tasks {
		if t.Repo == repo {
			tasks = append(tasks, t)
			if status := m.githubPRContext(t); status != nil {
				prs[t.ID] = status
			}
			if checksCurrent && m.dependencyChecks[t.ID] != "" {
				blocked[t.ID] = m.dependencyChecks[t.ID]
			}
		}
	}
	for i, d := range m.state.Decisions {
		if d.Repo == repo {
			d.Number = i + 1
			decisions = append(decisions, d)
		}
	}
	return struct {
		Repo                string                     `json:"repo"`
		DraftGoal           GoalDraft                  `json:"draft_goal"`
		Goal                ProjectGoal                `json:"goal"`
		Conversation        []ConversationMessage      `json:"conversation"`
		Tasks               []Task                     `json:"tasks"`
		Decisions           []Decision                 `json:"decisions"`
		MaxWorkers          int                        `json:"max_workers_global"`
		LiveWorkers         int                        `json:"live_workers_global"`
		Paused              bool                       `json:"project_paused"`
		BlockedDependencies map[string]string          `json:"blocked_dependencies,omitempty"`
		Language            string                     `json:"language"`
		PullRequests        map[string]*githubPRStatus `json:"pull_requests,omitempty"`
	}{repo, m.state.DraftGoals[repo], m.state.Goals[repo], m.state.Conversations[repo], tasks, decisions, m.state.MaxWorkers, m.liveWorkers(), m.state.PausedProjects[repo], blocked, m.state.Language, prs}
}
func prepareOrchestrator(repo string, snapshot any) (string, string, error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", "", err
	}
	runID := hex.EncodeToString(random[:])
	for _, path := range []string{filepath.Join(repo, ".fluke"), filepath.Join(repo, ".fluke", "orchestrator")} {
		if info, err := os.Lstat(path); err == nil && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
			return "", "", errors.New(uiText("directorio local del orquestador inválido"))
		}
	}
	dir := filepath.Join(repo, ".fluke", "orchestrator", runID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", "", err
	}
	exclude, err := git(repo, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude")
	if err != nil {
		return "", "", err
	}
	previous, err := os.ReadFile(exclude)
	if err != nil && !os.IsNotExist(err) {
		return "", "", err
	}
	if !strings.Contains("\n"+string(previous)+"\n", "\n/.fluke/\n") {
		f, e := os.OpenFile(exclude, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
		if e != nil {
			return "", "", e
		}
		_, e = f.WriteString("\n/.fluke/\n")
		closeErr := f.Close()
		if e != nil {
			return "", "", e
		}
		if closeErr != nil {
			return "", "", closeErr
		}
	}
	if err = atomicJSON(filepath.Join(dir, "context.json"), snapshot); err != nil {
		return "", "", err
	}
	example, _ := json.Marshal(orchestratorCommand{Version: 1, RunID: runID, Seq: 1, Action: "queue_task", TaskID: "ID de una tarea del contexto"})
	body := fmt.Sprintf(`# Orquestador de Fluke

Tu sesión es %s. Sos un compañero de conversación y trabajo. Respondé con naturalidad, cercanía y criterio, adaptando el tono al humano. Podés charlar, contestar dudas, explicar, ayudar a pensar y acompañar trabajo existente. No te presentes como orquestador en cada respuesta ni conviertas saludos o preguntas en un formulario de proyectos. No exijas un objetivo para conversar. Cuando el humano describa un proyecto nuevo, ayudalo a bajar sus requisitos y armar un plan concreto, aunque todavía no haya autorizado la implementación. Cuando quiera ejecutar trabajo, acordá el alcance y coordiná el plan. Todos los archivos de este contrato están en esta misma carpeta y excluidos de Git.
Antes de terminar cada turno, escribí update.json en esta misma carpeta usando temporal y rename. Formato: {"version":1,"run_id":"%s","seq":1,"message":"Tu mensaje al humano"}. Conservá run_id, incrementá seq en cada mensaje. message es la respuesta conversacional para la pantalla de Fluke. Respondé a lo que el humano dijo; no uses una plantilla de estado para charla o consultas. Cuando haya avances, bloqueos o decisiones relevantes, contalos brevemente. Una línea alcanza para una respuesta simple; usá hasta 6 líneas y 1200 caracteres. Podés incluir ejemplos o comandos útiles que el humano haya pedido. Omití transcripciones de herramientas, tokens, razonamiento interno y narración de cada paso. No repitas el mismo estado ni generes mensajes por cada herramienta. Escribilo también cuando necesites esperar: sin ese archivo el humano solo verá actividad del sistema. Las actualizaciones no necesitan un ack.
Para saludos, charla y preguntas que podés contestar con lo que ya sabés, respondé enseguida en update.json con una sola escritura. No releas el contrato, context.json ni ack.json, no explores el repositorio y no registres una decisión o propuesta para contestar esos mensajes. El mensaje recibido en la terminal es la intervención actual del humano. Leé el contexto cuando haya novedades de coordinación o el pedido requiera conocer tareas o archivos. Si vas a hacer un análisis largo, escribí primero una confirmación breve en ese canal. Las preguntas conversacionales van en message; usá ask solo para decisiones concretas que bloquean trabajo.
Excepción para chat rápido: si el mensaje empieza con [Fluke: respuesta nativa verificada], tu respuesta final normal llega directamente a F2 sin update.json. Para charla y dudas que podés resolver con lo que ya sabés, respondé sin herramientas. Consultá datos actuales del proyecto cuando la pregunta lo requiera. El protocolo command.json sigue vigente para coordinar tareas y decisiones; update.json sigue disponible para avances durante trabajo largo.
Solo al comenzar la sesión, si CODEX_SESSION_ID (o CODEX_THREAD_ID) está presente, obtené esa variable exacta con una herramienta y conservá su UUID como native_session_id en update.json para recuperar el historial. No vuelvas a consultar el entorno en cada mensaje. Omitilo si no existe; no inventes IDs ni vuelques otras variables de entorno.

En conversation, los mensajes humanos con delivery=pending o uncertain no son nuevas órdenes confirmadas: esperá su entrega o pedí aclaración.

Cuando necesites coordinar trabajo, context.json contiene las tareas y decisiones de este repositorio y el cupo global de workers. No lo revises por rutina en cada mensaje humano.
Sos el punto de conversación principal. Los workers ejecutan las tareas en worktrees aislados; no implementes sus cambios en el checkout principal.

El brief se revisa dentro de Fluke en F4 (Brief y decisiones), con scroll; F2 es el único chat. Si el humano pregunta dónde leerlo, indicá F4 o escribir ver brief en el chat. Mantené draft_goal actualizado con todos los requisitos, criterios y dudas conocidos. No reemplaces esta vista con enlaces a brief.md ni le exijas abrir archivos para revisar requisitos.
Un proyecto nuevo no es charla casual: recogé lo que el humano explicó y guardalo con draft_goal desde los primeros hechos, separá requisitos, criterios verificables y dudas que cambian el alcance. Con información suficiente, registrá propose_goal con ese resumen y sus criterios; no dejes los requisitos solo en una respuesta de chat ni le pidas al humano escribir las tareas. Podés proponer el alcance antes de autorizar implementación. Explicá en tu respuesta que la propuesta se puede revisar y responder en el mismo chat con Ctrl+D; para aprobar escribe apruebo y Enter, para rechazar escribe rechazo y Enter; mencioná esa acción antes de detalles que puedan truncarse en F2. No digas que creaste tareas si solo propusiste el objetivo.
Después de la aprobación, leé el goal actual, descomponelo en tareas concretas con create_task, criterios de aceptación y dependencias cuando correspondan, y presentá el plan. La aprobación del objetivo autoriza preparar esas tareas, pero no ejecutar implementación. Ofrecé ejecutar plan en el mismo chat cuando el plan esté listo. No pidas permiso para crear cada tarea. Un aviso de coordinación con un objetivo aprobado y sin tareas requiere armar ese plan, no solo confirmar que esperás pedidos. Preguntá únicamente por dudas que impiden definir o ejecutar una tarea; avanzá con las partes que ya están claras.

Para pedir una acción, escribí command.json usando un temporal en esta carpeta y renombralo al destino. Ejemplo:
%s

Acciones permitidas:
- draft_goal: registrá los hechos y requisitos de un proyecto nuevo a medida que el humano los explica, antes de tener un alcance completo. title resume el pedido, acceptance conserva los requisitos y criterios conocidos, question enumera dudas pendientes (pueden quedar vacíos al principio). Reemplaza el borrador completo de este repositorio; conservá los hechos anteriores y reflejá las correcciones. No autoriza ejecución ni crea tareas.
- propose_goal: title describe el objetivo y el alcance; acceptance especifica cómo verificarlo. Debe aprobarlo el humano antes de ejecutar trabajo nuevo. Que goal esté vacío no impide conversar, responder preguntas o dar consejos. Proponé un objetivo cuando el humano describa un proyecto o cambio con suficiente información para acordar requisitos; la propuesta todavía no autoriza ejecución. Si cambia el alcance de ejecución, proponé otro objetivo.
- create_task: title y acceptance definen una parte del plan del objetivo ya acordado. goal_id debe ser el ID actual de goal en context.json. Podés crear las tareas del plan SOLO dentro de ese alcance. Crear tareas no autoriza arrancar workers: quedan awaiting_execution=true hasta que el humano escriba ejecutar plan en el chat o inicie/encole una tarea. Presentá el plan y ofrecé ejecutar plan; no uses queue_task para saltar esta aprobación. Una tarea = un worker que la analiza, implementa y verifica. No crees perfiles. depends_on es una lista opcional de IDs de tareas previas del mismo objetivo/repositorio. Creá primero las tareas base y obtené sus IDs del contexto; luego creá sus dependientes. Fluke espera aceptación humana y commits de esas ramas integrados en la base antes de iniciar dependientes. Una entrega aceptada con cambios sin commit no habilita dependencias. No hagas merge ni commits por tu cuenta para destrabar la cola.
- queue_task: task_id identifica una tarea ya autorizada del contexto. Fluke inicia el worker cuando haya cupo global. El worker se hace cargo de implementación, validación y entrega. Una tarea running o awaiting_review no se reinicia.
- unqueue_task: retira una tarea pendiente de la cola.
- stop_task: detiene un worker de este repositorio; conserva sus cambios para revisión.
- ask: question contiene una pregunta de producto/alcance para el humano.
- propose_task: title y acceptance proponen una tarea nueva. Fluke pide aprobación humana antes de crearla o iniciarla. No des por aprobado un cambio de alcance.

Conservá version=1 y run_id. Incrementá seq en cada orden. Hay una sola orden en vuelo: esperá ack.json con el mismo run_id y seq antes de escribir la siguiente. Si ok=false leé message y corregí la causa. No reescribas la misma seq con otra acción.
Las respuestas humanas y reportes aparecen en context.json. Fluke te avisa cuando haya cambios si tu CLI está disponible. Para esperar una orden, un worker o una respuesta, terminá el turno con un mensaje breve: no hagas polling en bucles de shell ni sigas trabajando sin alcance autorizado.
Las decisiones con direct_instruction=true son mensajes humanos enviados directamente al worker y compartidos contigo. Las decisiones con supersedes reemplazan la respuesta cuyo number global coincide con supersedes, sin borrar su fuente. Los números globales no son índices de este array filtrado. Ajustá la coordinación y las dependencias dentro del alcance; si la intervención lo cambia, proponé un objetivo nuevo y esperá aprobación. Una instrucción pending/sending/uncertain no prueba que el worker ya la haya incorporado.
pull_requests resume consultas de solo lectura a GitHub: revisiones, checks y estado remoto. Un PR MERGED no prueba integración local ni habilita dependencias por sí mismo. No repitas actualizaciones por cada consulta sin cambios. Ante CHANGES_REQUESTED o checks fallidos, explicá el problema relevante y coordiná una tarea autorizada; la publicación o integración requieren acción humana.
No uses AskUserQuestion/request_user_input: escribí ask y terminá el turno. Los permisos propios de la CLI se resuelven en la terminal.
Una entrega awaiting_review requiere revisión humana. No hagas merge, publicación, push ni cambies la configuración de Fluke. No hay perfiles de workers.
`, runID, runID, example)
	err = os.WriteFile(filepath.Join(dir, "contract.md"), []byte(body), 0600)
	return runID, dir, err
}
func readOrchestratorCommand(dir string) (orchestratorCommand, error) {
	var c orchestratorCommand
	root, err := os.OpenRoot(dir)
	if err != nil {
		return c, err
	}
	defer root.Close()
	f, err := root.Open("command.json")
	if err != nil {
		return c, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 16384 {
		return c, errors.New(uiText("orden inválida o demasiado grande"))
	}
	data, err := io.ReadAll(io.LimitReader(f, 16385))
	if err != nil {
		return c, err
	}
	err = json.Unmarshal(data, &c)
	return c, err
}
func (m *model) applyOrchestratorCommand(repo string, c orchestratorCommand) (string, error) {
	next := m.state
	switch c.Action {
	case "draft_goal":
		title := strings.TrimSpace(cleanAgentText(c.Title))
		if title == "" {
			return "", errors.New(localText("The requirement draft needs a title.", "El borrador de requisitos necesita un título."))
		}
		next.DraftGoals = cloneGoalDrafts(next.DraftGoals)
		next.DraftGoals[repo] = GoalDraft{Title: title, Acceptance: cleanAgentText(c.Acceptance), OpenQuestions: cleanAgentText(c.Question)}
	case "create_task":
		goal := next.Goals[repo]
		if goal.ID == "" || c.GoalID != goal.ID {
			return "", errors.New(uiText("acordá un objetivo y referenciá su goal_id antes de crear tareas"))
		}
		for _, task := range next.Tasks {
			if task.Repo == repo && task.GoalID == goal.ID && strings.EqualFold(strings.TrimSpace(task.Title), strings.TrimSpace(c.Title)) && strings.TrimSpace(task.Acceptance) == strings.TrimSpace(c.Acceptance) {
				return "", fmt.Errorf(uiText("la tarea ya existe (%s); usá su estado en context.json"), task.ID)
			}
		}
		if err := next.addTask(repo, cleanAgentText(c.Title), cleanAgentText(c.Acceptance)); err != nil {
			return "", err
		}
		created := &next.Tasks[len(next.Tasks)-1]
		created.GoalID = goal.ID
		created.DependsOn = append([]string{}, c.DependsOn...)
		if err := validateTaskDependencies(next, *created); err != nil {
			return "", err
		}
		created.Queued = false
		created.AwaitingExecution = true
	case "queue_task", "unqueue_task", "stop_task":
		index := -1
		for i, t := range next.Tasks {
			if t.ID == c.TaskID && t.Repo == repo {
				index = i
				break
			}
		}
		if index < 0 {
			return "", errors.New(uiText("la tarea no pertenece a este repositorio"))
		}
		t := next.Tasks[index]
		if c.Action == "queue_task" {
			if t.AwaitingExecution {
				return "", errors.New(localText("The plan needs human execution approval in chat: run plan, or queue an individual task.", "El plan requiere aprobación humana de ejecución en el chat: ejecutar plan, o encolar una tarea individual."))
			}
			if err := taskScopeError(next, t); err != nil {
				return "", err
			}
		}
		if c.Action == "stop_task" {
			if !m.sessionAlive(t.ID) {
				return "", errors.New(uiText("el worker no está activo"))
			}
			m.stop(t.ID)
			if m.sessionAlive(t.ID) {
				return "", errors.New(uiText("no se pudo detener el worker"))
			}
			return "Worker detenido; cambios conservados.", nil
		}
		if t.Status != "pending" && t.Status != "interrupted" {
			return "", errors.New(uiText("la tarea no está pendiente ni interrumpida"))
		}
		next.Tasks = append([]Task{}, next.Tasks...)
		next.Tasks[index].Queued = c.Action == "queue_task"
	case "ask", "propose_task", "propose_goal":
		d := Decision{Repo: repo, RunID: c.RunID, Seq: c.Seq}
		if c.Action == "ask" {
			d.Question = strings.TrimSpace(cleanAgentText(c.Question))
			if d.Question == "" {
				return "", errors.New(uiText("falta una pregunta concreta"))
			}
		} else {
			d.ProposedGoal = c.Action == "propose_goal"
			d.ProposedTitle = strings.TrimSpace(cleanAgentText(c.Title))
			d.ProposedAcceptance = strings.TrimSpace(cleanAgentText(c.Acceptance))
			if d.ProposedTitle == "" || d.ProposedAcceptance == "" {
				return "", errors.New(uiText("la propuesta requiere título y criterio de aceptación"))
			}
			d.Question = uiText("¿Autorizar esta tarea? ") + d.ProposedTitle
			if d.ProposedGoal {
				d.Question = uiText("¿Acordamos este objetivo y su alcance? ") + d.ProposedTitle
			}
			d.Question += uiText("\nAceptación: ") + d.ProposedAcceptance
		}
		next.Decisions = append(append([]Decision{}, next.Decisions...), d)
	default:
		return "", errors.New(uiText("acción no admitida por Fluke"))
	}
	if !m.saveEdit(next, uiText("Orden del orquestador registrada.")) {
		return "", errors.New(m.notice)
	}
	if (c.Action == "ask" || c.Action == "propose_goal" || c.Action == "propose_task") && repo == m.repo && m.view == 1 && m.pane == 1 && !m.config && !m.review.open && !m.githubOpen && !m.projects.open && m.chatDraft[repo] == "" && m.chatDecision == 0 {
		m.chatDecision = len(m.state.Decisions)
		m.chatDecisionScroll = 0
	}
	if c.Action == "unqueue_task" && m.preparingTaskID == c.TaskID && m.preparingQueued {
		m.cancelPreparing = true
	}
	return "Acción registrada. Leé context.json para el estado actual.", nil
}
func (m *model) pollOrchestrators() {
	for repo, s := range m.orchestration {
		if !m.sessionAlive("fluke:" + repo) {
			continue
		}
		if s.PendingAck != nil {
			if err := atomicJSON(filepath.Join(s.Dir, "ack.json"), s.PendingAck); err != nil {
				continue
			}
			s.PendingAck = nil
		}
		c, err := readOrchestratorCommand(s.Dir)
		if err != nil || c.Version != 1 || c.RunID != s.RunID || c.Seq == 0 || c.Seq <= s.Seq {
			continue
		}
		notifyBefore := s.Notify
		message, e := m.applyOrchestratorCommand(repo, c)
		if e != nil {
			message = e.Error()
		}
		s.Seq = c.Seq
		ack := orchestratorAck{Version: 1, RunID: s.RunID, Seq: c.Seq, OK: e == nil, Message: message}
		s.PendingAck = &ack
		if err = atomicJSON(filepath.Join(s.Dir, "ack.json"), ack); err != nil {
			m.notice = uiText("No se pudo entregar la confirmación al orquestador: ") + err.Error()
		}
		if err == nil {
			s.PendingAck = nil
		}
		// Registering a question/proposal is already known to the agent. Its
		// successful ack is not a new human answer: avoid an extra model turn
		// just to announce that it is still waiting. Preserve unrelated news.
		if e == nil && (c.Action == "draft_goal" || c.Action == "ask" || c.Action == "propose_goal" || c.Action == "propose_task") {
			s.Notify = notifyBefore
		} else {
			s.Notify = true
		}
	}
	m.readOrchestratorMessages()
	m.readNativeReplies()
	m.refreshOrchestrators(false)
}
func (m *model) refreshOrchestrators(notify bool) {
	for repo, s := range m.orchestration {
		data, err := json.Marshal(m.orchestratorContext(repo))
		if err != nil {
			continue
		}
		hash := sha256.Sum256(data)
		if hash == s.Hash {
			continue
		}
		if err = atomicJSON(filepath.Join(s.Dir, "context.json"), json.RawMessage(data)); err != nil {
			m.notice = uiText("No se pudo actualizar el contexto: ") + err.Error()
			continue
		}
		s.Hash = hash
		if notify {
			s.Notify = true
		}
	}
}
func (m *model) wakeOrchestrators() tea.Cmd {
	var commands []tea.Cmd
	for repo, s := range m.orchestration {
		if !s.Notify || s.Sending || s.ChatSending || s.nativeAwaiting || !s.ReplyStarted.IsZero() {
			continue
		}
		w := m.terminalFor("fluke:" + repo)
		if w == nil || w.ProcessExited() || w.userInputPending.Load() || m.chatDraft[repo] != "" {
			continue
		}
		title, screen := w.agentSignals()
		if detectAgentState(s.Provider, title, screen) != "idle" {
			s.IdleSince = time.Time{}
			continue
		}
		if s.IdleSince.IsZero() {
			s.IdleSince = time.Now()
			continue
		}
		if time.Since(s.IdleSince) < 500*time.Millisecond {
			continue
		}
		s.Sending = true
		s.Notify = false
		s.IdleSince = time.Time{}
		runID := s.RunID
		commands = append(commands, func() tea.Msg {
			err := w.sendAutomaticPrompt(s.Provider, "Hay novedades de coordinación. Leé context.json y ack.json en la carpeta de tu contrato. Atendé lo que cambió dentro del alcance autorizado. Si hay un objetivo aprobado sin tareas, creá las tareas del plan con criterios verificables y dependencias usando el protocolo; no esperes que el humano las escriba. Contale al humano solo novedades útiles; no anuncies confirmaciones internas, no repitas preguntas pendientes ni recordatorios de tu rol. Si nada requiere su atención, no escribas otro mensaje y terminá el turno.")
			return orchestratorWakeResult{Repo: repo, RunID: runID, Err: err}
		})
	}
	return tea.Batch(commands...)
}
func (m *model) receiveOrchestratorWake(v orchestratorWakeResult) {
	s := m.orchestration[v.Repo]
	if s == nil || s.RunID != v.RunID {
		return
	}
	s.Sending = false
	if errors.Is(v.Err, errAutomaticDeferred) {
		s.Notify = true
		s.IdleSince = time.Time{}
		return
	}
	if v.Err != nil {
		m.notice = uiText("No se pudo avisar al orquestador. Revisá su sesión antes de continuar.")
	}
}
func (m *model) resolveProposal(id string, approved bool) tea.Cmd {
	previousGoal := m.state.Goals[m.repo].ID
	cmd := m.resolveProposalReply(id, approved, "")
	if approved && m.state.Goals[m.repo].ID != previousGoal && m.state.Orchestrator != nil && !m.sessionAlive("fluke:"+m.repo) {
		return tea.Batch(cmd, m.start(""))
	}
	return cmd
}

func (m *model) resolveProposalReply(id string, approved bool, reply string) tea.Cmd {
	n, err := strconv.Atoi(strings.TrimSpace(id))
	if err != nil || n < 1 || n > len(m.state.Decisions) {
		m.notice = uiText("Usá :approve N o :reject N")
		return nil
	}
	d := m.state.Decisions[n-1]
	if d.ProposedTitle == "" || d.Answer != nil {
		m.notice = uiText("No hay una propuesta pendiente en esa decisión.")
		return nil
	}
	next := m.state
	next.Decisions = append([]Decision{}, next.Decisions...)
	answer := "rechazada"
	if approved && d.ProposedGoal {
		if err = next.setGoal(d.Repo, d.ProposedTitle, d.ProposedAcceptance); err != nil {
			m.notice = err.Error()
			return nil
		}
		answer = "aprobada"
	} else if approved {
		if err = next.addTask(d.Repo, d.ProposedTitle, d.ProposedAcceptance); err != nil {
			m.notice = err.Error()
			return nil
		}
		next.Tasks[len(next.Tasks)-1].Queued = true
		answer = "aprobada"
	}
	next.Decisions[n-1].Answer = &answer
	if reply != "" {
		next = withConversation(next, d.Repo, ConversationMessage{Role: "human", Text: reply, RunID: d.RunID, Delivery: "sent"})
		message := localText("Proposal rejected. Tell Fluke what to change.", "Propuesta rechazada. Contale a Fluke qué querés cambiar.")
		if approved {
			message = localText("Proposal approved. Fluke can continue within this scope.", "Propuesta aprobada. Fluke puede continuar dentro de este alcance.")
		}
		next = withConversation(next, d.Repo, ConversationMessage{Role: "fluke", Text: message, RunID: d.RunID})
	}
	save := m.saveEdit
	if approved && d.ProposedGoal {
		save = m.saveGoalEdit
	}
	notice := localText("Proposal rejected.", "Propuesta rechazada.")
	if approved {
		notice = localText("Proposal approved.", "Propuesta aprobada.")
	}
	if !save(next, notice) {
		return nil
	}
	return tea.Batch(m.drainQueue(), m.scheduleWorkerTick())
}

func (m *model) markConversationDraft() {
	if w := m.terminalFor("fluke:" + m.repo); w != nil {
		w.conversationPending.Store(m.chatDraft[m.repo] != "")
	}
}

func cloneGoals(goals map[string]ProjectGoal) map[string]ProjectGoal {
	next := map[string]ProjectGoal{}
	for repo, g := range goals {
		next[repo] = g
	}
	return next
}

func cloneGoalDrafts(drafts map[string]GoalDraft) map[string]GoalDraft {
	next := make(map[string]GoalDraft, len(drafts)+1)
	for repo, draft := range drafts {
		next[repo] = draft
	}
	return next
}
