package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestChannelArgumentIsAbsoluteAndTheOnlyExtraAllowed(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "orchestrations", "run")
	ok := AgentConfig{Provider: "opencode", Executable: "opencode", Arguments: []string{"--channel=" + dir, "--auto-approve"}}
	if err := ok.validateACP(); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"--channel=relative/dir", "--channel=", "--channels=" + dir, "--other=" + dir} {
		cfg := AgentConfig{Provider: "opencode", Executable: "opencode", Arguments: []string{bad}}
		if cfg.validateACP() == nil {
			t.Errorf("%q was accepted", bad)
		}
	}
	argv, err := launchArgv(ok, "prompt")
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(argv[1:], " "); !strings.HasPrefix(got, "--acp-worker opencode --channel="+dir+" --auto-approve -- ") {
		t.Fatalf("%v", argv)
	}
}

func TestChannelDirectoriesGrantOnlyTheirOwnFiles(t *testing.T) {
	root := t.TempDir()
	cwd, channel := filepath.Join(root, "repo"), filepath.Join(root, "state", "orchestrations", "run")
	b := &acpBridge{out: &lockedBuffer{}, cwd: cwd, channels: []string{channel}}
	options := []acpPermissionOption{{"yes", "Allow once", "allow_once"}, {"no", "Reject", "reject_once"}}
	for name, tc := range map[string]struct {
		path string
		want bool
	}{
		"order file in the orchestrator channel": {filepath.Join(channel, "orders.json"), true},
		"worker channel still works":             {filepath.Join(cwd, ".fluke-worker", "state.json"), true},
		"a file of the repo":                     {filepath.Join(cwd, "main.go"), false},
		"a sibling directory of the channel":     {filepath.Join(root, "state", "orchestrations", "other", "x.json"), false},
		"the state file":                         {filepath.Join(root, "state", "state.json"), false},
		"traversal out of the channel":           {filepath.Join(channel, "..", "..", "state.json"), false},
	} {
		_, ok := b.signalChannelOption(acpPermissionRequest{Tool: acpToolCall{Kind: "edit", Title: tc.path}, Options: options})
		if ok != tc.want {
			t.Errorf("%s: granted=%v, want %v", name, ok, tc.want)
		}
	}
}
