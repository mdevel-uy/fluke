//go:build windows

package main

import (
	"os"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	clipboardGet  = clipboardUser32.NewProc("GetClipboardData")
	clipboardEnum = clipboardUser32.NewProc("EnumClipboardFormats")
	clipboardSize = clipboardKernel32.NewProc("GlobalSize")
)

func clipboardTextForTest(t *testing.T) (string, bool) {
	t.Helper()
	if err := openClipboard(0); err != nil {
		t.Fatal(err)
	}
	defer clipboardClose.Call()
	// Preserve images, rich text and application-specific clipboard formats by
	// refusing to run when restoring only text would discard any of them.
	var format uintptr
	for {
		next, _, _ := clipboardEnum.Call(format)
		if next == 0 {
			break
		}
		format = next
		if format != 1 && format != 7 && format != clipboardUnicodeText && format != 16 {
			t.Skip("clipboard contains non-text formats; leaving it untouched")
		}
	}
	handle, _, _ := clipboardGet.Call(clipboardUnicodeText)
	if handle == 0 {
		return "", false
	}
	ptr, _, err := clipboardLock.Call(handle)
	if ptr == 0 {
		t.Fatal(err)
	}
	defer clipboardUnlock.Call(handle)
	size, _, _ := clipboardSize.Call(handle)
	return windows.UTF16ToString(unsafe.Slice((*uint16)(unsafe.Pointer(ptr)), int(size/2))), true
}

func TestNativeClipboardUnicodeRoundTrip(t *testing.T) {
	if os.Getenv("FLUKE_TEST_CLIPBOARD") != "1" {
		t.Skip("opt-in native clipboard test")
	}
	previous, hadText := clipboardTextForTest(t)
	t.Cleanup(func() {
		if hadText {
			if err := copyText(previous); err != nil {
				t.Errorf("restore clipboard: %v", err)
			}
		} else {
			if err := openClipboard(0); err != nil {
				t.Errorf("restore empty clipboard: %v", err)
				return
			}
			clipboardEmpty.Call()
			clipboardClose.Call()
		}
	})
	for _, text := range []string{"Fluke — ¿listo?\nSí. 🦊", "segunda copia: 漢字"} {
		if err := copyText(text); err != nil {
			t.Fatal(err)
		}
		got, present := clipboardTextForTest(t)
		if !present || got != text {
			t.Fatalf("copied text mismatch: %q", got)
		}
	}
}
