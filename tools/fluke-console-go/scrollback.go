package main

import (
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/charmbracelet/x/ansi"
	"github.com/hinshun/vt10x"
)

const (
	maxScrollbackLines = 4096
	maxScrollbackCells = 128 * 1024 // Approximately 2 MiB of glyphs per open terminal.
	maxPendingVT       = 64 * 1024
)

type terminalScrollback struct {
	lines              [][]vt10x.Glyph
	head, count, cells int
	offset             int
	top, bottom        int
	cols, rows         int
	pending            []byte
}

func (h *terminalScrollback) region(cols, rows int) {
	h.cols, h.rows = cols, rows
	h.top, h.bottom = 0, rows-1
}

func (h *terminalScrollback) drop() {
	h.cells -= len(h.lines[h.head])
	h.lines[h.head] = nil
	h.head = (h.head + 1) % maxScrollbackLines
	h.count--
}

func (h *terminalScrollback) append(line []vt10x.Glyph) {
	for len(line) > 0 {
		cell := line[len(line)-1]
		if (cell.Char != 0 && cell.Char != ' ') || cell.BG != vt10x.DefaultBG {
			break
		}
		line = line[:len(line)-1]
	}
	line = line[:min(len(line), maxScrollbackCells)]
	line = slices.Clone(line)
	if h.lines == nil {
		h.lines = make([][]vt10x.Glyph, maxScrollbackLines)
	}
	for h.count == maxScrollbackLines || h.cells+len(line) > maxScrollbackCells {
		h.drop()
	}
	h.lines[(h.head+h.count)%maxScrollbackLines] = line
	h.count++
	h.cells += len(line)
	if h.offset > 0 {
		h.offset = min(h.offset+1, h.count)
	}
}

// Caller holds outputMu and the emulator lock, in that order.
func (h *terminalScrollback) capture(screen vt10x.Terminal, start, n int) {
	cols, rows := screen.Size()
	for y := max(0, start); y < min(start+n, rows); y++ {
		line := make([]vt10x.Glyph, cols)
		for x := range line {
			line[x] = screen.Cell(x, y)
		}
		h.append(line)
	}
}

func vtArguments(sequence string) (byte, []int) {
	if !strings.HasPrefix(sequence, "\x1b[") || len(sequence) < 3 {
		return 0, nil
	}
	body := sequence[2 : len(sequence)-1]
	if strings.ContainsAny(body, "?<>=:") {
		return 0, nil
	}
	var values []int
	if body == "" {
		return sequence[len(sequence)-1], nil
	}
	for _, value := range strings.Split(body, ";") {
		n, err := strconv.Atoi(value)
		if err != nil {
			break
		}
		values = append(values, n)
	}
	return sequence[len(sequence)-1], values
}

// vt10x exposes cells and the cursor but no scroll callback. Split writes at
// scrolling boundaries, preserving the outgoing rows before the emulator moves them.
func (w *terminalWindow) consumeOutput(data []byte) {
	w.outputMu.Lock()
	defer w.outputMu.Unlock()
	h := &w.history
	if h.rows == 0 {
		w.screen.Lock()
		cols, rows := w.screen.Size()
		w.screen.Unlock()
		h.region(cols, rows)
	}
	h.pending = append(h.pending, data...)
	for len(h.pending) > 0 {
		p := h.pending
		if p[0] >= 0x20 && p[0] != 0x7f {
			if utf8.FullRune(p) {
				if r, size := utf8.DecodeRune(p); r == utf8.RuneError && size == 1 {
					h.pending = p[1:]
					continue
				}
			}
			w.screen.Lock()
			cursor, mode := w.screen.Cursor(), w.screen.Mode()
			limit := max(1, h.cols-cursor.X)
			captureWrap := false
			// ponytail: vt10x's public Cursor.State uses bit 2 for deferred wrapping;
			// replace this check if the pinned emulator gains a scroll callback.
			if cursor.State&2 != 0 && mode&vt10x.ModeWrap != 0 {
				captureWrap = cursor.Y == h.bottom && h.top == 0
				limit = h.cols
			}
			w.screen.Unlock()
			n := 0
			for runes := 0; n < len(p) && runes < limit; runes++ {
				if p[n] < 0x20 || p[n] == 0x7f || !utf8.FullRune(p[n:]) {
					break
				}
				_, size := utf8.DecodeRune(p[n:])
				n += size
			}
			if n == 0 {
				break
			}
			if captureWrap {
				w.screen.Lock()
				h.capture(w.screen, 0, 1)
				w.screen.Unlock()
			}
			written, _ := w.screen.Write(p[:n])
			if written == 0 {
				break
			}
			h.pending = p[written:]
			continue
		}
		sequence, _, n, state := ansi.DecodeSequence(p, ansi.NormalState, nil)
		if state != ansi.NormalState || n == 0 {
			if len(p) > maxPendingVT {
				h.pending = nil
			}
			break
		}
		if n > maxPendingVT {
			h.pending = p[n:]
			continue
		}
		control := string(sequence)
		if strings.HasPrefix(control, "\x1b[?") && (strings.HasSuffix(control, "h") || strings.HasSuffix(control, "l")) {
			for _, mode := range strings.Split(control[3:len(control)-1], ";") {
				if mode == "2004" {
					w.bracketedPaste.Store(strings.HasSuffix(control, "h"))
				}
			}
		} else if control == "\x1bc" {
			w.bracketedPaste.Store(false)
		}
		command, args := vtArguments(control)
		w.screen.Lock()
		cursor := w.screen.Cursor()
		scroll := 0
		if h.top == 0 {
			switch {
			case control == "\n" || control == "\v" || control == "\f" || control == "\x1bD" || control == "\x1bE":
				if cursor.Y == h.bottom {
					scroll = 1
				}
			case command == 'S' || command == 'M' && cursor.Y == 0:
				scroll = 1
				if len(args) > 0 {
					scroll = args[0]
				}
			}
		}
		if scroll > 0 {
			h.capture(w.screen, 0, min(scroll, h.bottom+1))
		}
		w.screen.Unlock()
		written, _ := w.screen.Write(sequence)
		if written == 0 {
			break
		}
		h.pending = p[written:]
		if command == 'r' {
			h.top, h.bottom = 0, h.rows-1
			if len(args) > 0 {
				h.top = max(0, min(h.rows-1, args[0]-1))
			}
			if len(args) > 1 {
				h.bottom = max(0, min(h.rows-1, args[1]-1))
			}
			if h.top > h.bottom {
				h.top, h.bottom = h.bottom, h.top
			}
		} else if control == "\x1bc" {
			h.region(h.cols, h.rows)
		}
	}
	if len(h.pending) == 0 {
		h.pending = nil
	}
}

func (w *terminalWindow) liveOutput() {
	w.outputMu.Lock()
	w.history.offset = 0
	w.outputMu.Unlock()
}

func (w *terminalWindow) scrollKey(key string, mode int) bool {
	w.outputMu.Lock()
	defer w.outputMu.Unlock()
	h := &w.history
	if key == "shift+pgup" || key == "shift+pgdown" || key == "shift+home" || key == "shift+end" {
		key = strings.TrimPrefix(key, "shift+")
	} else if mode != windowMode && h.offset == 0 {
		return false
	}
	page := max(1, h.rows-1)
	switch key {
	case "pgup":
		h.offset = min(h.count, h.offset+page)
	case "pgdown":
		h.offset = max(0, h.offset-page)
	case "home":
		h.offset = h.count
	case "end", "esc":
		h.offset = 0
	default:
		return false
	}
	return true
}

func (w *terminalWindow) historyLabel() string {
	w.outputMu.Lock()
	defer w.outputMu.Unlock()
	if w.history.offset == 0 {
		return ""
	}
	return uiText("HISTORIAL ") + strconv.Itoa(w.history.offset) + "/" + strconv.Itoa(w.history.count)
}

func (w *terminalWindow) visibleCell(x, y int) vt10x.Glyph {
	h := &w.history
	index := h.count - h.offset + y
	if index < h.count {
		line := h.lines[(h.head+index)%maxScrollbackLines]
		if x < len(line) {
			return line[x]
		}
		return vt10x.Glyph{Char: ' ', FG: vt10x.DefaultFG, BG: vt10x.DefaultBG}
	}
	return w.screen.Cell(x, index-h.count)
}

func (w *terminalWindow) visibleText() string {
	w.outputMu.Lock()
	defer w.outputMu.Unlock()
	w.screen.Lock()
	defer w.screen.Unlock()
	cols, rows := w.screen.Size()
	var result strings.Builder
	for y := 0; y < rows; y++ {
		var line strings.Builder
		for x := 0; x < cols; x++ {
			r := w.visibleCell(x, y).Char
			if r == 0 {
				r = ' '
			}
			line.WriteRune(r)
		}
		result.WriteString(strings.TrimRight(line.String(), " "))
		result.WriteByte('\n')
	}
	return strings.TrimRight(result.String(), "\n")
}
