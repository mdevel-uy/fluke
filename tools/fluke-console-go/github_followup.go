package main

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

type githubPRCheck struct {
	Type       string `json:"__typename"`
	Name       string `json:"name"`
	Context    string `json:"context"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	State      string `json:"state"`
}

type githubPRFollowup struct {
	githubPR
	ReviewDecision string `json:"reviewDecision"`
	MergeState     string `json:"mergeStateStatus"`
	MergeCommit    *struct {
		OID string `json:"oid"`
	} `json:"mergeCommit"`
	Checks    []githubPRCheck `json:"statusCheckRollup"`
	CheckedAt time.Time       `json:"-"`
	Loading   bool            `json:"-"`
	Error     string          `json:"-"`
}

type githubPRFollowupResult struct {
	Repo        string
	TaskID      string
	Publication githubPRPlan
	Snapshot    githubPRFollowup
}

func readGithubPRFollowupContext(ctx context.Context, task Task) githubPRFollowupResult {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	r := githubPRFollowupResult{Repo: task.Repo, TaskID: task.ID}
	if task.Publication != nil {
		r.Publication = *task.Publication
	}
	fail := func(en, es string) githubPRFollowupResult { r.Snapshot.Error = localText(en, es); return r }
	if task.Publication == nil || !validStoredGithubPRPlan(task, *task.Publication) || !task.Publication.Complete {
		return fail("the task has no valid published PR", "la tarea no tiene un PR publicado válido")
	}
	remote, err := dependencyGit(ctx, task.Repo, "remote", "get-url", "origin")
	name, remoteErr := githubPRRemote(remote)
	if err != nil || remoteErr != nil || !strings.EqualFold(name, r.Publication.RepoName) {
		return fail("origin changed; review the PR destination before querying", "origin cambió; revisá el destino del PR antes de consultar")
	}
	cmd := ghCommand(ctx, task.Repo, "pr", "view", strconv.Itoa(r.Publication.Number), "--repo", r.Publication.RepoName, "--json", "number,url,state,isDraft,headRefName,headRefOid,baseRefName,isCrossRepository,reviewDecision,mergeStateStatus,mergeCommit,statusCheckRollup")
	out, stderr := &reviewOutput{remaining: 131072}, &reviewOutput{remaining: 2048}
	cmd.Stdout, cmd.Stderr, cmd.WaitDelay = out, stderr, 2*time.Second
	if err = cmd.Run(); err != nil || ctx.Err() != nil {
		return fail("could not query the PR; check gh auth login and retry", "no se pudo consultar el PR; revisá gh auth login y reintentá")
	}
	if out.truncated || json.Unmarshal([]byte(out.text.String()), &r.Snapshot) != nil || len(r.Snapshot.Checks) > 100 {
		return fail("invalid or oversized PR response", "respuesta del PR inválida o demasiado grande")
	}
	p, s := r.Publication, r.Snapshot
	if s.Number != p.Number || s.URL != p.URL || !validGithubPRURL(p.RepoName, s.URL, s.Number) || s.HeadBranch != p.HeadBranch || s.BaseBranch != p.BaseBranch || s.IsCrossRepository || s.Head != p.SourceHead || !validGitHash(s.Head) {
		return fail("the PR or its delivery changed; review GitHub manually", "el PR o su entrega cambiaron; revisá GitHub manualmente")
	}
	if s.State != "OPEN" && s.State != "CLOSED" && s.State != "MERGED" || s.ReviewDecision != "" && s.ReviewDecision != "APPROVED" && s.ReviewDecision != "CHANGES_REQUESTED" && s.ReviewDecision != "REVIEW_REQUIRED" || s.State == "MERGED" && (s.MergeCommit == nil || !validGitHash(s.MergeCommit.OID)) || s.MergeCommit != nil && !validGitHash(s.MergeCommit.OID) {
		return fail("GitHub returned an invalid PR state", "GitHub devolvió un estado de PR inválido")
	}
	switch s.MergeState {
	case "":
		if s.State == "OPEN" {
			return fail("GitHub returned an invalid merge state", "GitHub devolvió un estado de fusión inválido")
		}
		r.Snapshot.MergeState = "UNKNOWN"
	case "BEHIND", "BLOCKED", "CLEAN", "DIRTY", "DRAFT", "HAS_HOOKS", "UNKNOWN", "UNSTABLE":
	default:
		return fail("GitHub returned an invalid merge state", "GitHub devolvió un estado de fusión inválido")
	}
	r.Snapshot.CheckedAt = time.Now().UTC()
	return r
}

// Only the current publication may replace its cache; remote merge never changes local task status.
func applyGithubPRFollowup(task Task, old githubPRFollowup, result githubPRFollowupResult) (githubPRFollowup, bool) {
	if task.Repo != result.Repo || task.ID != result.TaskID || task.Publication == nil || !sameGithubPRSnapshot(*task.Publication, result.Publication) || task.Publication.Complete != result.Publication.Complete {
		return old, false
	}
	if result.Snapshot.Error != "" {
		old.Loading, old.Error = false, result.Snapshot.Error
		return old, true
	}
	return result.Snapshot, true
}

// Observed checks are not proof that all branch protection requirements passed.
func githubPRChecksSummary(checks []githubPRCheck) string {
	if len(checks) == 0 {
		return "none"
	}
	pending, unknown := false, false
	for _, check := range checks {
		var state string
		switch check.Type {
		case "CheckRun":
			if check.Status != "COMPLETED" {
				pending = true
				continue
			}
			state = check.Conclusion
		case "StatusContext":
			state = check.State
		default:
			unknown = true
			continue
		}
		switch state {
		case "FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE":
			return "failed"
		case "SUCCESS", "NEUTRAL", "SKIPPED":
		case "PENDING", "EXPECTED", "":
			pending = true
		default:
			unknown = true
		}
	}
	if unknown {
		return "unknown"
	}
	if pending {
		return "pending"
	}
	return "passed"
}
