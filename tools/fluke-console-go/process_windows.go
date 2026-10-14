package main

import (
	"errors"
	"fmt"
	"os/exec"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/charmbracelet/x/xpty"
	"golang.org/x/sys/windows"
)

type processGroup struct {
	sync.Mutex
	job windows.Handle
}

func startOwnedPTY(pty xpty.Pty, cmd *exec.Cmd) (*processGroup, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf(uiText("crear grupo de procesos: %w"), err)
	}
	g := &processGroup{job: job}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	// Assign before any user code runs, including immediate child creation.
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_SUSPENDED}
	if err = pty.Start(cmd); err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	fail := func(err error) (*processGroup, error) {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		_ = windows.CloseHandle(job)
		return nil, fmt.Errorf(uiText("proteger sesión: %w"), err)
	}
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		return fail(err)
	}
	err = windows.AssignProcessToJobObject(job, process)
	windows.CloseHandle(process)
	if err != nil {
		return fail(err)
	}
	if err = resumeOwnedProcess(uint32(cmd.Process.Pid)); err != nil {
		return fail(err)
	}
	return g, nil
}

// ConPTY closes the original thread handle after spawning the suspended process.
func resumeOwnedProcess(pid uint32) error {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ThreadEntry32{}
	entry.Size = uint32(unsafe.Sizeof(entry))
	for err = windows.Thread32First(snapshot, &entry); err == nil; err = windows.Thread32Next(snapshot, &entry) {
		if entry.OwnerProcessID != pid {
			continue
		}
		thread, err := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
		if err != nil {
			return err
		}
		_, err = windows.ResumeThread(thread)
		windows.CloseHandle(thread)
		return err
	}
	return errors.New(uiText("no se encontró el hilo suspendido de la sesión"))
}

func (g *processGroup) close() error {
	g.Lock()
	defer g.Unlock()
	if g.job == 0 {
		return nil
	}
	if err := windows.TerminateJobObject(g.job, 1); err != nil {
		return err
	}
	// Termination is asynchronous; don't release capacity while children live.
	var accounting struct {
		TotalUser, TotalKernel, PeriodUser, PeriodKernel int64
		PageFaults, Total, Active, Terminated            uint32
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if err := windows.QueryInformationJobObject(g.job, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&accounting)), uint32(unsafe.Sizeof(accounting)), nil); err != nil {
			return err
		}
		if accounting.Active == 0 {
			break
		}
		if time.Now().After(deadline) {
			return errors.New(uiText("el grupo de procesos no terminó; cupo retenido"))
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := windows.CloseHandle(g.job); err != nil {
		return err
	}
	g.job = 0
	return nil
}
