package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFailedEditKeepsSavedStateAndShowsError(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	repo := t.TempDir()
	state.Decisions = []Decision{{Repo: repo, Question: "Producto?"}}
	m := newModel(store, state, repo)
	defer m.cleanup()
	// A directory at the file's destination forces an actual atomic-replace failure.
	if err = os.Mkdir(filepath.Join(store.dir, "state.json"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{"task Test | acceptance", "limit 9", "decision question", "answer 1 yes"} {
		m.execute(command)
		if !strings.Contains(m.notice, "No se pudo guardar") {
			t.Fatalf("%q reported success: %s", command, m.notice)
		}
		if len(m.state.Tasks) != 0 || m.state.MaxWorkers != 2 || len(m.state.Decisions) != 1 || m.state.Decisions[0].Answer != nil {
			t.Fatalf("%q changed unpersisted state: %+v", command, m.state)
		}
	}
}

func TestSelectedConfigFieldStaysVisibleInShortTerminal(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	m := newModel(store, state, t.TempDir())
	defer m.cleanup()
	m.width = 80
	m.height = 18
	m.field = 4
	if !strings.Contains(m.View().Content, "Máximo de workers") {
		t.Fatal("selected configuration field is hidden")
	}
}
