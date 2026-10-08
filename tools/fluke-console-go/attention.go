package main

import "strings"

type attentionItem struct {
	Kind, Repo, TaskID, SessionKey string
	DecisionIndex                  int
	Summary                        string
}

// Enumeration reads current state only; it never consumes reports or saves state.
func (m *model) attentionItems() []attentionItem {
	var items []attentionItem
	decisions := map[string]bool{}
	sources := map[string]bool{}
	for i, d := range m.state.Decisions {
		if d.Answer != nil {
			continue
		}
		source := d.Repo + "\x00" + d.TaskID + "\x00" + d.RunID
		key := source + "\x00" + d.Question
		if decisions[key] {
			continue
		}
		decisions[key], sources[source] = true, true
		items = append(items, attentionItem{Kind: "decision", Repo: d.Repo, TaskID: d.TaskID, DecisionIndex: i, Summary: attentionSummary(d.Question)})
	}
	for _, t := range m.state.Tasks {
		if t.Status == "awaiting_review" && !t.Paused {
			items = append(items, attentionItem{Kind: "delivery", Repo: t.Repo, TaskID: t.ID, DecisionIndex: -1, Summary: status(taskAgentStatus(t)) + " · " + attentionSummary(t.AgentMessage)})
			continue
		}
		if t.Status != "running" || t.Paused || sources[t.Repo+"\x00"+t.ID+"\x00"+t.AgentRun] {
			continue
		}
		item := attentionItem{Kind: "report", Repo: t.Repo, TaskID: t.ID, DecisionIndex: -1, Summary: attentionSummary(t.AgentMessage)}
		if t.AgentState == "needs_response" || (t.AgentState == "blocked" && t.AgentSeq > 0) {
			if item.Summary == "" {
				item.Summary = localText("Worker needs your response", "El worker necesita tu respuesta")
			}
			items = append(items, item)
			continue
		}
		if summary, blocked := m.nativeAttention(t.ID, t.AgentProvider); blocked {
			item.Kind, item.SessionKey, item.Summary = "native", t.ID, summary
			items = append(items, item)
		}
	}
	for _, repo := range m.state.Projects {
		s := m.orchestration[repo]
		if s == nil || sources[repo+"\x00\x00"+s.RunID] {
			continue
		}
		key := "fluke:" + repo
		if summary, blocked := m.nativeAttention(key, s.Provider); blocked {
			items = append(items, attentionItem{Kind: "native", Repo: repo, SessionKey: key, DecisionIndex: -1, Summary: summary})
		}
	}
	for _, task := range m.state.Tasks {
		status := m.githubPRContext(task)
		if status == nil {
			continue
		}
		if status.Error != "" || status.Checks == "failed" || status.Review == "CHANGES_REQUESTED" || status.State == "CLOSED" {
			items = append(items, attentionItem{Kind: "github", Repo: task.Repo, TaskID: task.ID, DecisionIndex: -1, Summary: attentionSummary(m.githubPRStatusText(task))})
		}
	}
	return items
}

func (m *model) nativeAttention(key, provider string) (string, bool) {
	if m.terminals == nil {
		return "", false
	}
	w := m.terminalFor(key)
	if w == nil || w.ProcessExited() || w.screen == nil {
		return "", false
	}
	title, screen := w.agentSignals()
	if detectAgentState(provider, title, screen) != "blocked" {
		return "", false
	}
	if claudeTrustPending(provider, screen) {
		return localText("Claude is waiting for folder trust confirmation", "Claude espera que confirmes la confianza de la carpeta"), true
	}
	if limit := providerLimitMessage(provider, screen); limit != "" {
		return attentionSummary(limit), true
	}
	return localText("Native CLI needs permission or a response", "La CLI necesita autorización o una respuesta"), true
}

func attentionSummary(text string) string {
	text = strings.Join(strings.Fields(cleanAgentText(text)), " ")
	runes := []rune(text)
	if len(runes) > 180 {
		return string(runes[:179]) + "…"
	}
	return text
}

func (m *model) openAttention(index int) bool {
	items := m.attentionItems()
	if index < 0 || index >= len(items) {
		return false
	}
	item := items[index]
	m.closePanels()
	m.home = false
	m.repo, m.selected, m.pane = item.Repo, 0, 0
	switch item.Kind {
	case "decision":
		m.view = 3
		for i, d := range m.state.Decisions {
			if i == item.DecisionIndex {
				break
			}
			if d.Repo == item.Repo {
				m.selected++
			}
		}
	case "native":
		m.view = 2
		m.focus(item.SessionKey)
	default:
		m.view = 1
		for i, task := range m.projectTasks() {
			if task.ID == item.TaskID {
				m.selected = i
				break
			}
		}
	}
	return true
}
