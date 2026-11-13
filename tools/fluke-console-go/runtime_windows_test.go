package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestNpmShimPreservesMultilinePromptWithoutShell(t *testing.T) {
	if _, err := exec.LookPath("node.exe"); err != nil {
		t.Skip("Node unavailable for local argv fixture")
	}
	dir := t.TempDir()
	entry := filepath.Join(dir, "node_modules", "@openai", "codex", "bin", "codex.js")
	if err := os.MkdirAll(filepath.Dir(entry), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, []byte("process.stdout.write(JSON.stringify(process.argv.slice(2)))"), 0600); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(dir, "SHOULD_NOT_EXIST")
	prompt := "Primera línea: ñ 日本語\nSegunda \"comillas\" 'literal' & echo INJECTION > " + marker + "\n$(whoami) %PATH% `literal`"
	for _, extension := range []string{".cmd", ".ps1"} {
		t.Run(extension, func(t *testing.T) {
			shim := filepath.Join(dir, "codex"+extension)
			body := "@echo off\r\nnode.exe \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n"
			if extension == ".ps1" {
				body = "& node.exe \"$basedir/node_modules/@openai/codex/bin/codex.js\" $args"
			}
			if err := os.WriteFile(shim, []byte(body), 0600); err != nil {
				t.Fatal(err)
			}
			config := AgentConfig{Provider: "codex", Executable: shim, Model: "selected", Arguments: []string{"--no-alt-screen"}}
			argv, err := launchArgv(config, prompt)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.EqualFold(filepath.Base(argv[0]), "node.exe") || argv[1] != entry {
				t.Fatalf("npm shim still launches through a shell: %v", argv[:2])
			}
			out, err := exec.Command(argv[0], argv[1:]...).CombinedOutput()
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			if err := json.Unmarshal(out, &got); err != nil {
				t.Fatal(err)
			}
			want := []string{"--no-alt-screen", "--model", "selected", "--", prompt}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("CLI did not receive exact argument boundaries: %q", got)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatal("prompt text executed as a shell command")
			}
		})
	}
}

func TestUnknownWindowsShimRejectsUnsafePrompt(t *testing.T) {
	shim := filepath.Join(t.TempDir(), "other.cmd")
	if err := os.WriteFile(shim, []byte("@echo off\r\necho %*\r\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, prompt := range []string{"first\nsecond", `quoted "text"`} {
		if _, err := launchArgv(AgentConfig{Provider: "codex", Executable: shim}, prompt); err == nil {
			t.Fatal("unknown shim silently accepted an unsafe prompt")
		}
	}
}

func TestClaudeNpmShimResolvesNativeEntry(t *testing.T) {
	dir := t.TempDir()
	entry := filepath.Join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
	if err := os.MkdirAll(filepath.Dir(entry), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, []byte("fixture placeholder; never executed"), 0600); err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(dir, "claude.cmd")
	if err := os.WriteFile(shim, []byte(`"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*`), 0600); err != nil {
		t.Fatal(err)
	}
	prompt := "task\nnew contract"
	argv, err := launchArgv(AgentConfig{Provider: "claude", Executable: shim}, prompt)
	if err != nil || len(argv) != 3 || argv[0] != entry || argv[2] != prompt {
		t.Fatalf("native Claude entry not resolved: %v %v", argv, err)
	}
}
