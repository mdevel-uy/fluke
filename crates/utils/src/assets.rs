use directories::ProjectDirs;
use rust_embed::RustEmbed;

const PROJECT_ROOT: &str = env!("CARGO_MANIFEST_DIR");

pub fn asset_dir() -> std::path::PathBuf {
    let path = if cfg!(debug_assertions) {
        std::path::PathBuf::from(PROJECT_ROOT).join("../../dev_assets")
    } else {
        prod_asset_dir_path()
    };

    // Ensure the directory exists
    if !path.exists() {
        std::fs::create_dir_all(&path).expect("Failed to create asset directory");
    }

    path
    // ✔ macOS → ~/Library/Application Support/MyApp
    // ✔ Linux → ~/.local/share/myapp   (respects XDG_DATA_HOME)
    // ✔ Windows → %APPDATA%\Example\MyApp
}

pub fn prod_asset_dir_path() -> std::path::PathBuf {
    let dirs = |q: &str, org: &str, app: &str| {
        ProjectDirs::from(q, org, app)
            .expect("OS didn't give us a home directory")
            .data_dir()
            .to_path_buf()
    };
    // Cadena de rebrands, del más reciente al más viejo: vibe-kanban → mkanban → fluke.
    migrate_data_dir(
        &dirs("dev", "fluke", "fluke"),
        &[
            dirs("dev", "mkanban", "mkanban"),
            dirs("ai", "bloop", "vibe-kanban"),
        ],
    )
}

/// Migración del data dir legacy: si `new` todavía no existe, se renombra en el
/// lugar el primer path de `legacy` (ordenados del más reciente al más viejo)
/// que exista. Si el rename falla (permisos, cross-device, dir abierto), se
/// sigue usando el viejo para no arrancar jamás con una DB vacía.
///
/// `repos/` (clones hechos desde la UI) se queda en el path viejo: `repos.path`
/// en la DB guarda el path absoluto y los `.git` de los worktrees vivos apuntan
/// ahí. Los clones nuevos van a `<new>/repos`. Si no se puede devolver `repos/`
/// a su lugar, se deshace el rename entero.
fn migrate_data_dir(new: &std::path::Path, legacy: &[std::path::PathBuf]) -> std::path::PathBuf {
    if new.exists() {
        return new.to_path_buf();
    }
    let Some(old) = legacy.iter().find(|p| p.exists()) else {
        return new.to_path_buf();
    };
    let keep_repos = |()| {
        let moved = new.join("repos");
        if !moved.exists() {
            return Ok(());
        }
        std::fs::create_dir_all(old)
            .and_then(|_| std::fs::rename(&moved, old.join("repos")))
            .inspect_err(|_| {
                let _ = std::fs::remove_dir(old);
                let _ = std::fs::rename(new, old);
            })
    };
    let result = new
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|_| std::fs::rename(old, new))
        .and_then(keep_repos);
    match result {
        Ok(()) => {
            tracing::info!("data dir migrado: {} → {}", old.display(), new.display());
            new.to_path_buf()
        }
        // Si hasta el rollback de `keep_repos` falló, los datos quedaron en `new`.
        Err(e) if new.exists() => {
            tracing::error!(
                "migración del data dir {} → {} a medias: {e}; se usa {} pero repos/ quedó en {} \
                 y repos.path apunta a {}: moverlo a mano",
                old.display(),
                new.display(),
                new.display(),
                new.join("repos").display(),
                old.join("repos").display()
            );
            new.to_path_buf()
        }
        Err(e) => {
            tracing::warn!(
                "no se pudo migrar el data dir {} → {}: {e}; se sigue usando {}",
                old.display(),
                new.display(),
                old.display()
            );
            old.clone()
        }
    }
}

pub fn config_path() -> std::path::PathBuf {
    asset_dir().join("config.json")
}

pub fn profiles_path() -> std::path::PathBuf {
    asset_dir().join("profiles.json")
}

pub fn credentials_path() -> std::path::PathBuf {
    asset_dir().join("credentials.json")
}

/// Archivo de licencia firmada que el operador coloca en el data dir del
/// cliente (o que el heartbeat renueva). Ausente = instancia sin licenciar.
pub fn license_path() -> std::path::PathBuf {
    asset_dir().join("license.json")
}

/// Estado persistido del licenciamiento (último instante observado, para
/// detectar reloj retrocedido; y desde cuándo está degradada, para contar la
/// gracia de un archivo ausente). Separado de `license.json`: este lo escribe
/// la app, aquel lo entrega el operador.
pub fn license_state_path() -> std::path::PathBuf {
    asset_dir().join("license_state.json")
}

/// Identificador estable de la instalación (UUID). Generado en el primer
/// arranque y persistido; ata el heartbeat y las licencias a una instancia.
pub fn instance_id_path() -> std::path::PathBuf {
    asset_dir().join("instance_id")
}

/// Devuelve el `instance_id`, generándolo y persistiéndolo la primera vez.
pub fn instance_id() -> std::io::Result<String> {
    let path = instance_id_path();
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    std::fs::write(&path, &id)?;
    Ok(id)
}

pub fn trusted_keys_path() -> std::path::PathBuf {
    asset_dir().join("trusted_ed25519_public_keys.json")
}

pub fn server_signing_key_path() -> std::path::PathBuf {
    asset_dir().join("server_ed25519_signing_key")
}

pub fn relay_host_credentials_path() -> std::path::PathBuf {
    asset_dir().join("relay_host_credentials.json")
}

/// VAPID keypair (P-256, PKCS#8 PEM) for Web Push (RFC 8292). Generado la
/// primera vez que el servicio de push arranca y persistido en el asset dir
/// junto al resto de credenciales — la clave pública se emite al frontend en
/// `GET /api/push/vapid-key` para registrar el push subscription.
pub fn web_push_vapid_path() -> std::path::PathBuf {
    asset_dir().join("web_push_vapid.json")
}

#[derive(RustEmbed)]
#[folder = "../../assets/sounds"]
pub struct SoundAssets;

#[derive(RustEmbed)]
#[folder = "../../assets/scripts"]
pub struct ScriptAssets;

#[cfg(test)]
mod tests {
    use super::migrate_data_dir;

    /// Borra el dir temporal aunque falle un assert.
    struct TempRoot(std::path::PathBuf);
    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn migrate_data_dir_chain_is_idempotent_and_keeps_db() {
        let tmp =
            TempRoot(std::env::temp_dir().join(format!("fk-migrate-{}", uuid::Uuid::new_v4())));
        let root = &tmp.0;
        let fluke = root.join("fluke").join("data");
        let mkanban = root.join("mkanban");
        let vibe = root.join("vibe-kanban");
        let legacy = [mkanban.clone(), vibe.clone()];

        // Instalación nueva: nada que migrar.
        assert_eq!(migrate_data_dir(&fluke, &legacy), fluke);
        assert!(!fluke.exists());

        // Ya migrado a mkanban (con un vibe-kanban residual): sólo corre mkanban → fluke.
        std::fs::create_dir_all(&mkanban).unwrap();
        std::fs::create_dir_all(&vibe).unwrap();
        std::fs::write(mkanban.join("db.v2.sqlite"), "db").unwrap();
        std::fs::create_dir_all(mkanban.join("repos").join("acme-app")).unwrap();
        assert_eq!(migrate_data_dir(&fluke, &legacy), fluke);
        assert_eq!(
            std::fs::read_to_string(fluke.join("db.v2.sqlite")).unwrap(),
            "db"
        );
        // repos/ se queda en el path viejo: repos.path en la DB lo referencia.
        assert!(mkanban.join("repos").join("acme-app").exists());
        assert!(!mkanban.join("db.v2.sqlite").exists());
        assert!(!fluke.join("repos").exists());
        assert!(vibe.exists());

        // Idempotente: el segundo arranque no toca nada.
        assert_eq!(migrate_data_dir(&fluke, &legacy), fluke);
        assert_eq!(
            std::fs::read_to_string(fluke.join("db.v2.sqlite")).unwrap(),
            "db"
        );

        // Rename imposible (el padre del destino es un archivo): se sigue con el viejo.
        let blocker = root.join("blocker");
        std::fs::write(&blocker, "").unwrap();
        assert_eq!(
            migrate_data_dir(&blocker.join("fluke"), std::slice::from_ref(&vibe)),
            vibe
        );
        assert!(vibe.exists());
    }
}
