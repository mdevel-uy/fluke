//! Firma de licencias renovadas con la clave online.
//!
//! El vencimiento es **server-authoritative**: lo fija el control plane
//! (`now + validity_days`), no lo propone la instancia. Reusa el mismo mensaje
//! canónico y formato que la emisión manual (`licensing::signing_message`,
//! `LicenseFile`), así el binario del cliente verifica sin distinguir de dónde
//! vino la licencia.

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use chrono::{DateTime, Duration, Utc};
use ed25519_dalek::{Signer, SigningKey};
use licensing::{LicenseFile, LicensePayload, SUPPORTED_VERSION, signing_message};

/// Variables de entorno de la clave de firma online. Si faltan, el control
/// plane corre sin firmar (registra heartbeats y responde vacío) — útil en dev
/// y en un deploy que todavía no configuró la clave.
const KEY_PATH_ENV: &str = "MKANBAN_ONLINE_KEY_PATH";
const PASSPHRASE_ENV: &str = "MKANBAN_LICENSE_PASSPHRASE";

/// Días de validez de una licencia renovada. Ping diario con esta ventana: una
/// semana sin conectividad no molesta a un cliente al día, y el kill-switch
/// pasivo (dejar de renovar) tarda a lo sumo esto en hacer efecto.
const DEFAULT_VALIDITY_DAYS: i64 = 35;
const VALIDITY_DAYS_ENV: &str = "MKANBAN_LICENSE_VALIDITY_DAYS";

pub struct LicenseSigner {
    key: SigningKey,
    validity_days: i64,
}

impl LicenseSigner {
    /// Carga la clave online desde las variables de entorno. `Ok(None)` cuando
    /// no está configurada (no es un error: el control plane corre sin firmar).
    pub fn from_env() -> anyhow::Result<Option<Self>> {
        let (path, pass) = match (
            std::env::var(KEY_PATH_ENV).ok(),
            std::env::var(PASSPHRASE_ENV).ok(),
        ) {
            (Some(p), Some(pass)) if !p.is_empty() && !pass.is_empty() => (p, pass),
            _ => return Ok(None),
        };
        let key = license_keystore::load_signing_key(&path, &pass)?;
        let validity_days = std::env::var(VALIDITY_DAYS_ENV)
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_VALIDITY_DAYS);
        Ok(Some(Self { key, validity_days }))
    }

    /// Construye un firmador con una clave dada (para tests).
    pub fn with_key(key: SigningKey, validity_days: i64) -> Self {
        Self { key, validity_days }
    }

    /// Clave pública, para verificar en tests.
    pub fn verifying_key(&self) -> ed25519_dalek::VerifyingKey {
        self.key.verifying_key()
    }

    /// Firma una licencia renovada para una instancia, con vencimiento
    /// `now + validity_days`. Devuelve el contenido de `license.json`.
    pub fn sign_renewal(
        &self,
        cliente: &str,
        instance_id: &str,
        modalidad: &str,
        now: DateTime<Utc>,
    ) -> String {
        let payload = LicensePayload {
            v: SUPPORTED_VERSION,
            cliente: cliente.to_string(),
            instance_id: instance_id.to_string(),
            issued_at: now,
            expires_at: now + Duration::days(self.validity_days),
            modalidad: modalidad.to_string(),
        };
        let sig = self.key.sign(signing_message(&payload).as_bytes());
        let file = LicenseFile {
            payload,
            signature: B64.encode(sig.to_bytes()),
        };
        // to_string sobre tipos propios no falla; unwrap es seguro.
        serde_json::to_string(&file).expect("serializar licencia")
    }
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::SigningKey;
    use licensing::{LicenseStatus, evaluate, verify};
    use rand::rngs::OsRng;

    use super::*;

    #[test]
    fn la_licencia_renovada_verifica_y_esta_vigente() {
        let signer = LicenseSigner::with_key(SigningKey::generate(&mut OsRng), 35);
        let now = Utc::now();
        let json = signer.sign_renewal("acme", "01ABC", "onprem", now);

        // Verifica contra la clave pública del firmador (como haría el cliente
        // con la clave embebida).
        let payload = verify(&json, &[signer.verifying_key()]).expect("debe verificar");
        assert_eq!(payload.cliente, "acme");
        assert_eq!(payload.instance_id, "01ABC");

        // Y el estado es Valid (vence dentro de 35 días).
        let eval = evaluate(Some(&payload), now, None, 7);
        assert_eq!(eval.status, LicenseStatus::Valid);
    }

    #[test]
    fn otra_clave_no_verifica_la_renovacion() {
        let signer = LicenseSigner::with_key(SigningKey::generate(&mut OsRng), 35);
        let json = signer.sign_renewal("acme", "01ABC", "onprem", Utc::now());
        let impostor = SigningKey::generate(&mut OsRng).verifying_key();
        assert!(verify(&json, &[impostor]).is_err());
    }
}
