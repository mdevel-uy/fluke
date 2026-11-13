//go:build !windows

package main

import (
	"errors"
	"github.com/charmbracelet/x/xpty"
	"os/exec"
	"sync"
	"syscall"
)

type processGroup struct {
	sync.Mutex
	pid int
}

func startOwnedPTY(pty xpty.Pty, cmd *exec.Cmd) (*processGroup, error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := pty.Start(cmd); err != nil {
		return nil, err
	}
	return &processGroup{pid: cmd.Process.Pid}, nil
}
func (g *processGroup) close() error {
	g.Lock()
	defer g.Unlock()
	if g.pid == 0 {
		return nil
	}
	err := syscall.Kill(-g.pid, syscall.SIGKILL)
	if err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	g.pid = 0
	return nil
}
