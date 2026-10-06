//! Build-time read-only GitHub token; never include it in summaries or logs.
pub fn token() -> Option<&'static str> {
    option_env!("FLUKE_GITHUB_TOKEN").filter(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    #[test]
    fn build_token_presence_matches_configuration() {
        let expected = option_env!("FLUKE_GITHUB_TOKEN").filter(|value| !value.trim().is_empty());
        assert_eq!(super::token(), expected);
        if let Ok(configuration) = std::env::var("EXPECT_FLUKE_GITHUB_TOKEN") {
            assert_eq!(super::token().is_some(), configuration == "present");
        }
    }
}
