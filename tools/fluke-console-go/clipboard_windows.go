//go:build windows

package main

import (
	"fmt"
	"runtime"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	clipboardUser32        = windows.NewLazySystemDLL("user32.dll")
	clipboardKernel32      = windows.NewLazySystemDLL("kernel32.dll")
	clipboardCreateWindow  = clipboardUser32.NewProc("CreateWindowExW")
	clipboardDestroyWindow = clipboardUser32.NewProc("DestroyWindow")
	clipboardOpen          = clipboardUser32.NewProc("OpenClipboard")
	clipboardClose         = clipboardUser32.NewProc("CloseClipboard")
	clipboardEmpty         = clipboardUser32.NewProc("EmptyClipboard")
	clipboardSet           = clipboardUser32.NewProc("SetClipboardData")
	clipboardAlloc         = clipboardKernel32.NewProc("GlobalAlloc")
	clipboardFree          = clipboardKernel32.NewProc("GlobalFree")
	clipboardLock          = clipboardKernel32.NewProc("GlobalLock")
	clipboardUnlock        = clipboardKernel32.NewProc("GlobalUnlock")
)

const clipboardUnicodeText = 13

func copyText(text string) error {
	if err := validateClipboardText(text); err != nil {
		return err
	}
	encoded, err := windows.UTF16FromString(text)
	if err != nil {
		return err
	}
	// A real owner is required: EmptyClipboard after OpenClipboard(NULL) leaves
	// no owner and SetClipboardData fails. A message-only window stays invisible.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	class, _ := windows.UTF16PtrFromString("STATIC")
	window, _, callErr := clipboardCreateWindow.Call(0, uintptr(unsafe.Pointer(class)), 0, 0, 0, 0, 0, 0, ^uintptr(2), 0, 0, 0)
	if window == 0 {
		return fmt.Errorf(uiText("crear portapapeles: %w"), callErr)
	}
	defer clipboardDestroyWindow.Call(window)
	if err := openClipboard(window); err != nil {
		return err
	}
	defer clipboardClose.Call()
	handle, _, callErr := clipboardAlloc.Call(0x0002, uintptr(len(encoded)*2)) // GMEM_MOVEABLE
	if handle == 0 {
		return fmt.Errorf(uiText("reservar texto para copiar: %w"), callErr)
	}
	owned := true
	defer func() {
		if owned {
			clipboardFree.Call(handle)
		}
	}()
	ptr, _, callErr := clipboardLock.Call(handle)
	if ptr == 0 {
		return fmt.Errorf(uiText("preparar texto para copiar: %w"), callErr)
	}
	copy(unsafe.Slice((*uint16)(unsafe.Pointer(ptr)), len(encoded)), encoded)
	clipboardUnlock.Call(handle)
	if ok, _, callErr := clipboardEmpty.Call(); ok == 0 {
		return fmt.Errorf(uiText("abrir copia: %w"), callErr)
	}
	if ok, _, callErr := clipboardSet.Call(clipboardUnicodeText, handle); ok == 0 {
		return fmt.Errorf(uiText("copiar texto: %w"), callErr)
	}
	owned = false // Windows now owns and eventually frees this allocation.
	return nil
}

func openClipboard(owner uintptr) error {
	deadline := time.Now().Add(250 * time.Millisecond)
	for {
		if ok, _, err := clipboardOpen.Call(owner); ok != 0 {
			return nil
		} else if time.Now().After(deadline) {
			return fmt.Errorf(uiText("el portapapeles está ocupado: %w"), err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
