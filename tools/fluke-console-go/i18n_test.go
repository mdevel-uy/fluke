package main

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

func TestUILanguageSelection(t *testing.T) {
	previous := uiLanguage()
	t.Cleanup(func() { _ = setUILanguage(previous) })
	for _, test := range []struct{ code, want string }{
		{"en", "GOAL"},
		{"es", "OBJETIVO"},
		{"en", "GOAL"},
	} {
		if err := setUILanguage(test.code); err != nil {
			t.Fatal(err)
		}
		if uiLanguage() != test.code || uiText("OBJETIVO") != test.want {
			t.Fatalf("language %q: code=%q text=%q", test.code, uiLanguage(), uiText("OBJETIVO"))
		}
	}
	for _, code := range []string{"", "fr", "EN", " en ", "en-US", "\x00"} {
		if err := setUILanguage(code); err == nil {
			t.Fatalf("accepted unsupported language %q", code)
		}
		if uiLanguage() != "en" {
			t.Fatalf("invalid language %q changed the selected language", code)
		}
	}
}

func TestUITextFallbackIsExact(t *testing.T) {
	previous := uiLanguage()
	t.Cleanup(func() { _ = setUILanguage(previous) })
	for _, code := range []string{"en", "es"} {
		_ = setUILanguage(code)
		for _, text := range []string{"", "My task: arreglar OBJETIVO", "\x1b[31mcontenido propio\x1b[0m", "日本語\n🙂", "%s %d {model}"} {
			if got := uiText(text); got != text {
				t.Fatalf("%s changed uncatalogued text: %q → %q", code, text, got)
			}
		}
	}
	_ = setUILanguage("es")
	for original := range uiEnglish {
		if got := uiText(original); got != original {
			t.Fatalf("Spanish text changed: %q → %q", original, got)
		}
	}
}

func TestUITextCatalogPreservesFormats(t *testing.T) {
	directive := regexp.MustCompile(`%([-+# 0]*)(\d+|\*)?(\.\d+|\.\*)?([a-zA-Z%])`)
	for original, translated := range uiEnglish {
		if original == "" || translated == "" {
			t.Fatalf("empty catalogue entry: %q → %q", original, translated)
		}
		if !reflect.DeepEqual(directive.FindAllString(original, -1), directive.FindAllString(translated, -1)) {
			t.Errorf("format directives changed: %q → %q", original, translated)
		}
		if strings.Count(original, "\n") != strings.Count(translated, "\n") {
			t.Errorf("line breaks changed: %q → %q", original, translated)
		}
		if strings.Count(original, "{model}") != strings.Count(translated, "{model}") {
			t.Errorf("model placeholder changed: %q → %q", original, translated)
		}
	}
	previous := uiLanguage()
	t.Cleanup(func() { _ = setUILanguage(previous) })
	_ = setUILanguage("en")
	if got := fmt.Sprintf(uiText("GitHub: %s · %d issues abiertas (máximo 50)."), "owner/repo", 12); got != "GitHub: owner/repo · 12 open issues (maximum 50)." {
		t.Fatalf("formatted translation = %q", got)
	}
}

func TestEnglishConversationPreservesUserSpanish(t *testing.T) {
	previous := uiLanguage()
	t.Cleanup(func() { _ = setUILanguage(previous) })
	_ = setUILanguage("en")
	initial := newModel(nil, State{}, "example")
	if initial.notice != "Tell me what you want to achieve. Fluke prepares the plan and coordinates the work." {
		t.Fatalf("initial UI message lost its language or encoding: %q", initial.notice)
	}
	repo := "example"
	userText := "OBJETIVO: revisar DESCRIPCIÓN y archivos nuevos"
	m := model{repo: repo, terminals: &windowManager{}, state: State{Conversations: map[string][]ConversationMessage{repo: {{Role: "user", Text: userText}}}}}
	rendered := m.conversation(110, 26, false)
	if !strings.Contains(rendered, userText) {
		t.Fatalf("user-authored Spanish changed: %q", rendered)
	}
	if !strings.Contains(rendered, "Talk to Fluke") || strings.Contains(rendered, "Hablá con Fluke") {
		t.Fatalf("conversation chrome is not English: %q", rendered)
	}
	state, hint := m.sessionSummary()
	if state != "NO SESSION" || !strings.Contains(hint, "Enter starts Fluke") {
		t.Fatalf("session summary is not English: %q / %q", state, hint)
	}
}

func TestUILanguageToggleRequiresSavedState(t *testing.T) {
	previous := uiLanguage()
	t.Cleanup(func() { _ = setUILanguage(previous) })
	_ = setUILanguage("es")
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	m := newModel(store, state, t.TempDir())
	defer m.cleanup()
	_ = setUILanguage("es")
	m.toggleUILanguage()
	if uiLanguage() != "en" || m.state.Language != "en" {
		t.Fatalf("language selection was not persisted: locale=%s state=%s", uiLanguage(), m.state.Language)
	}
	if err := os.Remove(filepath.Join(store.dir, "state.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(store.dir, "state.json"), 0700); err != nil {
		t.Fatal(err)
	}
	m.toggleUILanguage()
	if uiLanguage() != "en" || m.state.Language != "en" {
		t.Fatal("failed persistence changed the interface language")
	}
}
