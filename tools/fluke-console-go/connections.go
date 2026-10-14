package main

import (
	"context"
	"fmt"
	"os/exec"
	"sort"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// Connections and consumption (F5 → Conexión in the shell). Everything shown
// here is either read locally (PATH, the CLIs' own status commands) or reported
// by workers; a figure nobody reported is "sin dato", never zero. Fluke does not
// query subscription quotas yet, and the screen says so.

type connectionProbeResult struct {
	generation uint64
	provider   string
	health     providerHealth
}

// Probes every installed CLI that has an adapter. Local checks only: no model
// requests and no tokens are spent.
func (m *model) probeConnections() tea.Cmd {
	if m.store == nil {
		return nil
	}
	m.connGeneration++
	generation := m.connGeneration
	var cmds []tea.Cmd
	for _, h := range detectHarnesses() {
		if !h.Usable {
			continue
		}
		config := AgentConfig{Provider: h.ID, Executable: h.ID}
		if o := m.state.Orchestrator; o != nil && o.Provider == h.ID && strings.TrimSpace(o.Executable) != "" {
			config.Executable = o.Executable
		}
		cmds = append(cmds, func() tea.Msg {
			return connectionProbeResult{generation, h.ID, probeProvider(context.Background(), config)}
		})
	}
	return tea.Batch(cmds...)
}

func (m *model) receiveConnectionProbe(r connectionProbeResult) {
	if r.generation != m.connGeneration {
		return
	}
	if m.connHealth == nil {
		m.connHealth = map[string]providerHealth{}
	}
	m.connHealth[r.provider] = r.health
}

// Sign-in is handed to the selected provider's own CLI, as in the Agent form.
func (m *model) loginConnection() tea.Cmd {
	entries := m.connectionEntries()
	if m.connSelected <= 0 || m.connSelected >= len(entries) {
		return nil
	}
	h := entries[m.connSelected]
	if !h.Usable {
		m.notice = localText("Fluke has no adapter for this CLI yet; sign in with its own command.", "Fluke todavía no tiene adaptador para esta CLI; iniciá sesión con su propio comando.")
		return nil
	}
	a := AgentConfig{Provider: h.ID, Executable: h.ID, Arguments: []string{"login"}}
	if h.ID == "claude" {
		a.Arguments = []string{"auth", "login"}
	}
	argv, err := launchArgv(a, "")
	if err != nil {
		m.notice = uiText("No se pudo abrir el login: ") + err.Error()
		return nil
	}
	return tea.ExecProcess(exec.Command(argv[0], argv[1:]...), func(err error) tea.Msg { return providerLoginResult{err} })
}

// Entry 0 of the list is the summary; the rest are the CLIs found on this machine.
func (m *model) connectionEntries() []discoveredHarness {
	entries := []discoveredHarness{{ID: "", Name: localText("Summary", "Resumen")}}
	for _, h := range detectHarnesses() {
		if h.Installed || h.Executable != "" {
			entries = append(entries, h)
		}
	}
	return entries
}

type usageRow struct {
	provider, model string
	runs            int
	tokens          int64
	cost            float64
	tokenRuns       int
	costRuns        int
	tasks           int
}

// Aggregates what workers reported, per provider and model, across all projects.
func (m *model) usageRows() []usageRow {
	byKey := map[string]*usageRow{}
	for _, t := range m.state.Tasks {
		provider, model := t.AgentProvider, ""
		if c := t.WorkerConfig; c != nil {
			if c.Provider != "" {
				provider = c.Provider
			}
			model = c.Model
		}
		if provider == "" {
			provider = "—"
		}
		key := provider + "\x00" + model
		row := byKey[key]
		if row == nil {
			row = &usageRow{provider: provider, model: model}
			byKey[key] = row
		}
		row.tasks++
		for _, u := range t.Metrics.Usage {
			row.runs++
			row.tokenRuns++
			row.tokens += u.InputTokens + u.OutputTokens
			if u.CostUSD != nil {
				row.cost += *u.CostUSD
				row.costRuns++
			}
		}
	}
	rows := make([]usageRow, 0, len(byKey))
	for _, row := range byKey {
		rows = append(rows, *row)
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].tokens != rows[j].tokens {
			return rows[i].tokens > rows[j].tokens
		}
		return rows[i].provider+rows[i].model < rows[j].provider+rows[j].model
	})
	return rows
}

func (r usageRow) tokenText() string {
	if r.tokenRuns == 0 {
		return localText("no data", "sin dato")
	}
	return compactTokens(r.tokens)
}

// "+" marks a total that leaves out runs which reported tokens but no cost.
func (r usageRow) costText() string {
	if r.costRuns == 0 {
		return localText("no data", "sin dato")
	}
	text := fmt.Sprintf("$%.2f", r.cost)
	if r.costRuns < r.tokenRuns {
		text += "+"
	}
	return text
}

func (m *model) connectionGlyph(h discoveredHarness) (string, bool) {
	if !h.Usable {
		return "·", false
	}
	health, ok := m.connHealth[h.ID]
	switch {
	case !ok:
		return "…", false
	case health.AuthKnown && health.Authenticated:
		return "✓", true
	case health.AuthKnown:
		return "!", false
	}
	return "?", false
}

func (m *model) connectionsShell(w, h int) string {
	inner := max(1, w-4)
	rows := max(3, h-4-2)
	entries := m.connectionEntries()
	m.connSelected = max(0, min(m.connSelected, len(entries)-1))
	lw := 24
	if w >= 120 {
		lw = 28
	}
	dw := max(10, inner-lw-3)

	var list []string
	orch := ""
	if o := m.state.Orchestrator; o != nil {
		orch = o.Provider
	}
	for i, e := range entries {
		mark := "  "
		name := accent(ansi.Truncate(e.Name, max(1, lw-9), "…"), foreground)
		if i == m.connSelected {
			mark = "› "
			name = strong(ansi.Truncate(e.Name, max(1, lw-9), "…"), foreground)
		}
		glyph, ok := "", false
		if i > 0 {
			glyph, ok = m.connectionGlyph(e)
		}
		ink := amber
		switch {
		case ok:
			ink = lime
		case glyph == "·" || glyph == "…":
			ink = muted
		}
		tag := ""
		if i > 0 && e.ID == orch {
			tag = " " + accent(localText("orch", "orq"), pink)
		}
		list = append(list, accent(mark, pink)+accent(glyph, ink)+" "+name+tag)
		if i == 0 {
			list = append(list, "")
		}
	}
	if len(entries) == 1 {
		list = append(list, "", accent(localText("No agent CLI found in PATH.", "No se encontró ninguna CLI de agentes en PATH."), muted))
	}

	var detail []string
	add := func(s string) {
		detail = append(detail, strings.Split(wrap(s, dw), "\n")...)
	}
	label := max(8, dw-28)
	header := func(a, b, c string) {
		detail = append(detail, accent(padCell(a, label)+padLeftCell(b, 14)+padLeftCell(c, 14), muted))
	}
	line := func(a, b, c string) {
		detail = append(detail, padCell(a, label)+padLeftCell(b, 14)+padLeftCell(c, 14))
	}
	selected := entries[m.connSelected]
	if m.connSelected == 0 {
		add(strong(localText("REPORTED CONSUMPTION", "CONSUMO REPORTADO"), cyan))
		usage := m.usageRows()
		if len(usage) == 0 {
			add(accent(localText("No tasks yet.", "Todavía no hay tareas."), muted))
		} else {
			header(localText("agent · model", "agente · modelo"), "tokens", "USD")
		}
		for _, r := range usage {
			name := r.provider
			if r.model != "" {
				name += " · " + r.model
			}
			line(name, r.tokenText(), r.costText())
		}
		add("")
		add(accent(localText("Only workers report usage; the orchestrator does not report to Fluke. A + means some runs reported no cost.", "Solo los workers reportan consumo; el orquestador no le informa a Fluke. Un + indica que algunas ejecuciones no reportaron costo."), muted))
		add("")
		add(strong(localText("SUBSCRIPTION QUOTA", "CUOTA DE SUSCRIPCIÓN"), cyan))
		add(accent(localText("no data · Fluke does not query subscription quotas yet. Use each CLI's own usage command.", "sin dato · Fluke todavía no consulta cuotas de suscripción. Usá el comando de uso de cada CLI."), amber))
	} else {
		add(strong(selected.Name, pink))
		add(accent(selected.Executable, muted))
		health, probed := m.connHealth[selected.ID]
		add("")
		add(strong(localText("STATE", "ESTADO"), cyan))
		cli := localText("CLI: installed", "CLI: instalada")
		if probed && health.Version != "" {
			cli += " · " + health.Version
		}
		add(cli)
		switch {
		case !selected.Usable:
			add(accent(selected.Message, muted))
		case !probed:
			add(accent(localText("Checking the CLI and its account…", "Comprobando la CLI y su cuenta…"), amber))
		case health.AuthKnown && health.Authenticated:
			add(localText("Account: ", "Cuenta: ") + accent(localText("authenticated", "autenticada"), lime))
		case health.AuthKnown:
			add(localText("Account: ", "Cuenta: ") + accent(localText("sign-in needed", "requiere iniciar sesión"), amber))
		default:
			add(localText("Account: ", "Cuenta: ") + accent(localText("unverified", "sin verificar"), amber))
		}
		if probed && health.Message != "" {
			add(accent(health.Message, muted))
		}
		if argv, ok := acpAvailable(selected.ID); ok {
			add(localText("ACP: ", "ACP: ") + strings.Join(argv, " "))
			if acpWorkerProviders[selected.ID] {
				add(accent(localText("Available as a worker: :agent ID | "+selected.ID+" | (model set in its own config).", "Disponible como worker: :agent ID | "+selected.ID+" | (el modelo se define en su configuración)."), lime))
			} else {
				add(accent(localText("Structured-event adapter found; Fluke does not run workers through it yet.", "Adaptador de eventos estructurados encontrado; Fluke todavía no ejecuta workers con él."), muted))
			}
		} else {
			add(accent(localText("ACP: no adapter on PATH.", "ACP: sin adaptador en PATH."), muted))
		}
		add("")
		add(strong(localText("USED IN FLUKE", "USO EN FLUKE"), cyan))
		if o := m.state.Orchestrator; o != nil && o.Provider == selected.ID {
			add(localText("Orchestrator: ", "Orquestador: ") + configLabel(o))
		} else {
			add(accent(localText("Not the orchestrator.", "No es el orquestador."), muted))
		}
		workers, models := 0, map[string]bool{}
		for _, t := range m.state.Tasks {
			provider := t.AgentProvider
			if t.WorkerConfig != nil && t.WorkerConfig.Provider != "" {
				provider = t.WorkerConfig.Provider
			}
			if provider != selected.ID {
				continue
			}
			workers++
			if t.WorkerConfig != nil && t.WorkerConfig.Model != "" {
				models[t.WorkerConfig.Model] = true
			}
		}
		if workers > 0 {
			names := make([]string, 0, len(models))
			for name := range models {
				names = append(names, name)
			}
			sort.Strings(names)
			text := fmt.Sprintf(localText("Workers: %d task(s)", "Workers: %d tarea(s)"), workers)
			if len(names) > 0 {
				text += " · " + strings.Join(names, ", ")
			}
			add(text)
		} else {
			add(accent(localText("No tasks use it.", "Ninguna tarea la usa."), muted))
		}
		add("")
		add(strong(localText("REPORTED CONSUMPTION", "CONSUMO REPORTADO"), cyan))
		found := false
		for _, r := range m.usageRows() {
			if r.provider != selected.ID {
				continue
			}
			found = true
			name := r.model
			if name == "" {
				name = localText("default model", "modelo predeterminado")
			}
			line(name, r.tokenText(), r.costText())
		}
		if !found {
			add(accent(localText("no data", "sin dato"), muted))
		}
		add("")
		add(strong(localText("SUBSCRIPTION QUOTA", "CUOTA DE SUSCRIPCIÓN"), cyan))
		add(accent(localText("no data · not queried by Fluke yet", "sin dato · Fluke todavía no la consulta"), amber))
		if selected.Usable {
			add("")
			add(accent(localText("[Ctrl+L] Sign in   [Ctrl+R] Check again", "[Ctrl+L] Iniciar sesión   [Ctrl+R] Volver a comprobar"), cyan))
		}
	}

	body := []string{m.configNav(inner), ""}
	sep := accent("│", borderInk)
	for i := 0; i < rows; i++ {
		left, right := "", ""
		if i < len(list) {
			left = list[i]
		}
		if i < len(detail) {
			right = detail[i]
		}
		body = append(body, fit(left, lw, 1)+" "+sep+" "+fit(right, dw, 1))
	}
	return frame(localText("SETTINGS / CONNECTIONS AND USAGE", "CONFIGURACIÓN / CONEXIONES Y CONSUMO"), strings.Join(body, "\n"), w, h, cyan, true)
}
