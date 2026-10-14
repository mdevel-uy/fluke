package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"path/filepath"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
)

type launchResult struct {
	taskID, repo, path, name string
	argv                     []string
	err                      error
	runID, provider          string
	baseCommit               string
	briefHash                string
	submittedDraft           string
	orchestrationDir         string
	config                   AgentConfig
	dependencyBlocked        bool
	background               bool
	nativeSession            *NativeSession
}
type model struct {
	store                              *Store
	state                              State
	repo                               string
	home                               bool
	projects                           projectEditor
	terminals                          *windowManager
	sessions                           map[string]string // durable task ID (or repo orchestrator) -> PTY window ID
	width, height, view, selected      int
	command                            *string
	notice                             string
	preparing                          bool
	quitting                           bool
	config                             bool
	field                              int
	draft                              [5]string
	draftAutonomous                    bool
	pane                               int
	chatDraft                          map[string]string
	chatCaret                          map[string]int // Distance from the end; new/replaced drafts start at the end.
	taskScroll                         int
	workerMessageID                    string
	github                             map[string]githubSnapshot
	githubOpen                         bool
	githubSelected                     int
	githubScroll                       int
	githubDetail                       bool
	githubCancel                       map[string]context.CancelFunc
	githubFollowups                    map[string]githubPRWatch
	githubFollowupCancel               map[string]context.CancelFunc
	githubFollowupTickPending          bool
	configSection                      int
	themeSelected                      int
	auth                               githubAuth
	authCancel                         context.CancelFunc
	authGeneration, authSelected       int
	authConfirm                        bool
	workerTickPending                  bool
	idleSince                          map[string]time.Time
	preparingWorker                    bool
	preparingTaskID                    string
	preparingQueued, cancelPreparing   bool
	orchestration                      map[string]*orchestratorSession
	review                             reviewPanel
	acceptingTaskID, integratingTaskID string
	publishingTaskID                   string
	chatScroll                         int
	provider                           providerHealth
	providerBusy                       bool
	providerGeneration                 uint64
	connHealth                         map[string]providerHealth
	connGeneration                     uint64
	connSelected                       int
	sessionHits                        []sessionHit
	modelChoices                       []string
	dependencyChecks                   map[string]string
	dependencyHash                     [32]byte
	dependencyChecked                  time.Time
	dependencyChecking                 bool
	setup                              firstRun
	metricsAt, metricsSaved            time.Time
	insights                           bool
	mouseDisabled                      bool
	floating                           floatingChat
	switcher                           *quickSwitcher
}

func newModel(store *Store, state State, repo string) *model {
	applyTheme(state.Theme)
	t := newWindowManager(100, 30)
	m := &model{store: store, state: state, repo: repo, terminals: t, sessions: map[string]string{}, chatDraft: map[string]string{}, pane: 1, width: 100, height: 36, notice: uiText("Contame qué querés lograr. Fluke prepara el plan y coordina el trabajo.")}
	t.titleFor = m.windowTitle
	m.home = repo == ""
	if m.home {
		m.pane = 0
	} else {
		m.view = 1
	}
	if state.Orchestrator == nil {
		m.openConfig()
	}
	m.github = map[string]githubSnapshot{}
	m.githubCancel = map[string]context.CancelFunc{}
	m.githubFollowups = map[string]githubPRWatch{}
	m.githubFollowupCancel = map[string]context.CancelFunc{}
	m.idleSince = map[string]time.Time{}
	m.orchestration = map[string]*orchestratorSession{}
	if saved := state.ChatWindow; saved != nil {
		m.floating = floatingChat{open: true, bounds: rectangle{saved.X, saved.Y, saved.Width, saved.Height}}
	}
	return m
}
func (m *model) Init() tea.Cmd {
	if m.setup.open {
		commands := []tea.Cmd{m.terminals.Init(), m.scanHarnesses(), m.setupPulse()}
		if m.setup.step >= 3 && !m.setup.githubLocal {
			commands = append(commands, m.refreshGithubAuth())
		}
		return tea.Batch(commands...)
	}
	return tea.Batch(m.terminals.Init(), m.checkProvider(), m.drainQueue(), m.scheduleWorkerTick(), m.queryPublishedPR("", false), m.scheduleGithubFollowup())
}
func (m *model) save() {
	if err := m.store.save(m.state); err != nil {
		m.notice = uiText("No se pudo guardar: ") + err.Error()
	} else {
		m.refreshProjectContexts()
	}
}
func (m *model) saveEdit(next State, success string) bool {
	if err := m.store.save(next); err != nil {
		m.notice = uiText("No se pudo guardar: ") + err.Error()
		return false
	}
	m.state = next
	m.notice = success
	m.refreshProjectContexts()
	return true
}
func (m *model) openConfig() {
	m.draftAutonomous = m.state.AutonomousFluke
	m.configSection = 0
	m.authConfirm = false
	m.config = true
	m.field = 0
	m.draft = [5]string{"codex", "codex", "", "[]", strconv.Itoa(m.state.MaxWorkers)}
	if a := m.state.Orchestrator; a != nil {
		args, _ := json.Marshal(append([]string{}, a.Arguments...))
		m.draft = [5]string{a.Provider, a.Executable, a.Model, string(args), strconv.Itoa(m.state.MaxWorkers)}
	}
	m.modelChoices = providerModelChoices(m.draft[0])
}
func (m *model) saveConfig() error {
	a := AgentConfig{Provider: m.draft[0], Executable: strings.TrimSpace(m.draft[1]), Model: strings.TrimSpace(m.draft[2]), Arguments: []string{}}
	if err := json.Unmarshal([]byte(m.draft[3]), &a.Arguments); err != nil {
		return errors.New(uiText("argumentos: usá una lista JSON, por ejemplo []"))
	}
	if a.Arguments == nil {
		return errors.New(uiText("argumentos: usá [] en lugar de null"))
	}
	if _, err := a.argv(); err != nil {
		return err
	}
	limit, err := strconv.Atoi(m.draft[4])
	if err != nil || limit < 1 || limit > 64 {
		return errors.New(uiText("workers: indicá un número entre 1 y 64"))
	}
	state := m.state
	state.Orchestrator = &a
	state.AutonomousFluke = m.draftAutonomous
	state.MaxWorkers = limit
	if err = m.store.save(state); err != nil {
		return err
	}
	m.state = state
	m.config = false
	m.notice = uiText("Configuración guardada. Workers nuevos usan ") + configLabel(&a) + "."
	if m.sessionAlive("fluke:" + m.repo) {
		m.notice += uiText(" F5 → Ctrl+Enter la aplica a Fluke.")
	}
	m.refreshProjectContexts()
	return nil
}
func (m *model) liveWorkers() int {
	n := 0
	for _, t := range m.state.Tasks {
		if m.sessionAlive(t.ID) {
			n++
		}
	}
	if m.preparing && m.preparingWorker {
		n++
	}
	return n
}
func (m *model) sessionAlive(key string) bool {
	id := m.sessions[key]
	for _, w := range m.terminals.Windows {
		if w.ID == id {
			return !w.ProcessExited()
		}
	}
	return false
}
func (m *model) reconcile() {
	m.observeWorkers(false)
	changed := false
	for i := range m.state.Tasks {
		t := &m.state.Tasks[i]
		if w := m.terminalFor(t.ID); t.Status == "running" && w != nil {
			if err := w.shutdownError.Load(); err != nil {
				note := "Error al cerrar procesos; cupo retenido: " + *err
				if t.Note != note {
					t.Note = note
					m.notice = note
					changed = true
				}
			}
		}
		if t.Status == "running" && !m.sessionAlive(t.ID) {
			t.Status = "interrupted"
			t.Note = uiText("La sesión terminó. Revisar los cambios; la salida no implica aceptación.")
			changed = true
		}
	}
	if changed {
		m.save()
	}
}
func (m *model) start(taskID string) tea.Cmd {
	return m.startSession(taskID, false)
}

func (m *model) startSession(taskID string, background bool) tea.Cmd {
	if taskID == "" && m.repo == "" {
		m.notice = localText("Create or open a project from F1 first.", "Primero creá o abrí un proyecto desde F1.")
		return nil
	}
	if m.preparing {
		m.notice = uiText("Hay una sesión en preparación.")
		return nil
	}
	if m.state.Orchestrator == nil {
		m.openConfig()
		return nil
	}
	a := *m.state.Orchestrator
	repo := m.repo
	dir := m.store.dir
	if taskID == "" {
		if a.Provider == "custom" {
			m.notice = uiText("Para conversar con Fluke, elegí Codex o Claude en F5. El proveedor custom abre procesos de workers.")
			return nil
		}
		if m.sessionAlive("fluke:" + repo) {
			m.view = 2
			m.focus("fluke:" + repo)
			return nil
		}
		if !m.failPendingChat(repo) {
			return nil
		}
		snapshot := m.orchestratorContext(repo)
		language := m.state.Language
		autonomous := m.state.AutonomousFluke
		initialMessage := m.chatDraft[repo]
		if len(initialMessage) > 16000 {
			m.notice = uiText("Resumí el pedido o referenciá un archivo del repo; el mensaje es demasiado largo.")
			return nil
		}
		m.preparing = true
		m.preparingWorker = false
		m.notice = uiText("Preparando orquestador…")
		var previous *NativeSession
		if saved, ok := m.state.OrchestratorSessions[repo]; ok {
			previous = &saved
		}
		return func() tea.Msg {
			runID, path, err := prepareOrchestrator(repo, snapshot)
			prompt := "Fluke · " + filepath.Base(repo) + " · Orchestrator\nRun activo de Fluke: " + runID + ". Sos el orquestador de Fluke. Leé el contrato local " + filepath.Join(path, "contract.md") + " y su contexto. Organizá las tareas autorizadas usando el canal de órdenes del contrato. Proponé nuevos alcances para aprobación humana; no hagas merge. Cuando necesites esperar workers, terminá el turno: Fluke te notificará los cambios."
			if strings.TrimSpace(initialMessage) != "" {
				prompt += "\nPedido inicial del humano: " + initialMessage
			}
			prompt += "\nReconciliá el contexto local con el historial: no dupliques tareas ni repitas órdenes de una ejecución anterior. El contrato nuevo reemplaza canales anteriores."
			prompt += "\n" + agentLanguageInstruction(language)
			if acpWorkerProviders[a.Provider] {
				prompt += acpAgentNote
			}
			launchConfig, native, e := prepareNativeConfig(a, previous, repo, runID)
			if err == nil {
				err = e
			}
			if acpWorkerProviders[launchConfig.Provider] {
				// The orchestrator reports through its contract directory, outside the repo.
				launchConfig.Arguments = append(append([]string{}, launchConfig.Arguments...), "--channel="+path)
			}
			if err == nil && autonomous {
				launchConfig, err = autonomousFlukeConfig(launchConfig, repo)
			}
			argv, e := launchArgv(launchConfig, prompt)
			if err == nil {
				err = e
			}
			return launchResult{repo: repo, path: repo, name: "FLUKE · " + filepath.Base(repo), argv: argv, err: err, runID: runID, provider: a.Provider, config: a, orchestrationDir: path, submittedDraft: initialMessage, nativeSession: native}
		}
	}
	for _, task := range m.state.Tasks {
		if task.ID != taskID {
			continue
		}
		if err := taskScopeError(m.state, task); err != nil {
			m.notice = err.Error()
			return nil
		}
		if task.Paused || m.state.PausedProjects[task.Repo] {
			m.notice = uiText("Tarea o proyecto pausado. :continue ID reanuda la tarea; :continue reanuda el proyecto.")
			return nil
		}
		if task.Status == "accepted" {
			m.notice = uiText("La entrega ya fue aceptada. F7 permite volver a revisar sus cambios.")
			return nil
		}
		if m.sessionAlive(taskID) {
			m.view = 2
			m.focus(taskID)
			return nil
		}
		if m.liveWorkers() >= m.state.MaxWorkers {
			m.notice = uiText("Límite de workers alcanzado.")
			return nil
		}
		m.preparing = true
		m.preparingWorker = true
		if task.WorkerConfig != nil {
			a = *task.WorkerConfig
		}
		m.preparingTaskID = task.ID
		m.preparingQueued = task.Queued
		m.cancelPreparing = false
		m.notice = uiText("Preparando worktree para ") + task.Title
		mSnapshot := m.state
		mSnapshot.Tasks = append([]Task{}, m.state.Tasks...)
		return func() tea.Msg {
			if err := dependencyReadiness(mSnapshot, task, task.Repo); err != nil {
				return launchResult{taskID: task.ID, err: err, dependencyBlocked: true}
			}
			path, err := prepareTask(task, dir)
			baseCommit := task.BaseCommit
			if err == nil {
				refreshedBase, dependencyErr := refreshDependencyWorktree(mSnapshot, task, path)
				if dependencyErr != nil {
					return launchResult{taskID: task.ID, path: path, err: dependencyErr, dependencyBlocked: true}
				}
				if refreshedBase != "" {
					baseCommit = refreshedBase
				}
			}
			runID := ""
			if err == nil && baseCommit == "" {
				baseCommit, err = git(path, "rev-parse", "HEAD")
			}
			if err == nil {
				runID, err = prepareWorkerContract(path, task.ID)
			}
			prompt := "Run activo de Fluke: " + runID + ". Leé .fluke-task.md y .fluke-worker-contract.md. Completá la tarea dentro del alcance y usá el contrato para reportar preguntas y resultados. Verificá el criterio de aceptación. No hagas merge."
			if task.ReviewFeedback != "" {
				prompt += "\nRevisión humana: corregí la entrega siguiendo este comentario: " + task.ReviewFeedback + "\nConservá el alcance acordado; cualquier cambio de producto requiere consulta al orquestador."
			}
			prompt += "\nEl contrato nuevo reemplaza reportes/canales anteriores. Leé el contexto local " + workerSignalPath(path, task.ID, runID, "context") + ": conserva estado, decisiones y respuestas. Comprobá los archivos antes de repetir acciones. Una entrega ya terminada se verifica y reporta, sin repetir trabajo ni volver a hacer preguntas respondidas."
			if err == nil {
				contextTask := task
				contextTask.BaseCommit, contextTask.Worktree = baseCommit, &path
				err = atomicJSON(workerSignalPath(path, task.ID, runID, "context"), workerContext(mSnapshot, contextTask))
			}
			prompt += "\n" + agentLanguageInstruction(mSnapshot.Language)
			if acpWorkerProviders[a.Provider] {
				prompt += acpAgentNote
			}
			launchConfig, native, e := prepareNativeConfig(a, task.NativeSession, path, runID)
			if err == nil {
				err = e
			}
			argv, e := launchArgv(launchConfig, prompt)
			if err == nil {
				err = e
			}
			return launchResult{taskID: task.ID, repo: task.Repo, path: path, name: task.Title, argv: argv, err: err, runID: runID, provider: a.Provider, config: a, baseCommit: baseCommit, briefHash: briefIdentity(task), background: background, nativeSession: native}
		}
	}
	m.notice = uiText("No existe esa tarea.")
	return nil
}
func (m *model) focus(key string) {
	for i, w := range m.terminals.Windows {
		if w.ID == m.sessions[key] {
			wasHidden := w.hidden
			w.hidden = false // Explicit diagnostics/permission access only for Fluke.
			m.terminals.FocusWindow(i)
			if wasHidden {
				m.terminals.layout()
			}
			m.terminals.Mode = terminalMode
			return
		}
	}
}
func (m *model) stop(key string) {
	if strings.HasPrefix(key, "fluke:") && !m.failPendingChat(strings.TrimPrefix(key, "fluke:")) {
		return
	}
	m.observeWorkers(true)
	for i, w := range m.terminals.Windows {
		if w.ID != m.sessions[key] {
			continue
		}
		if !m.terminals.DeleteWindow(i) {
			m.notice = uiText("No se pudo detener: ") + m.terminals.lastError.Error()
			return
		}
		delete(m.sessions, key)
		if strings.HasPrefix(key, "fluke:") {
			delete(m.orchestration, strings.TrimPrefix(key, "fluke:"))
		}
		m.reconcile()
		m.notice = uiText("Sesión cerrada; worktree conservado.")
		return
	}
	m.notice = uiText("No existe esa sesión.")
}
func (m *model) cleanup() {
	if m.projects.cancel != nil {
		m.projects.cancel()
	}
	for _, cancel := range m.githubFollowupCancel {
		cancel()
	}
	if m.setup.cancel != nil {
		m.setup.cancel()
	}
	if m.authCancel != nil {
		m.authCancel()
	}
	for _, cancel := range m.githubCancel {
		cancel()
	}
	for key := range m.sessions {
		m.stop(key)
	}
	m.terminals.Cleanup()
	m.reconcile()
}
func (m *model) execute(line string) tea.Cmd {
	verb, rest, _ := strings.Cut(strings.TrimSpace(line), " ")
	rest = strings.TrimSpace(rest)
	if m.repo == "" && (verb == "goal" || verb == "task" || verb == "issue" || verb == "decision" || verb == "fluke") {
		m.notice = localText("Open a project from F1 first.", "Abrí un proyecto desde F1 primero.")
		return nil
	}
	switch verb {
	case "home":
		m.closePanels()
		m.home, m.view, m.pane, m.selected = true, 0, 0, 0
	case "new":
		m.openProjectEditor(true)
	case "rework":
		id, feedback, _ := strings.Cut(rest, "|")
		return m.requestTaskChanges(strings.TrimSpace(id), feedback)
	case "depends":
		id, ids, found := strings.Cut(rest, "|")
		if !found {
			m.notice = uiText("Usá :depends ID | ID1 ID2 (lista vacía retira dependencias)")
			return nil
		}
		return m.setDependencies(strings.TrimSpace(id), ids)
	case "github", "issues":
		_, cmd := m.globalKey("f6")
		return cmd
	case "issue":
		index, acceptance, _ := strings.Cut(rest, "|")
		n, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(index), "#")))
		if err != nil || n < 1 || strings.TrimSpace(acceptance) == "" {
			m.notice = uiText("Usá :issue número | criterio de aceptación")
			return nil
		}
		return m.queryGithub(n, strings.TrimSpace(acceptance))
	case "goal":
		objective, acceptance, _ := strings.Cut(rest, "|")
		next := m.state
		if err := next.setGoal(m.repo, objective, acceptance); err != nil {
			m.notice = err.Error()
		} else {
			m.saveGoalEdit(next, "Objetivo acordado. Fluke puede organizar su plan.")
		}
	case "adopt":
		return m.adoptTaskGoal(rest)
	case "task":
		title, acceptance, _ := strings.Cut(rest, "|")
		next := m.state
		if err := next.addTask(m.repo, title, acceptance); err != nil {
			m.notice = err.Error()
		} else {
			m.saveEdit(next, uiText("Tarea creada."))
		}
	case "repo":
		repo, err := repoPath(strings.Trim(rest, "\""))
		if err != nil {
			m.notice = err.Error()
			break
		}
		found := false
		for _, p := range m.state.Projects {
			if p == repo {
				found = true
			}
		}
		next := m.state
		if !found {
			next.Projects = append(next.Projects, repo)
		}
		if m.saveEdit(next, uiText("Repositorio seleccionado.")) {
			m.repo = repo
			m.home = false
			m.selected = 0
			m.chatScroll = 0
		}
	case "fluke":
		return m.start("")
	case "agent":
		m.assignWorkerConfig(rest)
	case "start":
		return m.start(rest)
	case "fresh":
		return m.freshSession(rest)
	case "queue", "unqueue":
		m.queueTask(rest, verb == "queue")
		return tea.Batch(m.drainQueue(), m.scheduleWorkerTick())
	case "review":
		for _, task := range m.state.Tasks {
			if task.ID == rest {
				m.githubOpen = false
				m.config = false
				return m.review.start(task)
			}
		}
		m.notice = uiText("No existe esa tarea.")
	case "accept":
		return m.acceptTask(rest)
	case "integrate":
		return m.previewIntegration(rest)
	case "pr":
		return m.previewPullRequest(rest)
	case "approve", "reject":
		return m.resolveProposal(rest, verb == "approve")
	case "resume":
		m.retryContinuation(rest)
		return m.scheduleWorkerTick()
	case "pause":
		if rest != "" {
			return m.setTaskPaused(rest, true)
		}
		return m.pauseProject()
	case "continue":
		if rest != "" {
			return m.setTaskPaused(rest, false)
		}
		return m.resumeProject()
	case "stop":
		if rest == "fluke" {
			rest = "fluke:" + m.repo
		}
		m.stop(rest)
	case "limit":
		n, err := strconv.Atoi(rest)
		if err != nil || n < 1 || n > 64 {
			m.notice = uiText("Límite válido: 1–64")
		} else {
			next := m.state
			next.MaxWorkers = n
			m.saveEdit(next, uiText("Límite actualizado."))
		}
	case "decision":
		if rest == "" {
			m.notice = uiText("Indicá la pregunta.")
		} else {
			next := m.state
			next.Decisions = append(next.Decisions, Decision{Repo: m.repo, Question: rest})
			m.saveEdit(next, uiText("Decisión registrada."))
		}
	case "answer":
		index, answer, _ := strings.Cut(rest, " ")
		n, err := strconv.Atoi(index)
		if err != nil || n < 1 || n > len(m.state.Decisions) || strings.TrimSpace(answer) == "" {
			m.notice = uiText("Usá :answer número respuesta")
		} else {
			if m.state.Decisions[n-1].ProposedTitle != "" {
				m.notice = uiText("Usá :approve N o :reject N para una propuesta de tarea.")
				return nil
			}
			if m.state.Decisions[n-1].Answer != nil {
				m.notice = uiText("La decisión ya fue respondida. :resume ID reintenta una continuación incierta.")
				return nil
			}
			next := m.state
			next.Decisions = append([]Decision{}, next.Decisions...)
			next.Decisions[n-1].Answer = &answer
			next.Decisions[n-1].AnsweredBy, next.Decisions[n-1].Assistance = "human", false
			if next.Decisions[n-1].TaskID != "" {
				next.Decisions[n-1].Continuation = "pending"
			}
			if m.saveEdit(next, uiText("Respuesta guardada.")) {
				return tea.Batch(m.continueAnsweredWorkers(), m.scheduleWorkerTick())
			}
		}
	case "amend":
		return m.amendDecision(rest)
	case "tell":
		id, text, found := strings.Cut(rest, "|")
		if !found {
			m.notice = localText("Use :tell ID | message.", "Usá :tell ID | mensaje.")
			return nil
		}
		return m.sendWorkerMessage(strings.TrimSpace(id), text)
	default:
		m.notice = uiText("Comandos: goal · task · adopt · repo · fluke · start · fresh · queue · unqueue · stop · pause · continue · review · accept · integrate · pr · resume · limit · decision · answer · amend · tell · approve · reject · github · issue")
	}
	return nil
}
func (m *model) forward(msg tea.Msg) tea.Cmd { _, cmd := m.terminals.Update(msg); return cmd }
func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if handled, cmd := m.switcherInput(msg); handled {
		return m, cmd
	}
	switch v := msg.(type) {
	case projectResult:
		m.receiveProject(v)
		return m, nil
	case setupPulse:
		if m.setup.open {
			if v.generation == m.setup.generation {
				m.setup.frame++
			}
			return m, m.setupPulse()
		}
		return m, nil
	case setupDetected:
		return m, m.receiveSetupDetected(v)
	case setupProbed:
		if !m.setup.open || v.generation != m.setup.generation || v.index < 0 || v.index >= len(m.setup.harnesses) {
			return m, nil
		}
		m.setup.harnesses[v.index] = v.harness
		m.setup.checked++
		if m.setup.checked == m.setup.total {
			m.setup.scanning = false
			m.recommendSetupHarness()
		}
		return m, nil
	case setupRepoResult:
		if !m.setup.open || m.setup.step != 4 || !m.setup.repoBusy || v.generation != m.setup.repoGeneration || v.draft != m.setup.repoDraft {
			return m, nil
		}
		m.setup.repoBusy = false
		if v.err != nil {
			m.notice = v.err.Error()
			return m, nil
		}
		next := m.state
		found := false
		for _, repo := range next.Projects {
			if repo == v.repo {
				found = true
			}
		}
		if !found {
			next.Projects = append(append([]string{}, next.Projects...), v.repo)
		}
		if m.saveEdit(next, "") {
			m.repo = v.repo
			m.setup.repoDraft = v.repo
			m.saveSetupStep(5)
		}
		return m, nil
	case providerLoginResult:
		if v.err != nil {
			m.notice = uiText("El inicio de sesión no terminó. Ctrl+R comprueba el estado actual.")
		} else {
			m.notice = uiText("Inicio de sesión finalizado; comprobando la CLI.")
		}
		if m.setup.open {
			return m, m.scanHarnesses()
		}
		return m, m.checkProvider()
	case connectionProbeResult:
		m.receiveConnectionProbe(v)
		return m, nil
	case providerHealthResult:
		if v.generation == m.providerGeneration {
			m.provider, m.providerBusy = v.health, false
			if m.config && m.configSection == 0 && m.width < 104 {
				m.notice = v.health.Message
			}
		}
		return m, nil
	case clipboardResult:
		if v.Err != nil {
			m.notice = uiText("No se pudo copiar: ") + v.Err.Error()
		} else if v.ViaTerminal {
			m.notice = uiText("Copia enviada al terminal (OSC52).")
		} else {
			m.notice = "Texto copiado al portapapeles."
		}
		return m, nil
	case chatSentResult:
		m.receiveChatSent(v)
		return m, m.scheduleWorkerTick()
	case startupTrustResult:
		if s := m.orchestration[v.repo]; s != nil && s.RunID == v.runID {
			s.TrustSending = false
			if v.err != nil && !errors.Is(v.err, errAutomaticDeferred) {
				s.AutonomousStartup = false
				m.notice = v.err.Error()
			}
		}
		return m, m.scheduleWorkerTick()
	case taskReviewResult:
		m.review.receive(v)
		return m, nil
	case deliveryAcceptanceResult:
		return m, m.receiveAcceptance(v)
	case deliveryIntegrationResult:
		return m, m.receiveIntegration(v)
	case githubPRResult:
		return m, tea.Batch(m.receivePullRequest(v), m.queryPublishedPR("", false), m.scheduleGithubFollowup())
	case githubPRFollowupResult:
		m.receiveGithubFollowup(v)
		return m, m.scheduleWorkerTick()
	case githubFollowupTick:
		m.githubFollowupTickPending = false
		return m, tea.Batch(m.queryPublishedPR("", false), m.scheduleGithubFollowup())
	case orchestratorWakeResult:
		m.receiveOrchestratorWake(v)
		return m, m.scheduleWorkerTick()
	case continuationResult:
		m.receiveContinuation(v)
		return m, m.scheduleWorkerTick()
	case workerTick:
		m.workerTickPending = false
		m.observeWorkTime(time.Now())
		m.observeWorkers(true)
		m.reconcile()
		m.pollOrchestrators()
		return m, tea.Batch(m.trustAutonomousStarts(), m.dispatchChats(), m.wakeOrchestrators(), m.continueAnsweredWorkers(), m.drainQueue(), m.scheduleWorkerTick())
	case githubAuthResult:
		if v.Generation != m.authGeneration {
			return m, nil
		}
		m.auth = v.Auth
		if !v.Auth.Busy && m.authCancel != nil {
			m.authCancel()
			m.authCancel = nil
		}
		return m, v.Next
	case githubResult:
		m.receiveGithub(v)
		return m, nil
	case tea.WindowSizeMsg:
		m.floating.gesture = nil
		m.terminals.endMouse()
		m.width = v.Width
		m.height = v.Height
		return m, m.forward(tea.WindowSizeMsg{Width: v.Width - m.sessionsPanelWidth(), Height: m.workspaceHeight()})
	case dependencyCheckResult:
		m.dependencyChecking = false
		if v.Hash == dependencyStateHash(m.state) {
			m.dependencyHash, m.dependencyChecks, m.dependencyChecked = v.Hash, v.Reasons, time.Now()
			m.refreshOrchestrators(true)
		}
		return m, tea.Batch(m.drainQueue(), m.scheduleWorkerTick())
	case launchResult:
		// Finishing preparation must not pull the user out of another project.
		if m.home || v.repo != m.repo || m.projects.open || m.config || m.githubOpen || m.review.open || m.view == 3 && v.taskID == "" {
			v.background = true
		}
		canceled := m.cancelPreparing
		for _, task := range m.state.Tasks {
			if task.ID == v.taskID && (task.Paused || m.state.PausedProjects[task.Repo] || task.Status == "accepted" || taskScopeError(m.state, task) != nil) {
				canceled = true
			}
		}
		m.preparingTaskID = ""
		m.preparingQueued = false
		m.cancelPreparing = false
		m.preparing = false
		m.preparingWorker = false
		if v.taskID != "" && v.path != "" && validGitHash(v.baseCommit) {
			next := m.state
			next.Tasks = append([]Task{}, next.Tasks...)
			for i, task := range next.Tasks {
				if task.ID == v.taskID && (task.Worktree == nil || task.BaseCommit != v.baseCommit) {
					next.Tasks[i].Worktree, next.Tasks[i].BaseCommit = &v.path, v.baseCommit
					if !m.saveEdit(next, uiText("Base del worker guardada; preparando la sesión…")) {
						return m, nil
					}
					break
				}
			}
		}
		if canceled && v.taskID != "" {
			m.notice = "Inicio cancelado; worktree conservado."
			return m, tea.Batch(m.drainQueue(), m.scheduleWorkerTick())
		}
		if v.err != nil {
			if v.dependencyBlocked {
				if v.path != "" {
					next := m.state
					next.Tasks = append([]Task{}, next.Tasks...)
					for i := range next.Tasks {
						if next.Tasks[i].ID == v.taskID && next.Tasks[i].Worktree == nil {
							next.Tasks[i].Worktree = &v.path
						}
					}
					if !m.saveEdit(next, uiText("Worktree conservado; falta integrar dependencias en su base.")) {
						return m, nil
					}
				}
				m.dependencyChecked = time.Time{}
				m.notice = v.err.Error()
				return m, tea.Batch(m.drainQueue(), m.scheduleWorkerTick())
			}
			m.failQueuedLaunch(v.taskID, v.err.Error())
			m.notice = v.err.Error()
			return m, nil
		}
		if v.taskID != "" && v.briefHash != "" {
			for _, task := range m.state.Tasks {
				if task.ID == v.taskID {
					task.BriefHash, task.Worktree = v.briefHash, &v.path
					if err := checkTaskSpecs(task, m.state.Goals[task.Repo]); err != nil {
						m.holdChangedSpec(task, err)
						return m, m.scheduleWorkerTick()
					}
				}
			}
		}
		beforeLaunch := m.state
		next := m.state
		key := v.taskID
		if key == "" {
			key = "fluke:" + v.repo
			next = withOrchestratorSession(next, v.repo, v.nativeSession)
		} else {
			next.Tasks = append([]Task{}, next.Tasks...)
			for i := range next.Tasks {
				if next.Tasks[i].ID == key {
					t := &next.Tasks[i]
					t.Worktree, t.BaseCommit, t.NativeSession = &v.path, v.baseCommit, v.nativeSession
					t.BriefHash = v.briefHash
					t.Status, t.Note, t.Queued = "running", "", false
					t.AgentRun, t.AgentProvider, t.AgentConfig = v.runID, v.provider, &v.config
					t.AgentSeq, t.AgentState, t.AgentMessage, t.AgentEvidence = 0, "unknown", "", nil
					t.Metrics.Runs++
				}
			}
		}
		if v.taskID == "" && v.submittedDraft != "" {
			next = withConversation(next, v.repo, ConversationMessage{Role: "human", Text: v.submittedDraft, RunID: v.runID, Delivery: "pending"})
		}
		if !m.saveEdit(next, uiText("Contrato y sesión guardados; iniciando el proveedor…")) {
			return m, nil
		}
		before := len(m.terminals.Windows)
		focused, mode := m.terminals.FocusedWindow, m.terminals.Mode
		m.terminals.AddWindowIn(v.path, v.name, v.argv...)
		if len(m.terminals.Windows) == before {
			if m.saveEdit(beforeLaunch, uiText("No se pudo iniciar la terminal; revisá el ejecutable.")) {
				m.failQueuedLaunch(v.taskID, uiText("No se pudo iniciar la terminal"))
			}
			return m, nil
		}
		if v.background && before > 0 {
			m.terminals.FocusWindow(focused)
			m.terminals.Mode = mode
		}
		m.sessions[key] = m.terminals.Windows[len(m.terminals.Windows)-1].ID
		if v.taskID == "" {
			m.terminals.Windows[len(m.terminals.Windows)-1].hidden = true
			m.terminals.layout()
			m.orchestration[v.repo] = &orchestratorSession{RunID: v.runID, Dir: v.orchestrationDir, Provider: v.provider, Config: v.config, AutonomousStartup: m.state.AutonomousFluke}
			if v.submittedDraft != "" {
				m.receiveChatSent(chatSentResult{Repo: v.repo, RunID: v.runID, Text: v.submittedDraft})
				messages := m.state.Conversations[v.repo]
				if len(messages) == 0 || messages[len(messages)-1].Delivery != "sent" {
					m.stop(key)
					m.notice = uiText("La sesión se detuvo: el envío inicial no pudo confirmarse en el estado.")
					if m.sessionAlive(key) {
						m.notice = localText("Initial delivery could not be saved. The session is still open: check F3 before resending.", "El envío inicial no pudo guardarse. La sesión sigue abierta: revisá F3 antes de reenviar.")
					}
					return m, nil
				}
			}
		}
		if v.taskID == "" {
			if m.chatDraft[v.repo] == v.submittedDraft {
				m.chatDraft[v.repo] = ""
				if m.chatCaret != nil {
					m.chatCaret[v.repo] = 0
				}
			}
			m.markConversationDraft()
		}
		m.refreshProjectContexts()
		if v.taskID == "" && !v.background && !m.floating.open {
			m.home = false
			m.view = 1
			m.pane = 1
		} else if v.taskID != "" && !v.background {
			m.view = 2
		}
		if !v.background {
			m.terminals.Mode = terminalMode
			m.notice = uiText("Sesión activa · Ctrl+X para administrar ventanas")
		} else {
			m.notice = "Worker activo: " + v.name + " · F2 muestra su avance."
		}
		return m, tea.Batch(m.drainQueue(), m.scheduleWorkerTick())
	case tea.KeyPressMsg:
		key := v.String()
		if m.quitting {
			if key == "y" || key == "s" {
				if m.preparing || m.projects.busy || m.integratingTaskID != "" || m.publishingTaskID != "" {
					m.notice = uiText("Esperá a que termine la preparación, integración o publicación.")
					m.quitting = false
					return m, nil
				}
				m.cleanup()
				return m, tea.Quit
			}
			if key == "n" || key == "esc" {
				m.quitting = false
			}
			return m, nil
		}
		if m.setup.open && key != "ctrl+q" {
			return m, m.setupKey(v)
		}
		if m.projects.open && key != "ctrl+q" {
			if !m.projects.busy {
				if handled, cmd := m.globalKey(key); handled {
					return m, cmd
				}
			}
			return m, m.projectEditorKey(v)
		}
		if key == "ctrl+q" {
			m.quitting = true
			return m, nil
		}
		if handled, cmd := m.globalKey(key); handled {
			return m, cmd
		}
		if m.floatingVisible() && m.floating.focused {
			if key == "esc" || key == "tab" {
				m.floating.focused = false
				return m, nil
			}
			return m, m.chatKey(v)
		}
		if m.workerMessageID != "" {
			return m, m.editWorkerMessage(v)
		}
		if m.review.open {
			if key == "ctrl+r" && m.review.task.ID != "" {
				return m, m.queryPublishedPR(m.review.task.ID, true)
			}
			if m.review.publication != nil || m.review.publicationLoading {
				return m, m.publicationKey(v)
			}
			if m.review.integration != nil || m.review.integrationLoading {
				if key == "enter" && m.review.integration != nil && m.integratingTaskID == "" {
					return m, m.confirmIntegration()
				}
				return m, m.review.key(key, m.reviewDimsW(), m.reviewDimsH())
			}
			if (key == "tab" || key == "shift+tab") && m.reviewOverlay() {
				if key == "tab" {
					return m, m.reviewMove(1)
				}
				return m, m.reviewMove(-1)
			}
			if key == "m" && !m.review.loading && m.review.err == nil && m.review.task.Status == "accepted" {
				return m, m.previewIntegration(m.review.task.ID)
			}
			if key == "p" && !m.review.loading && m.review.err == nil && m.review.task.Status == "accepted" {
				return m, m.previewPullRequest(m.review.task.ID)
			}
			if key == "c" && !m.review.loading && m.review.err == nil && (m.review.task.Status == "awaiting_review" || m.review.task.Status == "accepted" && m.review.task.Integration == nil) {
				line := "rework " + m.review.task.ID + " | "
				m.review.open = false
				m.command = &line
				m.notice = uiText("Escribí qué falta corregir y Enter lo entrega al worker y al orquestador.")
				return m, nil
			}
			if key == "a" && !m.review.loading && m.review.err == nil && (m.review.task.Status == "awaiting_review" || m.review.task.Status == "accepted") {
				line := "accept " + m.review.task.ID
				m.review.open = false
				m.command = &line
				m.notice = uiText("Enter acepta la entrega y libera el worker. Los cambios quedan en su rama.")
				return m, nil
			}
			return m, m.review.key(key, m.reviewDimsW(), m.reviewDimsH())
		}
		if m.config {
			switch key {
			case "ctrl+o":
				return m, m.selectConfigSection(0)
			case "ctrl+g":
				return m, m.selectConfigSection(1)
			case "ctrl+t":
				return m, m.selectConfigSection(2)
			case "ctrl+i":
				return m, m.selectConfigSection(3)
			case "ctrl+right":
				return m, m.cycleConfigSection(1)
			case "ctrl+left":
				return m, m.cycleConfigSection(-1)
			}
			if m.configSection == 4 {
				switch key {
				case "esc":
					m.configSection = 0
				case "up", "shift+tab":
					m.connSelected = max(0, m.connSelected-1)
				case "down", "tab":
					m.connSelected = min(len(m.connectionEntries())-1, m.connSelected+1)
				case "ctrl+l":
					if m.shellMode() {
						return m, m.loginConnection()
					}
					return m, m.loginProvider()
				case "ctrl+r":
					return m, tea.Batch(m.checkProvider(), m.probeConnections())
				}
				return m, nil
			}
			if m.configSection == 3 {
				if key == "esc" {
					m.configSection = 0
				}
				return m, nil
			}
			if m.configSection == 2 {
				switch key {
				case "down", "right", "tab":
					m.themeSelected = (m.themeSelected + 1) % len(consoleThemes)
				case "up", "left", "shift+tab":
					m.themeSelected = (m.themeSelected + len(consoleThemes) - 1) % len(consoleThemes)
				case "enter", "ctrl+s":
					next := m.state
					next.Theme = consoleThemes[m.themeSelected].ID
					if m.saveEdit(next, localText("Theme saved: ", "Tema guardado: ")+consoleThemes[m.themeSelected].Name) {
						m.configSection = 0
						m.review.lines = nil
					}
				case "esc":
					m.configSection = 0
				}
				return m, nil
			}
			if key == "ctrl+e" {
				m.toggleUILanguage()
				return m, nil
			}
			if key == "ctrl+l" && m.configSection == 0 {
				return m, m.loginProvider()
			}
			if key == "ctrl+a" && m.configSection == 0 {
				m.draftAutonomous = !m.draftAutonomous
				return m, nil
			}
			if key == "ctrl+r" && m.configSection == 0 {
				return m, m.checkProvider()
			}
			if m.configSection == 1 {
				if m.authConfirm {
					m.authConfirm = false
					if key == "s" || key == "y" {
						return m, m.disconnectGithub()
					}
					return m, nil
				}
				switch key {
				case "tab", "down":
					m.authSelected = (m.authSelected + 1) % 3
				case "shift+tab", "up":
					m.authSelected = (m.authSelected + 2) % 3
				case "o":
					if m.auth.Code != "" {
						return m, openGithubDevice()
					}
				case "esc":
					if m.auth.Busy {
						m.cancelGithubAuth()
					} else {
						m.configSection = 0
					}
				case "enter":
					switch m.authSelected {
					case 0:
						return m, m.connectGithub()
					case 1:
						return m, m.refreshGithubAuth()
					case 2:
						if !m.auth.Busy && m.auth.Username != "" {
							m.authConfirm = true
						}
					}
				}
				return m, nil
			}
			switch key {
			case "ctrl+u":
				if m.field > 0 {
					m.draft[m.field] = ""
					if m.field == 1 {
						m.invalidateProvider()
					}
				}
			case "esc":
				if m.state.Orchestrator != nil {
					m.config = false
				}
			case "tab", "down":
				m.field = (m.field + 1) % 5
			case "shift+tab", "up":
				m.field = (m.field + 4) % 5
			case "ctrl+enter":
				return m, m.applyConfig()
			case "ctrl+s", "enter":
				if err := m.saveConfig(); err != nil {
					m.notice = err.Error()
					return m, nil
				}
				return m, m.checkProvider()
			case "left", "right", "space":
				if m.field == 0 {
					m.cycleProvider(key == "left")
					return m, m.checkProvider()
				} else if m.field == 2 && key != "space" {
					m.cycleModel(key == "left")
				} else if key == "space" {
					m.draft[m.field] += " "
				}
			case "backspace":
				r := []rune(m.draft[m.field])
				if m.field > 0 && len(r) > 0 {
					m.draft[m.field] = string(r[:len(r)-1])
					if m.field == 1 {
						m.invalidateProvider()
					}
				}
			default:
				if m.field > 0 && v.Text != "" {
					m.draft[m.field] += v.Text
					if m.field == 1 {
						m.invalidateProvider()
					}
				}
			}
			return m, nil
		}
		if m.command != nil {
			switch key {
			case "esc":
				m.command = nil
			case "enter":
				line := *m.command
				m.command = nil
				return m, m.execute(line)
			case "backspace":
				r := []rune(*m.command)
				if len(r) > 0 {
					*m.command = string(r[:len(r)-1])
				}
			default:
				*m.command += v.Text
			}
			return m, nil
		}
		if m.githubOpen {
			switch key {
			case "esc":
				m.githubOpen = false
			case "tab":
				m.githubDetail = !m.githubDetail
			case "r":
				return m, m.queryGithub(0, "")
			case "down", "j":
				m.githubSelected++
				m.githubScroll = 0
			case "up", "k":
				m.githubSelected = max(0, m.githubSelected-1)
				m.githubScroll = 0
			case "pgdown":
				m.githubScroll += max(1, m.workspaceHeight()-12)
			case "pgup":
				m.githubScroll = max(0, m.githubScroll-max(1, m.workspaceHeight()-12))
			case "enter":
				issues := m.github[m.repo].Issues
				if len(issues) > 0 {
					line := fmt.Sprintf("issue %d | ", issues[m.githubSelected%len(issues)].Number)
					m.command = &line
				}
			case "ctrl+k":
				line := ""
				m.command = &line
			}
			return m, nil
		}
		switch key {
		case "ctrl+x":
			m.view = 2
			m.terminals.Mode = windowMode
			return m, nil
		case "ctrl+k":
			line := ""
			m.command = &line
			return m, nil
		}
		if m.view == 2 && m.terminals.Mode == terminalMode {
			if key == "ctrl+b" {
				return m, nil
			}
			return m, m.forward(msg)
		}
		if key == ":" && !(m.pane == 1 && (m.view == 0 && !m.home || m.view == 1)) {
			line := ""
			m.command = &line
			return m, nil
		}
		if m.home && m.view == 0 {
			return m, m.homeKey(v)
		}
		if m.view == 2 {
			switch key {
			case "p":
				m.terminals.TogglePin()
			case "z":
				m.terminals.ToggleZoom()
			case "shift+tab":
				m.terminals.cycleFocus(-1)
			case "m":
				m.openWorkerMessage("")
			case "pgup", "pgdown", "home", "end", "shift+pgup", "shift+pgdown", "shift+home", "shift+end":
				return m, m.forward(msg)
			case "enter":
				m.terminals.Mode = terminalMode
			case "tab":
				m.terminals.cycleFocus(1)
			case "t":
				m.terminals.ToggleTiling()
			}
			return m, nil
		}
		if m.view == 0 && m.pane == 2 && key == "enter" {
			items := m.attentionItems()
			if len(items) > 0 {
				m.openAttention(m.selected % len(items))
			}
			return m, nil
		}
		if m.view == 3 && (key == "tab" || key == "shift+tab") {
			m.pane = 0
			return m, nil
		}
		if key == "tab" {
			m.pane = (m.pane + 1) % 3
			return m, nil
		}
		if key == "shift+tab" {
			m.pane = (m.pane + 2) % 3
			return m, nil
		}
		if m.pane == 1 && m.view != 3 {
			return m, m.chatKey(v)
		}
		if m.view == 1 && (m.pane == 0 || m.pane == 2) {
			if key == "pgup" || key == "pgdown" {
				step := max(1, m.workspaceHeight()/2)
				if key == "pgup" {
					step = -step
				}
				m.taskScroll = max(0, m.taskScroll+step)
				return m, nil
			}
			if key == "i" {
				m.insights = !m.insights
				return m, nil
			}
			if key == "ctrl+r" {
				tasks := m.projectTasks()
				if len(tasks) > 0 {
					return m, m.queryPublishedPR(tasks[m.selected%len(tasks)].ID, true)
				}
				return m, nil
			}
			if key == "space" {
				if m.state.PausedProjects[m.repo] {
					return m, m.resumeProject()
				}
				return m, m.pauseProject()
			}
			tasks := m.projectTasks()
			if len(tasks) > 0 {
				task := tasks[m.selected%len(tasks)]
				switch key {
				case "a":
					provider, model := "codex", ""
					if a := m.state.Orchestrator; a != nil {
						provider, model = a.Provider, a.Model
					}
					if a := task.WorkerConfig; a != nil {
						provider, model = a.Provider, a.Model
					}
					line := fmt.Sprintf("agent %s | %s | %s", task.ID, provider, model)
					m.command = &line
					return m, nil
				case "m":
					m.openWorkerMessage(task.ID)
					return m, nil
				case "q":
					m.queueTask(task.ID, !task.Queued)
					return m, tea.Batch(m.drainQueue(), m.scheduleWorkerTick())
				case "v":
					return m, m.review.start(task)
				case "p":
					return m, m.setTaskPaused(task.ID, !task.ManuallyPaused)
				}
			}
		}
		if key == "r" && m.view == 3 && m.selectedDecision() >= 0 && m.state.Decisions[m.selectedDecision()].ProposedTitle != "" {
			line := fmt.Sprintf("reject %d", m.selectedDecision()+1)
			m.command = &line
			return m, nil
		}
		if key == "enter" && m.view == 3 && m.selectedDecision() >= 0 {
			line := fmt.Sprintf("answer %d ", m.selectedDecision()+1)
			if m.state.Decisions[m.selectedDecision()].Answer != nil {
				line = fmt.Sprintf("amend %d ", m.selectedDecision()+1)
			}
			if m.state.Decisions[m.selectedDecision()].ProposedTitle != "" {
				line = fmt.Sprintf("approve %d", m.selectedDecision()+1)
			}
			m.command = &line
			return m, nil
		}
		switch key {
		case "down", "j":
			m.selected++
			m.taskScroll = 0
		case "up", "k":
			m.selected = max(0, m.selected-1)
			m.taskScroll = 0
		case "enter":
			if m.view == 0 {
				if len(m.state.Projects) > 0 {
					m.repo = m.state.Projects[m.selected%len(m.state.Projects)]
					m.chatScroll = 0
					m.view = 1
					m.selected = 0
				}
			} else if m.view == 1 {
				tasks := m.projectTasks()
				if len(tasks) > 0 {
					return m, m.start(tasks[m.selected%len(tasks)].ID)
				}
			}
		}
		return m, nil
	case tea.PasteMsg:
		if m.floatingVisible() && m.floating.focused {
			m.insertChat(v.Content)
			m.markConversationDraft()
			return m, nil
		}
		if m.projects.open {
			m.pasteProjectField(v.Content)
			return m, nil
		}
		if m.setup.open {
			text := strings.NewReplacer("\r", "", "\n", "", "\x00", "", "\x1b", "").Replace(v.Content)
			if m.setup.step == 4 && !m.setup.repoBusy && len(m.setup.repoDraft)+len(text) <= 4096 {
				m.setup.repoDraft += text
			}
			if m.setup.step == 2 && m.setup.modelEditing && len(m.setup.modelDraft)+len(text) <= 100 {
				m.setup.modelDraft += text
			}
			return m, nil
		}
		if m.review.open && m.review.publicationEditing != 0 {
			m.review.editPublication(v.Content)
			m.review.followPublicationCaret(m.reviewDimsW(), m.reviewDimsH())
			return m, nil
		}
		if m.review.open || m.quitting {
			return m, nil
		}
		if m.workerMessageID != "" {
			text := cleanAgentText(strings.ReplaceAll(v.Content, "\r", ""))
			if len(m.chatDraft[m.workerMessageID])+len(text) <= 4000 {
				m.chatDraft[m.workerMessageID] += text
			}
			return m, nil
		}
		if m.command != nil {
			*m.command += strings.ReplaceAll(v.Content, "\n", " ")
			return m, nil
		}
		if m.config {
			if m.configSection == 0 && m.field > 0 {
				m.draft[m.field] += strings.ReplaceAll(v.Content, "\n", "")
				if m.field == 1 {
					m.invalidateProvider()
				}
			}
			return m, nil
		}
		if m.githubOpen {
			return m, nil
		}
		if m.home && m.view == 0 {
			return m, nil
		}
		if m.view == 2 {
			return m, m.forward(msg)
		}
		if m.pane == 1 && m.view != 3 {
			m.insertChat(v.Content)
			m.markConversationDraft()
			return m, nil
		}
		return m, nil
	case tea.MouseClickMsg:
		if handled, cmd := m.clickNavigation(v.Mouse()); handled {
			return m, cmd
		}
		if handled, cmd := m.clickShell(v.Mouse()); handled {
			return m, cmd
		}
		if m.clickSessions(v.Mouse()) {
			return m, nil
		}
		if handled, cmd := m.clickChatAction(v.Mouse()); handled {
			return m, cmd
		}
		if handled, cmd := m.clickTaskAction(v.Mouse()); handled {
			return m, cmd
		}
		if m.floatingMouse(v.Mouse(), "click") {
			return m, nil
		}
		if !m.mouseDisabled && v.Button == tea.MouseLeft && !m.setup.open && !m.quitting && !m.projects.open {
			if handled, cmd := m.configTabClick(v.Mouse()); handled {
				return m, cmd
			}
		}
		if m.clickPanel(v.Mouse()) {
			return m, nil
		}
		if m.clickWorkspace(v.Mouse()) {
			return m, nil
		}
		if !m.allowMouse(v.Y) {
			return m, nil
		}
		v.Y -= m.headerRows()
		v.X -= m.sessionsPanelWidth()
		return m, m.forward(v)
	case tea.MouseReleaseMsg:
		if m.floatingMouse(v.Mouse(), "release") {
			return m, nil
		}
		if !m.allowMouse(v.Y) {
			return m, nil
		}
		v.Y -= m.headerRows()
		v.X -= m.sessionsPanelWidth()
		return m, m.forward(v)
	case tea.MouseMotionMsg:
		if m.floatingMouse(v.Mouse(), "motion") {
			return m, nil
		}
		if !m.allowMouse(v.Y) {
			return m, nil
		}
		v.Y -= m.headerRows()
		v.X -= m.sessionsPanelWidth()
		return m, m.forward(v)
	case tea.MouseWheelMsg:
		if m.floatingMouse(v.Mouse(), "wheel") {
			return m, nil
		}
		if !m.mouseDisabled && inRectangle(v.X, v.Y-m.headerRows(), m.chatRectangle()) {
			if v.Button == tea.MouseWheelUp {
				m.scrollChat(3)
			} else {
				m.scrollChat(-3)
			}
			return m, nil
		}
		if !m.mouseDisabled && m.view == 1 && !m.config && !m.review.open && !m.githubOpen && m.command == nil && !m.projects.open {
			_, detail := m.projectPanels()
			if inRectangle(v.X, v.Y-m.headerRows(), detail) {
				if v.Button == tea.MouseWheelUp {
					m.taskScroll = max(0, m.taskScroll-3)
				} else {
					m.taskScroll += 3
				}
				return m, nil
			}
		}
		if !m.allowMouse(v.Y) {
			return m, nil
		}
		v.Y -= m.headerRows()
		v.X -= m.sessionsPanelWidth()
		return m, m.forward(v)
	}
	cmd := m.forward(msg)
	m.reconcile()
	return m, cmd
}
func (m *model) allowMouse(y int) bool {
	return !m.mouseDisabled && !m.setup.open && !m.projects.open && m.view == 2 && !m.config && !m.githubOpen && !m.review.open && m.command == nil && m.workerMessageID == "" && !m.quitting && ((y >= m.headerRows() && y < m.height-m.footerRows()) || m.terminals.gesture != nil)
}
func (m *model) projectTasks() []Task {
	var tasks []Task
	for _, t := range m.state.Tasks {
		if t.Repo == m.repo {
			tasks = append(tasks, t)
		}
	}
	return tasks
}
