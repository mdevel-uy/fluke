use std::{
    path::{Component, PathBuf},
    process::Command,
};

use axum::{
    Json, Router,
    extract::Path,
    response::Json as ResponseJson,
    routing::{delete, get, post},
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utils::response::ApiResponse;

use crate::{DeploymentImpl, error::ApiError};

#[derive(Debug, Serialize, TS)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Deserialize, TS)]
pub struct InstallSkillRequest {
    pub url: String,
}

fn skills_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
    PathBuf::from(home).join(".claude").join("skills")
}

/// Validate that a skill name is safe and the resolved path stays inside
/// `~/.claude/skills`. Returns the destination directory.
fn validate_skill_path(name: &str) -> Result<PathBuf, ApiError> {
    if name.is_empty() {
        return Err(ApiError::BadRequest("skill name is empty".into()));
    }

    for component in PathBuf::from(name).components() {
        match component {
            Component::Normal(_) => {}
            _ => {
                return Err(ApiError::BadRequest(format!("invalid skill name: {name}")));
            }
        }
    }

    let base = skills_dir();
    let dest = base.join(name);

    // Verify via string prefix that dest is still inside the skills dir.
    let base_str = base.to_string_lossy().to_string();
    let dest_str = dest.to_string_lossy().to_string();
    if !dest_str.starts_with(&base_str) {
        return Err(ApiError::BadRequest("path traversal detected".into()));
    }

    Ok(dest)
}

/// Parse `name` and `description` from a SKILL.md YAML frontmatter block.
fn parse_skill_md(content: &str) -> (Option<String>, Option<String>) {
    let trimmed = content.trim();
    if !trimmed.starts_with("---") {
        return (None, None);
    }
    let inner = &trimmed[3..];
    let Some(end) = inner.find("---") else {
        return (None, None);
    };
    let frontmatter = &inner[..end];

    let mut name = None;
    let mut description = None;

    for line in frontmatter.lines() {
        if let Some(rest) = line.strip_prefix("name:") {
            name = Some(rest.trim().trim_matches('"').to_string());
        } else if let Some(rest) = line.strip_prefix("description:") {
            description = Some(rest.trim().trim_matches('"').to_string());
        }
    }

    (name, description)
}

fn read_skill(dir: &std::path::Path) -> Option<SkillInfo> {
    let dir_name = dir.file_name()?.to_string_lossy().to_string();
    let skill_md = dir.join("SKILL.md");

    let (parsed_name, description) = if skill_md.exists() {
        let content = std::fs::read_to_string(&skill_md).ok()?;
        parse_skill_md(&content)
    } else {
        (None, None)
    };

    Some(SkillInfo {
        name: parsed_name.unwrap_or(dir_name),
        description: description.unwrap_or_default(),
    })
}

pub async fn list_skills() -> Result<ResponseJson<ApiResponse<Vec<SkillInfo>>>, ApiError> {
    let base = skills_dir();

    if !base.exists() {
        return Ok(ResponseJson(ApiResponse::success(vec![])));
    }

    let mut skills = Vec::new();
    for entry in std::fs::read_dir(&base)?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(skill) = read_skill(&path) {
                skills.push(skill);
            }
        }
    }

    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(ResponseJson(ApiResponse::success(skills)))
}

pub async fn install_skill(
    Json(payload): Json<InstallSkillRequest>,
) -> Result<ResponseJson<ApiResponse<SkillInfo>>, ApiError> {
    let url = payload.url.trim().to_string();
    if url.is_empty() {
        return Err(ApiError::BadRequest("url is required".into()));
    }

    let raw_name = url
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .trim_end_matches(".git")
        .to_string();

    if raw_name.is_empty() {
        return Err(ApiError::BadRequest(
            "could not derive skill name from URL".into(),
        ));
    }

    let dest = validate_skill_path(&raw_name)?;

    if dest.exists() {
        return Err(ApiError::Conflict(format!(
            "skill '{raw_name}' is already installed"
        )));
    }

    std::fs::create_dir_all(skills_dir())?;

    let output = Command::new("git")
        .args(["clone", "--depth", "1", &url, dest.to_str().unwrap_or("")])
        .output()
        .map_err(|e| ApiError::BadRequest(format!("failed to run git: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError::BadGateway(format!("git clone failed: {stderr}")));
    }

    let skill = read_skill(&dest).ok_or_else(|| {
        ApiError::BadRequest(format!("skill cloned but could not be read: {raw_name}"))
    })?;

    Ok(ResponseJson(ApiResponse::success(skill)))
}

pub async fn delete_skill(
    Path(name): Path<String>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let dest = validate_skill_path(&name)?;

    if !dest.exists() {
        return Err(ApiError::BadRequest(format!("skill '{name}' not found")));
    }

    std::fs::remove_dir_all(&dest)?;

    Ok(ResponseJson(ApiResponse::success(())))
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/skills", get(list_skills).post(install_skill))
        .route("/skills/{name}", delete(delete_skill))
}
