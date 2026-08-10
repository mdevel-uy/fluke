use std::sync::OnceLock;

use regex::Regex;
use uuid::Uuid;

pub fn git_branch_id(input: &str) -> String {
    // 1. lowercase
    let lower = input.to_lowercase();

    // 2. replace non-alphanumerics with hyphens
    let re = Regex::new(r"[^a-z0-9]+").unwrap();
    let slug = re.replace_all(&lower, "-");

    // 3. trim extra hyphens
    let trimmed = slug.trim_matches('-');

    // 4. take up to 16 chars, then trim trailing hyphens again
    let cut: String = trimmed.chars().take(16).collect();
    cut.trim_end_matches('-').to_string()
}

pub fn short_uuid(u: &Uuid) -> String {
    // to_simple() gives you a 32-char hex string with no hyphens
    let full = u.simple().to_string();
    full.chars().take(4).collect() // grab the first 4 chars
}

/// True when `text` contains a direct GitHub CLI write invocation that the
/// factory wants routed through the agent-actions outbox instead of executed
/// by the agent. Kept in lockstep with the CI factory-guard for repo prompts
/// (issue #549) so souls (persisted in DB) and prompts (versioned in the
/// repo) share one definition of "gh write".
pub fn has_gh_write_patterns(text: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(
            r"gh\s+(pr|issue)\s+(create|close|comment|review)\b|gh\s+api\s+-X\s+(POST|PATCH|DELETE)\b",
        )
        .expect("valid gh-write regex")
    });
    re.is_match(text)
}

pub fn truncate_to_char_boundary(content: &str, max_len: usize) -> &str {
    if content.len() <= max_len {
        return content;
    }

    let cutoff = content
        .char_indices()
        .map(|(idx, _)| idx)
        .chain(std::iter::once(content.len()))
        .take_while(|&idx| idx <= max_len)
        .last()
        .unwrap_or(0);

    debug_assert!(content.is_char_boundary(cutoff));
    &content[..cutoff]
}

#[cfg(test)]
mod tests {

    #[test]
    fn test_truncate_to_char_boundary() {
        use super::truncate_to_char_boundary;

        let input = "a".repeat(10);
        assert_eq!(truncate_to_char_boundary(&input, 7), "a".repeat(7));

        let input = "hello world";
        assert_eq!(truncate_to_char_boundary(input, input.len()), input);

        let input = "🔥🔥🔥"; // each fire emoji is 4 bytes
        assert_eq!(truncate_to_char_boundary(input, 5), "🔥");
        assert_eq!(truncate_to_char_boundary(input, 3), "");
    }

    #[test]
    fn detects_gh_pr_and_issue_writes() {
        use super::has_gh_write_patterns;

        for sample in [
            "gh pr create --title foo",
            "gh pr close 12",
            "gh pr comment 12 -b hi",
            "gh pr review --approve 12",
            "gh issue create --title bug",
            "gh issue close 42",
            "gh issue comment 42 -b thanks",
            "gh issue review 42",
            "  gh   pr   create   ",
            "please run `gh pr create` when done",
        ] {
            assert!(
                has_gh_write_patterns(sample),
                "expected write match in: {sample:?}"
            );
        }
    }

    #[test]
    fn detects_gh_api_write_verbs() {
        use super::has_gh_write_patterns;

        for sample in [
            "gh api -X POST /repos/foo/comments",
            "gh api -X PATCH /repos/foo/issues/1",
            "gh api -X DELETE /repos/foo/issues/1/labels/bug",
        ] {
            assert!(
                has_gh_write_patterns(sample),
                "expected write match in: {sample:?}"
            );
        }
    }

    #[test]
    fn ignores_gh_read_and_unrelated_text() {
        use super::has_gh_write_patterns;

        for sample in [
            "",
            "gh pr view 12",
            "gh pr list",
            "gh pr checks 12",
            "gh issue view 42",
            "gh issue list",
            "gh api /user",
            "gh api -X GET /repos/foo",
            "ghost commander",
            "gh_pr_create is a slug",
            "gh api -X POSTX /foo",
        ] {
            assert!(
                !has_gh_write_patterns(sample),
                "did not expect write match in: {sample:?}"
            );
        }
    }
}
