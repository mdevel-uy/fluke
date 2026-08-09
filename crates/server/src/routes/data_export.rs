use std::{
    io::{Cursor, Write},
    path::{Path, PathBuf},
};

use axum::{
    Router,
    body::Body,
    extract::State,
    http::{StatusCode, header},
    response::Response,
    routing::get,
};
use chrono::Utc;
use db::models::repo::Repo;
use deployment::Deployment;
use serde::Serialize;
use tokio::task;
use utils::assets::asset_dir;
use zip::{ZipWriter, write::SimpleFileOptions};

use crate::{DeploymentImpl, error::ApiError};

/// Directories skipped inside each user repo when packaging the export.
/// Kept intentionally conservative: build/dependency dirs that any restore
/// workflow will regenerate. `.git` is preserved so the repository history
/// travels with the archive.
const REPO_EXCLUDED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".gradle",
    ".idea",
    ".vscode",
];

/// Per-file safety cap when packaging repos. Files above this size are
/// skipped and recorded in the manifest instead of ballooning the archive.
const MAX_REPO_FILE_BYTES: u64 = 100 * 1024 * 1024;

pub fn router() -> Router<DeploymentImpl> {
    Router::new().route("/system/data-export", get(download_data_export))
}

#[derive(Debug, Serialize)]
struct ExportManifest {
    generated_at: chrono::DateTime<Utc>,
    app_version: String,
    instance_id: Option<String>,
    asset_dir: String,
    repositories: Vec<ManifestRepo>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    warnings: Vec<String>,
    restore_instructions: RestoreInstructions,
}

#[derive(Debug, Serialize)]
struct ManifestRepo {
    id: String,
    name: String,
    display_name: String,
    source_path: String,
    /// Path inside the archive where this repo was written. `None` when the
    /// source path was unreachable at export time.
    archive_path: Option<String>,
}

#[derive(Debug, Serialize)]
struct RestoreInstructions {
    summary: String,
    steps: Vec<String>,
}

impl RestoreInstructions {
    fn default_english() -> Self {
        Self {
            summary: "Full mkanban instance backup for offboarding.".to_string(),
            steps: vec![
                "Install a fresh mkanban instance on the new host.".to_string(),
                "Stop the mkanban process before restoring.".to_string(),
                "Copy the contents of `asset_dir/` into the new instance's data \
                 directory (see docs for the platform-specific location)."
                    .to_string(),
                "Copy each folder under `repos/` back to a path of your choice; \
                 the manifest lists the original source path for each repo."
                    .to_string(),
                "Start mkanban and, if a repo's location changed, update the \
                 path from Settings → Repositories."
                    .to_string(),
            ],
        }
    }
}

async fn download_data_export(
    State(deployment): State<DeploymentImpl>,
) -> Result<Response, ApiError> {
    let repos = Repo::list_all(&deployment.db().pool).await?;

    let asset_dir_path = asset_dir();
    let instance_id = utils::assets::instance_id().ok();
    let app_version = env!("CARGO_PKG_VERSION").to_string();

    let bytes = task::spawn_blocking(move || {
        build_export_archive(asset_dir_path, repos, app_version, instance_id)
    })
    .await
    .map_err(|e| {
        ApiError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("export task panicked: {e}"),
        ))
    })??;

    let filename = format!("mkanban-export-{}.zip", Utc::now().format("%Y%m%d-%H%M%S"));

    let content_length = bytes.len();
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/zip")
        .header(header::CONTENT_LENGTH, content_length)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(bytes))
        .map_err(|e| {
            ApiError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("failed to build export response: {e}"),
            ))
        })
}

/// Build the full export zip in memory. Runs on a blocking thread; safe to
/// perform synchronous IO here.
fn build_export_archive(
    asset_dir_path: PathBuf,
    repos: Vec<Repo>,
    app_version: String,
    instance_id: Option<String>,
) -> Result<Vec<u8>, ApiError> {
    let buffer = Cursor::new(Vec::<u8>::new());
    let mut zip = ZipWriter::new(buffer);
    let file_opts =
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let dir_opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    let mut warnings = Vec::new();
    let mut manifest_repos = Vec::with_capacity(repos.len());

    // 1) The asset directory — mkanban's own data (SQLite DB, config, profiles, ...).
    if asset_dir_path.exists() {
        add_directory_to_zip(
            &mut zip,
            &asset_dir_path,
            "asset_dir",
            file_opts,
            dir_opts,
            &[],
            None,
            &mut warnings,
        )?;
    } else {
        warnings.push(format!(
            "asset directory not found on disk: {}",
            asset_dir_path.display()
        ));
    }

    // 2) Each registered repo.
    let mut used_slugs = std::collections::HashSet::new();
    for repo in &repos {
        let source_path = repo.path.clone();
        let slug = unique_slug(&repo.name, &mut used_slugs);
        let archive_root = format!("repos/{slug}");

        let mut archive_path: Option<String> = None;
        if source_path.exists() && source_path.is_dir() {
            match add_directory_to_zip(
                &mut zip,
                &source_path,
                &archive_root,
                file_opts,
                dir_opts,
                REPO_EXCLUDED_DIRS,
                Some(MAX_REPO_FILE_BYTES),
                &mut warnings,
            ) {
                Ok(()) => archive_path = Some(archive_root.clone()),
                Err(e) => warnings.push(format!(
                    "failed to package repo '{}' at {}: {}",
                    repo.name,
                    source_path.display(),
                    e
                )),
            }
        } else {
            warnings.push(format!(
                "repo '{}' source path is missing or not a directory: {}",
                repo.name,
                source_path.display()
            ));
        }

        manifest_repos.push(ManifestRepo {
            id: repo.id.to_string(),
            name: repo.name.clone(),
            display_name: repo.display_name.clone(),
            source_path: source_path.display().to_string(),
            archive_path,
        });
    }

    // 3) manifest.json describing what's inside and how to restore.
    let manifest = ExportManifest {
        generated_at: Utc::now(),
        app_version,
        instance_id,
        asset_dir: asset_dir_path.display().to_string(),
        repositories: manifest_repos,
        warnings,
        restore_instructions: RestoreInstructions::default_english(),
    };
    let manifest_json = serde_json::to_vec_pretty(&manifest).map_err(|e| {
        ApiError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("failed to serialize export manifest: {e}"),
        ))
    })?;
    zip.start_file("manifest.json", file_opts).map_err(zip_io)?;
    zip.write_all(&manifest_json).map_err(ApiError::Io)?;

    let result = zip.finish().map_err(zip_io)?;
    Ok(result.into_inner())
}

/// Recursively adds `source_dir` into the zip under `archive_root`.
/// Skips any directory whose file name matches `skip_dir_names`.
/// Files larger than `max_file_size` bytes (when Some) are recorded as
/// warnings and left out.
fn add_directory_to_zip(
    zip: &mut ZipWriter<Cursor<Vec<u8>>>,
    source_dir: &Path,
    archive_root: &str,
    file_opts: SimpleFileOptions,
    dir_opts: SimpleFileOptions,
    skip_dir_names: &[&str],
    max_file_size: Option<u64>,
    warnings: &mut Vec<String>,
) -> Result<(), ApiError> {
    // Emit the root directory entry so empty roots survive the round-trip.
    zip.add_directory(format!("{archive_root}/"), dir_opts)
        .map_err(zip_io)?;

    let walker = walkdir::WalkDir::new(source_dir).follow_links(false);
    for entry in walker.into_iter().filter_entry(|e| {
        // Root always kept; below the root, prune excluded dir names.
        if e.depth() == 0 {
            return true;
        }
        if e.file_type().is_dir() {
            match e.file_name().to_str() {
                Some(name) if skip_dir_names.contains(&name) => false,
                _ => true,
            }
        } else {
            true
        }
    }) {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                warnings.push(format!(
                    "skipped entry under {}: {}",
                    source_dir.display(),
                    e
                ));
                continue;
            }
        };
        if entry.depth() == 0 {
            continue;
        }
        let rel = match entry.path().strip_prefix(source_dir) {
            Ok(rel) => rel,
            Err(_) => continue,
        };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let archive_entry = format!("{archive_root}/{rel_str}");

        let file_type = entry.file_type();
        if file_type.is_dir() {
            zip.add_directory(format!("{archive_entry}/"), dir_opts)
                .map_err(zip_io)?;
            continue;
        }
        if !file_type.is_file() {
            // Skip symlinks, sockets, block devices, etc.
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(e) => {
                warnings.push(format!("unable to stat {}: {}", entry.path().display(), e));
                continue;
            }
        };
        if let Some(max) = max_file_size {
            if metadata.len() > max {
                warnings.push(format!(
                    "skipped oversized file ({} bytes > {} cap): {}",
                    metadata.len(),
                    max,
                    entry.path().display()
                ));
                continue;
            }
        }

        let data = match std::fs::read(entry.path()) {
            Ok(d) => d,
            Err(e) => {
                warnings.push(format!("unable to read {}: {}", entry.path().display(), e));
                continue;
            }
        };
        zip.start_file(&archive_entry, file_opts).map_err(zip_io)?;
        zip.write_all(&data).map_err(ApiError::Io)?;
    }
    Ok(())
}

fn unique_slug(name: &str, used: &mut std::collections::HashSet<String>) -> String {
    let base = sanitize_slug(name);
    let base = if base.is_empty() {
        "repo".to_string()
    } else {
        base
    };
    if used.insert(base.clone()) {
        return base;
    }
    for n in 2u32.. {
        let candidate = format!("{base}-{n}");
        if used.insert(candidate.clone()) {
            return candidate;
        }
    }
    unreachable!("slug counter exhausted");
}

fn sanitize_slug(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut prev_dash = false;
    for ch in name.chars() {
        let keep = ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.';
        if keep {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches(|c| c == '-' || c == '.').to_string()
}

fn zip_io(err: zip::result::ZipError) -> ApiError {
    ApiError::Io(std::io::Error::new(
        std::io::ErrorKind::Other,
        format!("zip error: {err}"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_replaces_unsafe_chars() {
        assert_eq!(sanitize_slug("my repo/name"), "my-repo-name");
        assert_eq!(sanitize_slug("../etc/passwd"), "etc-passwd");
        assert_eq!(sanitize_slug("a  b"), "a-b");
        assert_eq!(sanitize_slug(""), "");
    }

    #[test]
    fn unique_slug_collides_gracefully() {
        let mut used = std::collections::HashSet::new();
        assert_eq!(unique_slug("Repo", &mut used), "Repo");
        assert_eq!(unique_slug("Repo", &mut used), "Repo-2");
        assert_eq!(unique_slug("Repo", &mut used), "Repo-3");
        assert_eq!(unique_slug("///", &mut used), "repo");
    }
}
