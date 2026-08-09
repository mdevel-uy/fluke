//! Territory-lint helpers for issue #95.
//!
//! Analysts declare the file territory of a task inside a `## Territorio` (or
//! `## Territory` / `## File Territory`) section of the issue body. This
//! module parses that section into a list of file globs, and matches PR diff
//! files against the globs so the orchestrator can (a) post a warning comment
//! on the PR and (b) inject the same warning into the reviewer's prompt when
//! files fall outside the declared territory.
//!
//! The lint is deliberately advisory — never a gate. Cross-domain PRs are
//! legitimate; the warning gives the reviewer (human or LLM) a quick signal
//! that the change touched code the ticket did not explicitly claim, without
//! stopping the workflow.

use std::collections::HashSet;

const SECTION_HEADERS: [&str; 3] = ["territorio", "territory", "file territory"];

/// Extract file globs from the `## Territorio` section of an issue body.
///
/// Scans the prompt for a `## <header>` heading whose name (case-insensitive,
/// trimmed) matches one of [`SECTION_HEADERS`], collects every line until the
/// next `##` heading (or end of input), and returns each backticked
/// path-like token as a glob. Returns an empty vector when the section is
/// missing or contains no path-like tokens.
///
/// Normalisation rules for each extracted token:
/// - If it already contains `*`, keep as-is.
/// - If it contains a `.`, treat as a file path (keep as-is).
/// - Otherwise treat as a directory and append `/**` so a bare
///   `crates/services` matches every file under that directory.
/// - Trailing `/` is stripped before applying the rule above.
///
/// Filtering: tokens must contain either `/` or `.` and must have no
/// whitespace, so freeform commands accidentally backticked in the section
/// (e.g. `` `pnpm run check` ``) are dropped instead of becoming spurious
/// globs.
pub fn parse_territory_globs(prompt: &str) -> Vec<String> {
    let section = extract_section(prompt);
    if section.is_empty() {
        return Vec::new();
    }

    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for token in extract_backticked_tokens(&section) {
        let token = token.trim();
        if !is_path_like(token) {
            continue;
        }
        let glob = normalize_glob(token);
        if seen.insert(glob.clone()) {
            out.push(glob);
        }
    }
    out
}

/// Return the changed files that do not match any of the declared territory
/// globs, in the same order as `files`. When `globs` is empty the function
/// returns an empty vector — an undeclared territory has nothing to lint.
pub fn out_of_territory<'a>(globs: &[String], files: &'a [String]) -> Vec<&'a str> {
    if globs.is_empty() {
        return Vec::new();
    }
    files
        .iter()
        .filter(|f| !globs.iter().any(|g| glob_matches(g, f)))
        .map(String::as_str)
        .collect()
}

/// Build the warning comment body posted on the PR when the diff strays
/// outside the declared territory. Kept in one place so the PR comment and
/// the reviewer-prompt injection share exactly the same wording.
pub fn territory_warning_body(globs: &[String], out_of_scope: &[&str]) -> String {
    let mut body = String::from(
        "⚠️ **Auditoría de territorio**\n\n\
         Los siguientes archivos del diff están fuera del territorio declarado \
         en el issue. Es un aviso, no un bloqueo — puede haber cruces \
         declarados; el reviewer decide.\n\n\
         **Fuera de territorio:**\n",
    );
    for file in out_of_scope {
        body.push_str(&format!("- `{file}`\n"));
    }
    body.push_str("\n**Territorio declarado:**\n");
    for glob in globs {
        body.push_str(&format!("- `{glob}`\n"));
    }
    body
}

// --------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------

fn extract_section(prompt: &str) -> String {
    let mut in_section = false;
    let mut collected: Vec<&str> = Vec::new();
    for line in prompt.lines() {
        if let Some(header) = strip_h2_header(line) {
            let normalized = header.trim().to_ascii_lowercase();
            let normalized = normalized.trim_end_matches(':').trim();
            if SECTION_HEADERS.iter().any(|h| *h == normalized) {
                in_section = true;
                continue;
            }
            if in_section {
                // Next `## ...` header ends the section.
                break;
            }
        }
        if in_section {
            collected.push(line);
        }
    }
    collected.join("\n")
}

/// If `line` starts with `## ` (optionally after leading whitespace) return
/// the header text (everything after `##`). Otherwise `None`. Any header of
/// level `##` (exactly two `#`) is recognised; `#` and `###` are skipped so
/// nested subsections do not accidentally close the territory section.
fn strip_h2_header(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix("##")?;
    // Reject `###+` (peek at first char).
    if rest.starts_with('#') {
        return None;
    }
    // Require a space or end-of-line after `##`.
    if !rest.starts_with(' ') && !rest.is_empty() {
        return None;
    }
    Some(rest.trim_start())
}

fn extract_backticked_tokens(section: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut chars = section.chars();
    let mut buf = String::new();
    let mut in_tick = false;
    while let Some(c) = chars.next() {
        if c == '`' {
            if in_tick {
                out.push(std::mem::take(&mut buf));
                in_tick = false;
            } else {
                in_tick = true;
            }
        } else if in_tick {
            buf.push(c);
        }
    }
    // An unmatched trailing backtick leaves `buf` populated; discard it —
    // parsing a runaway would silently swallow the rest of the section.
    out
}

fn is_path_like(token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    if token.chars().any(char::is_whitespace) {
        return false;
    }
    token.contains('/') || token.contains('.')
}

fn normalize_glob(token: &str) -> String {
    if token.contains('*') {
        return token.to_string();
    }
    if token.contains('.') {
        // Looks like a file — keep literal.
        return token.to_string();
    }
    let trimmed = token.trim_end_matches('/');
    format!("{trimmed}/**")
}

/// Small path-aware glob matcher. Supports `**` (matches zero or more path
/// components), `*` (matches any run of non-slash characters), `?` (single
/// non-slash character), and literal chars. Enough for the territory
/// vocabulary — no character classes, no braces, no escaping — and small
/// enough to reason about without pulling in `globset` (which would require
/// a `Cargo.lock` regen, per `base_instructions.md`).
pub fn glob_matches(pattern: &str, path: &str) -> bool {
    let pat_segs: Vec<&str> = pattern.split('/').collect();
    let path_segs: Vec<&str> = path.split('/').collect();
    match_segments(&pat_segs, &path_segs)
}

fn match_segments(pat: &[&str], path: &[&str]) -> bool {
    match (pat.split_first(), path.split_first()) {
        (None, None) => true,
        (None, Some(_)) => false,
        (Some((p, prest)), None) => {
            // The only pattern that matches an empty remainder is a trailing
            // `**` (possibly followed by more `**`s).
            *p == "**" && match_segments(prest, path)
        }
        (Some((p, prest)), Some((t, trest))) => {
            if *p == "**" {
                // ** matches zero or more segments.
                if match_segments(prest, path) {
                    return true;
                }
                match_segments(pat, trest)
            } else if match_one_segment(p.as_bytes(), t.as_bytes()) {
                match_segments(prest, trest)
            } else {
                false
            }
        }
    }
}

fn match_one_segment(pat: &[u8], text: &[u8]) -> bool {
    // Iterative wildcard match for a single segment (no slashes involved).
    // Handles `*` (zero or more), `?` (exactly one), literal chars.
    let mut i = 0usize;
    let mut j = 0usize;
    let mut star_pat: Option<usize> = None;
    let mut star_text: usize = 0;
    while j < text.len() {
        if i < pat.len() && (pat[i] == b'?' || pat[i] == text[j]) {
            i += 1;
            j += 1;
        } else if i < pat.len() && pat[i] == b'*' {
            star_pat = Some(i);
            star_text = j;
            i += 1;
        } else if let Some(sp) = star_pat {
            i = sp + 1;
            star_text += 1;
            j = star_text;
        } else {
            return false;
        }
    }
    while i < pat.len() && pat[i] == b'*' {
        i += 1;
    }
    i == pat.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bulleted_backticked_paths() {
        let prompt = r#"
Some intro.

## Territorio

- `crates/services/src/services/quick_action_prompts.rs`
- `crates/services/src/services/worker_orchestrator.rs` (armado del prompt)
- `crates/server/src/routes/workspaces/pr.rs`
- `crates/services/src/services/git_host/*` (métodos nuevos si faltan)

## Criterios
- foo
"#;
        let globs = parse_territory_globs(prompt);
        assert_eq!(
            globs,
            vec![
                "crates/services/src/services/quick_action_prompts.rs",
                "crates/services/src/services/worker_orchestrator.rs",
                "crates/server/src/routes/workspaces/pr.rs",
                "crates/services/src/services/git_host/*",
            ]
        );
    }

    #[test]
    fn parses_prose_style_territory_and_normalizes_directories() {
        // Real-world sample from an early issue: a paragraph of free text
        // with backticked directory names mixed with prose. Bare directory
        // tokens must be normalized to `<dir>/**` so `crates/services`
        // catches `crates/services/src/foo.rs`.
        let prompt = r#"
## Territorio

`crates/services` (container.rs + worker_orchestrator) + `crates/services/base_instructions.md`.
"#;
        let globs = parse_territory_globs(prompt);
        assert_eq!(
            globs,
            vec![
                "crates/services/**".to_string(),
                "crates/services/base_instructions.md".to_string(),
            ]
        );
    }

    #[test]
    fn skips_non_path_backticked_tokens() {
        // Commands and env vars often appear in a territory section
        // (`pnpm run check`, `BASE_SHA`, `--watch`). They must not be
        // promoted to globs.
        let prompt = r#"
## Territorio

- `crates/services/**`
- `pnpm run check`
- `BASE_SHA`
"#;
        assert_eq!(parse_territory_globs(prompt), vec!["crates/services/**"]);
    }

    #[test]
    fn returns_empty_when_no_section_header() {
        let prompt = "Just some description with no territory declared.";
        assert!(parse_territory_globs(prompt).is_empty());
    }

    #[test]
    fn accepts_english_header_and_trailing_colon() {
        let prompt = "## Territory:\n\n- `crates/db/**`\n";
        assert_eq!(parse_territory_globs(prompt), vec!["crates/db/**"]);
    }

    #[test]
    fn glob_matches_directory_wildcards() {
        assert!(glob_matches(
            "crates/services/**",
            "crates/services/src/foo.rs"
        ));
        assert!(glob_matches("crates/services/**", "crates/services/lib.rs"));
        assert!(!glob_matches("crates/services/**", "crates/db/lib.rs"));
    }

    #[test]
    fn glob_matches_single_star_within_segment() {
        assert!(glob_matches("crates/*/lib.rs", "crates/services/lib.rs"));
        assert!(!glob_matches(
            "crates/*/lib.rs",
            "crates/services/src/lib.rs"
        ));
    }

    #[test]
    fn glob_matches_literal_file_path() {
        assert!(glob_matches(
            "crates/db/models/worker_task.rs",
            "crates/db/models/worker_task.rs"
        ));
        assert!(!glob_matches(
            "crates/db/models/worker_task.rs",
            "crates/db/models/worker.rs"
        ));
    }

    #[test]
    fn out_of_territory_flags_only_unmatched_files() {
        let globs = vec![
            "crates/services/**".to_string(),
            "crates/db/models/worker_task.rs".to_string(),
        ];
        let files = vec![
            "crates/services/src/foo.rs".to_string(),
            "crates/db/models/worker_task.rs".to_string(),
            "packages/local-web/src/components/Foo.tsx".to_string(),
        ];
        let out = out_of_territory(&globs, &files);
        assert_eq!(out, vec!["packages/local-web/src/components/Foo.tsx"]);
    }

    #[test]
    fn out_of_territory_is_noop_when_no_globs_declared() {
        let globs: Vec<String> = Vec::new();
        let files = vec!["foo.rs".to_string()];
        assert!(out_of_territory(&globs, &files).is_empty());
    }

    #[test]
    fn warning_body_lists_both_sections() {
        let body = territory_warning_body(
            &["crates/services/**".to_string()],
            &["packages/local-web/src/Foo.tsx"],
        );
        assert!(body.contains("Fuera de territorio"));
        assert!(body.contains("`packages/local-web/src/Foo.tsx`"));
        assert!(body.contains("Territorio declarado"));
        assert!(body.contains("`crates/services/**`"));
    }
}
