use sqlx::{Row, SqlitePool};
use uuid::Uuid;

/// Persistent link between a repository and its ad-hoc scratch workspace.
///
/// A repository has at most one scratch workspace (enforced by `UNIQUE(repo_id)`).
/// Queries here are runtime-checked (`sqlx::query`) so that adding the new table
/// does not require regenerating the sqlx offline cache.
pub struct ScratchWorkspace;

impl ScratchWorkspace {
    /// Look up the workspace_id of the scratch workspace for a given repo.
    pub async fn find_workspace_id_for_repo(
        pool: &SqlitePool,
        repo_id: Uuid,
    ) -> Result<Option<Uuid>, sqlx::Error> {
        let row = sqlx::query("SELECT workspace_id FROM scratch_workspaces WHERE repo_id = ?")
            .bind(repo_id)
            .fetch_optional(pool)
            .await?;

        row.map(|r| r.try_get::<Uuid, _>(0)).transpose()
    }

    /// Insert a new scratch workspace linkage.
    ///
    /// Enforces one scratch workspace per repository at the SQL layer.
    pub async fn create(
        pool: &SqlitePool,
        workspace_id: Uuid,
        repo_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("INSERT INTO scratch_workspaces (workspace_id, repo_id) VALUES (?, ?)")
            .bind(workspace_id)
            .bind(repo_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Return the ids of every workspace tagged as a scratch workspace.
    ///
    /// Callers use this to filter scratch workspaces out of the regular
    /// workspace listing (the ad-hoc panel is invisible in the sidebar).
    pub async fn all_workspace_ids(pool: &SqlitePool) -> Result<Vec<Uuid>, sqlx::Error> {
        let rows = sqlx::query("SELECT workspace_id FROM scratch_workspaces")
            .fetch_all(pool)
            .await?;

        rows.into_iter().map(|r| r.try_get::<Uuid, _>(0)).collect()
    }

    /// Return true if the given workspace is a scratch workspace.
    pub async fn is_scratch(pool: &SqlitePool, workspace_id: Uuid) -> Result<bool, sqlx::Error> {
        let row = sqlx::query("SELECT 1 FROM scratch_workspaces WHERE workspace_id = ?")
            .bind(workspace_id)
            .fetch_optional(pool)
            .await?;
        Ok(row.is_some())
    }
}
