package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
)

func briefIdentity(task Task) string {
	hash := sha256.Sum256([]byte(taskBrief(task)))
	return hex.EncodeToString(hash[:])
}

func readSpec(root, name string, limit int64) ([]byte, error) {
	files, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	defer files.Close()
	f, err := files.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return nil, errors.New(uiText("spec inválida o demasiado grande"))
	}
	return io.ReadAll(io.LimitReader(f, limit+1))
}

func checkTaskSpecs(task Task, goal ProjectGoal) error {
	// Older state has no supervision binding; the next real launch creates it.
	if task.BriefHash == "" {
		return nil
	}
	if task.BriefHash != briefIdentity(task) || task.Worktree == nil {
		return errors.New(uiText("el encargo cambió después de preparar el worker"))
	}
	body := taskBrief(task)
	for _, spec := range []struct{ root, name string }{{task.Repo, ".fluke/specs/" + task.ID + ".md"}, {*task.Worktree, ".fluke-task.md"}} {
		data, err := readSpec(spec.root, spec.name, int64(len(body)))
		if err != nil || string(data) != body {
			return errors.New(uiText("la spec de la tarea fue editada o falta; revisá el alcance y restaurá el brief antes de retomar"))
		}
	}
	if task.GoalID != "" && task.GoalID == goal.ID {
		expected, _ := json.Marshal(goal)
		data, err := readSpec(task.Repo, ".fluke/specs/"+goal.ID+".json", int64(len(expected)+4096))
		var actual ProjectGoal
		decoder := json.NewDecoder(strings.NewReader(string(data)))
		decoder.DisallowUnknownFields()
		if err != nil || decoder.Decode(&actual) != nil || actual != goal || decoder.Decode(&struct{}{}) != io.EOF {
			return errors.New(uiText("la spec del objetivo fue editada o falta; acordá el cambio con Fluke antes de continuar"))
		}
	}
	return nil
}

func (m *model) holdChangedSpec(task Task, reason error) {
	next := m.state
	next.Tasks = append([]Task{}, next.Tasks...)
	for i := range next.Tasks {
		if next.Tasks[i].ID == task.ID {
			next.Tasks[i].Paused, next.Tasks[i].Queued = true, false
			next.Tasks[i].BriefHash = task.BriefHash
			next.Tasks[i].Note = reason.Error()
		}
	}
	saved := m.saveEdit(next, reason.Error())
	if !saved {
		// The file changed independently of approval; stop even if journaling fails.
		m.state = next
	}
	if m.preparingTaskID == task.ID {
		m.cancelPreparing = true
	}
	if m.sessionAlive(task.ID) {
		m.stop(task.ID)
	}
	m.notice = "Tarea pausada: " + reason.Error()
	if m.sessionAlive(task.ID) {
		m.notice += ". No se pudo detener su worker; cupo retenido."
	}
	if !saved {
		m.notice += uiText(". No se pudo guardar la pausa; revisá el almacenamiento antes de retomar.")
	}
}

func (m *model) enforceTaskSpecs() {
	for _, task := range m.state.Tasks {
		if task.Status == "accepted" || task.Paused || !m.sessionAlive(task.ID) {
			continue
		}
		if err := checkTaskSpecs(task, m.state.Goals[task.Repo]); err != nil {
			m.holdChangedSpec(task, err)
		}
	}
}
