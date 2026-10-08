package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreateProject(t *testing.T) {
	for _, configured := range []bool{false, true} {
		t.Run(map[bool]string{false: "fallback", true: "configured"}[configured], func(t *testing.T) {
			config := filepath.Join(t.TempDir(), "gitconfig")
			contents := "[commit]\n gpgSign = true\n[core]\n hooksPath = missing-hooks\n"
			wantAuthor := "Fluke <fluke@localhost>"
			if configured {
				contents += "[user]\n name = Project User\n email = project@example.com\n"
				wantAuthor = "Project User <project@example.com>"
			}
			if err := os.WriteFile(config, []byte(contents), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("GIT_CONFIG_GLOBAL", config)
			t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
			for _, key := range []string{"GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"} {
				t.Setenv(key, "")
				if err := os.Unsetenv(key); err != nil {
					t.Fatal(err)
				}
			}
			path := filepath.Join(t.TempDir(), "parent", "project")
			got, err := createProject(context.Background(), path, "My project")
			if err != nil || got != path {
				t.Fatalf("createProject = %q, %v", got, err)
			}
			for _, check := range []struct {
				args []string
				want string
			}{
				{[]string{"symbolic-ref", "--short", "HEAD"}, "main"},
				{[]string{"ls-tree", "HEAD"}, ""},
				{[]string{"log", "-1", "--format=%an <%ae>"}, wantAuthor},
				{[]string{"rev-list", "--count", "HEAD"}, "1"},
			} {
				value, err := dependencyGit(context.Background(), path, check.args...)
				if err != nil || value != check.want {
					t.Fatalf("%v = %q, %v; want %q", check.args, value, err, check.want)
				}
			}
			if value, err := dependencyGit(context.Background(), path, "config", "--local", "--get", "user.name"); err == nil || value != "" {
				t.Fatal("fallback persisted local identity")
			}
		})
	}
}

func TestCreateProjectRefusesExisting(t *testing.T) {
	for _, kind := range []string{"file", "empty", "populated"} {
		t.Run(kind, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "existing")
			if kind == "file" {
				if err := os.WriteFile(path, []byte("keep"), 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.Mkdir(path, 0755); err != nil {
					t.Fatal(err)
				}
				if kind == "populated" {
					if err := os.WriteFile(filepath.Join(path, "keep"), []byte("keep"), 0600); err != nil {
						t.Fatal(err)
					}
				}
			}
			if got, err := createProject(context.Background(), path, "Project"); err == nil || got != "" {
				t.Fatalf("existing path accepted: %q %v", got, err)
			}
			if kind == "empty" {
				entries, err := os.ReadDir(path)
				if err != nil || len(entries) != 0 {
					t.Fatal("empty directory changed")
				}
			} else {
				file := path
				if kind == "populated" {
					file = filepath.Join(path, "keep")
				}
				data, err := os.ReadFile(file)
				if err != nil || string(data) != "keep" {
					t.Fatal("existing file changed")
				}
			}
		})
	}
}

func TestCreateProjectInvalidInputAndCancellation(t *testing.T) {
	for _, name := range []string{"", "  ", "bad\nname", strings.Repeat("é", 121)} {
		path := filepath.Join(t.TempDir(), "project")
		if _, err := createProject(context.Background(), path, name); err == nil {
			t.Fatal("invalid name accepted")
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatal("invalid input created directory")
		}
	}
	if _, err := createProject(context.Background(), "", "Project"); err == nil {
		t.Fatal("empty path accepted")
	}
	if _, err := createProject(context.Background(), "bad\x00path", "Project"); err == nil {
		t.Fatal("invalid path accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	path := filepath.Join(t.TempDir(), "project")
	if _, err := createProject(ctx, path, "Project"); err == nil {
		t.Fatal("cancelled context accepted")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("cancelled request created directory")
	}
}

func TestCreateProjectReturnsPartialPath(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	path := filepath.Join(t.TempDir(), "project")
	got, err := createProject(context.Background(), path, "Project")
	if err == nil || got != path {
		t.Fatalf("partial creation = %q, %v", got, err)
	}
	if info, err := os.Stat(path); err != nil || !info.IsDir() {
		t.Fatal("created folder was removed")
	}
}
