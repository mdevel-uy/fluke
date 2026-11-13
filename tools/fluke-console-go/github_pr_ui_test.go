package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

func publicationUI(t *testing.T) (*model, Task, githubPRPlan) {
	t.Helper()
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.lock.Close() })
	repo := t.TempDir()
	if err := state.addTask(repo, "Exportación", "Resultado revisado"); err != nil {
		t.Fatal(err)
	}
	task := &state.Tasks[0]
	task.Status, task.AcceptedTree = "accepted", strings.Repeat("a", 40)
	plan := githubPRPlan{TaskID: task.ID, HeadBranch: task.Branch, RepoName: "example/demo", RemoteURL: "https://github.com/example/demo.git", BaseBranch: "main", BaseHead: strings.Repeat("b", 40), SourceHead: strings.Repeat("c", 40), Tree: task.AcceptedTree, Title: "Exportación revisada", Body: "Cambios revisados", Draft: true}
	m := newModel(store, state, repo)
	m.width, m.height = 60, 22
	m.review.open, m.review.task, m.review.publication = true, *task, &plan
	return m, *task, plan
}

func TestPublicationRequiresDurableConfirmationAndPreservesPendingState(t *testing.T) {
	m, task, plan := publicationUI(t)
	if err := os.Mkdir(filepath.Join(m.store.dir, "state.json"), 0700); err != nil {
		t.Fatal(err)
	}
	if cmd := m.confirmPullRequest(); cmd != nil || m.state.Tasks[0].Publication != nil || m.publishingTaskID != "" {
		t.Fatal("publication proceeded without saving", m.notice)
	}
	if err := os.Remove(filepath.Join(m.store.dir, "state.json")); err != nil {
		t.Fatal(err)
	}
	if cmd := m.confirmPullRequest(); cmd == nil || m.publishingTaskID != task.ID || !m.state.Tasks[0].Publication.Started {
		t.Fatal("confirmation didn't journal the exact publication", m.notice)
	}
	// An in-flight write result survives closing the panel; a URL alone is not completion.
	m.closePanels()
	plan.Pushed, plan.RemoteHead, plan.Number, plan.URL = true, plan.SourceHead, 42, "https://github.com/example/demo/pull/42"
	m.receivePullRequest(githubPRResult{task: task, plan: plan, published: true})
	if m.state.Tasks[0].Publication.Complete || !strings.Contains(m.notice, "pendiente") {
		t.Fatal("incomplete metadata was certified", m.notice)
	}
	store := m.store
	store.lock.Close()
	reopened, state, err := openStore(store.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.lock.Close()
	if !strings.Contains(state.Tasks[0].Note, "pendiente") {
		t.Fatal("pending publication disappeared on reopen")
	}
}

func TestPublicationPreviewCannotOverwriteANewerAcceptance(t *testing.T) {
	m, task, plan := publicationUI(t)
	plan.Pushed, plan.Complete, plan.RemoteHead, plan.Number, plan.URL = true, true, plan.SourceHead, 42, "https://github.com/example/demo/pull/42"
	m.state.Tasks[0].AcceptedTree = strings.Repeat("d", 40)
	m.receivePullRequest(githubPRResult{task: task, plan: plan, generation: m.review.generation})
	if m.state.Tasks[0].Publication != nil {
		t.Fatal("old preview overwrote acceptance")
	}
	m.state.Tasks[0].AcceptedTree = task.AcceptedTree
	m.closePanels()
	m.receivePullRequest(githubPRResult{task: task, plan: plan, generation: m.review.generation - 1})
	if m.state.Tasks[0].Publication != nil {
		t.Fatal("closed preview overwrote publication")
	}
}

func TestPublicationEditorFollowsLongTitleAndMultilinePaste(t *testing.T) {
	m, _, _ := publicationUI(t)
	m.review.publication.Title = strings.Repeat("á", 120)
	m.Update(tea.KeyPressMsg(tea.Key{Text: "e", Code: 'e'}))
	if !strings.Contains(m.review.view(m.width, m.workspaceHeight()), "▌") {
		t.Fatal("title caret hidden")
	}
	m.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyTab}))
	m.review.publication.Body = ""
	m.Update(tea.PasteMsg{Content: strings.Repeat("Cambio revisado\r\n", 30)})
	if strings.Contains(m.review.publication.Body, "\r") || !strings.Contains(m.review.view(m.width, m.workspaceHeight()), "▌") {
		t.Fatal("body paste caret hidden or CRLF unnormalized")
	}
	m.Update(tea.KeyPressMsg(tea.Key{Code: 's', Mod: tea.ModCtrl}))
	if m.review.publicationEditing != 0 || m.publishingTaskID != "" || m.state.Tasks[0].Publication != nil {
		t.Fatal("editing published without confirmation")
	}
	// An existing incomplete ready PR stays editable and explicitly describes its state.
	m.review.publication.URL, m.review.publication.Draft = "https://github.com/example/demo/pull/42", false
	if text := m.review.publicationText(); !strings.Contains(text, "ya está listo para revisión") || !strings.Contains(text, "ACTUALIZAR PR") || strings.Contains(text, "Publicar borrador") {
		t.Fatal("existing ready PR mislabeled as draft")
	}
	m.Update(tea.KeyPressMsg(tea.Key{Text: "e", Code: 'e'}))
	if m.review.publicationEditing != 1 {
		t.Fatal("existing PR update editor inaccessible")
	}
	m.review.publicationEditing, m.review.publicationLoading = 0, true
	if cmd := m.publicationKey(tea.KeyPressMsg(tea.Key{Text: "r", Code: 'r'})); cmd != nil || !m.review.publicationLoading {
		t.Fatal("refresh interrupted an in-flight publication")
	}
}

func TestIntegrationPreviewCannotOverwriteANewerAcceptance(t *testing.T) {
	m, task, publication := publicationUI(t)
	plan := integrationPlan{TaskID: task.ID, Tree: task.AcceptedTree, TargetHead: publication.BaseHead, SourceHead: publication.SourceHead, MergedCommit: publication.SourceHead, TargetBranch: "main"}
	m.state.Tasks[0].AcceptedTree = strings.Repeat("d", 40)
	m.receiveIntegration(deliveryIntegrationResult{task: task, plan: plan, generation: m.review.generation})
	if m.state.Tasks[0].Integration != nil {
		t.Fatal("old preview overwrote acceptance")
	}
	m.state.Tasks[0].AcceptedTree = task.AcceptedTree
	m.closePanels()
	m.receiveIntegration(deliveryIntegrationResult{task: task, plan: plan, generation: m.review.generation - 1})
	if m.state.Tasks[0].Integration != nil {
		t.Fatal("closed preview overwrote integration")
	}
}
