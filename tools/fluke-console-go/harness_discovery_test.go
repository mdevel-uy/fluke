package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

type harnessDiscoveryFixture struct {
	MiseBinary string
	ClaudeHelp string
	ClaudeAuth bool
	CodexAuth  bool
	Executed   string
}

func init() {
	file := os.Getenv("FLUKE_HARNESS_DISCOVERY_FIXTURE")
	if file == "" {
		return
	}
	name := strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe")
	if name != "codex" && name != "claude" && name != "mise" && name != "droid" {
		return
	}
	data, err := os.ReadFile(file)
	var fixture harnessDiscoveryFixture
	if err != nil || json.Unmarshal(data, &fixture) != nil {
		os.Exit(90)
	}
	args := strings.Join(os.Args[1:], " ")
	switch {
	case name == "mise" && args == "which codex":
		if fixture.MiseBinary == "" {
			os.Exit(1)
		}
		fmt.Println(fixture.MiseBinary)
	case name == "codex" && args == "--version":
		fmt.Println("codex-cli fixture")
	case name == "codex" && args == "login status":
		if !fixture.CodexAuth {
			fmt.Println("Not logged in")
			os.Exit(1)
		}
		fmt.Println("Logged in using ChatGPT")
	case name == "claude" && args == "--version":
		fmt.Println("2.fixture (Claude Code)")
	case name == "claude" && args == "--help":
		fmt.Println(fixture.ClaudeHelp)
	case name == "claude" && args == "auth status":
		fmt.Printf("{\"loggedIn\":%v}\n", fixture.ClaudeAuth)
	default:
		_ = os.WriteFile(fixture.Executed, []byte(name+" "+args), 0600)
		os.Exit(91)
	}
	os.Exit(0)
}

func makeHarnessDiscoveryFixture(t *testing.T, names ...string) (string, string) {
	t.Helper()
	dir := t.TempDir()
	file := filepath.Join(dir, "fixture.json")
	fixture := harnessDiscoveryFixture{CodexAuth: true, ClaudeAuth: false, ClaudeHelp: "  --model <model> Model alias (e.g. 'fable', 'opus', or 'sonnet')\n  --name <name> Name", Executed: filepath.Join(dir, "unexpected-execution")}
	writeHarnessDiscoveryFixture(t, file, fixture)
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		if err = os.WriteFile(filepath.Join(dir, name), body, 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("FLUKE_HARNESS_DISCOVERY_FIXTURE", file)
	t.Setenv("PATH", dir)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(dir, "claude-config"))
	t.Setenv("CODEX_HOME", filepath.Join(dir, "codex-config"))
	return dir, file
}

func writeHarnessDiscoveryFixture(t *testing.T, file string, fixture harnessDiscoveryFixture) {
	t.Helper()
	data, err := json.Marshal(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestHarnessDiscoveryLocalOnlyAndHonestSupport(t *testing.T) {
	dir, _ := makeHarnessDiscoveryFixture(t, "codex", "claude", "droid", "deepseek")
	var foundCodex, foundClaude bool
	for _, h := range detectHarnesses() {
		switch h.ID {
		case "codex":
			h = probeDiscoveredHarness(context.Background(), h)
			if !h.Installed || !h.Usable || !h.AuthKnown || !h.Authenticated || h.RecommendedModel != "" {
				t.Fatalf("bad Codex discovery: %+v", h)
			}
			foundCodex = true
		case "claude":
			h = probeDiscoveredHarness(context.Background(), h)
			if !h.Installed || !h.Usable || !h.AuthKnown || h.Authenticated || h.RecommendedModel != "fable" {
				t.Fatalf("bad Claude discovery: %+v", h)
			}
			foundClaude = true
		case "droid", "deepseek":
			h = probeDiscoveredHarness(context.Background(), h)
			if !h.Installed || h.Usable || h.AuthKnown || h.RecommendedModel != "" {
				t.Fatalf("unsupported CLI became usable: %+v", h)
			}
		case "gemini":
			if h.Installed || h.Usable {
				t.Fatalf("missing CLI became usable: %+v", h)
			}
		}
	}
	if !foundCodex || !foundClaude {
		t.Fatal("missing supported catalog entries")
	}
	if _, err := os.Stat(filepath.Join(dir, "unexpected-execution")); !os.IsNotExist(err) {
		t.Fatal("discovery executed an unsupported CLI or inference")
	}
}

func TestHarnessDiscoveryOmarchyWrapperNeverInstalls(t *testing.T) {
	toolDir, file := makeHarnessDiscoveryFixture(t, "codex", "mise")
	wrapperDir := t.TempDir()
	name := "codex"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	wrapper := filepath.Join(wrapperDir, name)
	if err := os.WriteFile(wrapper, []byte("#!/bin/bash\nmise use -g codex\nexec mise exec -- codex \"$@\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", wrapperDir+string(os.PathListSeparator)+toolDir)
	var codex discoveredHarness
	for _, h := range detectHarnesses() {
		if h.ID == "codex" {
			codex = h
		}
	}
	if codex.Installed || codex.Usable || codex.Executable != wrapper {
		t.Fatalf("installer was counted as installed: %+v", codex)
	}
	missing := probeDiscoveredHarness(context.Background(), codex)
	if missing.Installed || missing.Usable || !strings.Contains(missing.Message, "Instalá") {
		t.Fatalf("missing mise installation was accepted: %+v", missing)
	}
	fixture := harnessDiscoveryFixture{MiseBinary: filepath.Join(toolDir, name), CodexAuth: true, Executed: filepath.Join(toolDir, "unexpected-execution")}
	writeHarnessDiscoveryFixture(t, file, fixture)
	ready := probeDiscoveredHarness(context.Background(), codex)
	if !ready.Installed || !ready.Usable || !ready.Authenticated || ready.Executable != fixture.MiseBinary {
		t.Fatalf("installed mise binary was not resolved: %+v", ready)
	}
	if _, err := os.Stat(fixture.Executed); !os.IsNotExist(err) {
		t.Fatal("mise installer was executed")
	}
}

func TestHarnessDiscoveryRecommendationUsesHealthAndOmarchy(t *testing.T) {
	candidates := []discoveredHarness{
		{ID: "opencode", Name: "OpenCode", Installed: true, AuthKnown: true, Authenticated: true},
		{ID: "codex", Name: "Codex", Installed: true, Usable: true, AuthKnown: true, Authenticated: true},
		{ID: "claude", Name: "Claude Code", Installed: true, Usable: true, AuthKnown: true, Authenticated: true},
	}
	i, _ := recommendHarness(candidates, "codex")
	if i < 0 || candidates[i].ID != "codex" {
		t.Fatal("healthy Omarchy preference was ignored")
	}
	i, _ = recommendHarness(candidates, "opencode")
	if i < 0 || !candidates[i].Usable {
		t.Fatal("unsupported Omarchy default was recommended")
	}
	want := candidates[i].ID
	slices.Reverse(candidates)
	i, _ = recommendHarness(candidates, "opencode")
	if i < 0 || candidates[i].ID != want {
		t.Fatal("catalog order changed equal-health recommendation")
	}
	for n := range candidates {
		if candidates[n].ID == "codex" {
			candidates[n].Authenticated = false
		}
	}
	i, _ = recommendHarness(candidates, "codex")
	if i < 0 || candidates[i].ID != "claude" {
		t.Fatal("logged-out preference beat an authenticated CLI")
	}
	if i, _ := recommendHarness([]discoveredHarness{{ID: "opencode", Name: "OpenCode", Installed: true}}, "opencode"); i != -1 {
		t.Fatal("unavailable/unsupported candidate was recommended")
	}
}

func TestHarnessDiscoveryOmarchyDefaultReadOnlyAndBounded(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	file := filepath.Join(dir, "omarchy", "defaults", "agent")
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ content, want string }{{"codex\n", "codex"}, {"cursor-agent\n", "cursor-agent"}, {"claude\ncodex\n", ""}, {"$(install-something)", ""}, {strings.Repeat("a", 300), ""}} {
		if err := os.WriteFile(file, []byte(test.content), 0600); err != nil {
			t.Fatal(err)
		}
		if got := readOmarchyDefault(); got != test.want {
			t.Fatalf("read default %q, want %q", got, test.want)
		}
		data, err := os.ReadFile(file)
		if err != nil || string(data) != test.content {
			t.Fatal("default was changed")
		}
	}
}

func TestHarnessDiscoveryCodexModelsNoHardcodedVersions(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	file := filepath.Join(dir, "models_cache.json")
	for _, test := range []struct{ cache, want string }{
		{`{"models":[{"slug":"hidden","visibility":"hide","priority":0},{"slug":"arbitrary-future-flagship","visibility":"list","priority":1},{"slug":"small-model","visibility":"list","priority":5}]}`, "arbitrary-future-flagship"},
		{`{"models":[{"slug":"unranked","visibility":"list"}]}`, ""},
		{`{"models":[{"slug":"one","visibility":"list","priority":1},{"slug":"two","visibility":"list","priority":1}]}`, ""},
		{`{"models":[{"slug":"bad\u001b[31m","visibility":"list","priority":0}]}`, ""},
	} {
		if err := os.WriteFile(file, []byte(test.cache), 0600); err != nil {
			t.Fatal(err)
		}
		_, got, reason := discoveredCodexModels()
		if got != test.want || reason == "" {
			t.Fatalf("got %q (%q), want %q", got, reason, test.want)
		}
	}
}

func TestHarnessDiscoveryClaudeHelpAndLocalPolicy(t *testing.T) {
	help := "  --model <model> Alias (e.g. 'fable', 'opus', or 'sonnet')\n  --output-format <format> 'haiku'"
	dir := t.TempDir()
	user := filepath.Join(dir, "settings.json")
	managed := filepath.Join(dir, "managed-settings.json")
	for _, test := range []struct {
		user, managed, want string
		models              []string
	}{
		{`{}`, ``, "fable", []string{"fable", "opus", "sonnet"}},
		{`{"availableModels":["opus","sonnet"]}`, ``, "opus", []string{"opus", "sonnet"}},
		{`{"availableModels":["fable","opus"]}`, `{"availableModels":["sonnet"]}`, "", []string{"sonnet"}},
		{`{}`, `{"availableModels":[]}`, "", nil},
		{`{"availableModels":["opus","claude-opus-future"]}`, ``, "", nil},
		{`{}`, `{"deniedModels":["fable"]}`, "opus", []string{"opus", "sonnet"}},
		{`{`, ``, "", nil},
	} {
		if err := os.WriteFile(user, []byte(test.user), 0600); err != nil {
			t.Fatal(err)
		}
		paths := []claudeModelSettingsPath{{path: user}}
		if test.managed != "" {
			if err := os.WriteFile(managed, []byte(test.managed), 0600); err != nil {
				t.Fatal(err)
			}
			paths = append(paths, claudeModelSettingsPath{path: managed, managed: true})
		}
		models, got, reason := discoveredClaudeModels(help, paths)
		if got != test.want || !slices.Equal(models, test.models) || reason == "" {
			t.Fatalf("got %v / %q (%s), want %v / %q", models, got, reason, test.models, test.want)
		}
	}
	if models, got, _ := discoveredClaudeModels("no model metadata", nil); len(models) > 0 || got != "" {
		t.Fatal("invented models without CLI metadata")
	}
}

func TestHarnessDiscoveryLiveLocalCLIs(t *testing.T) {
	if os.Getenv("FLUKE_LIVE_DISCOVERY") != "1" {
		t.Skip("opt-in installed CLI auth/catalog checks; no inference")
	}
	for _, h := range detectHarnesses() {
		if h.ID != "codex" && h.ID != "claude" {
			continue
		}
		h = probeDiscoveredHarness(context.Background(), h)
		if !h.Installed || !h.Usable || !h.AuthKnown || !h.Authenticated || len(h.Models) == 0 || h.Models[0] != "" || h.ModelReason == "" {
			t.Fatalf("%s is not ready: %s; %s", h.Name, h.Message, h.ModelReason)
		}
		t.Logf("%s %s: authenticated locally; recommended=%q; %d choices", h.Name, h.Version, h.RecommendedModel, len(h.Models))
	}
}
