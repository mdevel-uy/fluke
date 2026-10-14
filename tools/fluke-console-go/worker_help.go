package main

import (
	"errors"
	"strings"
)

// Technical assistance uses the same durable mailbox as human responses.
func (m *model) resolveWorkerHelp(repo string, c orchestratorCommand) (string, error) {
	i := c.DecisionNumber - 1
	if i < 0 || i >= len(m.state.Decisions) {
		return "", errors.New("select a decision_number from context.json")
	}
	d := m.state.Decisions[i]
	if d.Repo != repo || d.TaskID != c.TaskID || !d.Assistance || d.Answer != nil || d.ProposedTitle != "" {
		return "", errors.New("only unanswered technical help from this project's worker can be resolved")
	}
	for _, task := range m.state.Tasks {
		if task.ID != d.TaskID || task.Repo != repo {
			continue
		}
		if task.AgentRun != d.RunID || task.AgentSeq != d.Seq || task.Status != "running" || task.AgentState != "blocked" {
			return "", errors.New("the worker has moved on; read the latest context")
		}
		if err := taskScopeError(m.state, task); err != nil {
			return "", err
		}
		if err := checkTaskSpecs(task, m.state.Goals[repo]); err != nil {
			return "", err
		}
		if task.Paused || m.state.PausedProjects[repo] || !m.sessionAlive(task.ID) {
			return "", errors.New("worker is paused or stopped; do not resume it implicitly")
		}
		for _, pending := range m.state.Decisions {
			if pending.TaskID == task.ID && pending.RunID == task.AgentRun && (pending.Continuation == "pending" || pending.Continuation == "sending" || pending.Continuation == "uncertain") {
				return "", errors.New("another instruction is pending; wait for delivery or human reconciliation")
			}
		}
		next := m.state
		next.Decisions = append([]Decision{}, next.Decisions...)
		if c.Action == "escalate_worker" {
			next.Decisions[i].Assistance = false
		} else {
			answer := strings.TrimSpace(cleanAgentText(c.Answer))
			if answer == "" || len(answer) > 4000 {
				return "", errors.New("answer must contain a technical next step (up to 4000 bytes)")
			}
			next.Decisions[i].Answer = &answer
			next.Decisions[i].AnsweredBy = "fluke"
			next.Decisions[i].Continuation = "pending"
		}
		if !m.saveEdit(next, localText("Fluke coordinated the worker's help request.", "Fluke coordinó el pedido de ayuda del worker.")) {
			return "", errors.New(m.notice)
		}
		return "Saved. The mailbox delivers once the CLI is available; product decisions and permissions remain human.", nil
	}
	return "", errors.New("worker not found")
}
