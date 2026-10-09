package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func TestBriefIsReadableInFlukeWithoutAnotherChat(t *testing.T) {
	m := projectTestModel(t)
	m.repo, m.home, m.view, m.pane, m.width, m.height = t.TempDir(), false, 1, 1, 140, 36
	m.state.DraftGoals = map[string]GoalDraft{m.repo: {Title: "Delivery app", Acceptance: "Save clients and orders; optimize routes; open Waze", OpenQuestions: "Notes or products? Which devices?"}}
	m.state.Conversations = map[string][]ConversationMessage{m.repo: {{Role: "human", Text: "CHAT_ONLY_SENTINEL"}}}
	m.chatDraft[m.repo] = "Keep my draft"
	m.Update(tea.KeyPressMsg{Code: tea.KeyF4})
	text := ansi.Strip(m.View().Content)
	for _, part := range []string{"Delivery app", "Save clients and orders", "Notes or products?"} {
		if !strings.Contains(text, part) {
			t.Fatalf("brief not visible: %q", text)
		}
	}
	if strings.Contains(text, "CHAT_ONLY_SENTINEL") || strings.Contains(text, "Keep my draft") {
		t.Fatal("F4 still duplicates the chat")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
	m.Update(tea.PasteMsg{Content: "must not edit chat"})
	if m.chatDraft[m.repo] != "Keep my draft" {
		t.Fatal("F4 changed the chat draft")
	}
	m.Update(tea.KeyPressMsg{Code: 'c', Text: "c"})
	if m.view != 1 || m.pane != 1 || m.chatDraft[m.repo] != "Keep my draft" {
		t.Fatal("C did not return to the same chat")
	}
	m.chatDraft[m.repo] = "ver brief"
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if m.view != 3 || m.pane != 0 || m.chatDraft[m.repo] != "" {
		t.Fatal("chat cannot open brief directly")
	}
}

func TestLongBriefScrollsAndRenderingDoesNotEditState(t *testing.T) {
	m := projectTestModel(t)
	m.repo, m.home, m.width, m.height = t.TempDir(), false, 76, 28
	lines := []string{}
	for i := 0; i < 120; i++ {
		lines = append(lines, fmt.Sprintf("REQUISITO_%03d", i))
	}
	m.state.DraftGoals = map[string]GoalDraft{m.repo: {Title: "Draft", Acceptance: strings.Join(lines, "\n"), OpenQuestions: "LAST_QUESTION"}}
	before, _ := json.Marshal(m.state)
	m.Update(tea.KeyPressMsg{Code: tea.KeyF4})
	if !strings.Contains(ansi.Strip(m.View().Content), "REQUISITO_000") {
		t.Fatal("start of brief hidden")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnd})
	if !strings.Contains(ansi.Strip(m.View().Content), "LAST_QUESTION") {
		t.Fatal("cannot reach end of brief")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyHome})
	if !strings.Contains(ansi.Strip(m.View().Content), "REQUISITO_000") {
		t.Fatal("cannot return to start")
	}
	after, _ := json.Marshal(m.state)
	if string(before) != string(after) {
		t.Fatal("reading brief mutated persistent state")
	}
}

func TestDecisionHistoryLinksToSameChatAndPreservesTarget(t *testing.T) {
	m := projectTestModel(t)
	m.repo, m.home = t.TempDir(), false
	m.state.Decisions = []Decision{{Repo: m.repo, Question: "Which routing service?"}}
	m.Update(tea.KeyPressMsg{Code: tea.KeyF4})
	m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
	m.Update(tea.KeyPressMsg{Code: 'd', Mod: tea.ModCtrl})
	if m.view != 1 || m.pane != 1 || m.reviewedChatDecision() != 0 {
		t.Fatal("decision did not open in F2")
	}
	m.Update(tea.PasteMsg{Content: "Google Maps"})
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if m.state.Decisions[0].Answer == nil || *m.state.Decisions[0].Answer != "Google Maps" {
		t.Fatal("response lost decision binding")
	}
}
