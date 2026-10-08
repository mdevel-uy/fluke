//go:build !windows

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

func copyText(text string) error {
	if err := validateClipboardText(text); err != nil {
		return err
	}
	var candidates [][]string
	if runtime.GOOS == "darwin" {
		candidates = append(candidates, []string{"pbcopy"})
	}
	if os.Getenv("WAYLAND_DISPLAY") != "" {
		candidates = append(candidates, []string{"wl-copy"})
	}
	if os.Getenv("DISPLAY") != "" {
		candidates = append(candidates, []string{"xclip", "-selection", "clipboard"}, []string{"xsel", "--clipboard", "--input"})
	}
	for _, args := range candidates {
		path, err := exec.LookPath(args[0])
		if err != nil {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		cmd := exec.CommandContext(ctx, path, args[1:]...)
		cmd.Stdin = strings.NewReader(text)
		err = cmd.Run()
		cancel()
		if err != nil {
			return fmt.Errorf(uiText("copiar con %s: %w"), args[0], err)
		}
		return nil
	}
	return errClipboardUnavailable
}
