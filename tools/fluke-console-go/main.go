package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/colorprofile"
)

func defaultStateDir() string {
	if p := os.Getenv("LOCALAPPDATA"); runtime.GOOS == "windows" && p != "" {
		return filepath.Join(p, "fluke-console")
	}
	if p := os.Getenv("XDG_STATE_HOME"); p != "" {
		return filepath.Join(p, "fluke-console")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "state", "fluke-console")
}
func run() error {
	_ = setUILanguage("en")
	repo := flag.String("repo", ".", uiText("Repositorio inicial"))
	dir := flag.String("state-dir", defaultStateDir(), uiText("Directorio de estado"))
	monochrome := flag.Bool("no-color", false, uiText("Interfaz sin colores"))
	language := flag.String("lang", "", "Interface language: en or es")
	setup := flag.Bool("setup", false, "Open first-run setup")
	flag.Parse()
	initial, err := expandUserPath(*repo)
	if err != nil {
		return err
	}
	root, _ := repoPath(initial)
	absolute, err := filepath.Abs(*dir)
	if err != nil {
		return err
	}
	store, state, err := openStore(absolute)
	if err != nil {
		return err
	}
	defer store.lock.Close()
	chosenLanguage := *language
	if chosenLanguage == "" {
		chosenLanguage = state.Language
	}
	if chosenLanguage == "" {
		chosenLanguage = "en"
	}
	if err := setUILanguage(chosenLanguage); err != nil {
		return err
	}
	state.Language = chosenLanguage
	found := false
	for _, p := range state.Projects {
		if p == root {
			found = true
		}
	}
	if !found && root != "" {
		state.Projects = append(state.Projects, root)
	}
	if err = store.save(state); err != nil {
		return err
	}
	m := newModel(store, state, root)
	if *setup || root == "" || state.Orchestrator == nil || state.Setup != nil && !state.Setup.Complete {
		m.beginSetup(initial, *setup)
	}
	defer m.cleanup()
	// Fluke is a color TUI. Agent runners may export NO_COLOR=1 even when the
	// program is launched later in Windows Terminal; don't inherit that into
	// its own design. The explicit flag still provides a monochrome option.
	profile := colorprofile.TrueColor
	if *monochrome {
		profile = colorprofile.NoTTY
	}
	_, err = tea.NewProgram(m, tea.WithFPS(30), tea.WithColorProfile(profile)).Run()
	return err
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
