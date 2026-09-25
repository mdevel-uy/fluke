use std::{
    collections::HashSet,
    io::{Cursor, Write},
    path::{Path, PathBuf},
};

use axum::{
    Router,
    body::Body,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::Response,
    routing::get,
};
use chrono::Utc;
use db::models::repo::Repo;
use deployment::Deployment;
use relay_client::RELAY_HEADER;
use serde::Serialize;
use sqlx::SqlitePool;
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

/// Live SQLite files skipped when walking `asset_dir`. The consistent
/// snapshot produced by `VACUUM INTO` is added to the archive in their place,
/// so restore does not need to reconcile a partial rollback journal.
const LIVE_DB_FILES: &[&str] = &[
    "db.v2.sqlite",
    "db.v2.sqlite-journal",
    "db.v2.sqlite-wal",
    "db.v2.sqlite-shm",
];

/// Path (inside the archive) where the consistent database snapshot is
/// stored. Matches the on-disk name so restore is a straight copy back into
/// `asset_dir/`.
const DB_ARCHIVE_ENTRY: &str = "asset_dir/db.v2.sqlite";

/// Response header exposing how many items had issues during the export.
/// The frontend reads this to render a "N items had issues" banner without
/// having to open manifest.json.
const EXPORT_WARNINGS_HEADER: &str = "x-fluke-export-warnings";

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
    /// Manifest text is intentionally English-only technical documentation
    /// bundled inside the archive. The equivalent user-facing strings live
    /// in `packages/web-core/src/i18n/locales/*/settings.json` under
    /// `settings.data.restore.*` and must be kept in sync manually when the
    /// restore procedure changes.
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
    /// Hardcoded English defaults for the manifest. Duplicates the wording
    /// of `settings.data.restore.*` in the i18n bundle on purpose: the
    /// manifest travels inside the zip and must remain readable without any
    /// runtime i18n context. Keep both in sync when the restore flow
    /// changes.
    fn english_manifest_defaults() -> Self {
        Self {
            summary: "Full fluke instance backup for offboarding.".to_string(),
            steps: vec![
                "Install a fresh fluke instance on the new host.".to_string(),
                "Stop the fluke process before restoring.".to_string(),
                "Copy the contents of `asset_dir/` into the new instance's data \
                 directory (see docs for the platform-specific location)."
                    .to_string(),
                "Copy each folder under `repos/` back to a path of your choice; \
                 the manifest lists the original source path for each repo."
                    .to_string(),
                "Start fluke and, if a repo's location changed, update the \
                 path from Settings → Repositories."
                    .to_string(),
            ],
        }
    }
}

/// RAII wrapper so a failed export path never leaves the SQLite snapshot
/// behind in `TMPDIR`.
struct TempSnapshot(PathBuf);

impl TempSnapshot {
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempSnapshot {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

async fn download_data_export(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    // The archive is buffered in memory and would blow past the 50 MiB cap
    // of `sign_relay_response` for any non-trivial instance. Restrict the
    // endpoint to direct/local requests; the frontend hides the UI when the
    // selected host is remote so this is defence-in-depth rather than the
    // main gate.
    if is_relay_request(&headers) {
        return Err(ApiError::BadRequest(
            "Data export can only run on the local host; open the app on the \
             machine that hosts fluke and try again."
                .to_string(),
        ));
    }

    let repos = Repo::list_all(&deployment.db().pool).await?;
    let snapshot = snapshot_database(&deployment.db().pool).await?;

    let asset_dir_path = asset_dir();
    let instance_id = utils::assets::instance_id().ok();
    let app_version = env!("CARGO_PKG_VERSION").to_string();

    let (bytes, warnings_count) = task::spawn_blocking(move || {
        // `snapshot` is moved into the blocking task and dropped there so
        // its Drop impl cleans up the temp file even if the archive build
        // itself fails halfway through.
        build_export_archive(asset_dir_path, repos, app_version, instance_id, &snapshot)
    })
    .await
    .map_err(|e| {
        ApiError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("export task panicked: {e}"),
        ))
    })??;

    let filename = format!("fluke-export-{}.zip", Utc::now().format("%Y%m%d-%H%M%S"));
    let content_length = bytes.len();

    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/zip")
        .header(header::CONTENT_LENGTH, content_length)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .header(header::CACHE_CONTROL, "no-store")
        .header(EXPORT_WARNINGS_HEADER, warnings_count)
        .body(Body::from(bytes))
        .map_err(|e| {
            ApiError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("failed to build export response: {e}"),
            ))
        })?;

    // Some CORS/proxy layers strip custom response headers unless they are
    // whitelisted. Advertise the header explicitly so the browser exposes it
    // to the fetch caller.
    response.headers_mut().insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static(EXPORT_WARNINGS_HEADER),
    );
    Ok(response)
}

/// Produce a consistent SQLite snapshot via `VACUUM INTO`. Copying the live
/// `db.v2.sqlite` while mkanban is running would risk capturing pages
/// written mid-commit; VACUUM INTO writes a fully-quiesced copy that is
/// safe to open standalone.
async fn snapshot_database(pool: &SqlitePool) -> Result<TempSnapshot, ApiError> {
    let snapshot_path =
        std::env::temp_dir().join(format!("fluke-export-{}.sqlite", uuid::Uuid::new_v4()));
    // VACUUM INTO does not accept bind parameters; splice the path directly
    // and double any single quotes defensively. The path is UUID-based, so
    // it never contains quotes in practice.
    let escaped = snapshot_path.display().to_string().replace('\'', "''");
    let sql = format!("VACUUM INTO '{escaped}'");
    sqlx::query(&sql).execute(pool).await?;
    Ok(TempSnapshot(snapshot_path))
}

fn is_relay_request(headers: &HeaderMap) -> bool {
    headers
        .get(RELAY_HEADER)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim() == "1")
}

/// Build the full export zip in memory. Runs on a blocking thread; safe to
/// perform synchronous IO here. Returns the archive bytes and the number of
/// warnings collected while packaging, so the caller can expose that count
/// to the UI.
fn build_export_archive(
    asset_dir_path: PathBuf,
    repos: Vec<Repo>,
    app_version: String,
    instance_id: Option<String>,
    snapshot: &TempSnapshot,
) -> Result<(Vec<u8>, usize), ApiError> {
    let buffer = Cursor::new(Vec::<u8>::new());
    let mut zip = ZipWriter::new(buffer);
    let file_opts =
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let dir_opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    let mut warnings = Vec::new();
    let mut manifest_repos = Vec::with_capacity(repos.len());

    // 1) The asset directory — mkanban's own data (config, profiles,
    //    guidelines, credentials, attachments, ...). The live SQLite files
    //    are skipped here; the VACUUM INTO snapshot is added separately
    //    below so restore always gets a consistent database copy.
    if asset_dir_path.exists() {
        add_directory_to_zip(
            &mut zip,
            &asset_dir_path,
            "asset_dir",
            file_opts,
            dir_opts,
            &[],
            LIVE_DB_FILES,
            None,
            &mut warnings,
        )?;
    } else {
        warnings.push(format!(
            "asset directory not found on disk: {}",
            asset_dir_path.display()
        ));
    }

    // 2) The consistent SQLite snapshot, written under the same relative
    //    name so a restore is a plain copy into the new instance.
    match std::fs::read(snapshot.path()) {
        Ok(bytes) => {
            zip.start_file(DB_ARCHIVE_ENTRY, file_opts)
                .map_err(zip_io)?;
            zip.write_all(&bytes).map_err(ApiError::Io)?;
        }
        Err(e) => warnings.push(format!(
            "failed to read database snapshot at {}: {}",
            snapshot.path().display(),
            e
        )),
    }

    // 3) Each registered repo.
    let mut used_slugs = HashSet::new();
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
                &[],
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

    // 4) manifest.json describing what's inside and how to restore.
    let warnings_count = warnings.len();
    let manifest = ExportManifest {
        generated_at: Utc::now(),
        app_version,
        instance_id,
        asset_dir: asset_dir_path.display().to_string(),
        repositories: manifest_repos,
        warnings,
        restore_instructions: RestoreInstructions::english_manifest_defaults(),
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
    Ok((result.into_inner(), warnings_count))
}

/// Recursively adds `source_dir` into the zip under `archive_root`.
/// Skips any directory whose file name matches `skip_dir_names`, and any
/// direct file whose name matches `skip_file_names` (only at the root of
/// `source_dir`, since that's what all current callers need).
/// Files larger than `max_file_size` bytes (when Some) are recorded as
/// warnings and left out.
#[allow(clippy::too_many_arguments)]
fn add_directory_to_zip(
    zip: &mut ZipWriter<Cursor<Vec<u8>>>,
    source_dir: &Path,
    archive_root: &str,
    file_opts: SimpleFileOptions,
    dir_opts: SimpleFileOptions,
    skip_dir_names: &[&str],
    skip_root_file_names: &[&str],
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

        // Skip named files at the root of `source_dir` (used to drop the
        // live SQLite files in favour of the VACUUM INTO snapshot).
        if entry.depth() == 1 {
            if let Some(name) = entry.file_name().to_str() {
                if skip_root_file_names.contains(&name) {
                    continue;
                }
            }
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

fn unique_slug(name: &str, used: &mut HashSet<String>) -> String {
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
        let mut used = HashSet::new();
        assert_eq!(unique_slug("Repo", &mut used), "Repo");
        assert_eq!(unique_slug("Repo", &mut used), "Repo-2");
        assert_eq!(unique_slug("Repo", &mut used), "Repo-3");
        assert_eq!(unique_slug("///", &mut used), "repo");
    }

    #[test]
    fn is_relay_request_reads_header() {
        let mut headers = HeaderMap::new();
        assert!(!is_relay_request(&headers));
        headers.insert(RELAY_HEADER, HeaderValue::from_static("1"));
        assert!(is_relay_request(&headers));
        headers.insert(RELAY_HEADER, HeaderValue::from_static("0"));
        assert!(!is_relay_request(&headers));
    }
}
