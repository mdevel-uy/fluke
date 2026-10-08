package main

import (
	"errors"
	"strings"

	tea "charm.land/bubbletea/v2"
)

var errClipboardUnavailable = errors.New("no hay una herramienta de portapapeles disponible")

type clipboardResult struct {
	Err         error
	ViaTerminal bool
}

// Prefer the local clipboard. OSC52 also reaches a terminal's host over SSH.
func copyToClipboard(text string) tea.Cmd {
	return func() tea.Msg {
		err := copyText(text)
		if errors.Is(err, errClipboardUnavailable) {
			return tea.Sequence(tea.SetClipboard(text), func() tea.Msg {
				return clipboardResult{ViaTerminal: true}
			})()
		}
		return clipboardResult{Err: err}
	}
}

func validateClipboardText(text string) error {
	if strings.ContainsRune(text, 0) {
		return errors.New(uiText("el texto contiene un carácter nulo"))
	}
	if len(text) > 1024*1024 {
		return errors.New(uiText("el texto supera el límite de copia de 1 MiB"))
	}
	return nil
}
