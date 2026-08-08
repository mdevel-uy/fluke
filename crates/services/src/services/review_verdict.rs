//! `.vk/review.json` — structured reviewer verdict.
//!
//! Contract from REVIEW-LOOP-SPEC.md §A1: the reviewer agent writes one file
//! at `<worktree>/.vk/review.json`, and the orchestrator (not the agent)
//! validates it and submits the review to GitHub with the reviewer's PAT.
//! The `gh pr review` path from the agent's prompt is gone in this PR — the
//! agent produces the verdict, the system produces the effect.
//!
//! Validation is strict on purpose: a malformed or missing file marks the
//! reviewer task `failed` with a legible reason, and the round row moves to
//! `failed` (which does **not** consume a round in the cap). Invalid JSON
//! must never masquerade as a review.
//!
//! What we accept:
//! - `verdict`: `"approve"` | `"request_changes"` (required).
//! - `summary`: non-empty free-text — becomes the review body (required).
//! - `items`: array; optional with `approve`, required (≥1) with
//!   `request_changes`. Each item has an optional `path`+`line` (positioned
//!   inline; omitting them sends the comment to the body), an optional
//!   `severity` (`blocker` | `major` | `minor` | `nit`) recorded for UI
//!   consumption, and a required non-empty `comment`.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Path (relative to the worktree root) where the reviewer agent writes its
/// verdict. Kept as a constant so the prompt template and the parser agree.
pub const REVIEW_JSON_RELATIVE_PATH: &str = ".vk/review.json";

pub const VERDICT_APPROVE: &str = "approve";
pub const VERDICT_REQUEST_CHANGES: &str = "request_changes";

pub const SEVERITY_BLOCKER: &str = "blocker";
pub const SEVERITY_MAJOR: &str = "major";
pub const SEVERITY_MINOR: &str = "minor";
pub const SEVERITY_NIT: &str = "nit";

pub const EVENT_APPROVE: &str = "APPROVE";
pub const EVENT_REQUEST_CHANGES: &str = "REQUEST_CHANGES";

#[derive(Debug, Clone, Deserialize)]
pub struct ReviewVerdict {
    pub verdict: String,
    pub summary: String,
    #[serde(default)]
    pub items: Vec<ReviewItem>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReviewItem {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub line: Option<i64>,
    #[serde(default)]
    pub severity: Option<String>,
    pub comment: String,
}

/// Everything that can go wrong parsing/validating `.vk/review.json`.
/// Serialized to the reviewer task's `failure_reason` so the human sees
/// exactly what the reviewer wrote (or didn't).
#[derive(Debug)]
pub enum VerdictError {
    Missing { path: PathBuf },
    ReadError { path: PathBuf, message: String },
    ParseError { message: String },
    InvalidVerdict(String),
    EmptySummary,
    RequestChangesWithoutItems,
    EmptyComment { index: usize },
    InvalidSeverity { index: usize, value: String },
    InvalidLineWithoutPath { index: usize },
}

impl std::fmt::Display for VerdictError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing { path } => write!(
                f,
                "El reviewer no escribió `{}` — sin veredicto no hay ronda.",
                path.display()
            ),
            Self::ReadError { path, message } => {
                write!(f, "No pude leer `{}`: {message}", path.display())
            }
            Self::ParseError { message } => {
                write!(f, "`.vk/review.json` no es JSON válido: {message}")
            }
            Self::InvalidVerdict(v) => write!(
                f,
                "`verdict` inválido: `{v}`. Valores permitidos: `approve` o `request_changes`."
            ),
            Self::EmptySummary => write!(f, "`summary` no puede estar vacío."),
            Self::RequestChangesWithoutItems => {
                write!(f, "`request_changes` requiere al menos un item en `items`.")
            }
            Self::EmptyComment { index } => {
                write!(f, "`items[{index}].comment` no puede estar vacío.")
            }
            Self::InvalidSeverity { index, value } => write!(
                f,
                "`items[{index}].severity` inválido: `{value}`. \
                 Valores permitidos: `blocker`, `major`, `minor`, `nit`."
            ),
            Self::InvalidLineWithoutPath { index } => write!(
                f,
                "`items[{index}]` trae `line` sin `path`: la línea inline necesita el archivo."
            ),
        }
    }
}

/// Read `<worktree>/.vk/review.json`, parse it, and validate it against the
/// schema. On success returns the verdict ready to be submitted.
pub fn read_and_validate(worktree_path: &Path) -> Result<ReviewVerdict, VerdictError> {
    let full_path = worktree_path.join(REVIEW_JSON_RELATIVE_PATH);
    if !full_path.exists() {
        return Err(VerdictError::Missing { path: full_path });
    }
    let raw = std::fs::read_to_string(&full_path).map_err(|e| VerdictError::ReadError {
        path: full_path.clone(),
        message: e.to_string(),
    })?;
    let verdict: ReviewVerdict =
        serde_json::from_str(&raw).map_err(|e| VerdictError::ParseError {
            message: e.to_string(),
        })?;
    validate(&verdict)?;
    Ok(verdict)
}

fn validate(v: &ReviewVerdict) -> Result<(), VerdictError> {
    match v.verdict.as_str() {
        VERDICT_APPROVE | VERDICT_REQUEST_CHANGES => {}
        other => return Err(VerdictError::InvalidVerdict(other.to_string())),
    }
    if v.summary.trim().is_empty() {
        return Err(VerdictError::EmptySummary);
    }
    if v.verdict == VERDICT_REQUEST_CHANGES && v.items.is_empty() {
        return Err(VerdictError::RequestChangesWithoutItems);
    }
    for (index, item) in v.items.iter().enumerate() {
        if item.comment.trim().is_empty() {
            return Err(VerdictError::EmptyComment { index });
        }
        if let Some(sev) = item.severity.as_deref() {
            match sev {
                SEVERITY_BLOCKER | SEVERITY_MAJOR | SEVERITY_MINOR | SEVERITY_NIT => {}
                other => {
                    return Err(VerdictError::InvalidSeverity {
                        index,
                        value: other.to_string(),
                    });
                }
            }
        }
        if item.line.is_some() && item.path.as_deref().map(str::trim).unwrap_or("").is_empty() {
            return Err(VerdictError::InvalidLineWithoutPath { index });
        }
    }
    Ok(())
}

/// GitHub review event verb for a verdict.
pub fn github_event_for(verdict: &str) -> Option<&'static str> {
    match verdict {
        VERDICT_APPROVE => Some(EVENT_APPROVE),
        VERDICT_REQUEST_CHANGES => Some(EVENT_REQUEST_CHANGES),
        _ => None,
    }
}

/// Does this item have a usable `path` (non-empty after trim)?
fn has_path(item: &ReviewItem) -> bool {
    !item.path.as_deref().map(str::trim).unwrap_or("").is_empty()
}

/// True if the item can be posted as a GitHub inline review comment
/// (needs both a path AND a line — GitHub inline comments are always
/// tied to a specific line).
fn is_inline(item: &ReviewItem) -> bool {
    item.line.is_some() && has_path(item)
}

/// Compose the review body posted to GitHub: the reviewer's summary plus,
/// when present, a trailer listing every item that can't be posted inline.
/// An item goes to the body when it has no `line` — either because the
/// reviewer wanted a general comment (no path/line) or because they wanted
/// to point at a whole file (`path` only). Anything not eligible for inline
/// **must** end up in the body; a silent drop would lose reviewer intent.
pub fn compose_body(verdict: &ReviewVerdict) -> String {
    let summary = verdict.summary.trim();
    let body_items: Vec<&ReviewItem> = verdict
        .items
        .iter()
        .filter(|item| !is_inline(*item))
        .collect();
    if body_items.is_empty() {
        return summary.to_string();
    }
    let mut body = String::with_capacity(summary.len() + 64 + body_items.len() * 96);
    body.push_str(summary);
    body.push_str("\n\n---\n\n");
    body.push_str("**Otros comentarios:**\n");
    for (n, item) in body_items.iter().enumerate() {
        let severity = match item.severity.as_deref() {
            Some(s) => format!(" _({s})_"),
            None => String::new(),
        };
        let location = if has_path(item) {
            format!("`{}` — ", item.path.as_deref().unwrap_or("").trim())
        } else {
            String::new()
        };
        body.push_str(&format!(
            "\n{}. {}{}{}",
            n + 1,
            location,
            item.comment.trim(),
            severity
        ));
    }
    body
}

/// Split items into inline (path+line present) and body-only groups. Inline
/// comments become GitHub `PullRequestReviewComment`s; body-only ones are
/// folded into the review body by [`compose_body`].
pub fn inline_items(verdict: &ReviewVerdict) -> Vec<&ReviewItem> {
    verdict
        .items
        .iter()
        .filter(|item| is_inline(*item))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(json: &str) -> Result<ReviewVerdict, VerdictError> {
        let parsed: ReviewVerdict =
            serde_json::from_str(json).map_err(|e| VerdictError::ParseError {
                message: e.to_string(),
            })?;
        validate(&parsed)?;
        Ok(parsed)
    }

    #[test]
    fn approve_without_items_is_valid() {
        let ok = v(r#"{"verdict":"approve","summary":"LGTM"}"#).unwrap();
        assert_eq!(ok.verdict, VERDICT_APPROVE);
        assert!(ok.items.is_empty());
    }

    #[test]
    fn request_changes_needs_items() {
        let err = v(r#"{"verdict":"request_changes","summary":"nope"}"#).unwrap_err();
        assert!(matches!(err, VerdictError::RequestChangesWithoutItems));
    }

    #[test]
    fn request_changes_with_one_item_is_valid() {
        let ok = v(r#"{"verdict":"request_changes","summary":"nope","items":[
                {"path":"foo.rs","line":10,"severity":"major","comment":"fix this"}
            ]}"#)
        .unwrap();
        assert_eq!(ok.items.len(), 1);
    }

    #[test]
    fn invalid_verdict_rejected() {
        let err = v(r#"{"verdict":"maybe","summary":"..."}"#).unwrap_err();
        assert!(matches!(err, VerdictError::InvalidVerdict(_)));
    }

    #[test]
    fn empty_summary_rejected() {
        let err = v(r#"{"verdict":"approve","summary":"   "}"#).unwrap_err();
        assert!(matches!(err, VerdictError::EmptySummary));
    }

    #[test]
    fn invalid_severity_rejected() {
        let err = v(r#"{"verdict":"request_changes","summary":"...","items":[
                {"comment":"x","severity":"critical"}
            ]}"#)
        .unwrap_err();
        assert!(matches!(err, VerdictError::InvalidSeverity { .. }));
    }

    #[test]
    fn empty_comment_rejected() {
        let err = v(r#"{"verdict":"request_changes","summary":"...","items":[
                {"comment":"   "}
            ]}"#)
        .unwrap_err();
        assert!(matches!(err, VerdictError::EmptyComment { .. }));
    }

    #[test]
    fn line_without_path_rejected() {
        let err = v(r#"{"verdict":"request_changes","summary":"...","items":[
                {"line":42,"comment":"where?"}
            ]}"#)
        .unwrap_err();
        assert!(matches!(err, VerdictError::InvalidLineWithoutPath { .. }));
    }

    #[test]
    fn compose_body_folds_unpositioned_items() {
        let verdict = v(
            r#"{"verdict":"request_changes","summary":"tighten this","items":[
                {"path":"a.rs","line":1,"comment":"inline"},
                {"comment":"body-only","severity":"minor"}
            ]}"#,
        )
        .unwrap();
        let body = compose_body(&verdict);
        assert!(body.contains("tighten this"));
        assert!(body.contains("Otros comentarios"));
        assert!(body.contains("body-only"));
        assert!(!body.contains("inline"));
    }

    /// Regression: `path` without `line` used to be dropped silently — the
    /// item was excluded from inline (needs `line`) AND from the body
    /// (filter treated any `path` as positioned). Now it must land in the
    /// body with the file mentioned as context.
    #[test]
    fn compose_body_includes_path_only_items() {
        let verdict = v(
            r#"{"verdict":"request_changes","summary":"file-level nits","items":[
                {"path":"a.rs","line":1,"comment":"real inline"},
                {"path":"b.rs","comment":"whole-file nit","severity":"minor"}
            ]}"#,
        )
        .unwrap();
        let body = compose_body(&verdict);
        assert!(
            body.contains("whole-file nit"),
            "path-only item must appear in the body, not vanish"
        );
        assert!(
            body.contains("`b.rs`"),
            "path-only item should surface the file it points at"
        );
        assert!(
            !body.contains("real inline"),
            "true inline items still stay out of the body"
        );
        assert_eq!(inline_items(&verdict).len(), 1);
    }

    /// Regression: severity markdown used to be `_(_{s}_)_` which renders
    /// as literal underscores around asterisked text. It should be a clean
    /// italicised `_(severity)_`.
    #[test]
    fn compose_body_severity_uses_clean_markdown() {
        let verdict = v(
            r#"{"verdict":"request_changes","summary":"...","items":[
                {"comment":"c","severity":"blocker"}
            ]}"#,
        )
        .unwrap();
        let body = compose_body(&verdict);
        assert!(
            body.contains("_(blocker)_"),
            "severity should render as _(blocker)_, got: {body}"
        );
        assert!(!body.contains("_(_"), "leftover extra underscores");
    }

    #[test]
    fn missing_file_reports_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let err = read_and_validate(tmp.path()).unwrap_err();
        assert!(matches!(err, VerdictError::Missing { .. }));
    }

    #[test]
    fn round_trip_parse_and_validate() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".vk")).unwrap();
        std::fs::write(
            tmp.path().join(REVIEW_JSON_RELATIVE_PATH),
            r#"{"verdict":"approve","summary":"looks fine"}"#,
        )
        .unwrap();
        let verdict = read_and_validate(tmp.path()).unwrap();
        assert_eq!(verdict.verdict, VERDICT_APPROVE);
    }
}
