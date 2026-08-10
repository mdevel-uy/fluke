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
    let new = ProjectDirs::from("dev", "mkanban", "mkanban")
        .expect("OS didn't give us a home directory")
        .data_dir()
        .to_path_buf();

    // Migración del data dir legacy (rebrand vibe-kanban → mkanban): si el
    // path nuevo todavía no existe pero el viejo sí, se renombra en el lugar.
    // Si el rename falla (permisos, cross-device), se sigue usando el viejo
    // para no arrancar jamás con una DB vacía.
    let legacy = ProjectDirs::from("ai", "bloop", "vibe-kanban")
        .expect("OS didn't give us a home directory")
        .data_dir()
        .to_path_buf();
    if !new.exists() && legacy.exists() {
        let renamed = new
            .parent()
            .map(|parent| std::fs::create_dir_all(parent).is_ok())
            .unwrap_or(false)
            && std::fs::rename(&legacy, &new).is_ok();
        if !renamed {
            return legacy;
        }
    }

    new
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

// Nota: `license.json`, el estado del licenciamiento y el log de reportes
// viven ahora en el runtime de tetherpad, que usa este mismo asset dir como
// data dir (los archivos y su formato son compatibles con los que escribia
// la app antes de la extraccion).

/// Identificador estable de la instalación (UUID). Generado en el primer
/// arranque y persistido; ata el heartbeat y las licencias a una instancia.
/// El runtime de tetherpad lee/escribe este mismo archivo (mismo formato).
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
