package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Agent Client Protocol (ACP) client: JSON-RPC 2.0, one JSON object per line
// over the agent's stdio. It gives Fluke structured events (message chunks,
// tool calls, plans, permission requests) from any agent that speaks ACP,
// instead of scraping a terminal.
//
// This file is the transport and the session calls only. It does not start
// agents on its own, advertises no file-system or terminal capability (the
// agent keeps using its own tools), and never answers a permission request
// without a policy chosen by the caller.

const acpProtocolVersion = 1

const acpMaxLine = 8 << 20

type acpError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *acpError) Error() string { return fmt.Sprintf("acp error %d: %s", e.Code, e.Message) }

type acpMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *acpError       `json:"error,omitempty"`
}

type acpToolCall struct {
	ID, Title, Kind, Status string
	Text                    []string
	// Paths the call says it touches (locations or raw input), when it says so.
	Paths []string
}

type acpPlanEntry struct{ Content, Status, Priority string }

type acpEvent struct {
	Session string
	// message | thought | tool | tool_update | plan | usage | other
	Kind string
	Text string
	Tool *acpToolCall
	Plan []acpPlanEntry
	// Context window use as the agent reports it; zero when absent.
	Used, Size int64
	Raw        json.RawMessage
}

type acpPermissionOption struct{ ID, Name, Kind string }

type acpPermissionRequest struct {
	Session string
	Tool    acpToolCall
	Options []acpPermissionOption
}

type acpAgentInfo struct {
	ProtocolVersion int
	Name, Title     string
	Version         string
	LoadSession     bool
	Image, Audio    bool
	AuthMethods     []string
}

type acpClient struct {
	w   io.WriteCloser
	cmd *exec.Cmd

	wmu     sync.Mutex
	mu      sync.Mutex
	next    int64
	pending map[int64]chan acpMessage
	err     error
	done    chan struct{}

	// OnEvent runs on the reader goroutine: it must not block. Set before use.
	OnEvent func(acpEvent)
	// OnPermission picks an option id, or returns false to cancel the request.
	// Without it, a "reject" option is chosen when the agent offers one.
	OnPermission func(acpPermissionRequest) (string, bool)
}

func newACPClient(r io.Reader, w io.WriteCloser) *acpClient {
	c := &acpClient{w: w, pending: map[int64]chan acpMessage{}, done: make(chan struct{})}
	go c.read(r)
	return c
}

// startACP launches an agent process speaking ACP on stdio.
func startACP(argv []string, cwd string, env []string) (*acpClient, error) {
	if len(argv) == 0 {
		return nil, errors.New("empty ACP command")
	}
	exe, err := exec.LookPath(argv[0])
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(exe, argv[1:]...)
	cmd.Dir = cwd
	if env != nil {
		cmd.Env = env
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	c := newACPClient(stdout, stdin)
	c.cmd = cmd
	return c, nil
}

// Close ends the agent: stdin closes first so it can exit by itself.
func (c *acpClient) Close() {
	_ = c.w.Close()
	if c.cmd == nil || c.cmd.Process == nil {
		return
	}
	exited := make(chan struct{})
	go func() { _ = c.cmd.Wait(); close(exited) }()
	select {
	case <-exited:
	case <-time.After(2 * time.Second):
		_ = c.cmd.Process.Kill()
		<-exited
	}
}

func (c *acpClient) read(r io.Reader) {
	reader := bufio.NewReaderSize(r, 64*1024)
	var failure error
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > acpMaxLine {
			failure = errors.New("acp message exceeds the size limit")
			break
		}
		if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
			var msg acpMessage
			// Lines that are not JSON-RPC (banners, logs) are ignored.
			if json.Unmarshal(trimmed, &msg) == nil {
				c.dispatch(msg)
			}
		}
		if err != nil {
			failure = err
			if errors.Is(err, io.EOF) {
				failure = errors.New("the agent closed its output")
			}
			break
		}
	}
	c.mu.Lock()
	c.err = failure
	close(c.done)
	c.mu.Unlock()
}

func (c *acpClient) dispatch(msg acpMessage) {
	switch {
	case msg.Method != "" && len(msg.ID) > 0:
		go c.serve(msg)
	case msg.Method != "":
		if msg.Method == "session/update" && c.OnEvent != nil {
			if event, ok := parseACPUpdate(msg.Params); ok {
				c.OnEvent(event)
			}
		}
	case len(msg.ID) > 0:
		var id int64
		if json.Unmarshal(msg.ID, &id) != nil {
			return
		}
		c.mu.Lock()
		ch := c.pending[id]
		delete(c.pending, id)
		c.mu.Unlock()
		if ch != nil {
			ch <- msg
		}
	}
}

// Requests from the agent. Only permission is supported; the rest is declined
// because Fluke advertises no file-system or terminal capability.
func (c *acpClient) serve(msg acpMessage) {
	if msg.Method != "session/request_permission" {
		c.reply(msg.ID, nil, &acpError{Code: -32601, Message: "method not supported by this client: " + msg.Method})
		return
	}
	var p struct {
		SessionID string `json:"sessionId"`
		ToolCall  struct {
			ID      string          `json:"toolCallId"`
			Title   string          `json:"title"`
			Kind    string          `json:"kind"`
			Status  string          `json:"status"`
			Content   json.RawMessage `json:"content"`
			Locations []struct {
				Path string `json:"path"`
			} `json:"locations"`
			RawInput map[string]any `json:"rawInput"`
		} `json:"toolCall"`
		Options []struct {
			ID   string `json:"optionId"`
			Name string `json:"name"`
			Kind string `json:"kind"`
		} `json:"options"`
	}
	if err := json.Unmarshal(msg.Params, &p); err != nil {
		c.reply(msg.ID, nil, &acpError{Code: -32602, Message: "invalid permission request"})
		return
	}
	req := acpPermissionRequest{Session: p.SessionID, Tool: acpToolCall{ID: p.ToolCall.ID, Title: p.ToolCall.Title, Kind: p.ToolCall.Kind, Status: p.ToolCall.Status, Text: acpContentText(p.ToolCall.Content)}}
	for _, l := range p.ToolCall.Locations {
		if l.Path != "" {
			req.Tool.Paths = append(req.Tool.Paths, l.Path)
		}
	}
	for _, key := range []string{"filePath", "file_path", "path"} {
		if s, ok := p.ToolCall.RawInput[key].(string); ok && s != "" {
			req.Tool.Paths = append(req.Tool.Paths, s)
		}
	}
	for _, o := range p.Options {
		req.Options = append(req.Options, acpPermissionOption{o.ID, o.Name, o.Kind})
	}
	choice, ok := "", false
	if c.OnPermission != nil {
		choice, ok = c.OnPermission(req)
	} else {
		for _, o := range req.Options {
			if o.Kind == "reject_once" {
				choice, ok = o.ID, true
				break
			}
		}
	}
	outcome := map[string]any{"outcome": "cancelled"}
	if ok && choice != "" {
		outcome = map[string]any{"outcome": "selected", "optionId": choice}
	}
	c.reply(msg.ID, map[string]any{"outcome": outcome}, nil)
}

func (c *acpClient) reply(id json.RawMessage, result any, rpcErr *acpError) {
	out := map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(id)}
	if rpcErr != nil {
		out["error"] = rpcErr
	} else {
		out["result"] = result
	}
	_ = c.send(out)
}

func (c *acpClient) send(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_, err = c.w.Write(append(data, '\n'))
	return err
}

func (c *acpClient) call(ctx context.Context, method string, params, out any) error {
	c.mu.Lock()
	if c.err != nil {
		err := c.err
		c.mu.Unlock()
		return err
	}
	c.next++
	id := c.next
	ch := make(chan acpMessage, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	forget := func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}
	if err := c.send(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		forget()
		return err
	}
	select {
	case msg := <-ch:
		if msg.Error != nil {
			return msg.Error
		}
		if out != nil && len(msg.Result) > 0 {
			return json.Unmarshal(msg.Result, out)
		}
		return nil
	case <-c.done:
		forget()
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.err
	case <-ctx.Done():
		forget()
		return ctx.Err()
	}
}

func (c *acpClient) Initialize(ctx context.Context) (acpAgentInfo, error) {
	var res struct {
		ProtocolVersion   int `json:"protocolVersion"`
		AgentCapabilities struct {
			LoadSession        bool `json:"loadSession"`
			PromptCapabilities struct {
				Image bool `json:"image"`
				Audio bool `json:"audio"`
			} `json:"promptCapabilities"`
		} `json:"agentCapabilities"`
		AgentInfo struct {
			Name    string `json:"name"`
			Title   string `json:"title"`
			Version string `json:"version"`
		} `json:"agentInfo"`
		AuthMethods []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"authMethods"`
	}
	params := map[string]any{
		"protocolVersion": acpProtocolVersion,
		"clientCapabilities": map[string]any{
			"fs":       map[string]any{"readTextFile": false, "writeTextFile": false},
			"terminal": false,
		},
	}
	if err := c.call(ctx, "initialize", params, &res); err != nil {
		return acpAgentInfo{}, err
	}
	info := acpAgentInfo{ProtocolVersion: res.ProtocolVersion, Name: res.AgentInfo.Name, Title: res.AgentInfo.Title, Version: res.AgentInfo.Version,
		LoadSession: res.AgentCapabilities.LoadSession, Image: res.AgentCapabilities.PromptCapabilities.Image, Audio: res.AgentCapabilities.PromptCapabilities.Audio}
	for _, m := range res.AuthMethods {
		name := m.Name
		if name == "" {
			name = m.ID
		}
		info.AuthMethods = append(info.AuthMethods, name)
	}
	return info, nil
}

func (c *acpClient) NewSession(ctx context.Context, cwd string) (string, error) {
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return "", err
	}
	var res struct {
		SessionID string `json:"sessionId"`
	}
	if err := c.call(ctx, "session/new", map[string]any{"cwd": abs, "mcpServers": []any{}}, &res); err != nil {
		return "", err
	}
	if res.SessionID == "" {
		return "", errors.New("the agent returned no session id")
	}
	return res.SessionID, nil
}

// Prompt sends one turn and returns when the agent stops. Events arrive through
// OnEvent meanwhile. Cancelling ctx asks the agent to stop the turn first.
func (c *acpClient) Prompt(ctx context.Context, session, text string) (string, error) {
	var res struct {
		StopReason string `json:"stopReason"`
	}
	params := map[string]any{"sessionId": session, "prompt": []any{map[string]any{"type": "text", "text": text}}}
	err := c.call(ctx, "session/prompt", params, &res)
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		_ = c.send(map[string]any{"jsonrpc": "2.0", "method": "session/cancel", "params": map[string]any{"sessionId": session}})
	}
	return res.StopReason, err
}

func (c *acpClient) Cancel(session string) {
	_ = c.send(map[string]any{"jsonrpc": "2.0", "method": "session/cancel", "params": map[string]any{"sessionId": session}})
}

// ---- updates -----------------------------------------------------------------

// Text of ACP content blocks: either one block or a list of tool-call content.
func acpContentText(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	type block struct {
		Type    string          `json:"type"`
		Text    string          `json:"text"`
		Path    string          `json:"path"`
		Content json.RawMessage `json:"content"`
	}
	var one block
	var many []block
	if json.Unmarshal(raw, &many) != nil {
		if json.Unmarshal(raw, &one) != nil {
			return nil
		}
		many = []block{one}
	}
	var out []string
	for _, b := range many {
		switch {
		case b.Text != "":
			out = append(out, b.Text)
		case b.Type == "diff" && b.Path != "":
			out = append(out, "diff "+b.Path)
		case len(b.Content) > 0:
			out = append(out, acpContentText(b.Content)...)
		}
	}
	return out
}

func parseACPUpdate(params json.RawMessage) (acpEvent, bool) {
	var p struct {
		SessionID string          `json:"sessionId"`
		Update    json.RawMessage `json:"update"`
	}
	if json.Unmarshal(params, &p) != nil || len(p.Update) == 0 {
		return acpEvent{}, false
	}
	var u struct {
		Kind    string          `json:"sessionUpdate"`
		Content json.RawMessage `json:"content"`
		ID      string          `json:"toolCallId"`
		Title   string          `json:"title"`
		ToolKnd string          `json:"kind"`
		Status  string          `json:"status"`
		Entries []struct {
			Content  string `json:"content"`
			Status   string `json:"status"`
			Priority string `json:"priority"`
		} `json:"entries"`
		Used int64 `json:"used"`
		Size int64 `json:"size"`
	}
	if json.Unmarshal(p.Update, &u) != nil {
		return acpEvent{}, false
	}
	event := acpEvent{Session: p.SessionID, Raw: p.Update, Kind: "other"}
	switch u.Kind {
	case "agent_message_chunk", "agent_thought_chunk", "user_message_chunk":
		event.Kind = map[string]string{"agent_message_chunk": "message", "agent_thought_chunk": "thought", "user_message_chunk": "other"}[u.Kind]
		event.Text = strings.Join(acpContentText(u.Content), "")
	case "tool_call", "tool_call_update":
		event.Kind = "tool"
		if u.Kind == "tool_call_update" {
			event.Kind = "tool_update"
		}
		event.Tool = &acpToolCall{ID: u.ID, Title: u.Title, Kind: u.ToolKnd, Status: u.Status, Text: acpContentText(u.Content)}
	case "plan":
		event.Kind = "plan"
		for _, e := range u.Entries {
			event.Plan = append(event.Plan, acpPlanEntry{e.Content, e.Status, e.Priority})
		}
	case "usage_update":
		event.Kind, event.Used, event.Size = "usage", u.Used, u.Size
	}
	return event, true
}

// ---- launchers and the safe probe ---------------------------------------------

// Commands that start an ACP server. The first entry that is on PATH wins. These
// are the documented entry points of each project; none is run by discovery.
type acpLauncher struct {
	Agent string
	Argv  []string
}

var acpLaunchers = []acpLauncher{
	{"codex", []string{"codex-acp"}},
	{"claude", []string{"claude-code-acp"}},
	{"claude", []string{"claude-agent-acp"}},
	{"gemini", []string{"gemini", "--experimental-acp"}},
	{"opencode", []string{"opencode", "acp"}},
}

// acpAvailable reports the launcher for an agent when its executable exists.
func acpAvailable(agent string) ([]string, bool) {
	for _, l := range acpLaunchers {
		if l.Agent != agent {
			continue
		}
		if _, err := exec.LookPath(l.Argv[0]); err == nil {
			return l.Argv, true
		}
	}
	return nil, false
}

// checkACP starts the command, performs the initialize handshake only (no
// session, no model request, no tokens) and describes what the agent offers.
func checkACP(argv []string, timeout time.Duration) (acpAgentInfo, error) {
	cwd, _ := os.Getwd()
	c, err := startACP(argv, cwd, nil)
	if err != nil {
		return acpAgentInfo{}, err
	}
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return c.Initialize(ctx)
}

// runACPCheck backs `--acp-check "<command> [args]"`: it is the safe way to see
// whether an adapter speaks ACP on this machine before Fluke relies on it.
func runACPCheck(command string) error {
	argv := strings.Fields(command)
	if len(argv) == 0 {
		return errors.New("--acp-check needs a command, for example: --acp-check \"opencode acp\"")
	}
	info, err := checkACP(argv, 20*time.Second)
	if err != nil {
		return fmt.Errorf("%s did not complete the ACP handshake: %w", argv[0], err)
	}
	yes := func(b bool) string {
		if b {
			return "yes"
		}
		return "no"
	}
	name := info.Name
	if info.Title != "" {
		name = info.Title
	}
	if name == "" {
		name = argv[0]
	}
	fmt.Printf("ACP agent: %s %s\nprotocol: %d\nload session: %s · images: %s · audio: %s\n", name, info.Version, info.ProtocolVersion, yes(info.LoadSession), yes(info.Image), yes(info.Audio))
	if len(info.AuthMethods) > 0 {
		fmt.Printf("auth methods: %s\n", strings.Join(info.AuthMethods, ", "))
	}
	return nil
}

// acpWorkerProviders are the agent ids Fluke can run as workers over ACP.
var acpWorkerProviders = map[string]bool{"opencode": true}

// ACP agents choose their model in their own configuration; ACP has no stable
// way to pick one per session, so a per-task model is refused instead of ignored.
func (a AgentConfig) validateACP() error {
	if !acpWorkerProviders[a.Provider] {
		return nil
	}
	for _, arg := range a.Arguments {
		// --channel=<dir> is Fluke's own: a directory the agent reports through.
		if dir, ok := strings.CutPrefix(arg, "--channel="); ok && filepath.IsAbs(dir) && !strings.ContainsAny(dir, "\x00\r\n") {
			continue
		}
		if arg != "--auto-approve" {
			return errors.New(localText("ACP agents accept no extra arguments here; configure the agent itself.", "Los agentes ACP no aceptan argumentos extra acá; configurá el agente en sí."))
		}
	}
	if strings.TrimSpace(a.Model) != "" {
		return errors.New(localText("OpenCode picks its model in its own configuration; leave the model empty.", "OpenCode elige su modelo en su propia configuración; dejá el modelo vacío."))
	}
	return nil
}

// probeACPProvider checks an ACP agent with the initialize handshake only: no
// session, no model request. Account and model live in the agent's own config.
func probeACPProvider(config AgentConfig) providerHealth {
	h := providerHealth{Provider: config.Provider, Models: []string{""}}
	argv, ok := acpAvailable(config.Provider)
	if !ok {
		h.Message = uiText("CLI no encontrada. Revisá el ejecutable en configuración.")
		return h
	}
	h.Available, h.Executable = true, argv[0]
	info, err := checkACP(argv, 8*time.Second)
	if err != nil {
		h.Message = localText("The CLI did not complete the ACP handshake: ", "La CLI no completó el handshake ACP: ") + err.Error()
		return h
	}
	h.Version = strings.TrimSpace(info.Name + " " + info.Version)
	h.Message = localText("ACP available. Its account and model are set in the agent's own configuration.", "ACP disponible. Su cuenta y su modelo se definen en la configuración del propio agente.")
	return h
}

// acpAgentNote adjusts the contract for agents run through ACP, where every
// shell command and every edit outside Fluke's channel asks the person first.
const acpAgentNote = "\nExcepción para este agente: escribí los reportes y órdenes del contrato directamente en su ruta final con una sola escritura; no uses un archivo temporal ni un comando de shell para renombrarlo. Para leer o listar archivos usá tus herramientas de lectura y búsqueda, no comandos de shell: cada comando de shell le pide permiso a la persona."
