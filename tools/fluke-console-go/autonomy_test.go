package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

func TestAutonomousFlukeConfigPreservesWorkerDefaults(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		t.Run(provider, func(t *testing.T) {
			args := []string{"--no-daemon", "-a", "on-request", "--sandbox=workspace-write"}
			if provider == "claude" {
				args = []string{"--permission-mode=auto", "--settings", `{"env":{"KEEP":"yes"}}`, "--no-chrome"}
			}
			a := AgentConfig{Provider: provider, Executable: provider, Model: "chosen", Arguments: args}
			original := append([]string{}, args...)
			configured, err := autonomousFlukeConfig(a, `C:\New Project`)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(a.Arguments, original) || a.Model != configured.Model {
				t.Fatal("worker defaults mutated")
			}
			joined := strings.Join(configured.Arguments, " ")
			if strings.Contains(joined, "on-request") || strings.Contains(joined, "workspace-write") || strings.Contains(joined, "permission-mode=auto") {
				t.Fatal("conflicting permission mode", joined)
			}
			if provider == "claude" && (!strings.Contains(joined, `"KEEP":"yes"`) || !strings.Contains(joined, `"skipDangerousModePermissionPrompt":true`)) {
				t.Fatal("lost settings or first-start acknowledgement")
			}
			if provider == "codex" && !strings.Contains(joined, "--dangerously-bypass-approvals-and-sandbox") {
				t.Fatal("missing Codex mode")
			}
		})
	}
	if _, err := autonomousFlukeConfig(AgentConfig{Provider: "custom"}, "repo"); err == nil {
		t.Fatal("invented unsupported provider flags")
	}
}

func TestAutonomousTrustIsOnlyForExactStartupWorkspace(t *testing.T) {
	for _, tc := range []struct{ provider, screen string }{
		{"claude", "Accessing workspace:\nC:/Project\n1. Yes, I trust this folder"},
		{"codex", "C:/Project\nTrust this folder?\n1. Trust and continue"},
	} {
		if !startupTrustPrompt(tc.provider, `C:\Project`, tc.screen) {
			t.Fatal("valid startup trust not recognized")
		}
		if startupTrustPrompt(tc.provider, `C:\Other`, tc.screen) || startupTrustPrompt(tc.provider, `C:\Project`, "C:/Project\nDo you want to proceed?\n1. Yes") {
			t.Fatal("unrelated permission was auto-approved")
		}
		if startupTrustPrompt(tc.provider, `C:\Pro`, tc.screen) || startupTrustPrompt(tc.provider, `C:\Pro ject`, tc.screen) {
			t.Fatal("matched a different directory sharing a prefix or spacing")
		}
	}
}

func TestAutonomousSettingPersistsAndCancelDoesNotApply(t *testing.T) {
	m := projectTestModel(t)
	m.openConfig()
	m.Update(tea.KeyPressMsg{Code: 'a', Mod: tea.ModCtrl})
	if !m.draftAutonomous || m.state.AutonomousFluke {
		t.Fatal("toggle applied without save")
	}
	m.openConfig()
	if m.draftAutonomous {
		t.Fatal("cancel didn't restore saved choice")
	}
	m.draftAutonomous = true
	if err := m.saveConfig(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(m.store.dir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	var saved State
	if err = json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if !saved.AutonomousFluke {
		t.Fatal("autonomy not saved")
	}
}
