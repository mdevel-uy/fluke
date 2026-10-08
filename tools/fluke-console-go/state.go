package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/gofrs/flock"
)

type AgentConfig struct {
	Provider   string   `json:"provider"`
	Executable string   `json:"executable"`
	Model      string   `json:"model"`
	Arguments  []string `json:"arguments"`
}
type ConversationMessage struct {
	Role     string `json:"role"`
	Text     string `json:"text"`
	RunID    string `json:"run_id,omitempty"`
	Seq      uint64 `json:"seq,omitempty"`
	Delivery string `json:"delivery,omitempty"`
}
type ProjectGoal struct {
	ID         string `json:"id"`
	Objective  string `json:"objective"`
	Acceptance string `json:"acceptance"`
}
type Task struct {
	GoalID         string           `json:"goal_id,omitempty"`
	ID             string           `json:"id"`
	Repo           string           `json:"repo"`
	Title          string           `json:"title"`
	Acceptance     string           `json:"acceptance"`
	DependsOn      []string         `json:"depends_on,omitempty"`
	Status         string           `json:"status"`
	Worktree       *string          `json:"worktree"`
	Branch         string           `json:"branch"`
	Note           string           `json:"note"`
	IssueURL       string           `json:"issue_url,omitempty"`
	IssueBody      string           `json:"issue_body,omitempty"`
	AgentRun       string           `json:"agent_run,omitempty"`
	AgentProvider  string           `json:"agent_provider,omitempty"`
	AgentConfig    *AgentConfig     `json:"agent_config,omitempty"`
	AgentSeq       uint64           `json:"agent_seq,omitempty"`
	AgentState     string           `json:"agent_state,omitempty"`
	AgentMessage   string           `json:"agent_message,omitempty"`
	AgentEvidence  []string         `json:"agent_evidence,omitempty"`
	BaseCommit     string           `json:"base_commit,omitempty"`
	BriefHash      string           `json:"brief_hash,omitempty"`
	Queued         bool             `json:"queued,omitempty"`
	Paused         bool             `json:"paused,omitempty"`
	ManuallyPaused bool             `json:"manually_paused,omitempty"`
	ReviewFeedback string           `json:"review_feedback,omitempty"`
	AcceptedTree   string           `json:"accepted_tree,omitempty"`
	Integration    *integrationPlan `json:"integration,omitempty"`
	Publication    *githubPRPlan    `json:"publication,omitempty"`
	NativeSession  *NativeSession   `json:"native_session,omitempty"`
}
type Decision struct {
	Number              int     `json:"number,omitempty"`
	Repo                string  `json:"repo"`
	Question            string  `json:"question"`
	Answer              *string `json:"answer"`
	TaskID              string  `json:"task_id,omitempty"`
	RunID               string  `json:"run_id,omitempty"`
	Seq                 uint64  `json:"seq,omitempty"`
	Continuation        string  `json:"continuation,omitempty"`
	ReviewFeedback      bool    `json:"review_feedback,omitempty"`
	DirectInstruction   bool    `json:"direct_instruction,omitempty"`
	HumanInstructionSeq uint64  `json:"human_instruction_seq,omitempty"`
	Supersedes          int     `json:"supersedes,omitempty"`
	ProposedTitle       string  `json:"proposed_title,omitempty"`
	ProposedGoal        bool    `json:"proposed_goal,omitempty"`
	ProposedAcceptance  string  `json:"proposed_acceptance,omitempty"`
}
type State struct {
	Version              int                              `json:"version"`
	MaxWorkers           int                              `json:"max_workers"`
	Projects             []string                         `json:"projects"`
	Tasks                []Task                           `json:"tasks"`
	Decisions            []Decision                       `json:"decisions"`
	Orchestrator         *AgentConfig                     `json:"orchestrator"`
	Goals                map[string]ProjectGoal           `json:"goals,omitempty"`
	Conversations        map[string][]ConversationMessage `json:"conversations,omitempty"`
	PausedProjects       map[string]bool                  `json:"paused_projects,omitempty"`
	OrchestratorSessions map[string]NativeSession         `json:"orchestrator_sessions,omitempty"`
	Language             string                           `json:"language,omitempty"`
	Setup                *setupProgress                   `json:"setup,omitempty"`
}
type Store struct {
	dir  string
	lock *flock.Flock
}

func openStore(dir string) (*Store, State, error) {
	s := State{Version: 1, MaxWorkers: 2, Projects: []string{}, Tasks: []Task{}, Decisions: []Decision{}}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, s, err
	}
	store := &Store{dir: dir, lock: flock.New(filepath.Join(dir, "console.lock"))}
	locked, err := store.lock.TryLock()
	if err != nil || !locked {
		return nil, s, errors.New(uiText("ya hay una consola usando este estado"))
	}
	fail := func(err error) (*Store, State, error) { _ = store.lock.Close(); return nil, s, err }
	data, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err == nil {
		if err = json.Unmarshal(data, &s); err != nil {
			return fail(fmt.Errorf(uiText("estado inválido; se conserva el archivo: %w"), err))
		}
	} else if !os.IsNotExist(err) {
		return fail(err)
	}
	if s.Version != 1 || s.MaxWorkers < 1 || s.MaxWorkers > 64 {
		return fail(errors.New(uiText("versión o límite de workers inválido")))
	}
	if s.Language != "" && s.Language != "en" && s.Language != "es" || s.Setup != nil && (s.Setup.Step < 0 || s.Setup.Step > 6 || len(s.Setup.RepoDraft) > 4096 || strings.ContainsAny(s.Setup.RepoDraft, "\x00\r\n")) {
		return fail(errors.New(localText("invalid first-run configuration", "configuración inicial inválida")))
	}
	for repo := range s.PausedProjects {
		if !filepath.IsAbs(repo) {
			return fail(errors.New(uiText("proyecto pausado inválido")))
		}
	}
	for repo, session := range s.OrchestratorSessions {
		if !filepath.IsAbs(repo) || !validStoredNativeSession(session) {
			return fail(errors.New(uiText("sesión guardada del orquestador inválida")))
		}
	}
	for repo, goal := range s.Goals {
		if !filepath.IsAbs(repo) || (len(goal.ID) != 33 || goal.ID[0] != 'g' || !validID("t"+goal.ID[1:])) || strings.TrimSpace(goal.Objective) == "" || strings.TrimSpace(goal.Acceptance) == "" {
			return fail(errors.New(uiText("objetivo inválido; se conserva el estado")))
		}
	}
	for repo, messages := range s.Conversations {
		if !filepath.IsAbs(repo) || len(messages) > 100 {
			return fail(errors.New(uiText("conversación inválida")))
		}
		for i, msg := range messages {
			if (msg.Role != "human" && msg.Role != "fluke") || len(msg.Text) > 16384 {
				return fail(errors.New(uiText("mensaje inválido")))
			}
			if msg.Delivery == "pending" {
				s.Conversations[repo][i].Delivery = "uncertain"
			}
		}
	}
	ids := map[string]bool{}
	for i := range s.Tasks {
		t := &s.Tasks[i]
		if !validID(t.ID) || ids[t.ID] || !filepath.IsAbs(t.Repo) || t.Branch != "codex/fluke/"+t.ID {
			return fail(errors.New(uiText("tarea inválida; se conserva el estado")))
		}
		ids[t.ID] = true
		if t.BriefHash != "" && (len(t.BriefHash) != 64 || !validGitHash(t.BriefHash)) {
			return fail(errors.New("identidad de spec inválida"))
		}
		if len(t.ReviewFeedback) > 4000 {
			return fail(errors.New(uiText("comentario de revisión demasiado largo")))
		}
		if t.AcceptedTree != "" && !validGitHash(t.AcceptedTree) {
			return fail(errors.New(uiText("snapshot de aceptación inválido")))
		}
		if t.NativeSession != nil && !validStoredNativeSession(*t.NativeSession) {
			return fail(errors.New(uiText("sesión guardada del worker inválida")))
		}
		if p := t.Publication; p != nil {
			if !validStoredGithubPRPlan(*t, *p) {
				return fail(errors.New(uiText("publicación GitHub guardada inválida")))
			}
			if p.Started && !p.Complete {
				t.Note = uiText("Publicación anterior pendiente de verificar. F7 → p consulta GitHub antes de continuar.")
			}
		}
		if t.AgentConfig != nil {
			if _, err := t.AgentConfig.argv(); err != nil {
				return fail(err)
			}
		}
		if p := t.Integration; p != nil {
			if p.ExpectedTree != "" && !validGitHash(p.ExpectedTree) {
				return fail(errors.New(uiText("árbol de integración guardado inválido")))
			}
			if p.TaskID != t.ID || !validGitHash(p.TargetHead) || !validGitHash(p.SourceHead) || !validGitHash(p.Tree) || p.TargetBranch == "" || strings.ContainsAny(p.TargetBranch, "\x00\r\n") || p.MergedCommit != "" && !validGitHash(p.MergedCommit) {
				return fail(errors.New(uiText("integración guardada inválida")))
			}
			if p.Started && p.MergedCommit == "" {
				t.Note = uiText("Integración anterior pendiente de verificar. F7 → m reconcilia Git antes de continuar.")
			}
		}
		switch t.Status {
		case "pending", "interrupted", "awaiting_review", "accepted":
		case "running":
			t.Status = "interrupted"
			t.Note = uiText("Ejecución anterior terminada; revisar cambios antes de reiniciar.")
		default:
			return fail(errors.New(uiText("estado de tarea desconocido")))
		}
		if t.Worktree != nil && !filepath.IsAbs(*t.Worktree) {
			return fail(errors.New(uiText("worktree inválido")))
		}
	}
	for _, task := range s.Tasks {
		if err := validateTaskDependencies(s, task); err != nil {
			return fail(fmt.Errorf(uiText("dependencias inválidas; se conserva el estado: %w"), err))
		}
	}
	for _, p := range s.Projects {
		if !filepath.IsAbs(p) {
			return fail(errors.New(uiText("repositorio inválido")))
		}
	}
	for i := range s.Decisions {
		d := s.Decisions[i]
		if d.Supersedes != 0 {
			if d.Supersedes < 1 || d.Supersedes > i || d.Answer == nil {
				return fail(errors.New(localText("invalid decision correction", "corrección de decisión inválida")))
			}
			previous := s.Decisions[d.Supersedes-1]
			if previous.Answer == nil || previous.Repo != d.Repo || previous.TaskID != d.TaskID || previous.Question != d.Question {
				return fail(errors.New(localText("invalid decision correction source", "fuente de corrección inválida")))
			}
		}
		if d.DirectInstruction || d.HumanInstructionSeq != 0 {
			if d.Answer == nil || strings.TrimSpace(*d.Answer) == "" || len(*d.Answer) > 4000 || !validID(d.TaskID) || !filepath.IsAbs(d.Repo) || d.HumanInstructionSeq != uint64(i+1) {
				return fail(errors.New(localText("invalid saved worker instruction", "instrucción guardada del worker inválida")))
			}
		}
		if s.Decisions[i].Continuation == "sending" {
			s.Decisions[i].Continuation = "uncertain"
		}
	}
	if s.Orchestrator != nil {
		if _, err := s.Orchestrator.argv(); err != nil {
			return fail(err)
		}
	}
	return store, s, nil
}
func validID(s string) bool {
	if len(s) < 2 || s[0] != 't' {
		return false
	}
	for _, c := range s[1:] {
		if !strings.ContainsRune("0123456789abcdef", c) {
			return false
		}
	}
	return true
}
func (s *Store) save(state State) error {
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(s.dir, ".state-*.json")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
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
	return replaceFile(name, filepath.Join(s.dir, "state.json"))
}
func (s *State) addTask(repo, title, acceptance string) error {
	title = strings.TrimSpace(title)
	acceptance = strings.TrimSpace(acceptance)
	if title == "" || acceptance == "" {
		return errors.New(uiText("usá :task título | criterio de aceptación"))
	}
	// Wall-clock resolution on Windows can give consecutive tasks the same ID.
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	id := "t" + hex.EncodeToString(random[:])
	s.Tasks = append(s.Tasks, Task{ID: id, GoalID: s.Goals[repo].ID, Repo: repo, Title: title, Acceptance: acceptance, Status: "pending", Branch: "codex/fluke/" + id})
	return nil
}
func (a AgentConfig) argv() ([]string, error) {
	if strings.TrimSpace(a.Executable) == "" {
		return nil, errors.New(uiText("indicá el ejecutable"))
	}
	if a.Provider != "codex" && a.Provider != "claude" && a.Provider != "custom" {
		return nil, errors.New(uiText("proveedor inválido"))
	}
	args := append([]string{}, a.Arguments...)
	if a.Provider == "custom" && a.Model != "" {
		found := false
		for _, arg := range args {
			if arg == "{model}" {
				found = true
			}
		}
		if !found {
			return nil, errors.New(uiText("para una CLI personalizada usá {model} como argumento"))
		}
	}
	for i, v := range args {
		if strings.ContainsAny(v, "\x00\r\n") {
			return nil, errors.New(uiText("argumento inválido"))
		}
		if a.Provider != "custom" && (v == "--model" || v == "-m" || strings.HasPrefix(v, "--model=")) {
			return nil, errors.New(uiText("el modelo se define en su campo"))
		}
		if a.Provider == "custom" && v == "{model}" {
			args[i] = a.Model
		}
	}
	if strings.ContainsAny(a.Executable+a.Model, "\x00\r\n") {
		return nil, errors.New(uiText("configuración inválida"))
	}
	if a.Provider != "custom" && strings.TrimSpace(a.Model) != "" {
		args = append(args, "--model", a.Model)
	}
	return append([]string{a.Executable}, args...), nil
}

func (s *State) setGoal(repo, objective, acceptance string) error {
	objective = strings.TrimSpace(objective)
	acceptance = strings.TrimSpace(acceptance)
	if objective == "" || acceptance == "" {
		return errors.New(uiText("indicá objetivo y criterio de aceptación"))
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	s.Goals = cloneGoals(s.Goals)
	s.Goals[repo] = ProjectGoal{ID: "g" + hex.EncodeToString(random[:]), Objective: objective, Acceptance: acceptance}
	return nil
}
