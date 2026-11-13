package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/charmbracelet/x/term"
)

// ACP worker bridge. Fluke's window system hosts terminals, so an ACP agent
// runs behind a small terminal front-end: this process. It starts the agent,
// sends the task prompt, prints what the agent reports (messages, tool calls,
// plan), asks the person before any tool permission, and tells Fluke its state
// through the window title. Fluke keeps its worktree, contract, report files,
// message editor and review unchanged.

// Titles Fluke reads to know what the worker is doing.
const acpTitlePrefix = "fluke-acp:"

func acpTitleState(title string) string {
	if !strings.HasPrefix(title, acpTitlePrefix) {
		return "unknown"
	}
	switch state := strings.TrimPrefix(title, acpTitlePrefix); state {
	case "working", "blocked", "idle":
		return state
	}
	return "unknown"
}

type acpBridge struct {
	client  *acpClient
	cwd     string
	session string

	omu sync.Mutex
	out io.Writer

	mu          sync.Mutex
	state       string
	turnCancel  context.CancelFunc
	permOptions []acpPermissionOption
	permAnswer  chan string
	turns       sync.WaitGroup
	// lastEvent is the last sign of life from the agent; heartbeat is how long a
	// silent turn waits before saying so (zero means a minute).
	lastEvent time.Time
	heartbeat time.Duration
	// autoApprove is the autonomous-Fluke switch: tool permissions are granted
	// once each, without asking. Never on by default.
	autoApprove bool
	// channels are extra directories the agent reports through (the
	// orchestrator's contract directory); writes inside them are granted.
	channels []string
}

func newACPBridge(client *acpClient, out io.Writer, cwd string) *acpBridge {
	b := &acpBridge{client: client, out: out, cwd: cwd}
	client.OnEvent = b.handleEvent
	client.OnPermission = b.handlePermission
	return b
}

// Lines end with CRLF so output is right whether or not the terminal maps LF.
func (b *acpBridge) print(text string) {
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\n", "\r\n")
	b.omu.Lock()
	defer b.omu.Unlock()
	_, _ = io.WriteString(b.out, text)
}

func (b *acpBridge) setState(state string) {
	b.mu.Lock()
	changed := b.state != state
	b.state = state
	b.mu.Unlock()
	if changed {
		b.omu.Lock()
		_, _ = io.WriteString(b.out, "\x1b]0;"+acpTitlePrefix+state+"\x07")
		b.omu.Unlock()
	}
}

func (b *acpBridge) handleEvent(e acpEvent) {
	b.mu.Lock()
	b.lastEvent = time.Now()
	b.mu.Unlock()
	switch e.Kind {
	case "message":
		b.print(e.Text)
	case "thought":
		// Reasoning stays out of the transcript; Fluke only needs the work.
	case "tool":
		if e.Tool != nil {
			b.print("\n▸ " + e.Tool.Title + "\n")
		}
	case "tool_update":
		if e.Tool != nil && (e.Tool.Status == "completed" || e.Tool.Status == "failed") {
			b.print("  " + map[string]string{"completed": "✓", "failed": "✗"}[e.Tool.Status] + " " + e.Tool.Status + "\n")
		}
	case "plan":
		var lines []string
		for _, p := range e.Plan {
			mark := map[string]string{"completed": "✓", "in_progress": "◐"}[p.Status]
			if mark == "" {
				mark = "○"
			}
			lines = append(lines, "  "+mark+" "+p.Content)
		}
		if len(lines) > 0 {
			b.print("\nPlan\n" + strings.Join(lines, "\n") + "\n")
		}
	}
}

// Always asks. The request stays on screen, the title says "blocked" so Fluke
// raises it as attention, and nothing is approved until the person answers.
func (b *acpBridge) handlePermission(req acpPermissionRequest) (string, bool) {
	if id, ok := b.signalChannelOption(req); ok {
		b.print("\n(report to Fluke allowed)\n")
		return id, true
	}
	if b.autoApprove {
		for _, o := range req.Options {
			if o.Kind == "allow_once" {
				b.print("\n(auto-approved: " + req.Tool.Title + ")\n")
				return o.ID, true
			}
		}
	}
	answer := make(chan string, 1)
	b.mu.Lock()
	b.permOptions, b.permAnswer = req.Options, answer
	b.mu.Unlock()
	var list strings.Builder
	for i, o := range req.Options {
		fmt.Fprintf(&list, "  %d) %s\n", i+1, o.Name)
	}
	b.print("\n⚠ Permission requested: " + req.Tool.Title + "\n" + list.String() + "  Number, or Enter to reject: ")
	b.setState("blocked")
	choice := <-answer
	b.mu.Lock()
	b.permOptions, b.permAnswer = nil, nil
	b.mu.Unlock()
	if choice == "" {
		return "", false
	}
	b.setState("working")
	return choice, true
}

// Resolves the pending permission from a typed line.
func (b *acpBridge) answerPermission(text string) bool {
	b.mu.Lock()
	options, answer := b.permOptions, b.permAnswer
	b.mu.Unlock()
	if answer == nil {
		return false
	}
	text = strings.TrimSpace(text)
	choice := ""
	if n, err := strconv.Atoi(text); err == nil && n >= 1 && n <= len(options) {
		choice = options[n-1].ID
	} else {
		for _, o := range options {
			if o.Kind == "reject_once" {
				choice = o.ID
				break
			}
		}
	}
	select {
	case answer <- choice:
	default:
	}
	b.print("\n")
	return true
}

func (b *acpBridge) turnRunning() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.turnCancel != nil
}

func (b *acpBridge) startTurn(text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	b.mu.Lock()
	if b.turnCancel != nil {
		b.mu.Unlock()
		b.print("\n(a turn is running; wait for it or press Ctrl+C)\n")
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	b.turnCancel = cancel
	b.lastEvent = time.Now()
	interval := b.heartbeat
	b.mu.Unlock()
	if interval <= 0 {
		interval = 60 * time.Second
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				b.mu.Lock()
				quiet, waiting := time.Since(b.lastEvent), b.permAnswer != nil
				b.mu.Unlock()
				if !waiting && quiet >= interval {
					b.print(fmt.Sprintf("\n(no news from the agent for %ds · Ctrl+C cancels)\n", int(quiet.Seconds())))
				}
			}
		}
	}()
	b.setState("working")
	b.turns.Add(1)
	go func() {
		defer b.turns.Done()
		stop, err := b.client.Prompt(ctx, b.session, text)
		cancel()
		b.mu.Lock()
		b.turnCancel = nil
		b.mu.Unlock()
		switch {
		case err != nil && !errors.Is(err, context.Canceled):
			b.print("\n✗ " + err.Error() + "\n")
		case stop == "cancelled" || errors.Is(err, context.Canceled):
			b.print("\n(turn cancelled)\n")
		default:
			b.print("\n— turn finished (" + stop + ")\n")
		}
		b.setState("idle")
		b.print("> ")
	}()
}

// Raw input: typed text, bracketed paste, Enter, Backspace, Ctrl+C, Ctrl+D.
func (b *acpBridge) readInput(r io.Reader) error {
	br := bufio.NewReader(r)
	var line []rune
	paste := false
	echo := func(s string) { b.print(s) }
	for {
		c, _, err := br.ReadRune()
		if err != nil {
			return err
		}
		switch {
		case c == 0x1b:
			seq := ""
			if br.Buffered() > 0 {
				if next, _ := br.ReadByte(); next == '[' {
					seq = "["
					for {
						d, err := br.ReadByte()
						if err != nil {
							break
						}
						seq += string(d)
						if d >= 0x40 && d <= 0x7e {
							break
						}
					}
				}
			}
			switch seq {
			case "[200~":
				paste = true
			case "[201~":
				paste = false
			}
		case paste:
			if c == '\r' {
				continue
			}
			line = append(line, c)
			if c == '\n' {
				echo("↵")
			} else {
				echo(string(c))
			}
		case c == '\r' || c == '\n':
			text := string(line)
			line = nil
			if b.answerPermission(text) {
				continue
			}
			echo("\n")
			b.startTurn(text)
		case c == 0x7f || c == 0x08:
			if len(line) > 0 {
				line = line[:len(line)-1]
				echo("\b \b")
			}
		case c == 0x03:
			b.mu.Lock()
			answer, cancel := b.permAnswer, b.turnCancel
			b.mu.Unlock()
			switch {
			case answer != nil:
				select {
				case answer <- "":
				default:
				}
			case cancel != nil:
				b.client.Cancel(b.session)
			default:
				line = nil
				echo("\r\n> ")
			}
		case c == 0x04:
			if len(line) == 0 {
				return io.EOF
			}
		case c >= 0x20:
			line = append(line, c)
			echo(string(c))
		}
	}
}

// ---- process entry --------------------------------------------------------------

func runACPWorker(agent, prompt string, autoApprove bool, channels []string) error {
	var argv []string
	for _, l := range acpLaunchers {
		if l.Agent == agent {
			argv = l.Argv
			if _, err := exec.LookPath(argv[0]); err == nil {
				break
			}
		}
	}
	if len(argv) == 0 {
		return fmt.Errorf("no ACP launcher is known for %q", agent)
	}
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stdout, "\x1b]0;%sstarting\x07Fluke · %s over ACP\r\n", acpTitlePrefix, agent)
	client, err := startACP(argv, cwd, acpAgentEnv(agent, autoApprove, os.Environ()))
	if err != nil {
		return err
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if _, err := client.Initialize(ctx); err != nil {
		return fmt.Errorf("initialize: %w", err)
	}
	session, err := client.NewSession(ctx, cwd)
	if err != nil {
		return fmt.Errorf("new session: %w", err)
	}
	bridge := newACPBridge(client, os.Stdout, cwd)
	bridge.session, bridge.autoApprove, bridge.channels = session, autoApprove, channels
	if fd := os.Stdin.Fd(); term.IsTerminal(fd) {
		if state, err := term.MakeRaw(fd); err == nil {
			defer term.Restore(fd, state)
		}
	}
	bridge.print("\x1b[?2004h")
	defer bridge.print("\x1b[?2004l")
	bridge.setState("idle")
	if strings.TrimSpace(prompt) != "" {
		bridge.startTurn(prompt)
	} else {
		bridge.print("> ")
	}
	inputDone := make(chan error, 1)
	go func() { inputDone <- bridge.readInput(os.Stdin) }()
	select {
	case err := <-inputDone:
		if bridge.turnRunning() {
			bridge.client.Cancel(bridge.session)
		}
		bridge.turns.Wait()
		if errors.Is(err, io.EOF) {
			return nil
		}
		return err
	case <-client.done:
		return errors.New("the ACP agent exited")
	}
}

// OpenCode decides by its own configuration which tools need permission, and by
// default it lets edits and shell commands run. Fluke's rule is to ask, so the
// agent is started with those two set to "ask" unless the person already chose
// something through OPENCODE_CONFIG_CONTENT, or autonomous Fluke is on.
func acpAgentEnv(agent string, autoApprove bool, base []string) []string {
	if agent != "opencode" || autoApprove {
		return nil
	}
	for _, kv := range base {
		if strings.HasPrefix(kv, "OPENCODE_CONFIG_CONTENT=") {
			return nil
		}
	}
	return append(append([]string{}, base...), `OPENCODE_CONFIG_CONTENT={"permission":{"edit":"ask","bash":"ask"}}`)
}

// The worker reports to Fluke by writing under <worktree>/.fluke-worker/. That
// channel is Fluke's own, excluded from Git and checked by Fluke before it is
// read, so writes there are granted without asking; they would otherwise
// interrupt the person on every status update. Anything else, and every shell
// command, still goes through the question.
func (b *acpBridge) signalChannelOption(req acpPermissionRequest) (string, bool) {
	candidates := append([]string{}, req.Tool.Paths...)
	if req.Tool.Kind == "edit" || len(candidates) == 0 {
		candidates = append(candidates, req.Tool.Title)
	}
	signalDirs := append([]string{filepath.Join(b.cwd, ".fluke-worker")}, b.channels...)
	inside := false
	for _, c := range candidates {
		if !filepath.IsAbs(c) {
			continue
		}
		within := false
		for _, dir := range signalDirs {
			rel, err := filepath.Rel(dir, filepath.Clean(c))
			if err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				within = true
				break
			}
		}
		if !within {
			return "", false // a path outside every channel: ask
		}
		inside = true
	}
	if !inside || (req.Tool.Kind != "edit" && req.Tool.Kind != "") {
		return "", false
	}
	for _, o := range req.Options {
		if o.Kind == "allow_once" {
			return o.ID, true
		}
	}
	return "", false
}
