//! Build-time read-only GitHub token; never include it in summaries or logs.
pub fn token() -> Option<&'static str> {
    option_env!("FLUKE_GITHUB_TOKEN").filter(|value| !value.trim().is_empty())
}
