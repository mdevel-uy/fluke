package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	tea "charm.land/bubbletea/v2"
)

type NativeSession struct {
	ID         string      `json:"id"`
	InitialRun string      `json:"initial_run"`
	Config     AgentConfig `json:"config"`
}

func validStoredNativeSession(s NativeSession) bool {
	if !validNativeSessionID(s.ID) || len(s.InitialRun) != 32 || !validID("t"+s.InitialRun) || s.Config.Provider != "codex" && s.Config.Provider != "claude" {
		return false
	}
	_, err := s.Config.argv()
	return err == nil
}

func codexSessionHome() (string, error) {
	if home := os.Getenv("CODEX_HOME"); home != "" {
		return filepath.Abs(home)
	}
	home, err := os.UserHomeDir()
	return filepath.Join(home, ".codex"), err
}

func prepareNativeConfig(config AgentConfig, previous *NativeSession, path, runID string) (AgentConfig, *NativeSession, error) {
	if config.Provider == "codex" {
		if err := validateNativeSessionConfig(config); err != nil {
			return config, nil, err
		}
	}
	if previous != nil && previous.Config.Provider == config.Provider && previous.Config.Executable == config.Executable {
		if !validStoredNativeSession(*previous) {
			return config, nil, errors.New(uiText("sesión nativa guardada inválida"))
		}
		if config.Provider == "codex" {
			home, err := codexSessionHome()
			if err != nil {
				return config, nil, err
			}
			if err = verifyCodexNativeSession(home, previous.ID, path, previous.InitialRun); err != nil {
				return config, nil, errors.New(uiText("no se pudo verificar la sesión anterior; :fresh inicia otra conservando los archivos: ") + err.Error())
			}
		}
		resume, err := nativeResumeConfig(config, previous.ID)
		session := *previous
		session.Config = config
		return resume, &session, err
	}
	if config.Provider == "claude" {
		id, err := newNativeSessionID()
		if err != nil {
			return config, nil, err
		}
		fresh, err := nativeNewClaudeConfig(config, id)
		return fresh, &NativeSession{ID: id, InitialRun: runID, Config: config}, err
	}
	return config, nil, nil
}

func capturedCodexSession(config AgentConfig, id, path, run string, existing *NativeSession) *NativeSession {
	if config.Provider != "codex" || !validNativeSessionID(id) {
		return existing
	}
	if existing != nil {
		return existing
	}
	home, err := codexSessionHome()
	if err != nil || verifyCodexNativeSession(home, id, path, run) != nil {
		return nil
	}
	return &NativeSession{ID: strings.ToLower(id), InitialRun: run, Config: config}
}

func withOrchestratorSession(state State, repo string, session *NativeSession) State {
	next := state
	next.OrchestratorSessions = make(map[string]NativeSession, len(state.OrchestratorSessions)+1)
	for key, value := range state.OrchestratorSessions {
		next.OrchestratorSessions[key] = value
	}
	if session == nil {
		delete(next.OrchestratorSessions, repo)
	} else {
		next.OrchestratorSessions[repo] = *session
	}
	return next
}

// Explicit recovery escape hatch: files, goal and conversation remain intact.
func (m *model) freshSession(id string) tea.Cmd {
	if id == "" || id == "fluke" {
		if m.preparing {
			m.notice = uiText("Esperá a que termine la preparación.")
			return nil
		}
		m.stop("fluke:" + m.repo)
		if m.sessionAlive("fluke:" + m.repo) {
			return nil
		}
		if !m.saveEdit(withOrchestratorSession(m.state, m.repo, nil), uiText("Fluke iniciará otra sesión con el contexto guardado.")) {
			return nil
		}
		return m.start("")
	}
	for i, task := range m.state.Tasks {
		if task.ID != id || task.Repo != m.repo {
			continue
		}
		if err := taskScopeError(m.state, task); err != nil {
			m.notice = err.Error()
			return nil
		}
		if m.preparingTaskID == id || m.acceptingTaskID == id || m.integratingTaskID == id || m.publishingTaskID == id {
			m.notice = uiText("Esperá a que termine la operación actual.")
			return nil
		}
		if task.Status == "accepted" {
			m.notice = uiText("La entrega ya fue aceptada.")
			return nil
		}
		m.stop(id)
		if m.sessionAlive(id) {
			return nil
		}
		next := m.state
		next.Tasks = append([]Task{}, next.Tasks...)
		next.Tasks[i].NativeSession = nil
		if !m.saveEdit(next, uiText("Se inicia otra sesión conservando la tarea, archivos y decisiones.")) {
			return nil
		}
		return m.start(id)
	}
	m.notice = uiText("Usá :fresh fluke o :fresh ID.")
	return nil
}
