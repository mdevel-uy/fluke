//! Servicio de licenciamiento: carga el archivo de licencia, lo verifica contra
//! las claves públicas embebidas en el binario, y expone el estado vigente.
//!
//! Esta es la fundación **read-only**: carga, verificación, persistencia del
//! estado anti-reloj-retrocedido, y una evaluación cacheada. NO aplica todavía
//! ningún efecto sobre la ejecución de agentes; ese gate llega en un paso
//! aparte para no mezclar un cambio de comportamiento con la fundación.
//!
//! **Licenciamiento desactivado por defecto**: si no hay claves públicas
//! embebidas (build de desarrollo, o la flota actual), el estado es siempre
//! `Valid` y nada cambia. El enforcement solo existe en builds que embeben una
//! clave real vía `MKANBAN_LICENSE_PUBKEYS`.

use std::sync::{OnceLock, RwLock};

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use chrono::{DateTime, Utc};
use ed25519_dalek::VerifyingKey;
use licensing::{DEFAULT_GRACE_DAYS, Evaluation, LicenseStatus, effective_now, evaluate, verify};
use serde::{Deserialize, Serialize};

/// Claves públicas confiables, embebidas en tiempo de compilación como una lista
/// separada por comas de valores base64. Vacío = licenciamiento desactivado.
/// Es una lista (no una sola) para poder rotar sin día de bandera; ver
/// `licensing::verify`.
const EMBEDDED_PUBKEYS: Option<&str> = option_env!("MKANBAN_LICENSE_PUBKEYS");

/// Estado persistido en `license_state.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PersistedState {
    /// Máximo instante observado. Protege contra atrasar el reloj del servidor.
    last_seen: Option<DateTime<Utc>>,
    /// Desde cuándo la licencia está ausente o inválida. Permite que un archivo
    /// faltante respete la gracia en vez de suspender de golpe.
    degraded_since: Option<DateTime<Utc>>,
}

pub struct LicenseService {
    keys: Vec<VerifyingKey>,
    grace_days: i64,
    cached: RwLock<Evaluation>,
}

fn parse_keys(raw: &str) -> Vec<VerifyingKey> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter_map(|s| {
            let bytes: [u8; 32] = B64.decode(s).ok()?.as_slice().try_into().ok()?;
            VerifyingKey::from_bytes(&bytes).ok()
        })
        .collect()
}

impl LicenseService {
    /// Construye el servicio y evalúa una vez al arranque.
    pub fn new() -> Self {
        let keys = EMBEDDED_PUBKEYS.map(parse_keys).unwrap_or_default();
        let svc = Self {
            keys,
            grace_days: DEFAULT_GRACE_DAYS,
            cached: RwLock::new(Evaluation {
                status: LicenseStatus::Valid,
                days_remaining: None,
                reason: None,
            }),
        };
        svc.refresh();
        svc
    }

    /// `true` cuando el binario embebe al menos una clave. Con licenciamiento
    /// desactivado el resto del servicio se comporta como "siempre válido".
    pub fn is_enforced(&self) -> bool {
        !self.keys.is_empty()
    }

    /// Re-lee el archivo, re-evalúa y actualiza la cache. Se llama al arranque y
    /// periódicamente (una instancia puede correr meses sin reiniciar).
    pub fn refresh(&self) -> Evaluation {
        let eval = self.evaluate_now();
        if let Ok(mut guard) = self.cached.write() {
            *guard = eval.clone();
        }
        eval
    }

    /// Última evaluación cacheada, sin tocar disco.
    pub fn current(&self) -> Evaluation {
        self.cached
            .read()
            .map(|g| g.clone())
            .unwrap_or_else(|_| Evaluation {
                status: LicenseStatus::Valid,
                days_remaining: None,
                reason: None,
            })
    }

    fn evaluate_now(&self) -> Evaluation {
        // Licenciamiento desactivado: nada que aplicar.
        if self.keys.is_empty() {
            return Evaluation {
                status: LicenseStatus::Valid,
                days_remaining: None,
                reason: None,
            };
        }

        let mut state = load_state();
        let system_now = Utc::now();
        let now = effective_now(system_now, state.last_seen);

        // Avanzar el máximo instante observado (nunca retroceder).
        if state.last_seen.map(|s| now > s).unwrap_or(true) {
            state.last_seen = Some(now);
        }

        let license = read_and_verify(&self.keys);

        // Mantener `degraded_since`: se fija cuando falta/invalida y se limpia
        // cuando vuelve a haber una licencia legible.
        match &license {
            Some(_) => state.degraded_since = None,
            None => {
                if state.degraded_since.is_none() {
                    state.degraded_since = Some(now);
                }
            }
        }

        let eval = evaluate(license.as_ref(), now, state.degraded_since, self.grace_days);
        save_state(&state);
        eval
    }
}

impl Default for LicenseService {
    fn default() -> Self {
        Self::new()
    }
}

/// Instancia process-global. Read-only por ahora: la evaluación ocurre al
/// construirla (arranque) y en cada `refresh()`. El loop de refresco periódico
/// y el gate en el orquestador se conectan en un paso aparte.
static GLOBAL: OnceLock<LicenseService> = OnceLock::new();

pub fn global() -> &'static LicenseService {
    GLOBAL.get_or_init(LicenseService::new)
}

fn read_and_verify(keys: &[VerifyingKey]) -> Option<licensing::LicensePayload> {
    let raw = std::fs::read_to_string(utils::assets::license_path()).ok()?;
    match verify(&raw, keys) {
        Ok(payload) => Some(payload),
        Err(e) => {
            tracing::warn!("licencia presente pero inválida: {e}");
            None
        }
    }
}

fn load_state() -> PersistedState {
    std::fs::read_to_string(utils::assets::license_state_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_state(state: &PersistedState) {
    if let Ok(json) = serde_json::to_string_pretty(state) {
        let _ = std::fs::write(utils::assets::license_state_path(), json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sin_claves_embebidas_el_licenciamiento_esta_desactivado() {
        // EMBEDDED_PUBKEYS no está seteada en el entorno de test.
        let svc = LicenseService::new();
        assert!(!svc.is_enforced());
        assert_eq!(svc.current().status, LicenseStatus::Valid);
    }

    #[test]
    fn parse_keys_ignora_entradas_vacias_y_basura() {
        assert!(parse_keys("").is_empty());
        assert!(parse_keys(" , , ").is_empty());
        assert!(parse_keys("no-es-base64!!").is_empty());
    }

    #[test]
    fn parse_keys_acepta_una_clave_valida() {
        use ed25519_dalek::SigningKey;
        use rand::rngs::OsRng;
        let key = SigningKey::generate(&mut OsRng);
        let b64 = B64.encode(key.verifying_key().to_bytes());
        assert_eq!(parse_keys(&b64).len(), 1);
        // Y una lista de dos, con espacios y una entrada basura intercalada.
        let key2 = SigningKey::generate(&mut OsRng);
        let b64_2 = B64.encode(key2.verifying_key().to_bytes());
        assert_eq!(parse_keys(&format!("{b64}, basura , {b64_2}")).len(), 2);
    }
}
