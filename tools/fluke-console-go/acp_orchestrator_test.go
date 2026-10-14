package main

import (
	"context"
	"strings"
	"testing"
)

func acpOrchestratorModel(t *testing.T) *model {
	t.Helper()
	m := projectTestModel(t)
	repo := testRepo(t)
	m.repo, m.home, m.view, m.pane = repo, false, 1, 1
	m.state.Projects = []string{repo}
	m.state.Orchestrator = &AgentConfig{Provider: "opencode", Executable: "opencode", Arguments: []string{}}
	return m
}

func TestOrchestratorOverACPLaunchesTheBridgeWithTheContractPrompt(t *testing.T) {
	m := acpOrchestratorModel(t)
	cmd := m.start("")
	if cmd == nil {
		t.Fatalf("no launch; notice=%q", m.notice)
	}
	res, ok := cmd().(launchResult)
	if !ok || res.err != nil {
		t.Fatalf("%#v", res)
	}
	argv := res.argv
	if len(argv) != 5 || argv[1] != "--acp-worker" || argv[2] != "opencode" || argv[3] != "--" {
		t.Fatalf("%v", argv)
	}
	if !strings.Contains(argv[4], "contract.md") || res.provider != "opencode" || res.nativeSession != nil {
		t.Fatalf("prompt/provider/session: %q %q %v", argv[4], res.provider, res.nativeSession)
	}
}

func TestAutonomousFlukeAutoApprovesOnlyForACPWhenAsked(t *testing.T) {
	m := acpOrchestratorModel(t)
	m.state.AutonomousFluke = true
	res := m.start("")().(launchResult)
	if res.err != nil {
		t.Fatal(res.err)
	}
	if got := strings.Join(res.argv[1:5], " "); got != "--acp-worker opencode --auto-approve --" {
		t.Fatalf("%v", res.argv)
	}
	m = acpOrchestratorModel(t)
	res = m.start("")().(launchResult)
	for _, arg := range res.argv {
		if arg == "--auto-approve" {
			t.Fatal("approval must stay off unless autonomous Fluke is on")
		}
	}
}

func TestACPAgentsAcceptNoArbitraryArguments(t *testing.T) {
	for _, args := range [][]string{{"--yolo"}, {"--model", "x"}, {"--auto-approve", "--other"}} {
		if err := (AgentConfig{Provider: "opencode", Executable: "opencode", Arguments: args}).validateACP(); err == nil {
			t.Fatalf("%v was accepted", args)
		}
	}
	if err := (AgentConfig{Provider: "opencode", Executable: "opencode", Arguments: []string{"--auto-approve"}}).validateACP(); err != nil {
		t.Fatal(err)
	}
}

func TestBridgeAutoApproveGrantsOnlyAnAllowOnceOption(t *testing.T) {
	b := &acpBridge{out: &lockedBuffer{}, autoApprove: true}
	id, ok := b.handlePermission(acpPermissionRequest{Tool: acpToolCall{Title: "Edit file"}, Options: []acpPermissionOption{
		{"always", "Always", "allow_always"}, {"once", "Once", "allow_once"}, {"no", "Reject", "reject_once"},
	}})
	if !ok || id != "once" {
		t.Fatalf("%q %v", id, ok)
	}
}

func TestProviderChoiceIncludesOpenCodeAndProbeNeedsNoModel(t *testing.T) {
	m := projectTestModel(t)
	m.draft[0] = "claude"
	m.cycleProvider(false)
	if m.draft[0] != "opencode" {
		t.Fatalf("provider after claude: %q", m.draft[0])
	}
	t.Setenv("PATH", t.TempDir())
	h := probeProvider(context.Background(), AgentConfig{Provider: "opencode", Executable: "opencode"})
	if h.Available || h.Message == "" {
		t.Fatalf("%+v", h)
	}
	if err := (AgentConfig{Provider: "opencode", Executable: "opencode", Model: "x"}).validateACP(); err == nil {
		t.Fatal("a model must be refused: ACP agents choose theirs")
	}
}

func TestOpenCodeIsStartedAskingForEditsAndCommands(t *testing.T) {
	env := acpAgentEnv("opencode", false, []string{"PATH=x"})
	if len(env) != 2 || !strings.Contains(env[1], `"edit":"ask"`) || !strings.Contains(env[1], `"bash":"ask"`) {
		t.Fatalf("%v", env)
	}
	if acpAgentEnv("opencode", true, []string{"PATH=x"}) != nil {
		t.Fatal("autonomous Fluke must not force questions")
	}
	if acpAgentEnv("opencode", false, []string{"OPENCODE_CONFIG_CONTENT={}"}) != nil {
		t.Fatal("the person's own inline configuration must win")
	}
	if acpAgentEnv("gemini", false, nil) != nil {
		t.Fatal("only OpenCode is configured this way")
	}
}
