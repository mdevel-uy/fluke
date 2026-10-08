package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/xpty"
	"github.com/hinshun/vt10x"
)

const (
	windowMode = iota
	terminalMode
)

type terminalChanged struct{}
type ptyWriter struct {
	sync.Mutex
	pty xpty.Pty
}

func (p *ptyWriter) Write(b []byte) (int, error) { p.Lock(); defer p.Unlock(); return p.pty.Write(b) }

type terminalWindow struct {
	ID, Name            string
	Cmd                 *exec.Cmd
	pty                 xpty.Pty
	writer              *ptyWriter
	screen              vt10x.Terminal
	outputMu            sync.Mutex
	history             terminalScrollback
	x, y, w, h          int
	exited              atomic.Bool
	closed              bool
	userInputPending    atomic.Bool
	conversationPending atomic.Bool
	bracketedPaste      atomic.Bool
	group               *processGroup
	shutdownError       atomic.Pointer[string]
}

func (w *terminalWindow) ProcessExited() bool { return w.exited.Load() }
func (w *terminalWindow) resize(cols, rows int) error {
	w.outputMu.Lock()
	defer w.outputMu.Unlock()
	cols = max(1, cols)
	rows = max(1, rows)
	oldCols, oldRows := w.screen.Size()
	if oldCols == cols && oldRows == rows {
		return nil
	}
	if err := w.pty.Resize(cols, rows); err != nil {
		return err
	}
	w.screen.Lock()
	if slide := w.screen.Cursor().Y - rows + 1; slide > 0 {
		w.history.capture(w.screen, 0, min(slide, oldRows))
	}
	w.screen.Unlock()
	w.screen.Resize(cols, rows)
	w.history.region(cols, rows)
	return nil
}
func (w *terminalWindow) close() error {
	if w.closed {
		return nil
	}
	if err := w.group.close(); err != nil {
		return err
	}
	w.closed = true
	w.exited.Store(true)
	_ = w.pty.Close()
	return nil
}

type rectangle struct{ x, y, w, h int }
type mouseGesture struct {
	windowID       string
	startX, startY int
	initial        rectangle
	edge           int
}

const (
	edgeLeft = 1 << iota
	edgeRight
	edgeBottom
	edgeTop
)

type windowManager struct {
	Windows             []*terminalWindow
	FocusedWindow, Mode int
	width, height       int
	tiled               bool
	gesture             *mouseGesture
	changes             chan struct{}
	done                chan struct{}
	closed              bool
	nextID              int
	lastError           error
}

func newWindowManager(w, h int) *windowManager {
	return &windowManager{width: w, height: h, tiled: true, changes: make(chan struct{}, 1), done: make(chan struct{})}
}
func (m *windowManager) signal() {
	select {
	case m.changes <- struct{}{}:
	default:
	}
}
func (m *windowManager) Init() tea.Cmd {
	return func() tea.Msg {
		select {
		case <-m.changes:
			return terminalChanged{}
		case <-m.done:
			return nil
		}
	}
}
func (m *windowManager) AddWindowIn(dir, name string, argv ...string) {
	if len(argv) == 0 {
		m.lastError = fmt.Errorf("%s", uiText("falta el ejecutable"))
		return
	}
	pty, err := xpty.NewPty(max(1, m.width-2), max(1, m.height-3))
	if err != nil {
		m.lastError = err
		return
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	group, err := startOwnedPTY(pty, cmd)
	if err != nil {
		pty.Close()
		m.lastError = err
		return
	}
	m.nextID++
	writer := &ptyWriter{pty: pty}
	w := &terminalWindow{ID: fmt.Sprintf("session-%d", m.nextID), Name: name, Cmd: cmd, pty: pty, writer: writer, group: group, w: m.width, h: m.height}
	w.screen = vt10x.New(vt10x.WithSize(max(1, w.w-2), max(1, w.h-3)), vt10x.WithWriter(writer))
	m.Windows = append(m.Windows, w)
	m.FocusWindow(len(m.Windows) - 1)
	m.layout()
	m.lastError = nil
	go func() {
		buf := make([]byte, 16384)
		for {
			n, err := pty.Read(buf)
			if n > 0 {
				w.consumeOutput(buf[:n])
				m.signal()
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		_, _ = cmd.Process.Wait()
		if err := group.close(); err == nil {
			w.exited.Store(true)
		} else {
			message := err.Error()
			w.shutdownError.Store(&message)
		}
		m.signal()
	}()
}
func (m *windowManager) FocusWindow(i int) {
	if i >= 0 && i < len(m.Windows) {
		m.FocusedWindow = i
	}
}
func (m *windowManager) DeleteWindow(i int) bool {
	if i < 0 || i >= len(m.Windows) {
		return false
	}
	if err := m.Windows[i].close(); err != nil {
		m.lastError = err
		return false
	}
	m.Windows = append(m.Windows[:i], m.Windows[i+1:]...)
	m.FocusedWindow = min(m.FocusedWindow, max(0, len(m.Windows)-1))
	m.layout()
	return true
}
func (m *windowManager) Cleanup() {
	if m.closed {
		return
	}
	m.closed = true
	close(m.done)
	for _, w := range m.Windows {
		w.close()
	}
	m.Windows = nil
}
func (m *windowManager) ToggleTiling() { m.tiled = !m.tiled; m.layout() }
func (m *windowManager) layout() {
	n := len(m.Windows)
	if n == 0 {
		return
	}
	if m.tiled {
		cols := 1
		if n > 1 && m.width >= 64 {
			cols = 2
		}
		rows := (n + cols - 1) / cols
		for i, w := range m.Windows {
			x := i % cols * m.width / cols
			y := i / cols * m.height / rows
			right := (i%cols + 1) * m.width / cols
			bottom := (i/cols + 1) * m.height / rows
			w.x = x
			w.y = y
			w.w = right - x
			w.h = bottom - y
			_ = w.resize(w.w-2, w.h-3)
		}
	} else {
		for _, w := range m.Windows {
			m.clamp(w)
			_ = w.resize(w.w-2, w.h-3)
		}
	}
}
func (m *windowManager) clamp(w *terminalWindow) {
	w.w = min(m.width, max(20, w.w))
	w.h = min(m.height, max(6, w.h))
	w.x = max(0, min(w.x, m.width-w.w))
	w.y = max(0, min(w.y, m.height-w.h))
}
func (m *windowManager) hit(x, y int) int {
	if i := m.FocusedWindow; i >= 0 && i < len(m.Windows) {
		w := m.Windows[i]
		if x >= w.x && x < w.x+w.w && y >= w.y && y < w.y+w.h {
			return i
		}
	}
	for i := len(m.Windows) - 1; i >= 0; i-- {
		w := m.Windows[i]
		if x >= w.x && x < w.x+w.w && y >= w.y && y < w.y+w.h {
			return i
		}
	}
	return -1
}
func (m *windowManager) beginMouse(mouse tea.Mouse) {
	if mouse.Button != tea.MouseLeft {
		return
	}
	i := m.hit(mouse.X, mouse.Y)
	if i < 0 {
		return
	}
	m.FocusWindow(i)
	w := m.Windows[i]
	edge := 0
	if mouse.X == w.x {
		edge |= edgeLeft
	}
	if mouse.X == w.x+w.w-1 {
		edge |= edgeRight
	}
	if mouse.Y == w.y+w.h-1 {
		edge |= edgeBottom
	}
	if mouse.Y == w.y {
		edge |= edgeTop
	}
	if edge == 0 && mouse.Y > w.y+1 {
		m.Mode = terminalMode
		return
	}
	m.Mode = windowMode
	m.tiled = false
	m.gesture = &mouseGesture{windowID: w.ID, startX: mouse.X, startY: mouse.Y, initial: rectangle{w.x, w.y, w.w, w.h}, edge: edge}
}
func (m *windowManager) moveMouse(mouse tea.Mouse) {
	g := m.gesture
	if g == nil {
		return
	}
	var w *terminalWindow
	for _, candidate := range m.Windows {
		if candidate.ID == g.windowID {
			w = candidate
		}
	}
	if w == nil {
		return
	}
	dx, dy := mouse.X-g.startX, mouse.Y-g.startY
	r := g.initial
	w.x = r.x
	w.y = r.y
	w.w = r.w
	w.h = r.h
	if g.edge == 0 {
		w.x += dx
		w.y += dy
	} else {
		if g.edge&edgeLeft != 0 {
			w.x += dx
			w.w -= dx
		}
		if g.edge&edgeRight != 0 {
			w.w += dx
		}
		if g.edge&edgeBottom != 0 {
			w.h += dy
		}
		if g.edge&edgeTop != 0 {
			w.y += dy
			w.h -= dy
		}
	}
	m.clamp(w)
	// Commit the PTY size on release, rather than flooding the child during a drag.
}
func (m *windowManager) endMouse() {
	if m.gesture == nil {
		return
	}
	m.gesture = nil
	for _, w := range m.Windows {
		_ = w.resize(w.w-2, w.h-3)
	}
}
func (m *windowManager) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch v := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = max(1, v.Width)
		m.height = max(1, v.Height)
		m.layout()
	case terminalChanged:
		return nil, m.Init()
	case tea.MouseClickMsg:
		m.beginMouse(v.Mouse())
	case tea.MouseMotionMsg:
		m.moveMouse(v.Mouse())
	case tea.MouseReleaseMsg:
		m.moveMouse(v.Mouse())
		m.endMouse()
	case tea.KeyPressMsg:
		if len(m.Windows) > 0 && m.Windows[m.FocusedWindow].scrollKey(v.String(), m.Mode) {
			return nil, nil
		}
		if m.Mode == terminalMode && len(m.Windows) > 0 {
			w := m.Windows[m.FocusedWindow]
			w.liveOutput()
			w.screen.Lock()
			appCursor := w.screen.Mode()&vt10x.ModeAppCursor != 0
			w.screen.Unlock()
			w.writer.Lock()
			if v.Text != "" {
				w.userInputPending.Store(true)
			}
			if v.String() == "enter" || v.String() == "esc" || v.String() == "ctrl+u" {
				w.userInputPending.Store(false)
			}
			_, _ = w.writer.pty.Write(keyBytes(v, appCursor))
			w.writer.Unlock()
		}
	case tea.PasteMsg:
		if m.Mode == terminalMode && len(m.Windows) > 0 {
			w := m.Windows[m.FocusedWindow]
			w.liveOutput()
			w.writer.Lock()
			w.userInputPending.Store(v.Content != "")
			_, _ = w.writer.pty.Write(w.pasteBytes(v.Content))
			w.writer.Unlock()
		}
	}
	return nil, nil
}
func keyBytes(k tea.KeyPressMsg, appCursor bool) []byte {
	if k.Text != "" {
		return []byte(k.Text)
	}
	special := map[string]string{"enter": terminalEnter(), "tab": "\t", "shift+tab": "\x1b[Z", "backspace": "\x7f", "esc": terminalEscape(), "up": "\x1b[A", "down": "\x1b[B", "right": "\x1b[C", "left": "\x1b[D", "home": "\x1b[H", "end": "\x1b[F", "delete": "\x1b[3~", "pgup": "\x1b[5~", "pgdown": "\x1b[6~"}
	key := k.String()
	if v, ok := special[key]; ok {
		if appCursor && (key == "up" || key == "down" || key == "left" || key == "right") {
			v = strings.Replace(v, "[", "O", 1)
		}
		return []byte(v)
	}
	if len(key) == 6 && strings.HasPrefix(key, "ctrl+") {
		c := key[5]
		if c >= 'a' && c <= 'z' {
			return []byte{c - 'a' + 1}
		}
	}
	if strings.HasPrefix(key, "alt+") && k.Code > 0 && k.Code < 128 {
		return []byte("\x1b" + string(k.Code))
	}
	return nil
}
func vtColor(c vt10x.Color, foreground bool) string {
	if c == vt10x.DefaultFG || c == vt10x.DefaultBG {
		if foreground {
			return "38;2;238;234;250"
		}
		return "48;2;11;6;25"
	}
	prefix := "48"
	if foreground {
		prefix = "38"
	}
	if c < 256 {
		return fmt.Sprintf("%s;5;%d", prefix, c)
	}
	return fmt.Sprintf("%s;2;%d;%d;%d", prefix, c>>16&255, c>>8&255, c&255)
}
func renderTerminal(w *terminalWindow) (string, *tea.Cursor) {
	w.outputMu.Lock()
	defer w.outputMu.Unlock()
	w.screen.Lock()
	defer w.screen.Unlock()
	cols, rows := w.screen.Size()
	var b strings.Builder
	var previous vt10x.Glyph
	first := true
	for y := 0; y < rows; y++ {
		for x := 0; x < cols; x++ {
			cell := w.visibleCell(x, y)
			if first || cell.FG != previous.FG || cell.BG != previous.BG || cell.Mode != previous.Mode {
				fmt.Fprintf(&b, "\x1b[0;%s;%sm", vtColor(cell.FG, true), vtColor(cell.BG, false))
				if cell.Mode&1 != 0 {
					b.WriteString("\x1b[7m")
				}
				if cell.Mode&2 != 0 {
					b.WriteString("\x1b[4m")
				}
				if cell.Mode&4 != 0 {
					b.WriteString("\x1b[1m")
				}
				previous = cell
				first = false
			}
			r := cell.Char
			if r == 0 {
				r = ' '
			}
			b.WriteRune(r)
		}
		b.WriteString("\x1b[0m")
		first = true
		if y < rows-1 {
			b.WriteByte('\n')
		}
	}
	var cursor *tea.Cursor
	if w.history.offset == 0 && w.screen.CursorVisible() && !w.ProcessExited() {
		c := w.screen.Cursor()
		cursor = tea.NewCursor(w.x+c.X+1, w.y+c.Y+2)
	}
	return b.String(), cursor
}
func (m *windowManager) View() tea.View {
	layers := []*lipgloss.Layer{lipgloss.NewLayer(textStyle.Render(fit("", m.width, m.height)))}
	var cursor *tea.Cursor
	order := make([]int, 0, len(m.Windows))
	for i := range m.Windows {
		if i != m.FocusedWindow {
			order = append(order, i)
		}
	}
	if len(m.Windows) > 0 {
		order = append(order, m.FocusedWindow)
	}
	for _, i := range order {
		w := m.Windows[i]
		content, c := renderTerminal(w)
		border := muted
		if i == m.FocusedWindow {
			border = cyan
			cursor = c
		}
		title := w.Name
		if label := w.historyLabel(); label != "" {
			title += " · " + label
		}
		if w.ProcessExited() {
			title += uiText(" · SALIÓ")
		}
		interior := accent(ansi.Truncate(title, max(1, w.w-2), "…"), border) + "\n" + fit(content, max(1, w.w-2), max(1, w.h-3))
		frame := lipgloss.NewStyle().Border(lipgloss.NormalBorder()).BorderForeground(border).Background(ground).Width(max(1, w.w-2)).Height(max(1, w.h-2)).MaxWidth(w.w).MaxHeight(w.h).Render(interior)
		layers = append(layers, lipgloss.NewLayer(frame).X(w.x).Y(w.y))
	}
	view := tea.NewView(lipgloss.NewCompositor(layers...).Render())
	if m.Mode == terminalMode && m.gesture == nil {
		view.Cursor = cursor
	}
	return view
}

// ConPTY clients using ReadConsoleInput (Codex/crossterm) need VK_RETURN,
// rather than a carriage-return character with virtual key zero.
func terminalEnter() string {
	if runtime.GOOS == "windows" {
		return "\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_"
	}
	return "\r"
}
func terminalEscape() string {
	if runtime.GOOS == "windows" {
		return "\x1b[27;1;27;1;0;1_\x1b[27;1;27;0;0;1_"
	}
	return "\x1b"
}

var errAutomaticDeferred = errors.New("automatic prompt deferred for human input or busy CLI")

func (w *terminalWindow) sendQueuedChat(provider, prompt string) error {
	title, screen := w.agentSignals()
	if detectAgentState(provider, title, screen) != "idle" {
		return errAutomaticDeferred
	}
	w.writer.Lock()
	defer w.writer.Unlock()
	if w.userInputPending.Load() {
		return errAutomaticDeferred
	}
	return w.writePrompt(prompt)
}
func (w *terminalWindow) sendAutomaticPrompt(provider, prompt string) error {
	title, screen := w.agentSignals()
	if detectAgentState(provider, title, screen) != "idle" {
		return errAutomaticDeferred
	}
	w.writer.Lock()
	defer w.writer.Unlock()
	if w.userInputPending.Load() || w.conversationPending.Load() {
		return errAutomaticDeferred
	}
	return w.writePrompt(prompt)
}

func (w *terminalWindow) sendPrompt(prompt string) error {
	w.writer.Lock()
	defer w.writer.Unlock()
	return w.writePrompt(prompt)
}
func (w *terminalWindow) writePrompt(prompt string) error {
	if prompt != "" {
		if _, err := w.writer.pty.Write(w.pasteBytes(prompt)); err != nil {
			return err
		}
		// Keep submit out of the same paste burst: both agent TUIs protect pasted newlines.
		time.Sleep(300 * time.Millisecond)
	}
	_, err := w.writer.pty.Write([]byte(terminalEnter()))
	return err
}

func (w *terminalWindow) pasteBytes(text string) []byte {
	text = strings.ReplaceAll(text, "\x1b", "")
	if w.bracketedPaste.Load() {
		return []byte("\x1b[200~" + text + "\x1b[201~")
	}
	return []byte(text)
}
