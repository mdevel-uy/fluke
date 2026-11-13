package main

import (
	"os"
	"path/filepath"
	"testing"

	tea "charm.land/bubbletea/v2"
)

func setupTestModel(t *testing.T, step int) *model {
	t.Helper()
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	state.Orchestrator = &AgentConfig{Provider: "codex", Executable: "codex", Model: "manual-model", Arguments: []string{}}
	state.Setup = &setupProgress{Step: step}
	m := newModel(store, state, "")
	m.beginSetup("project", false)
	t.Cleanup(func() { m.cleanup(); store.lock.Close() })
	return m
}

func TestSetupManualEditorEscapeAndPaste(t *testing.T) {
	m := setupTestModel(t, 2)
	m.setup.modelEditing = true
	m.Update(tea.PasteMsg{Content: "custom\r\n-model"})
	if m.setup.modelDraft != "custom-model" {
		t.Fatal(m.setup.modelDraft)
	}
	m.setupKey(tea.KeyPressMsg{Code: tea.KeyEscape})
	if m.setup.step != 2 || m.setup.modelEditing {
		t.Fatal("Escape must cancel only the editor")
	}
}

func TestSetupModelWaitsForScanAndAuthentication(t *testing.T) {
	for _, scanning := range []bool{false, true} {
		m := setupTestModel(t, 2)
		m.setup.scanning = scanning
		m.setup.harnesses[0].AuthKnown = true
		m.setupKey(tea.KeyPressMsg{Code: tea.KeyEnter})
		if m.setup.step != 2 {
			t.Fatal("advanced without an authenticated completed scan")
		}
	}
}

func TestSetupRepositoryResultAfterEscapeIsIgnored(t *testing.T) {
	m := setupTestModel(t, 4)
	m.setup.repoBusy = true
	m.setup.repoGeneration = 1
	m.setupKey(tea.KeyPressMsg{Code: tea.KeyBackspace})
	m.Update(tea.PasteMsg{Content: "changed"})
	if m.setup.repoDraft != "project" {
		t.Fatal("edited a busy repository")
	}
	m.setupKey(tea.KeyPressMsg{Code: tea.KeyEscape})
	m.Update(setupRepoResult{generation: 1, draft: "project", repo: t.TempDir()})
	if m.setup.step != 3 || m.repo != "" {
		t.Fatal("stale result advanced setup")
	}
}

func TestSetupResumePreservesManualModel(t *testing.T) {
	m := setupTestModel(t, 2)
	m.setup.harnesses = []discoveredHarness{{ID: "codex", Usable: true, Models: []string{"default"}}}
	m.recommendSetupHarness()
	if m.setup.modelSelected != 1 || m.setup.harnesses[0].Models[1] != "manual-model" {
		t.Fatal("manual model was lost on rescan")
	}
}

func TestSetupFailedSaveDoesNotAdvanceOrChangeLanguage(t *testing.T) {
	m := setupTestModel(t, 0)
	before := uiLanguage()
	if err := os.Mkdir(filepath.Join(m.store.dir, "state.json"), 0700); err != nil {
		t.Fatal(err)
	}
	m.setupKey(tea.KeyPressMsg{Code: tea.KeyEnter})
	m.setupKey(tea.KeyPressMsg{Code: 'l', Mod: tea.ModCtrl})
	if m.setup.step != 0 || uiLanguage() != before {
		t.Fatal("failed persistence changed setup")
	}
}

func TestSetupSignalTicksAcrossStepsAndRescans(t *testing.T) {
	m := setupTestModel(t, 0)
	if cmd := m.setupKey(tea.KeyPressMsg{Code: 'p', Text: "p"}); cmd != nil {
		t.Fatal("removed pause key scheduled another pulse")
	}
	for step := 0; step <= 6; step++ {
		m.setup.step = step
		before := m.setup.frame
		_, cmd := m.Update(setupPulse{generation: m.setup.generation})
		if m.setup.frame != before+1 || cmd == nil {
			t.Fatalf("step %d stopped signal motion", step)
		}
	}
	oldGeneration := m.setup.generation
	m.setup.generation++
	before := m.setup.frame
	if _, cmd := m.Update(setupPulse{generation: oldGeneration}); cmd == nil || m.setup.frame != before {
		t.Fatal("rescan lost the pulse chain or accepted a stale frame")
	}
	m.setup.open = false
	if _, cmd := m.Update(setupPulse{generation: m.setup.generation}); cmd != nil || m.setup.frame != before {
		t.Fatal("signal continued after setup closed")
	}
}

func TestSetupResumesChosenRepositoryBeforeOpeningWorkspace(t *testing.T) {
	m := setupTestModel(t, 6)
	chosen := t.TempDir()
	m.state.Setup.RepoDraft = chosen
	m.state.Setup.LocalOnly = true
	m.beginSetup(t.TempDir(), false)
	if m.setup.step != 4 || m.setup.repoDraft != chosen || !m.setup.githubLocal {
		t.Fatal("resume lost its project or local GitHub choice")
	}
	m.repo = chosen
	m.beginSetup(t.TempDir(), false)
	if m.setup.step != 6 {
		t.Fatal("resume repeated repository selection in the same project")
	}
}
