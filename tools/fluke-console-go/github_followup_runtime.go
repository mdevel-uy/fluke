package main

import (
	"context"
	"fmt"
	"time"

	tea "charm.land/bubbletea/v2"
)

type githubFollowupTick struct{}
type githubPRWatch struct {
	Publication githubPRPlan
	Snapshot    githubPRFollowup
	AttemptedAt time.Time
}

func (m *model) scheduleGithubFollowup() tea.Cmd {
	if m.githubFollowupTickPending {
		return nil
	}
	for _, task := range m.state.Tasks {
		if task.Publication != nil && task.Publication.Complete {
			m.githubFollowupTickPending = true
			return tea.Tick(30*time.Second, func(time.Time) tea.Msg { return githubFollowupTick{} })
		}
	}
	return nil
}

func (m *model) queryPublishedPR(id string, force bool) tea.Cmd {
	if len(m.githubFollowupCancel) > 0 {
		if force {
			m.notice = localText("PR status refresh in progress.", "Actualización de estado del PR en curso.")
		}
		return nil
	}
	var selected *Task
	var oldest time.Time
	for _, task := range m.state.Tasks {
		if task.Publication == nil || !task.Publication.Complete || id != "" && id != task.ID {
			continue
		}
		watch := m.githubFollowups[task.ID]
		if !sameGithubPRSnapshot(watch.Publication, *task.Publication) {
			watch = githubPRWatch{}
		}
		if !force && !watch.AttemptedAt.IsZero() && time.Since(watch.AttemptedAt) < time.Minute {
			continue
		}
		if selected == nil || watch.AttemptedAt.Before(oldest) {
			selected, oldest = &task, watch.AttemptedAt
		}
	}
	if selected == nil {
		if force {
			m.notice = localText("No published PR to refresh for this task.", "Esta tarea no tiene un PR publicado para actualizar.")
		}
		return nil
	}
	task := *selected
	watch := m.githubFollowups[task.ID]
	if !sameGithubPRSnapshot(watch.Publication, *task.Publication) {
		watch = githubPRWatch{}
	}
	watch.Publication, watch.AttemptedAt, watch.Snapshot.Loading = *task.Publication, time.Now(), true
	if m.githubFollowups == nil {
		m.githubFollowups = map[string]githubPRWatch{}
	}
	m.githubFollowups[task.ID] = watch
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	if m.githubFollowupCancel == nil {
		m.githubFollowupCancel = map[string]context.CancelFunc{}
	}
	m.githubFollowupCancel[task.ID] = cancel
	if force {
		m.notice = localText("Refreshing PR checks, reviews and merge state…", "Actualizando checks, revisiones y estado del PR…")
	}
	return func() tea.Msg { defer cancel(); return readGithubPRFollowupContext(ctx, task) }
}

func (m *model) receiveGithubFollowup(result githubPRFollowupResult) {
	delete(m.githubFollowupCancel, result.TaskID)
	for _, task := range m.state.Tasks {
		if task.ID != result.TaskID {
			continue
		}
		watch := m.githubFollowups[task.ID]
		old := m.githubPRContext(task)
		snapshot, valid := applyGithubPRFollowup(task, watch.Snapshot, result)
		if !valid {
			delete(m.githubFollowups, task.ID)
			return
		}
		watch.Snapshot = snapshot
		m.githubFollowups[task.ID] = watch
		current := m.githubPRContext(task)
		if old == nil && current != nil || old != nil && (current == nil || *old != *current) {
			m.refreshOrchestrators(true)
		}
		return
	}
	delete(m.githubFollowups, result.TaskID)
}

type githubPRStatus struct {
	URL         string `json:"url"`
	State       string `json:"state"`
	Review      string `json:"review"`
	Checks      string `json:"checks"`
	MergeState  string `json:"merge_state"`
	RemoteMerge string `json:"remote_merge_commit,omitempty"`
	Error       string `json:"error,omitempty"`
}

func (m *model) githubPRContext(task Task) *githubPRStatus {
	watch, exists := m.githubFollowups[task.ID]
	if !exists || task.Publication == nil || !task.Publication.Complete || !sameGithubPRSnapshot(watch.Publication, *task.Publication) {
		return nil
	}
	s := watch.Snapshot
	if s.State == "" && s.Error == "" {
		return nil
	}
	status := &githubPRStatus{URL: task.Publication.URL, State: s.State, Review: s.ReviewDecision, Checks: githubPRChecksSummary(s.Checks), MergeState: s.MergeState, Error: s.Error}
	if s.MergeCommit != nil {
		status.RemoteMerge = s.MergeCommit.OID
	}
	return status
}

func (m *model) githubPRStatusText(task Task) string {
	if task.Publication == nil || !task.Publication.Complete {
		return ""
	}
	s := m.githubPRContext(task)
	if s == nil {
		return localText("PR status pending · Ctrl+R refreshes", "Estado del PR pendiente · Ctrl+R actualiza")
	}
	text := fmt.Sprintf("PR #%d · %s", task.Publication.Number, s.State)
	if s.Review != "" {
		text += " · " + s.Review
	}
	text += "\n" + localText("Checks: ", "Checks: ") + s.Checks + " · " + s.MergeState
	if s.State == "MERGED" {
		text += "\n" + localText("Merged on GitHub; local integration is verified separately.", "Integrado en GitHub; la integración local se verifica por separado.")
	}
	if s.Error != "" {
		if s.State == "" {
			text = localText("PR status unavailable. Ctrl+R retries.", "Estado del PR no disponible. Ctrl+R reintenta.")
		} else {
			text += "\n" + localText("Refresh failed; last verified status retained. Ctrl+R retries.", "Falló la consulta; se conserva el último estado verificado. Ctrl+R reintenta.")
		}
	}
	return text
}
