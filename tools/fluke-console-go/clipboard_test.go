package main

import (
	"strings"
	"testing"
)

func TestClipboardTextValidation(t *testing.T) {
	for _, text := range []string{"", "Fluke: ¿listo?\nSí. 🦊", strings.Repeat("a", 1024*1024)} {
		if err := validateClipboardText(text); err != nil {
			t.Fatal(err)
		}
	}
	for _, text := range []string{"a\x00b", strings.Repeat("a", 1024*1024+1)} {
		if err := validateClipboardText(text); err == nil {
			t.Fatal("invalid clipboard text accepted")
		}
	}
}
