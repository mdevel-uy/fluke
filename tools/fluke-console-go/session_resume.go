package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func validNativeSessionID(id string) bool {
	if len(id) != 36 {
		return false
	}
	for i, c := range id {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
		} else if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
			return false
		}
	}
	return true
}

func newNativeSessionID() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	bytes[6], bytes[8] = bytes[6]&0x0f|0x40, bytes[8]&0x3f|0x80
	id := hex.EncodeToString(bytes[:])
	return id[:8] + "-" + id[8:12] + "-" + id[12:16] + "-" + id[16:20] + "-" + id[20:], nil
}

// Pass the returned config to launchArgv with the new contract prompt. UUIDs
// only: names or "last" could select someone else's conversation.
func nativeResumeConfig(config AgentConfig, sessionID string) (AgentConfig, error) {
	if !validNativeSessionID(sessionID) {
		return config, errors.New(uiText("ID de sesión nativa inválido; hace falta un UUID exacto"))
	}
	if config.Provider != "codex" && config.Provider != "claude" {
		return config, errors.New(uiText("esta CLI no tiene recuperación nativa implementada"))
	}
	if err := validateNativeSessionConfig(config); err != nil {
		return config, err
	}
	args := append([]string{}, config.Arguments...)
	if config.Provider == "codex" {
		config.Arguments = append([]string{"resume", sessionID}, args...)
	} else {
		config.Arguments = append(args, "--resume", sessionID)
	}
	return config, nil
}

func validateNativeSessionConfig(config AgentConfig) error {
	if _, err := config.argv(); err != nil {
		return err
	}
	for _, arg := range config.Arguments {
		option, _, _ := strings.Cut(arg, "=")
		switch option {
		case "--", "--last", "--all", "--continue", "--resume", "--session-id", "--fork-session", "--from-pr", "--worktree", "--background", "--bg", "--no-session-persistence", "-r", "-w":
			return errors.New(uiText("los argumentos no pueden elegir, crear o descartar otra sesión al recuperar"))
		case "-c":
			if config.Provider == "claude" {
				return errors.New(uiText("--continue no puede combinarse con una recuperación por UUID"))
			}
		}
	}
	return nil
}

func nativeNewClaudeConfig(config AgentConfig, sessionID string) (AgentConfig, error) {
	if config.Provider != "claude" || !validNativeSessionID(sessionID) {
		return config, errors.New(uiText("solo Claude permite asignar un UUID nativo al iniciar"))
	}
	if err := validateNativeSessionConfig(config); err != nil {
		return config, err
	}
	config.Arguments = append(append([]string{}, config.Arguments...), "--session-id", sessionID)
	return config, nil
}

// ponytail: Codex rollout format is internal; fail closed if it changes. Replace
// this check with a supported CLI identity endpoint when one becomes available.
func verifyCodexNativeSession(codexHome, sessionID, cwd, runID string) error {
	if !validNativeSessionID(sessionID) || !filepath.IsAbs(codexHome) || !filepath.IsAbs(cwd) || len(runID) != 32 {
		return errors.New(uiText("identidad de sesión Codex inválida"))
	}
	if _, err := hex.DecodeString(runID); err != nil {
		return errors.New(uiText("run ID de sesión Codex inválido"))
	}
	matches, err := filepath.Glob(filepath.Join(codexHome, "sessions", "[0-9][0-9][0-9][0-9]", "[0-9][0-9]", "[0-9][0-9]", "rollout-*-"+strings.ToLower(sessionID)+".jsonl"))
	if err != nil || len(matches) != 1 {
		return errors.New(uiText("no hay un único transcript local para ese UUID Codex; recuperación bloqueada"))
	}
	root, err := os.OpenRoot(codexHome)
	if err != nil {
		return errors.New(uiText("no se pudo abrir el directorio de sesiones Codex"))
	}
	defer root.Close()
	rel, err := filepath.Rel(codexHome, matches[0])
	if err != nil || !filepath.IsLocal(rel) {
		return errors.New(uiText("ruta de transcript Codex inválida"))
	}
	info, err := root.Lstat(rel)
	if err != nil || !info.Mode().IsRegular() {
		return errors.New(uiText("el transcript Codex no es un archivo regular"))
	}
	file, err := root.Open(rel)
	if err != nil {
		return errors.New(uiText("no se pudo leer el transcript exacto de Codex"))
	}
	defer file.Close()
	scanner := bufio.NewScanner(io.LimitReader(file, 2*1024*1024))
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	var event struct {
		Type    string `json:"type"`
		Payload struct {
			ID        string `json:"id"`
			SessionID string `json:"session_id"`
			Cwd       string `json:"cwd"`
			Type      string `json:"type"`
			Message   string `json:"message"`
			Item      struct {
				Type    string `json:"type"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"item"`
		} `json:"payload"`
	}
	if !scanner.Scan() || json.Unmarshal(scanner.Bytes(), &event) != nil || event.Type != "session_meta" || !strings.EqualFold(event.Payload.ID, sessionID) || event.Payload.SessionID != "" && !strings.EqualFold(event.Payload.SessionID, sessionID) || !dependencySamePath(event.Payload.Cwd, cwd) {
		return errors.New(uiText("el UUID Codex reportado no coincide con el worktree de esta ejecución"))
	}
	for scanner.Scan() {
		// UserMessage events identify actual human input. Raw response_item user
		// messages also include automatically injected AGENTS/environment context.
		event.Type, event.Payload.Type, event.Payload.Message = "", "", ""
		event.Payload.Item.Type, event.Payload.Item.Content = "", nil
		if json.Unmarshal(scanner.Bytes(), &event) != nil {
			return errors.New(uiText("formato de transcript Codex desconocido; recuperación bloqueada"))
		}
		if event.Type != "event_msg" {
			continue
		}
		var texts []string
		switch event.Payload.Type {
		case "user_message":
			texts = append(texts, event.Payload.Message)
		case "item_completed":
			if event.Payload.Item.Type != "UserMessage" {
				continue
			}
			for _, content := range event.Payload.Item.Content {
				if content.Type == "text" {
					texts = append(texts, content.Text)
				}
			}
		default:
			continue
		}
		prompt := strings.TrimSpace(strings.Join(texts, "\n"))
		if strings.Contains(prompt, runID) {
			return nil
		}
		return errors.New(uiText("el primer prompt de la sesión Codex no pertenece a esta ejecución Fluke"))
	}
	return errors.New(uiText("no se pudo verificar el primer prompt Codex dentro del límite de lectura"))
}
