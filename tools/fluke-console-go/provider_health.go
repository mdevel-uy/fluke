package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type providerHealth struct {
	Provider, Executable, Version, Message string
	Available, AuthKnown, Authenticated    bool
	Models                                 []string
}

// probeProvider performs local CLI checks only, without spending model tokens.
// Call it in a tea.Cmd: an npm wrapper can take several seconds to start.
func probeProvider(ctx context.Context, config AgentConfig) providerHealth {
	h := providerHealth{Provider: config.Provider, Models: providerModelChoices(config.Provider)}
	executable, err := exec.LookPath(config.Executable)
	if err != nil {
		h.Message = uiText("CLI no encontrada. Revisá el ejecutable en configuración.")
		return h
	}
	h.Available, h.Executable = true, executable
	if config.Provider == "custom" {
		h.Message = uiText("Ejecutable disponible; autenticación gestionada por esa CLI.")
		return h
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if out, err := providerCheck(ctx, config, "--version"); err == nil {
		line := strings.TrimSpace(strings.SplitN(out, "\n", 2)[0])
		if len(line) < 120 && !strings.ContainsAny(line, "\x1b\r") {
			h.Version = line
		}
	}
	var out string
	switch config.Provider {
	case "codex":
		out, err = providerCheck(ctx, config, "login", "status")
	case "claude":
		out, err = providerCheck(ctx, config, "auth", "status")
	default:
		h.Message = uiText("Proveedor desconocido.")
		return h
	}
	h.AuthKnown, h.Authenticated = providerAuthState(config.Provider, out, err)
	switch {
	case ctx.Err() != nil:
		h.Message = uiText("La CLI no respondió a tiempo. Volvé a comprobar la conexión.")
	case h.AuthKnown && h.Authenticated:
		h.Message = uiText("Sesión autenticada. La conexión al modelo se comprobará al iniciar.")
	case h.AuthKnown:
		if config.Provider == "codex" {
			h.Message = uiText("Falta iniciar sesión: ejecutá codex login en una consola.")
		} else {
			h.Message = uiText("Falta iniciar sesión: ejecutá claude auth login en una consola.")
		}
	default:
		h.Message = uiText("CLI disponible; no se pudo verificar la sesión. Abrila para revisar.")
	}
	return h
}

func providerAuthState(provider, output string, commandErr error) (known, authenticated bool) {
	if provider == "claude" {
		var status struct {
			LoggedIn *bool `json:"loggedIn"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(output)), &status) == nil && status.LoggedIn != nil {
			if !*status.LoggedIn {
				return true, false
			}
			return commandErr == nil, commandErr == nil
		}
	} else if provider == "codex" {
		output = strings.ToLower(output)
		if strings.Contains(output, "not logged in") {
			return true, false
		}
		if commandErr == nil && strings.Contains(output, "logged in using") {
			return true, true
		}
	}
	return false, false
}

// Discard excess CLI output without returning raw output or command errors to UI.
type providerOutput struct{ data []byte }

func (w *providerOutput) Write(p []byte) (int, error) {
	n := len(p)
	if remaining := 32*1024 - len(w.data); remaining > 0 {
		w.data = append(w.data, p[:min(remaining, len(p))]...)
	}
	return n, nil
}

func providerCheck(ctx context.Context, config AgentConfig, args ...string) (string, error) {
	config.Model, config.Arguments = "", args
	argv, err := launchArgv(config, "")
	if err != nil {
		return "", err
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.WaitDelay = 250 * time.Millisecond
	var output providerOutput
	cmd.Stdout, cmd.Stderr = &output, &output
	err = cmd.Run()
	return string(output.data), err
}

func providerModelChoices(provider string) []string {
	choices := []string{""} // Keep the CLI's own default selectable.
	if provider == "claude" {
		// Aliases documented by the installed Claude CLI's --help.
		return append(choices, "sonnet", "opus", "fable")
	}
	if provider != "codex" {
		return choices
	}
	codexHome := os.Getenv("CODEX_HOME")
	if codexHome == "" {
		if home, err := os.UserHomeDir(); err == nil {
			codexHome = filepath.Join(home, ".codex")
		}
	}
	file, err := os.Open(filepath.Join(codexHome, "models_cache.json"))
	if err != nil {
		return choices
	}
	defer file.Close()
	return append(choices, readProviderModelCache(file)...)
}

func readProviderModelCache(r io.Reader) []string {
	var cache struct {
		Models []struct {
			Slug       string `json:"slug"`
			Visibility string `json:"visibility"`
			Priority   int    `json:"priority"`
		} `json:"models"`
	}
	data, err := io.ReadAll(io.LimitReader(r, 4*1024*1024+1))
	if err != nil || len(data) > 4*1024*1024 || json.Unmarshal(data, &cache) != nil {
		return nil
	}
	sort.SliceStable(cache.Models, func(i, j int) bool { return cache.Models[i].Priority < cache.Models[j].Priority })
	var models []string
	seen := map[string]bool{}
	for _, model := range cache.Models {
		if model.Visibility != "list" || model.Slug == "" || len(model.Slug) > 100 || seen[model.Slug] {
			continue
		}
		valid := true
		for _, c := range model.Slug {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("._-", c)) {
				valid = false
				break
			}
		}
		if valid {
			seen[model.Slug] = true
			models = append(models, model.Slug)
		}
	}
	return models
}
