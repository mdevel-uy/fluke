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
	promptMu            sync.Mutex
	lastOutput          atomic.Int64
	history             terminalScrollback
	x, y, w, h          int
	pinned              bool
	hidden              bool
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
	zoomed              bool
	restoreBounds       map[string]rectangle
	// titleFor lets the host describe a window (task, state, model) in its title bar.
	titleFor func(*terminalWindow) string
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
	if i >= 0 && i < len(m.Windows) && !m.Windows[i].hidden {
		m.FocusedWindow = i
		if m.singleWindow() {
			m.layout()
		}
	}
}

func (m *windowManager) visibleWindows() []int {
	var visible []int
	for i, w := range m.Windows {
		if !w.hidden {
			visible = append(visible, i)
		}
	}
	return visible
}

func (m *windowManager) cycleFocus(step int) {
	visible := m.visibleWindows()
	for n, i := range visible {
		if i == m.FocusedWindow {
			m.FocusWindow(visible[(n+step+len(visible))%len(visible)])
			return
		}
	}
	if len(visible) > 0 {
		m.FocusWindow(visible[0])
	}
}

func (m *windowManager) TogglePin() {
	if len(m.visibleWindows()) == 0 || m.Windows[m.FocusedWindow].hidden {
		return
	}
	if m.zoomed {
		m.ToggleZoom()
	}
	w := m.Windows[m.FocusedWindow]
	w.pinned = !w.pinned
	if w.pinned {
		m.tiled = false
	}
	m.layout()
}

// Painting and hit testing must agree, including unfocused pinned windows.
func (m *windowManager) windowOrder() []int {
	order := make([]int, 0, len(m.Windows))
	for _, pinned := range []bool{false, true} {
		for i, w := range m.Windows {
			if !w.hidden && w.pinned == pinned && i != m.FocusedWindow && !m.singleWindow() {
				order = append(order, i)
			}
		}
		if i := m.FocusedWindow; i >= 0 && i < len(m.Windows) && !m.Windows[i].hidden && m.Windows[i].pinned == pinned {
			order = append(order, i)
		}
	}
	return order
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
func (m *windowManager) ToggleTiling() {
	if m.zoomed {
		m.ToggleZoom()
	}
	m.tiled = !m.tiled
	m.layout()
}

// tileColumns: tiles are horizontal bands, one above the other, each using the
// full width, because terminal agents print line by line. Only when the bands
// would be too short does a second column appear, before falling back to a
// single window.
func (m *windowManager) tileColumns(n int) int {
	for cols := 1; cols <= n; cols++ {
		rows := (n + cols - 1) / cols
		if m.height/rows >= 8 && m.width/cols >= 50 {
			return cols
		}
	}
	return 1
}

func (m *windowManager) singleWindow() bool {
	n := len(m.visibleWindows())
	cols := m.tileColumns(n)
	return m.zoomed || m.tiled && (m.width < 64 || m.height/max(1, (n+cols-1)/cols) < 8)
}

func (m *windowManager) ToggleZoom() {
	if len(m.visibleWindows()) == 0 || m.Windows[m.FocusedWindow].hidden {
		return
	}
	if m.zoomed {
		for _, w := range m.Windows {
			if r, ok := m.restoreBounds[w.ID]; ok {
				w.x, w.y, w.w, w.h = r.x, r.y, r.w, r.h
			}
		}
		m.restoreBounds = nil
	} else {
		m.restoreBounds = map[string]rectangle{}
		for _, w := range m.Windows {
			m.restoreBounds[w.ID] = rectangle{w.x, w.y, w.w, w.h}
		}
	}
	m.zoomed = !m.zoomed
	m.gesture = nil
	m.layout()
}
func (m *windowManager) layout() {
	visible := m.visibleWindows()
	n := len(visible)
	if n == 0 {
		return
	}
	if m.FocusedWindow < 0 || m.FocusedWindow >= len(m.Windows) || m.Windows[m.FocusedWindow].hidden {
		m.FocusedWindow = visible[0]
	}
	if m.singleWindow() {
		w := m.Windows[m.FocusedWindow]
		w.x, w.y, w.w, w.h = 0, 0, m.width, m.height
		_ = w.resize(max(1, w.w-2), max(1, w.h-3))
		return
	}
	if m.tiled {
		cols := m.tileColumns(n)
		rows := (n + cols - 1) / cols
		for i, index := range visible {
			w := m.Windows[index]
			row, col := i/cols, i%cols
			in := min(cols, n-row*cols) // windows in this row: a short row fills the width
			x := col * m.width / in
			y := row * m.height / rows
			right := (col + 1) * m.width / in
			bottom := (row + 1) * m.height / rows
			w.x = x
			w.y = y
			w.w = right - x
			w.h = bottom - y
			_ = w.resize(w.w-2, w.h-3)
		}
	} else {
		for _, w := range m.Windows {
			if w.hidden {
				continue
			}
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
	order := m.windowOrder()
	for n := len(order) - 1; n >= 0; n-- {
		i := order[n]
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
	if mouse.Y == w.y+1 && mouse.X >= w.x+w.w-5 && mouse.X <= w.x+w.w-3 && w.w >= 20 {
		m.ToggleZoom()
		return
	}
	if mouse.Y == w.y+1 && mouse.X >= w.x+w.w-9 && mouse.X <= w.x+w.w-7 && w.w >= 20 {
		m.TogglePin()
		return
	}
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
	if m.singleWindow() {
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
	r := dragRectangle(g.initial, mouse.X-g.startX, mouse.Y-g.startY, g.edge, m.width, m.height, 20, 6)
	w.x, w.y, w.w, w.h = r.x, r.y, r.w, r.h
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
	case tea.MouseWheelMsg:
		if i := m.hit(v.X, v.Y); i >= 0 {
			w := m.Windows[i]
			w.outputMu.Lock()
			if v.Button == tea.MouseWheelUp {
				w.history.offset = min(w.history.count, w.history.offset+3)
			}
			if v.Button == tea.MouseWheelDown {
				w.history.offset = max(0, w.history.offset-3)
			}
			w.outputMu.Unlock()
		}
	case tea.KeyPressMsg:
		if len(m.Windows) > 0 && !m.Windows[m.FocusedWindow].hidden && m.Windows[m.FocusedWindow].scrollKey(v.String(), m.Mode) {
			return nil, nil
		}
		if m.Mode == terminalMode && len(m.Windows) > 0 && !m.Windows[m.FocusedWindow].hidden {
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
		if m.Mode == terminalMode && len(m.Windows) > 0 && !m.Windows[m.FocusedWindow].hidden {
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
			return themeVTColor(textStyle.GetForeground(), "38")
		}
		return themeVTColor(ground, "48")
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
	for _, i := range m.windowOrder() {
		w := m.Windows[i]
		if cursor != nil && i != m.FocusedWindow && cursor.X >= w.x && cursor.X < w.x+w.w && cursor.Y >= w.y && cursor.Y < w.y+w.h {
			cursor = nil
		}
		content, c := renderTerminal(w)
		border, titleInk := borderInk, foreground
		if i == m.FocusedWindow {
			border, titleInk = pink, pink
			cursor = c
		}
		title := w.Name
		if m.titleFor != nil {
			if described := m.titleFor(w); described != "" {
				title = described
			}
		}
		if m.singleWindow() {
			visible := m.visibleWindows()
			for n, index := range visible {
				if index == i {
					title = fmt.Sprintf("%d/%d · %s", n+1, len(visible), title)
					break
				}
			}
		}
		if label := w.historyLabel(); label != "" {
			title += " · " + label
		}
		if w.ProcessExited() {
			title += uiText(" · SALIÓ")
		}
		label := ansi.Truncate(title, max(1, w.w-12), "…")
		pin := "[p]"
		if w.pinned {
			pin = "[*]"
		}
		button := "[+]"
		if m.zoomed {
			button = "[-]"
		}
		interior := accent(fit(label, max(1, w.w-10), 1)+pin+" "+button+" ", titleInk) + "\n" + fit(content, max(1, w.w-2), max(1, w.h-3))
		frame := lipgloss.NewStyle().Border(lipgloss.NormalBorder()).BorderForeground(border).BorderBackground(ground).Background(ground).Width(w.w).Height(w.h).MaxWidth(w.w).MaxHeight(w.h).Render(interior)
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
	w.promptMu.Lock()
	defer w.promptMu.Unlock()
	title, screen := w.agentSignals()
	if detectAgentState(provider, title, screen) != "idle" {
		return errAutomaticDeferred
	}
	if w.userInputPending.Load() {
		return errAutomaticDeferred
	}
	return w.submitPrompt(provider, prompt)
}
func (w *terminalWindow) sendAutomaticPrompt(provider, prompt string) error {
	w.promptMu.Lock()
	defer w.promptMu.Unlock()
	title, screen := w.agentSignals()
	if detectAgentState(provider, title, screen) != "idle" {
		return errAutomaticDeferred
	}
	if w.userInputPending.Load() || w.conversationPending.Load() {
		return errAutomaticDeferred
	}
	return w.submitPrompt(provider, prompt)
}

// A successful pipe write is not evidence that the CLI submitted the input.
func (w *terminalWindow) submitPrompt(provider, prompt string) error {
	if err := w.writePrompt(prompt); err != nil {
		w.userInputPending.Store(true)
		return err
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		title, screen := w.agentSignals()
		state := detectAgentState(provider, title, screen)
		if state == "working" || state == "blocked" {
			return nil
		}
		if w.ProcessExited() {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	w.userInputPending.Store(true)
	return errors.New("provider did not acknowledge submission; input retained, not resent")
}

func (w *terminalWindow) sendPrompt(prompt string) error {
	w.promptMu.Lock()
	defer w.promptMu.Unlock()
	return w.writePrompt(prompt)
}
func (w *terminalWindow) writePrompt(prompt string) error {
	if prompt != "" {
		started := time.Now()
		if _, err := w.writer.Write(w.pasteBytes(prompt)); err != nil {
			return err
		}
		// Wait for the paste to render, rather than racing a fixed delay under load.
		for {
			last := time.Unix(0, w.lastOutput.Load())
			if last.After(started) && time.Since(last) >= 200*time.Millisecond && time.Since(started) >= 300*time.Millisecond {
				break
			}
			if time.Since(started) > 3*time.Second || w.ProcessExited() {
				return errors.New("provider did not finish receiving pasted input; submit withheld")
			}
			time.Sleep(25 * time.Millisecond)
		}
	}
	_, err := w.writer.Write([]byte(terminalEnter()))
	return err
}

func (w *terminalWindow) pasteBytes(text string) []byte {
	text = strings.ReplaceAll(text, "\x1b", "")
	if w.bracketedPaste.Load() {
		return []byte("\x1b[200~" + text + "\x1b[201~")
	}
	return []byte(text)
}
