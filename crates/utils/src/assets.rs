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

#[derive(RustEmbed)]
#[folder = "../../assets/sounds"]
pub struct SoundAssets;

#[derive(RustEmbed)]
#[folder = "../../assets/scripts"]
pub struct ScriptAssets;
