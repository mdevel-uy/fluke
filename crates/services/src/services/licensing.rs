//! Licenciamiento: wrapper del SDK de tetherpad.
//!
//! La logica (verificacion, gracia, anti-reloj, revocacion, heartbeat) vive
//! en `tetherpad-runtime`; aca solo el wiring de mkanban: claves embebidas en
//! build, data dir de la app, y configuracion del control plane por entorno.
//! Nada de logica de contrato en esta capa (ADR 0011 de tetherpad).
//!
//! **Licenciamiento desactivado por defecto**: sin claves publicas embebidas
//! (build de desarrollo) el estado es siempre `Valid` y el gate no bloquea.
//! El enforcement solo existe en builds con `TETHERPAD_LICENSE_PUBKEYS`.

use std::sync::{Arc, OnceLock};

use tetherpad_runtime::{Config, Runtime, parse_trusted_keys};
pub use tetherpad_runtime::{Evaluation, LicenseStatus};

/// Claves publicas confiables, embebidas en tiempo de compilacion como lista
/// separada por comas en base64. Vacio = licenciamiento desactivado.
const EMBEDDED_PUBKEYS: Option<&str> = option_env!("TETHERPAD_LICENSE_PUBKEYS");

/// URL del control plane. Sin ella el heartbeat no corre (opt-in).
const CONTROL_PLANE_URL_ENV: &str = "TETHERPAD_CONTROL_PLANE_URL";
/// Token de enrolamiento (viene en el bundle del cliente; auto-vincula la
/// instancia al contrato en el primer heartbeat). Sin token, la instancia
/// entra pendiente y un operador la aprueba.
const ENROLL_TOKEN_ENV: &str = "TETHERPAD_ENROLL_TOKEN";

static GLOBAL: OnceLock<Arc<Runtime>> = OnceLock::new();

/// Runtime de tetherpad process-global. Se inicializa en el primer uso con la
/// identidad persistida en el asset dir de la app (mismos archivos que
/// versiones anteriores: `instance_id`, `license.json`).
pub fn global() -> &'static Arc<Runtime> {
    GLOBAL.get_or_init(|| {
        let mut config = Config::new(
            utils::assets::asset_dir(),
            "mkanban",
            utils::version::APP_VERSION,
        );
        config.trusted_keys = EMBEDDED_PUBKEYS.map(parse_trusted_keys).unwrap_or_default();
        config.control_plane_url = std::env::var(CONTROL_PLANE_URL_ENV)
            .ok()
            .map(|u| u.trim().trim_end_matches('/').to_string())
            .filter(|u| !u.is_empty());
        config.enroll_token = std::env::var(ENROLL_TOKEN_ENV)
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());

        let rt = Runtime::init(config)
            .expect("no se pudo inicializar el runtime de tetherpad (asset dir inaccesible)");
        Arc::new(rt)
    })
}
