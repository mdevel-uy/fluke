package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestReplaceFileWaitsForWindowsReaderAndPreservesLockedState(t *testing.T) {
	for _, release := range []bool{true, false} {
		t.Run(map[bool]string{true: "reader closes", false: "reader stays"}[release], func(t *testing.T) {
			dir := t.TempDir()
			from, to := filepath.Join(dir, "temporary"), filepath.Join(dir, "state.json")
			if err := os.WriteFile(from, []byte("new"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(to, []byte("old"), 0600); err != nil {
				t.Fatal(err)
			}
			path, _ := windows.UTF16PtrFromString(to)
			handle, err := windows.CreateFile(path, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
			if err != nil {
				t.Fatal(err)
			}
			if release {
				done := make(chan struct{})
				go func() { time.Sleep(35 * time.Millisecond); _ = windows.CloseHandle(handle); close(done) }()
				err = replaceFile(from, to)
				<-done
			} else {
				err = replaceFile(from, to)
				_ = windows.CloseHandle(handle)
			}
			data, readErr := os.ReadFile(to)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if release {
				if err != nil || string(data) != "new" {
					t.Fatal("reader blocked atomic replacement", err, string(data))
				}
			} else {
				if err == nil || string(data) != "old" {
					t.Fatal("locked state was lost", err, string(data))
				}
				if _, err := os.Stat(from); err != nil {
					t.Fatal("failed replacement lost its source", err)
				}
			}
		})
	}
}
