package main

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

func TestApplyModelUsesNewProviderAndKeepsProjectContext(t *testing.T) {
	repo := testRepo(t)
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	state.Orchestrator = &AgentConfig{Provider: "codex", Executable: "codex"}
	_ = state.setGoal(repo, "Objetivo acordado", "Un resultado verificable")
	state = withConversation(state, repo, ConversationMessage{Role: "human", Text: "conservar este contexto"})
	m := newModel(store, state, repo)
	defer m.cleanup()
	m.openConfig()
	m.draft = [5]string{"claude", "claude", "sonnet", "[]", "3"}
	cmd := m.applyConfig()
	if cmd == nil {
		t.Fatal(m.notice)
	}
	batch := cmd().(tea.BatchMsg)
	launch := batch[0]().(launchResult)
	if launch.err != nil {
		t.Fatal(launch.err)
	}
	argv := strings.Join(launch.argv, " ")
	if launch.config.Model != "sonnet" || launch.provider != "claude" || !strings.Contains(argv, "--model") || !strings.Contains(argv, "sonnet") {
		t.Fatalf("el modelo elegido no llega a la CLI: %+v", launch)
	}
	if m.state.Goals[repo].ID != state.Goals[repo].ID || m.state.Conversations[repo][0].Text != "conservar este contexto" || m.state.MaxWorkers != 3 {
		t.Fatal("aplicar un modelo perdió el proyecto o la configuración")
	}
	m.providerGeneration = 2
	m.Update(providerHealthResult{generation: 1, health: providerHealth{Provider: "codex", Authenticated: true}})
	if m.provider.Authenticated {
		t.Fatal("comprobación vieja reemplazó la conexión del proveedor nuevo")
	}
}

func TestApplyConfigCancelsChatWaitingAtPermissionDialog(t *testing.T) {
	for _, writing := range []bool{false, true} {
		t.Run(map[bool]string{false: "queued", true: "writing"}[writing], func(t *testing.T) {
			repo := testRepo(t)
			store, state, err := openStore(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer store.lock.Close()
			state.Orchestrator = &AgentConfig{Provider: "claude", Executable: "claude"}
			m := newModel(store, state, repo)
			defer m.cleanup()
			pauseTestWindow(t, m, "fluke:"+repo)
			w := m.terminalFor("fluke:" + repo)
			w.consumeOutput([]byte("Yes, I trust this folder\r\nEnter to confirm"))
			m.orchestration[repo] = &orchestratorSession{RunID: "waiting", Provider: "claude", Dir: t.TempDir()}
			m.sendChat("Conservá este pedido")
			s := m.orchestration[repo]
			if !s.ChatSending || s.ChatWriting {
				t.Fatal("chat did not wait at the permission dialog")
			}
			s.ChatWriting = writing
			m.openConfig()
			m.draft = [5]string{"codex", "codex", "", "[]", "2"}
			cmd := m.applyConfig()
			if writing {
				if cmd != nil || !m.sessionAlive("fluke:"+repo) || m.state.Orchestrator.Provider != "claude" {
					t.Fatal("configuration interrupted an in-flight write")
				}
				return
			}
			if cmd == nil || m.sessionAlive("fluke:"+repo) || m.state.Orchestrator.Provider != "codex" {
				t.Fatal("a queued chat prevented changing provider", m.notice)
			}
			message := m.state.Conversations[repo][0]
			if message.Text != "Conservá este pedido" || message.Delivery != "uncertain" {
				t.Fatal("restart lost or automatically redelivered the pending message")
			}
			if _, exists := m.orchestration[repo]; exists {
				t.Fatal("old orchestration queue survived restart")
			}
		})
	}
}
