package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

func createProject(ctx context.Context, path, name string) (string, error) {
	if strings.TrimSpace(name) == "" || utf8.RuneCountInString(name) > 120 || strings.ContainsFunc(name, unicode.IsControl) {
		return "", errors.New("el nombre debe tener entre 1 y 120 caracteres, sin caracteres de control")
	}
	if strings.TrimSpace(path) == "" {
		return "", errors.New("indicá una carpeta nueva para el proyecto")
	}
	destination, err := expandUserPath(path)
	if err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
		return "", err
	}
	if err := os.Mkdir(destination, 0755); err != nil {
		return "", fmt.Errorf("no se pudo crear la carpeta nueva: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if _, err := dependencyGit(ctx, destination, "init", "--initial-branch=main"); err != nil {
		return destination, fmt.Errorf("no se pudo inicializar Git: %w", err)
	}
	args := []string{"-c", "core.hooksPath=" + os.DevNull, "-c", "commit.gpgSign=false"}
	for _, setting := range []struct{ key, fallback string }{{"user.name", "Fluke"}, {"user.email", "fluke@localhost"}} {
		value, err := dependencyGit(ctx, destination, "config", "--get", setting.key)
		if ctx.Err() != nil {
			return destination, ctx.Err()
		}
		if err != nil || strings.TrimSpace(value) == "" {
			args = append(args, "-c", setting.key+"="+setting.fallback)
		}
	}
	args = append(args, "commit", "--allow-empty", "--no-verify", "-m", "Initial commit")
	if _, err := dependencyGit(ctx, destination, args...); err != nil {
		return destination, fmt.Errorf("no se pudo crear el commit inicial: %w", err)
	}
	return destination, nil
}
