//! Wire result of the server-side app-error issue lookup.
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Lookup {
    Checking,
    Existing { url: String },
    Missing,
    Disabled,
    Failed,
}

/// Only the build environment configures the optional credential.
pub fn token() -> Option<&'static str> {
    option_env!("FLUKE_GITHUB_ISSUES_TOKEN").filter(|value| !value.trim().is_empty())
}
