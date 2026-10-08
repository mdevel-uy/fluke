package main

import (
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/charmbracelet/x/ansi"
	"github.com/hinshun/vt10x"
)

func scrollbackWindow(cols, rows int) *terminalWindow {
	return &terminalWindow{screen: vt10x.New(vt10x.WithSize(cols, rows))}
}

func TestBracketedPasteTracksSplitModesAndPreservesMultiline(t *testing.T) {
	w := scrollbackWindow(80, 10)
	if string(w.pasteBytes("one\ntwo")) != "one\ntwo" {
		t.Fatal("plain shell paste changed")
	}
	w.consumeOutput([]byte("\x1b[?25;20"))
	if w.bracketedPaste.Load() {
		t.Fatal("incomplete mode enabled paste")
	}
	w.consumeOutput([]byte("04h"))
	if string(w.pasteBytes("one\ntwo")) != "\x1b[200~one\ntwo\x1b[201~" {
		t.Fatal("multiline paste not framed")
	}
	if string(w.pasteBytes("safe\x1b[201~text")) != "\x1b[200~safe[201~text\x1b[201~" {
		t.Fatal("embedded escape broke paste framing")
	}
	w.consumeOutput([]byte("\x1b[?2004l"))
	if w.bracketedPaste.Load() {
		t.Fatal("disabled paste stayed enabled")
	}
	w.consumeOutput([]byte("\x1b[?2004h\x1bc"))
	if w.bracketedPaste.Load() {
		t.Fatal("terminal reset kept paste enabled")
	}
}

func TestScrollbackPreservesBurstOrderAndReturnsToLive(t *testing.T) {
	w := scrollbackWindow(20, 4)
	var output strings.Builder
	for n := 0; n < 50; n++ {
		fmt.Fprintf(&output, "row-%02d\r\n", n)
	}
	w.consumeOutput([]byte(output.String()))
	if text := w.visibleText(); !strings.Contains(text, "row-49") || strings.Contains(text, "row-00") {
		t.Fatalf("unexpected live screen: %q", text)
	}
	if !w.scrollKey("home", windowMode) || !strings.HasPrefix(w.visibleText(), "row-00\nrow-01\nrow-02\nrow-03") {
		t.Fatalf("earliest output lost: %q", w.visibleText())
	}
	_, cursor := renderTerminal(w)
	if cursor != nil || !strings.HasPrefix(w.historyLabel(), "HISTORIAL ") {
		t.Fatal("history should hide the live cursor and identify the reading position")
	}
	w.consumeOutput([]byte("row-50\r\n"))
	if !strings.HasPrefix(w.visibleText(), "row-00\nrow-01\nrow-02\nrow-03") {
		t.Fatal("new output moved the page while reading")
	}
	w.scrollKey("pgdown", windowMode)
	if !strings.HasPrefix(w.visibleText(), "row-03\nrow-04") {
		t.Fatalf("page down didn't retain one line of context: %q", w.visibleText())
	}
	w.scrollKey("end", windowMode)
	if !strings.Contains(w.visibleText(), "row-50") || w.historyLabel() != "" {
		t.Fatal("End didn't restore live output")
	}
}

func TestScrollbackHandlesWrapSplitUTF8AndSplitEscape(t *testing.T) {
	w := scrollbackWindow(4, 2)
	w.consumeOutput([]byte("abcdefgh"))
	// The final glyph triggers the deferred wrap only when its complete UTF-8 arrives.
	w.consumeOutput([]byte{0xc3})
	if w.history.count != 0 {
		t.Fatal("an incomplete rune archived a line without scrolling")
	}
	w.consumeOutput([]byte{0xa9})
	w.consumeOutput([]byte("\x1b[3"))
	w.consumeOutput([]byte("1mZ\x1b[0m"))
	w.scrollKey("home", windowMode)
	if text := w.visibleText(); text != "abcd\nefgh" {
		t.Fatalf("wrapped line missing: %q", text)
	}
	w.scrollKey("end", windowMode)
	if !strings.Contains(w.visibleText(), "éZ") {
		t.Fatalf("split UTF-8 or SGR corrupted: %q", w.visibleText())
	}
	w.consumeOutput([]byte{0xff, '\r', '\n', 'O', 'K'})
	if !strings.Contains(w.visibleText(), "OK") {
		t.Fatal("a malformed byte stopped all subsequent terminal output")
	}
}

func TestScrollbackStoresColorsAndIgnoresRepaints(t *testing.T) {
	w := scrollbackWindow(10, 3)
	w.consumeOutput([]byte("\x1b[?1049h\x1b[31mred\x1b[0m\r\nsecond\r\nthird\r\n"))
	if w.history.count != 1 {
		t.Fatalf("actual alternate-screen scroll missing: %d", w.history.count)
	}
	w.scrollKey("home", windowMode)
	content, _ := renderTerminal(w)
	if !strings.HasPrefix(ansi.Strip(content), "red") || !strings.Contains(content, "38;5;1") {
		t.Fatalf("history lost terminal colors: %q", content)
	}
	w.liveOutput()
	for n := 0; n < 100; n++ {
		w.consumeOutput([]byte("\x1b[H\x1b[2Jrepaint"))
	}
	if w.history.count != 1 {
		t.Fatal("agent repaint spam filled the scrollback")
	}
}

func TestScrollbackDoesNotArchiveInsetScrollRegionsOrZeroScroll(t *testing.T) {
	w := scrollbackWindow(12, 4)
	w.consumeOutput([]byte("header\r\none\r\ntwo\r\nthree"))
	w.consumeOutput([]byte("\x1b[2;4r\x1b[4;1H\r\n"))
	if w.history.count != 0 {
		t.Fatal("an internal widget's scroll was confused with terminal history")
	}
	w.consumeOutput([]byte("\x1b[r\x1b[0S"))
	if w.history.count != 0 {
		t.Fatal("zero-line scroll duplicated output")
	}
	w.consumeOutput([]byte("\x1b[2S"))
	if w.history.count != 2 {
		t.Fatal("explicit full-screen scroll didn't preserve outgoing rows")
	}
}

func TestScrollbackBoundsRetainedCellsLinesAndPendingSequence(t *testing.T) {
	h := terminalScrollback{}
	for n := 0; n < maxScrollbackLines+10; n++ {
		h.append(nil)
	}
	if h.count != maxScrollbackLines {
		t.Fatal("blank history grew without a line limit")
	}
	line := make([]vt10x.Glyph, 1024)
	for n := range line {
		line[n] = vt10x.Glyph{Char: 'x', FG: vt10x.DefaultFG, BG: vt10x.DefaultBG}
	}
	for n := 0; n < 500; n++ {
		h.append(line)
	}
	if h.cells > maxScrollbackCells || h.count > maxScrollbackLines {
		t.Fatal("terminal history exceeded its memory budget")
	}
	capacity := 0
	for _, saved := range h.lines {
		capacity += cap(saved)
	}
	if capacity > maxScrollbackCells {
		t.Fatalf("trimmed rows retained hidden oversized allocations: %d", capacity)
	}
	w := scrollbackWindow(20, 4)
	w.consumeOutput([]byte("\x1b]0;" + strings.Repeat("x", maxPendingVT+1)))
	if len(w.history.pending) > maxPendingVT {
		t.Fatal("unterminated control sequence grew without a bound")
	}
}

func TestScrollbackKeepsLiveKeysForTheChild(t *testing.T) {
	w := scrollbackWindow(20, 4)
	w.consumeOutput([]byte("a\r\nb\r\nc\r\nd\r\ne\r\n"))
	for _, key := range []string{"pgup", "pgdown", "home", "end", "esc", "up", "shift+esc", "shift+up"} {
		if w.scrollKey(key, terminalMode) {
			t.Fatalf("live terminal swallowed %s", key)
		}
	}
	if !w.scrollKey("shift+pgup", terminalMode) || w.history.offset == 0 {
		t.Fatal("Shift+PgUp didn't enter native scrollback")
	}
	if w.scrollKey("x", terminalMode) {
		t.Fatal("history consumed normal input")
	}
	w.liveOutput()
	if w.history.offset != 0 {
		t.Fatal("typing didn't return to live output")
	}
}

func TestScrollbackConcurrentOutputAndReading(t *testing.T) {
	w := scrollbackWindow(30, 8)
	var group sync.WaitGroup
	group.Add(2)
	go func() {
		defer group.Done()
		for n := 0; n < 500; n++ {
			w.consumeOutput([]byte(fmt.Sprintf("row-%04d\r\n", n)))
		}
	}()
	go func() {
		defer group.Done()
		for n := 0; n < 100; n++ {
			w.scrollKey("shift+pgup", terminalMode)
			_, _ = renderTerminal(w)
			_ = w.visibleText()
			_, _ = w.agentSignals()
			w.liveOutput()
		}
	}()
	group.Wait()
	if !strings.Contains(w.visibleText(), "row-0499") {
		t.Fatal("concurrent history reading lost output")
	}
}
