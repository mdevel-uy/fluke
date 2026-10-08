package main

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func init() {
	if os.Getenv("FLUKE_PROCESS_FIXTURE") != "1" {
		return
	}
	dir := os.Getenv("FLUKE_PROCESS_FIXTURE_DIR")
	manager := newWindowManager(80, 24)
	manager.AddWindowIn(dir, "worker", "powershell.exe", "-NoProfile", "-File", filepath.Join(dir, "parent.ps1"))
	if len(manager.Windows) != 1 {
		os.Exit(2)
	}
	os.WriteFile(filepath.Join(dir, "parent.pid"), []byte(strconv.Itoa(manager.Windows[0].Cmd.Process.Pid)), 0600)
	time.Sleep(30 * time.Second)
	manager.Cleanup()
	os.Exit(0)
}

func TestWorkerTreeStopsOnCloseAndConsoleCrash(t *testing.T) {
	for _, mode := range []string{"close", "crash"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			pidfile := filepath.Join(dir, "child.pid")
			body := fmt.Sprintf("$info = New-Object System.Diagnostics.ProcessStartInfo\n$info.FileName = 'powershell.exe'\n$info.Arguments = '-NoProfile -Command \"Start-Sleep -Seconds 25\"'\n$info.UseShellExecute = $false\n$info.CreateNoWindow = $true\n$child = [System.Diagnostics.Process]::Start($info)\n$child.Id | Set-Content -LiteralPath '%s'\nStart-Sleep -Seconds 25\n", strings.ReplaceAll(pidfile, "'", "''"))
			os.WriteFile(filepath.Join(dir, "parent.ps1"), []byte(body), 0600)
			var manager *windowManager
			var console *exec.Cmd
			if mode == "close" {
				manager = newWindowManager(80, 24)
				t.Cleanup(manager.Cleanup)
				manager.AddWindowIn(dir, "worker", "powershell.exe", "-NoProfile", "-File", filepath.Join(dir, "parent.ps1"))
				if len(manager.Windows) != 1 {
					t.Fatal(manager.lastError)
				}
			} else {
				exe, err := os.Executable()
				if err != nil {
					t.Fatal(err)
				}
				console = exec.Command(exe)
				console.Env = append(os.Environ(), "FLUKE_PROCESS_FIXTURE=1", "FLUKE_PROCESS_FIXTURE_DIR="+dir)
				if err = console.Start(); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { console.Process.Kill(); console.Wait() })
			}
			deadline := time.Now().Add(10 * time.Second)
			var pid int
			for time.Now().Before(deadline) {
				data, _ := os.ReadFile(pidfile)
				pid, _ = strconv.Atoi(strings.TrimSpace(string(data)))
				if pid > 0 {
					break
				}
				time.Sleep(20 * time.Millisecond)
			}
			if pid == 0 {
				t.Fatal("worker child not created")
			}
			handle, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_TERMINATE, false, uint32(pid))
			if err != nil {
				t.Fatal(err)
			}
			defer windows.CloseHandle(handle)
			defer windows.TerminateProcess(handle, 0)
			if mode == "close" {
				if !manager.DeleteWindow(0) {
					t.Fatal(manager.lastError)
				}
			} else {
				if err = console.Process.Kill(); err != nil {
					t.Fatal(err)
				}
				console.Wait()
			}
			result, err := windows.WaitForSingleObject(handle, 5000)
			if err != nil || result != uint32(windows.WAIT_OBJECT_0) {
				t.Fatalf("child survived %s: %d %v", mode, result, err)
			}
		})
	}
}

func TestParentExitTerminatesChild(t *testing.T) {
	dir := t.TempDir()
	pidfile := filepath.Join(dir, "child.pid")
	script := filepath.Join(dir, "parent.ps1")
	body := fmt.Sprintf("$child = Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 20') -PassThru\n$child.Id | Set-Content -LiteralPath '%s'\nStart-Sleep -Milliseconds 200\n", strings.ReplaceAll(pidfile, "'", "''"))
	if err := os.WriteFile(script, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	manager := newWindowManager(80, 24)
	defer manager.Cleanup()
	manager.AddWindowIn(dir, "parent", "powershell.exe", "-NoProfile", "-File", script)
	if len(manager.Windows) != 1 {
		t.Fatal(manager.lastError)
	}
	deadline := time.Now().Add(10 * time.Second)
	for !manager.Windows[0].ProcessExited() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !manager.Windows[0].ProcessExited() {
		t.Fatal("parent did not exit")
	}
	data, err := os.ReadFile(pidfile)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		if err == windows.ERROR_INVALID_PARAMETER {
			return
		} // Already reaped by the job.
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	defer windows.TerminateProcess(handle, 0)
	before, _ := windows.WaitForSingleObject(handle, 0)
	manager.Cleanup()
	after, _ := windows.WaitForSingleObject(handle, 5000)
	t.Logf("Parent exited; child alive before cleanup=%v, after cleanup=%v", before == uint32(windows.WAIT_TIMEOUT), after == uint32(windows.WAIT_TIMEOUT))
	if after == uint32(windows.WAIT_TIMEOUT) {
		t.Error("child survived worker and console cleanup; lifecycle ownership is incomplete")
	}
}
