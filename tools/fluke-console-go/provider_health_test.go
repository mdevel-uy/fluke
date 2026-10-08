package main

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
)

func TestProviderAuthState(t *testing.T) {
	for _, test := range []struct {
		provider, output string
		err              error
		known, loggedIn  bool
	}{
		{"codex", "Logged in using ChatGPT\n", nil, true, true},
		{"codex", "Logged in using an API key - sk-secret", nil, true, true},
		{"codex", "Not logged in", errors.New("exit 1"), true, false},
		{"codex", "Logged in using ChatGPT", errors.New("failed"), false, false},
		{"claude", `{"loggedIn":true,"email":"private","token":"secret"}`, nil, true, true},
		{"claude", `{"loggedIn":false}`, errors.New("exit 1"), true, false},
		{"claude", `{"loggedIn":true}`, errors.New("failed"), false, false},
		{"claude", `{"email":"private"}`, nil, false, false},
		{"claude", "network unavailable", errors.New("failed"), false, false},
	} {
		known, loggedIn := providerAuthState(test.provider, test.output, test.err)
		if known != test.known || loggedIn != test.loggedIn {
			t.Errorf("%s %q: got %v/%v, want %v/%v", test.provider, test.output, known, loggedIn, test.known, test.loggedIn)
		}
	}
}

func TestProviderModelsRespectVisibilityAndPriority(t *testing.T) {
	cache := `{"identity":{"token":"private"},"models":[{"slug":"hidden","visibility":"hide","priority":0},{"slug":"model-b","visibility":"list","priority":2},{"slug":"model-a","visibility":"list","priority":1},{"slug":"model-b","visibility":"list","priority":3},{"slug":"bad\u001b[31m","visibility":"list","priority":0}]}`
	if got := strings.Join(readProviderModelCache(strings.NewReader(cache)), ","); got != "model-a,model-b" {
		t.Fatalf("unexpected safe visible models: %q", got)
	}
	if got := readProviderModelCache(strings.NewReader(`{"models":`)); len(got) != 0 {
		t.Fatalf("invalid cache supplied models: %v", got)
	}
}

func TestProviderMissingExecutableIsActionable(t *testing.T) {
	h := probeProvider(context.Background(), AgentConfig{Provider: "codex", Executable: "fluke-nonexistent-cli-7943783"})
	if h.Available || h.AuthKnown || !strings.Contains(h.Message, "ejecutable") {
		t.Fatalf("unexpected missing CLI status: %+v", h)
	}
}

func TestLiveProviderHealth(t *testing.T) {
	if os.Getenv("FLUKE_LIVE_HEALTH") != "1" {
		t.Skip("opt-in local CLI authentication check; no inference")
	}
	for _, provider := range []string{"codex", "claude"} {
		t.Run(provider, func(t *testing.T) {
			h := probeProvider(context.Background(), AgentConfig{Provider: provider, Executable: provider})
			if !h.Available || !h.AuthKnown || !h.Authenticated || h.Version == "" {
				t.Fatalf("local CLI is not ready: %s", h.Message)
			}
			t.Logf("%s: %s; authenticated; %d model suggestions", provider, h.Version, len(h.Models))
		})
	}
}
