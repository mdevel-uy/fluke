package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGithubDeviceFlowAndConfig(t *testing.T) {
	setupGithubFixture(t)
	t.Setenv("GH_TOKEN", "")
	t.Setenv("GITHUB_TOKEN", "")
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("Accept") != "application/json" {
			t.Error("incorrect OAuth request")
		}
		r.ParseForm()
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/device/code" {
			fmt.Fprint(w, `{"device_code":"fixture-device","user_code":"TEST-CODE","expires_in":30,"interval":1}`)
		} else {
			if r.Form.Get("device_code") != "fixture-device" {
				t.Error("incorrect device code")
			}
			requests++
			if requests == 1 {
				fmt.Fprint(w, `{"error":"authorization_pending"}`)
			} else {
				fmt.Fprint(w, `{"access_token":"fixture-token"}`)
			}
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	d, err := requestGithubDevice(ctx, server.URL)
	if err != nil || d.UserCode != "TEST-CODE" {
		t.Fatalf("device: %+v %v", d, err)
	}
	token, err := pollGithubToken(ctx, server.URL, d)
	if err != nil || token != "fixture-token" {
		t.Fatalf("token: %v", err)
	}
	repo := t.TempDir()
	if err = saveGithubToken(ctx, repo, token); err != nil {
		t.Fatal(err)
	}
	a := readGithubAuth(ctx, repo)
	if a.Username != "fixture-user" || a.Error != "" {
		t.Fatalf("%+v", a)
	}
	canceled, stop := context.WithCancel(context.Background())
	stop()
	if _, err = pollGithubToken(canceled, server.URL, d); err == nil {
		t.Fatal("cancel ignored")
	}
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	m := newModel(store, state, repo)
	defer m.cleanup()
	m.configSection = 1
	m.auth = a
	m.width, m.height = 100, 36
	if !strings.Contains(m.View().Content, "fixture-user") {
		t.Fatal("account absent from configuration")
	}
	m.width, m.height = 80, 18
	m.auth.Code = "TEST-CODE"
	m.auth.Busy = true
	if !strings.Contains(m.View().Content, "TEST-CODE") || !strings.Contains(m.View().Content, githubDevicePage) {
		t.Fatal("device code hidden in small terminal")
	}
	m.auth.Busy = false
	generation := m.authGeneration
	m.cancelGithubAuth()
	m.Update(githubAuthResult{Generation: generation, Auth: githubAuth{Username: "stale"}})
	if m.auth.Username == "stale" {
		t.Fatal("canceled login replaced current status")
	}
	encoded, _ := json.Marshal(m.state)
	if strings.Contains(string(encoded), "fixture-token") {
		t.Fatal("token persisted in Fluke state")
	}
	t.Setenv("GH_TOKEN", "from-environment")
	m.auth = readGithubAuth(ctx, repo)
	if m.connectGithub() != nil || !strings.Contains(m.auth.Error, "GH_TOKEN") {
		t.Fatal("environment credentials overwritten")
	}
}
