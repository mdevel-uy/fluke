//go:build !windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestClipboardNativeToolReceivesUnicode(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	t.Setenv("WAYLAND_DISPLAY", "")
	t.Setenv("DISPLAY", ":fluke-test")
	if runtime.GOOS != "darwin" {
		if err := copyText("test"); !errors.Is(err, errClipboardUnavailable) {
			t.Fatalf("expected terminal fallback, got %v", err)
		}
	}
	tool := "xclip"
	if runtime.GOOS == "darwin" {
		tool = "pbcopy"
	}
	output := filepath.Join(dir, "copied.txt")
	t.Setenv("FLUKE_CLIPBOARD_TEST_OUTPUT", output)
	if err := os.WriteFile(filepath.Join(dir, tool), []byte("#!/bin/sh\n/bin/cat > \"$FLUKE_CLIPBOARD_TEST_OUTPUT\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	text := "Fluke — ¿listo?\nSí. 🦊"
	if err := copyText(text); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(output)
	if err != nil || string(got) != text {
		t.Fatalf("native tool stdin mismatch: %q, %v", got, err)
	}
}
