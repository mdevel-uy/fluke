package main

import (
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"time"
)

type WorkerUsage struct {
	InputTokens  int64    `json:"input_tokens"`
	OutputTokens int64    `json:"output_tokens"`
	CostUSD      *float64 `json:"cost_usd,omitempty"`
	Source       string   `json:"source"`
}

type RunUsage struct {
	RunID string `json:"run_id"`
	WorkerUsage
}

type TaskMetrics struct {
	Runs       int        `json:"runs,omitempty"`
	Deliveries int        `json:"deliveries,omitempty"`
	Reworks    int        `json:"reworks,omitempty"`
	ObservedMS int64      `json:"observed_ms,omitempty"`
	Usage      []RunUsage `json:"usage,omitempty"`
}

func validUsageNumbers(u WorkerUsage) bool {
	return u.InputTokens >= 0 && u.OutputTokens >= 0 && u.InputTokens <= 1e12 && u.OutputTokens <= 1e12 && (u.CostUSD == nil || !math.IsNaN(*u.CostUSD) && !math.IsInf(*u.CostUSD, 0) && *u.CostUSD >= 0 && *u.CostUSD <= 1e9)
}

func validateWorkerUsage(u WorkerUsage, task Task) error {
	if !validUsageNumbers(u) {
		return errors.New("invalid reported usage")
	}
	if task.Worktree == nil || !filepath.IsLocal(u.Source) {
		return errors.New("usage requires a local evidence file")
	}
	root, err := os.OpenRoot(*task.Worktree)
	if err != nil {
		return err
	}
	defer root.Close()
	info, err := root.Stat(u.Source)
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("usage evidence must be an existing file inside the worktree")
	}
	for _, previous := range task.Metrics.Usage {
		if previous.RunID == task.AgentRun && (u.InputTokens < previous.InputTokens || u.OutputTokens < previous.OutputTokens || previous.CostUSD != nil && (u.CostUSD == nil || *u.CostUSD < *previous.CostUSD)) {
			return errors.New("usage totals cannot decrease within a run")
		}
	}
	return nil
}

func (s TaskMetrics) withUsage(run string, usage WorkerUsage) TaskMetrics {
	s.Usage = append([]RunUsage{}, s.Usage...)
	for i := range s.Usage {
		if s.Usage[i].RunID == run {
			s.Usage[i].WorkerUsage = usage
			return s
		}
	}
	s.Usage = append(s.Usage, RunUsage{run, usage})
	return s
}

type projectMetrics struct {
	Repo                                                               string `json:"repo"`
	Total, Accepted, Integrated, Reviewing, Remaining, Blocked, Queued int
	Runs, Deliveries, Reworks, FirstPass, Reviewed                     int
	ObservedMS, Tokens                                                 int64
	CostUSD                                                            float64
	UsageRuns, CostRuns                                                int
}

func summarizeProject(state State, repo string) projectMetrics {
	s := projectMetrics{Repo: repo}
	for _, t := range state.Tasks {
		if repo != "" && t.Repo != repo {
			continue
		}
		s.Total++
		s.Runs += t.Metrics.Runs
		s.Deliveries += t.Metrics.Deliveries
		s.Reworks += t.Metrics.Reworks
		s.ObservedMS += t.Metrics.ObservedMS
		for _, u := range t.Metrics.Usage {
			s.UsageRuns++
			s.Tokens += u.InputTokens + u.OutputTokens
			if u.CostUSD != nil {
				s.CostUSD += *u.CostUSD
				s.CostRuns++
			}
		}
		if t.Status == "accepted" {
			s.Accepted++
			if t.Integration != nil && t.Integration.MergedCommit != "" {
				s.Integrated++
			}
			// Legacy deliveries have no measured review history.
			if t.Metrics.Deliveries > 0 {
				s.Reviewed++
				if t.Metrics.Reworks == 0 && t.ReviewFeedback == "" {
					s.FirstPass++
				}
			}
		} else if t.Status == "awaiting_review" {
			s.Reviewing++
		} else {
			s.Remaining++
		}
		if t.AgentState == "blocked" || t.AgentState == "needs_response" {
			s.Blocked++
		}
		if t.Queued {
			s.Queued++
		}
	}
	return s
}

func (m *model) portfolioMetrics() []projectMetrics {
	items := make([]projectMetrics, 0, len(m.state.Projects))
	for _, repo := range m.state.Projects {
		items = append(items, summarizeProject(m.state, repo))
	}
	return items
}

// Count only time observed by this console. Downtime is never billed as work.
func (m *model) observeWorkTime(now time.Time) {
	if m.metricsAt.IsZero() {
		m.metricsAt = now
		return
	}
	delta := now.Sub(m.metricsAt)
	m.metricsAt = now
	if delta <= 0 || delta > 5*time.Second {
		return
	}
	for i := range m.state.Tasks {
		t := &m.state.Tasks[i]
		if t.Status == "running" && !t.Paused && !m.state.PausedProjects[t.Repo] && m.sessionAlive(t.ID) && t.AgentState != "blocked" && t.AgentState != "needs_response" && t.AgentState != "idle" && t.AgentState != "turn_finished" {
			t.Metrics.ObservedMS += delta.Milliseconds()
		}
	}
	if m.metricsSaved.IsZero() || now.Sub(m.metricsSaved) >= 30*time.Second {
		if err := m.store.save(m.state); err != nil {
			m.notice = err.Error()
		} else {
			m.metricsSaved = now
		}
	}
}

func metricsDuration(ms int64) string {
	seconds := ms / 1000
	if seconds < 60 {
		return fmt.Sprintf("%ds", seconds)
	}
	if seconds < 3600 {
		return fmt.Sprintf("%dm %02ds", seconds/60, seconds%60)
	}
	return fmt.Sprintf("%dh %02dm", seconds/3600, seconds%3600/60)
}

func metricsContent(s projectMetrics, w int) string {
	if w < 58 {
		quality := localText("No measured reviews", "Sin revisiones medidas")
		if s.Reviewed > 0 {
			quality = fmt.Sprintf(localText("Without rework: %d/%d accepted", "Sin correcciones: %d/%d aceptadas"), s.FirstPass, s.Reviewed)
		}
		usage := localText("Tokens / USD: unavailable", "Tokens / USD: no disponibles")
		if s.UsageRuns > 0 {
			usage = fmt.Sprintf(localText("Reported: %d tokens (%d/%d runs)", "Reportado: %d tokens (%d/%d runs)"), s.Tokens, s.UsageRuns, s.Runs)
		}
		if s.CostRuns > 0 {
			usage += fmt.Sprintf("\nUSD %.4f (%d/%d runs)", s.CostUSD, s.CostRuns, s.Runs)
		} else if s.UsageRuns > 0 {
			usage += localText("\nUSD: unavailable", "\nUSD: no disponibles")
		}
		return wrap(fmt.Sprintf(localText("%d/%d accepted · %d integrated\n%d to do · %d review · %d blocked", "%d/%d aceptadas · %d integradas\n%d faltan · %d revisar · %d bloqueos"), s.Accepted, s.Total, s.Integrated, s.Remaining, s.Reviewing, s.Blocked), w) + "\n" + accent(wrap(fmt.Sprintf(localText("Work: %s · reworks: %d", "Trabajo: %s · correcciones: %d"), metricsDuration(s.ObservedMS), s.Reworks), w), cyan) + "\n" + wrap(quality, w) + "\n" + accent(wrap(usage, w), muted)
	}
	progress := fmt.Sprintf(localText("%d/%d accepted · %d integrated\n%d to do · %d in review · %d blocked", "%d/%d aceptadas · %d integradas\n%d por hacer · %d en revisión · %d bloqueadas"), s.Accepted, s.Total, s.Integrated, s.Remaining, s.Reviewing, s.Blocked)
	quality := localText("First-pass acceptance: no measured reviews yet", "Aceptadas sin correcciones: sin revisiones medidas")
	if s.Reviewed > 0 {
		quality = fmt.Sprintf(localText("Accepted without rework: %d/%d reviewed tasks", "Aceptadas sin correcciones: %d/%d tareas revisadas"), s.FirstPass, s.Reviewed)
	}
	usage := localText("Tokens / USD: unavailable", "Tokens / USD: no disponibles")
	if s.UsageRuns > 0 {
		usage = fmt.Sprintf(localText("Reported tokens: %d (%d/%d runs)", "Tokens reportados: %d (%d/%d ejecuciones)"), s.Tokens, s.UsageRuns, s.Runs)
	}
	if s.CostRuns > 0 {
		usage += fmt.Sprintf(localText("\nReported USD: %.4f (%d/%d runs)", "\nUSD reportados: %.4f (%d/%d ejecuciones)"), s.CostUSD, s.CostRuns, s.Runs)
	}
	if s.UsageRuns > 0 && s.CostRuns == 0 {
		usage += localText("\nUSD: unavailable", "\nUSD: no disponibles")
	}
	return wrap(progress, w) + "\n" + accent(wrap(fmt.Sprintf(localText("Observed work: %s · %d reworks", "Trabajo observado: %s · %d correcciones"), metricsDuration(s.ObservedMS), s.Reworks), w), cyan) + "\n" + wrap(quality, w) + "\n" + accent(wrap(usage, w), muted)
}
