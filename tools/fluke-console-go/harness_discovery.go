package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

type discoveredHarness struct {
	ID, Name, Executable, Version, Message      string
	Installed, Usable, AuthKnown, Authenticated bool
	Models                                      []string
	RecommendedModel, ModelReason               string
}

// Discovery reads PATH and launcher files; it never runs an agent or installer.
func detectHarnesses() []discoveredHarness {
	entries := []discoveredHarness{
		{ID: "agy", Name: "Antigravity"}, {ID: "aider", Name: "Aider"},
		{ID: "amp", Name: "Amp"}, {ID: "claude", Name: "Claude Code"},
		{ID: "codex", Name: "Codex"}, {ID: "continue", Name: "Continue"},
		{ID: "copilot", Name: "GitHub Copilot"}, {ID: "crush", Name: "Crush"},
		{ID: "cursor-agent", Name: "Cursor CLI"}, {ID: "deepseek", Name: "DeepSeek (CLI)"},
		{ID: "droid", Name: "Droid"}, {ID: "gemini", Name: "Gemini CLI"},
		{ID: "goose", Name: "Goose"}, {ID: "grok", Name: "Grok"},
		{ID: "hermes", Name: "Hermes"}, {ID: "kimi", Name: "Kimi CLI"},
		{ID: "muse", Name: "Muse Code"}, {ID: "omp", Name: "Oh My Pi"},
		{ID: "openclaw", Name: "OpenClaw"}, {ID: "opencode", Name: "OpenCode"},
		{ID: "openhands", Name: "OpenHands"}, {ID: "ori", Name: "Ori"},
		{ID: "pi", Name: "Pi"}, {ID: "qwen", Name: "Qwen Code"},
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	for i := range entries {
		h := &entries[i]
		h.Message = uiText("No encontrada en PATH.")
		if h.ID == "deepseek" {
			h.Message = uiText("DeepSeek es un proveedor/modelo; no se encontró una CLI deepseek.")
		}
		path, err := exec.LookPath(h.ID)
		if err != nil {
			continue
		}
		h.Executable = path
		if installingHarnessLauncher(path) {
			h.Message = uiText("Launcher de instalación detectado; se comprobará si el binario ya existe.")
			continue
		}
		h.Installed = true
		h.Usable = h.ID == "codex" || h.ID == "claude"
		h.Message = uiText("CLI instalada; sesión pendiente de comprobar.")
		if !h.Usable {
			h.Message = uiText("CLI detectada; Fluke todavía no tiene un adaptador de estado y sesiones para ella.")
		}
	}
	return entries
}

var installationLauncher = regexp.MustCompile(`(?m)^\s*(?:exec\s+)?(?:mise\s+(?:use|exec|x)\b|omarchy-install-[a-z0-9-]+\b)`)

func installingHarnessLauncher(path string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	body, err := io.ReadAll(io.LimitReader(file, 32*1024))
	return err == nil && !bytes.ContainsRune(body, '\x00') && installationLauncher.Match(body)
}

func probeDiscoveredHarness(ctx context.Context, h discoveredHarness) discoveredHarness {
	h.Models, h.RecommendedModel, h.ModelReason = nil, "", ""
	h.Version, h.AuthKnown, h.Authenticated = "", false, false
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if h.Executable == "" {
		h.Installed, h.Usable = false, false
		return h
	}
	if installingHarnessLauncher(h.Executable) {
		path, err := installedMiseHarness(ctx, h.ID)
		if err != nil {
			h.Installed, h.Usable = false, false
			h.Message = uiText("Solo hay un launcher instalador. Instalá la CLI antes de usarla; Fluke no ejecutó el instalador.")
			return h
		}
		h.Executable = path
		h.Installed = true
	}
	if h.ID != "codex" && h.ID != "claude" {
		h.Usable = false
		h.Message = uiText("CLI detectada; Fluke todavía no tiene un adaptador de estado y sesiones para ella.")
		return h
	}
	config := AgentConfig{Provider: h.ID, Executable: h.Executable}
	health := probeProvider(ctx, config)
	h.Installed, h.Executable = health.Available, health.Executable
	h.Version, h.Message = health.Version, health.Message
	h.AuthKnown, h.Authenticated = health.AuthKnown, health.Authenticated
	h.Usable = health.Available && health.Version != "" && ctx.Err() == nil
	if !h.Usable {
		h.Message = uiText("No se pudo comprobar que esta CLI arranque correctamente; revisá la instalación.")
		return h
	}
	if h.ID == "codex" {
		h.Models, h.RecommendedModel, h.ModelReason = discoveredCodexModels()
	} else {
		help, err := providerCheck(ctx, config, "--help")
		if err == nil {
			h.Models, h.RecommendedModel, h.ModelReason = discoveredClaudeModels(help, claudeModelSettingsPaths())
		} else {
			h.ModelReason = uiText("No se pudo leer el catálogo de la CLI; conservá su modelo predeterminado o elegilo manualmente.")
		}
	}
	h.Models = append([]string{""}, h.Models...)
	return h
}

func installedMiseHarness(ctx context.Context, id string) (string, error) {
	// `which` only resolves an installed tool; `use` and `exec` may install it.
	cmd := exec.CommandContext(ctx, "mise", "which", id)
	cmd.WaitDelay = 250 * time.Millisecond
	var out providerOutput
	cmd.Stdout = &out
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return "", err
	}
	path := strings.TrimSpace(string(out.data))
	if !filepath.IsAbs(path) || strings.ContainsAny(path, "\x00\r\n") || installingHarnessLauncher(path) {
		return "", os.ErrNotExist
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", os.ErrNotExist
	}
	return exec.LookPath(path)
}

func recommendHarness(candidates []discoveredHarness, omarchyDefault string) (int, string) {
	best, rank := -1, -1
	for i, h := range candidates {
		if !h.Installed || !h.Usable {
			continue
		}
		r := 0
		if !h.AuthKnown {
			r = 1
		} else if h.Authenticated {
			r = 2
		}
		prefer := best < 0 || r > rank
		if best >= 0 && r == rank {
			isDefault, currentDefault := h.ID == omarchyDefault, candidates[best].ID == omarchyDefault
			prefer = isDefault && !currentDefault || isDefault == currentDefault && h.Name < candidates[best].Name
		}
		if prefer {
			best, rank = i, r
		}
	}
	if best < 0 {
		return -1, uiText("No hay una CLI compatible y comprobada; instalá Codex o Claude Code y volvé a detectar.")
	}
	if rank == 2 && candidates[best].ID == omarchyDefault {
		return best, uiText("Tu agente predeterminado de Omarchy está instalado y autenticado.")
	}
	if rank == 2 {
		return best, uiText("CLI compatible y autenticada. La recomendación usa tu instalación; podés elegir otra.")
	}
	if rank == 1 {
		return best, uiText("CLI compatible; verificá su sesión antes de comenzar.")
	}
	return best, uiText("CLI compatible; necesitás iniciar sesión antes de comenzar.")
}

func readOmarchyDefault() string {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		dir = filepath.Join(userHome, ".config")
	}
	file, err := os.Open(filepath.Join(dir, "omarchy", "defaults", "agent"))
	if err != nil {
		return ""
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 257))
	if err != nil || len(data) > 256 {
		return ""
	}
	value := strings.TrimSpace(string(data))
	if !regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`).MatchString(value) {
		return ""
	}
	return value
}

func discoveredCodexModels() ([]string, string, string) {
	dir := os.Getenv("CODEX_HOME")
	if dir == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return nil, "", uiText("No se pudo localizar el catálogo local de Codex.")
		}
		dir = filepath.Join(userHome, ".codex")
	}
	file, err := os.Open(filepath.Join(dir, "models_cache.json"))
	if err != nil {
		return nil, "", uiText("Codex todavía no tiene un catálogo local. Conservá el modelo de la CLI o elegilo manualmente.")
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 4*1024*1024+1))
	if err != nil || len(data) > 4*1024*1024 {
		return nil, "", uiText("No se pudo leer el catálogo local de Codex.")
	}
	models := readProviderModelCache(bytes.NewReader(data))
	var cache struct {
		Models []struct {
			Slug       string `json:"slug"`
			Visibility string `json:"visibility"`
			Priority   *int   `json:"priority"`
		} `json:"models"`
	}
	if json.Unmarshal(data, &cache) != nil || len(models) == 0 {
		return models, "", uiText("El catálogo local no contiene modelos visibles válidos.")
	}
	visible := map[string]bool{}
	for _, model := range models {
		visible[model] = true
	}
	best, priority, tied := "", 0, false
	for _, model := range cache.Models {
		if model.Visibility != "list" || !visible[model.Slug] || model.Priority == nil || *model.Priority < 0 {
			continue
		}
		if best == "" || *model.Priority < priority {
			best, priority, tied = model.Slug, *model.Priority, false
		} else if *model.Priority == priority && model.Slug != best {
			tied = true
		}
	}
	if best == "" || tied {
		return models, "", uiText("El catálogo no identifica una prioridad única; elegí el modelo o conservá el predeterminado de Codex.")
	}
	return models, best, uiText("Mayor prioridad entre modelos visibles del catálogo local de Codex. La disponibilidad remota se verifica al usarlo.")
}

type claudeModelSettingsPath struct {
	path    string
	managed bool
}

func claudeModelSettingsPaths() []claudeModelSettingsPath {
	// ponytail: only local files inform onboarding; require CLI policy metadata
	// before promising model availability on centrally managed machines.
	dir := os.Getenv("CLAUDE_CONFIG_DIR")
	if dir == "" {
		userHome, _ := os.UserHomeDir()
		dir = filepath.Join(userHome, ".claude")
	}
	paths := []claudeModelSettingsPath{{path: filepath.Join(dir, "settings.json")}}
	if cwd, err := os.Getwd(); err == nil {
		paths = append(paths, claudeModelSettingsPath{path: filepath.Join(cwd, ".claude", "settings.json")}, claudeModelSettingsPath{path: filepath.Join(cwd, ".claude", "settings.local.json")})
	}
	managedDir := "/etc/claude-code"
	if runtime.GOOS == "darwin" {
		managedDir = "/Library/Application Support/ClaudeCode"
	}
	if runtime.GOOS == "windows" {
		if programFiles := os.Getenv("ProgramFiles"); programFiles != "" {
			managedDir = filepath.Join(programFiles, "ClaudeCode")
		} else {
			managedDir = `C:\Program Files\ClaudeCode`
		}
	}
	paths = append(paths, claudeModelSettingsPath{path: filepath.Join(managedDir, "managed-settings.json"), managed: true})
	dropins, _ := filepath.Glob(filepath.Join(managedDir, "managed-settings.d", "*.json"))
	for _, path := range dropins {
		paths = append(paths, claudeModelSettingsPath{path: path, managed: true})
	}
	return paths
}

var quotedClaudeAlias = regexp.MustCompile(`['"]([a-z]+)['"]`)

func discoveredClaudeModels(help string, paths []claudeModelSettingsPath) ([]string, string, string) {
	start := strings.Index(help, "--model ")
	if start < 0 {
		return nil, "", uiText("Esta CLI no publica aliases de modelo en --help; elegí el modelo manualmente.")
	}
	section := help[start:]
	if end := regexp.MustCompile(`\n\s+--[a-z]`).FindStringIndex(section); end != nil {
		section = section[:end[0]]
	}
	available := map[string]bool{}
	for _, match := range quotedClaudeAlias.FindAllStringSubmatch(section, -1) {
		available[match[1]] = true
	}
	var lists [][]string
	managed := false
	var denied []string
	for _, path := range paths {
		file, err := os.Open(path.path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, "", uiText("No se pudo leer una configuración de modelos; revisala en Claude antes de elegir.")
		}
		data, err := io.ReadAll(io.LimitReader(file, 1024*1024+1))
		_ = file.Close()
		var settings struct {
			Available *[]string `json:"availableModels"`
			Denied    []string  `json:"deniedModels"`
		}
		if err != nil || len(data) > 1024*1024 || json.Unmarshal(data, &settings) != nil {
			return nil, "", uiText("Una configuración de modelos no se pudo interpretar; revisala en Claude antes de elegir.")
		}
		if path.managed {
			denied = append(denied, settings.Denied...)
		}
		if settings.Available == nil {
			continue
		}
		if path.managed && !managed {
			lists, managed = nil, true
		}
		if !managed || path.managed {
			lists = append(lists, *settings.Available)
		}
	}
	var models []string
	// Family aliases follow the installed CLI; version IDs never live in Fluke.
	for _, alias := range []string{"best", "fable", "opus", "sonnet", "haiku"} {
		if !available[alias] {
			continue
		}
		allowed := len(lists) == 0
		if managed {
			allowed = true
		}
		for _, list := range lists {
			inList := false
			for _, entry := range list {
				if entry == alias {
					inList = true
				}
			}
			if managed {
				allowed = allowed && inList
			} else {
				allowed = allowed || inList
			}
		}
		// A version-specific family entry disables its broad wildcard. The
		// cached policy cannot tell us what version an alias would resolve to.
		for _, list := range lists {
			for _, entry := range list {
				if strings.Contains(entry, "claude-"+alias+"-") {
					allowed = false
				}
			}
		}
		for _, entry := range denied {
			if entry == alias || strings.Contains(entry, "claude-"+alias+"-") {
				allowed = false
			}
		}
		if allowed {
			models = append(models, alias)
		}
	}
	for _, flagship := range []string{"best", "fable", "opus"} {
		for _, model := range models {
			if model == flagship {
				return models, model, uiText("Recomendación por familia insignia documentada, entre los aliases reconocidos que publica --help. Acceso y cuota remotos pendientes de verificar.")
			}
		}
	}
	return models, "", uiText("La ayuda o las restricciones locales no permiten identificar un modelo insignia. Conservá el predeterminado de Claude o elegí uno manualmente.")
}
