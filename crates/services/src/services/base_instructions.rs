//! System-level base instructions embedded at build time.
//!
//! These are injected into every worker prompt before the worker soul.
//! They are immutable from the UI; changing them requires a code change,
//! review, and redeploy — exactly like any other operational rule.
//!
//! Operators may append extra instructions without a rebuild by setting the
//! `VK_BASE_INSTRUCTIONS_EXTRA` environment variable to the path of a
//! markdown file mounted read-only in the container. If the variable is
//! absent or the file cannot be read, only the embedded content is used.

const EMBEDDED: &str = include_str!("base_instructions.md");
const ENV_EXTRA: &str = "VK_BASE_INSTRUCTIONS_EXTRA";

/// Returns the effective base instructions: the embedded markdown plus any
/// extra content from the file pointed to by `VK_BASE_INSTRUCTIONS_EXTRA`.
///
/// Silently falls back to the embedded-only content if the env var is absent
/// or the file cannot be read.
pub fn effective_base_instructions() -> String {
    let extra = std::env::var(ENV_EXTRA)
        .ok()
        .filter(|p| !p.is_empty())
        .and_then(|path| std::fs::read_to_string(&path).ok());

    match extra {
        Some(extra) if !extra.trim().is_empty() => {
            format!("{}\n\n{}", EMBEDDED.trim(), extra.trim())
        }
        _ => EMBEDDED.trim().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_content_is_non_empty() {
        let instructions = effective_base_instructions();
        assert!(!instructions.is_empty());
        assert!(instructions.contains("PR"));
    }

    #[test]
    fn missing_extra_env_returns_embedded_only() {
        // Ensure the env var is not set for this test.
        // SAFETY: single-threaded test context.
        unsafe {
            std::env::remove_var(ENV_EXTRA);
        }
        let instructions = effective_base_instructions();
        assert_eq!(instructions, EMBEDDED.trim());
    }
}
