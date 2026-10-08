package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
)

// Same public GitHub CLI OAuth application used by original Fluke's device flow.
const githubOAuthBase = "https://github.com/login"
const githubDevicePage = "https://github.com/login/device"
const githubOAuthClient = "178c6fc778ccc68e1d6a"

type githubAuth struct {
	Available, Busy, Environment bool
	Username, Code, Error        string
}
type githubAuthResult struct {
	Generation int
	Auth       githubAuth
	Next       tea.Cmd
}
type githubDevice struct {
	DeviceCode string `json:"device_code"`
	UserCode   string `json:"user_code"`
	Interval   int    `json:"interval"`
	Expires    int    `json:"expires_in"`
}
type githubTokenReply struct {
	Token string `json:"access_token"`
	Error string `json:"error"`
}

func oauthClientID() string {
	if id := strings.TrimSpace(os.Getenv("GITHUB_APP_CLIENT_ID")); id != "" {
		return id
	}
	return githubOAuthClient
}
func oauthPost(ctx context.Context, endpoint string, values url.Values, result any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(values.Encode()))
	if err != nil {
		return errors.New(uiText("no se pudo preparar la conexión con GitHub"))
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	client := &http.Client{Timeout: 15 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return errors.New(uiText("no se pudo contactar con GitHub; reintentá la conexión"))
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return errors.New(uiText("GitHub rechazó la solicitud de conexión"))
	}
	if err = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(result); err != nil {
		return errors.New(uiText("respuesta de autenticación inválida"))
	}
	return nil
}
func requestGithubDevice(ctx context.Context, base string) (githubDevice, error) {
	d := githubDevice{}
	err := oauthPost(ctx, base+"/device/code", url.Values{"client_id": {oauthClientID()}, "scope": {"repo read:org gist"}}, &d)
	if err == nil && (d.DeviceCode == "" || d.UserCode == "" || d.Expires < 1) {
		err = errors.New(uiText("GitHub no devolvió un código válido"))
	}
	return d, err
}
func pollGithubToken(ctx context.Context, base string, d githubDevice) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Duration(d.Expires)*time.Second)
	defer cancel()
	interval := time.Duration(max(1, d.Interval)) * time.Second
	for {
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return "", errors.New(uiText("conexión cancelada o código vencido; podés conectar de nuevo"))
		case <-timer.C:
		}
		r := githubTokenReply{}
		if err := oauthPost(ctx, base+"/oauth/access_token", url.Values{"client_id": {oauthClientID()}, "device_code": {d.DeviceCode}, "grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}}, &r); err != nil {
			return "", err
		}
		if r.Token != "" {
			return r.Token, nil
		}
		switch r.Error {
		case "authorization_pending":
		case "slow_down":
			interval += 5 * time.Second
		case "access_denied":
			return "", errors.New(uiText("no autorizaste la conexión con GitHub"))
		case "expired_token":
			return "", errors.New(uiText("el código venció; conectá de nuevo"))
		default:
			return "", errors.New(uiText("GitHub no pudo completar la autorización"))
		}
	}
}
func readGithubAuth(ctx context.Context, repo string) githubAuth {
	a := githubAuth{Environment: os.Getenv("GH_TOKEN") != "" || os.Getenv("GITHUB_TOKEN") != ""}
	if _, err := exec.LookPath("gh"); err != nil {
		a.Error = uiText("GitHub CLI no está instalado. Instalá gh y actualizá el estado.")
		return a
	}
	a.Available = true
	user := struct {
		Login string `json:"login"`
	}{}
	if err := ghJSON(ctx, repo, &user, "api", "user", "--hostname", "github.com"); err != nil {
		a.Error = uiText("Sin una sesión válida. Elegí Conectar para autorizar desde el navegador.")
	} else {
		a.Username = user.Login
	}
	return a
}
func saveGithubToken(ctx context.Context, repo, token string) error {
	cmd := ghCommand(ctx, repo, "auth", "login", "--hostname", "github.com", "--with-token")
	cmd.Stdin = strings.NewReader(token + "\n")
	if err := cmd.Run(); err != nil {
		return errors.New(uiText("no se pudo guardar la sesión en GitHub CLI; conectá de nuevo"))
	}
	return nil
}
func (m *model) authContext(timeout time.Duration) (context.Context, int) {
	if m.authCancel != nil {
		m.authCancel()
	}
	m.authGeneration++
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	m.authCancel = cancel
	m.auth.Busy = true
	m.auth.Error = ""
	m.auth.Code = ""
	return ctx, m.authGeneration
}
func (m *model) refreshGithubAuth() tea.Cmd {
	if m.auth.Busy {
		return nil
	}
	ctx, generation := m.authContext(20 * time.Second)
	repo := m.repo
	return func() tea.Msg { return githubAuthResult{Generation: generation, Auth: readGithubAuth(ctx, repo)} }
}
func (m *model) connectGithub() tea.Cmd {
	if m.auth.Busy {
		return nil
	}
	if !m.auth.Available {
		m.auth.Error = uiText("Instalá GitHub CLI (gh) y elegí Actualizar estado.")
		return nil
	}
	if m.auth.Environment {
		m.auth.Error = uiText("La cuenta proviene de GH_TOKEN/GITHUB_TOKEN; modificá esa variable para cambiarla.")
		return nil
	}
	ctx, generation := m.authContext(15 * time.Minute)
	repo := m.repo
	return func() tea.Msg {
		d, err := requestGithubDevice(ctx, githubOAuthBase)
		if err != nil {
			return githubAuthResult{Generation: generation, Auth: githubAuth{Available: true, Error: err.Error()}}
		}
		return githubAuthResult{Generation: generation, Auth: githubAuth{Available: true, Busy: true, Code: d.UserCode}, Next: func() tea.Msg {
			token, err := pollGithubToken(ctx, githubOAuthBase, d)
			if err == nil {
				err = saveGithubToken(ctx, repo, token)
			}
			if err != nil {
				return githubAuthResult{Generation: generation, Auth: githubAuth{Available: true, Error: err.Error()}}
			}
			return githubAuthResult{Generation: generation, Auth: readGithubAuth(ctx, repo)}
		}}
	}
}
func (m *model) disconnectGithub() tea.Cmd {
	if m.auth.Busy || m.auth.Username == "" {
		return nil
	}
	if m.auth.Environment {
		m.auth.Error = uiText("La sesión proviene del entorno; quitá GH_TOKEN/GITHUB_TOKEN para desconectarla.")
		return nil
	}
	ctx, generation := m.authContext(20 * time.Second)
	repo, username := m.repo, m.auth.Username
	return func() tea.Msg {
		cmd := ghCommand(ctx, repo, "auth", "logout", "--hostname", "github.com", "--user", username)
		if err := cmd.Run(); err != nil {
			return githubAuthResult{Generation: generation, Auth: githubAuth{Available: true, Username: username, Error: uiText("No se pudo desconectar la cuenta; actualizá el estado.")}}
		}
		return githubAuthResult{Generation: generation, Auth: readGithubAuth(ctx, repo)}
	}
}
func (m *model) cancelGithubAuth() {
	if m.authCancel != nil {
		m.authCancel()
	}
	m.authGeneration++
	m.auth.Busy = false
	m.auth.Code = ""
	m.auth.Error = uiText("Conexión cancelada. Actualizá el estado para comprobar la cuenta.")
}
func openGithubDevice() tea.Cmd {
	return func() tea.Msg {
		var cmd *exec.Cmd
		switch runtime.GOOS {
		case "windows":
			cmd = exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", githubDevicePage)
		case "darwin":
			cmd = exec.Command("open", githubDevicePage)
		default:
			cmd = exec.Command("xdg-open", githubDevicePage)
		}
		_ = cmd.Run()
		return nil
	}
}
