package main

import (
	"errors"
	"os"
	"time"

	"golang.org/x/sys/windows"
)

func replaceFile(from, to string) error {
	a, err := windows.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	b, err := windows.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	for attempt := 0; ; attempt++ {
		err = windows.MoveFileEx(a, b, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
		if err == nil || attempt == 19 || !(errors.Is(err, windows.ERROR_ACCESS_DENIED) || errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION)) {
			return err
		}
		if info, statErr := os.Lstat(to); statErr == nil && info.IsDir() {
			return err
		}
		// Windows readers can temporarily deny replacement even for an owned file.
		time.Sleep(10 * time.Millisecond)
	}
}
