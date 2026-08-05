//! Verificación de licencias firmadas y máquina de estados del kill-switch.
//!
//! Ver `design/LICENSING-SPEC.md`. Resumen del contrato con el cliente
//! (Términos y Condiciones, cl. 9):
//!
//! * La degradación afecta la **ejecución de agentes nuevos**, nunca el acceso
//!   a los datos. Este crate no conoce agentes: solo decide un estado; el gate
//!   vive en el orquestador.
//! * El kill-switch es **pasivo**: no hay comando remoto de apagado, la
//!   licencia simplemente vence si deja de renovarse.
//! * Ante duda —archivo ausente, ilegible o firma inválida— se degrada primero
//!   a `Grace` (banner) y recién tras el período de gracia a `Suspended`.
//!
//! El crate es deliberadamente independiente del resto del workspace: no toca
//! disco, ni reloj, ni configuración. Todo entra por parámetro para que sea
//! verificable en tests.

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use chrono::{DateTime, Duration, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Período de gracia por defecto. Los T&C publicados comprometen "no menor a
/// 7 días desde el aviso": se puede alargar, no acortar sin cambiar el documento.
pub const DEFAULT_GRACE_DAYS: i64 = 7;

/// Versión de formato soportada. Un archivo con `v` mayor viene de una versión
/// más nueva del producto y se rechaza explícitamente en lugar de malinterpretarse.
pub const SUPPORTED_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LicensePayload {
    pub v: u32,
    pub cliente: String,
    pub instance_id: String,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub modalidad: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicenseFile {
    pub payload: LicensePayload,
    /// Firma ed25519 del mensaje canónico, en base64 estándar.
    pub signature: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum LicenseError {
    #[error("el archivo de licencia no es JSON válido")]
    Malformed,
    #[error("versión de licencia no soportada: {found} (esperada {SUPPORTED_VERSION})")]
    UnsupportedVersion { found: u32 },
    #[error("la firma no está en base64 válido")]
    MalformedSignature,
    #[error("la firma no corresponde al contenido de la licencia")]
    InvalidSignature,
}

/// Mensaje canónico que se firma y se verifica.
///
/// Se construye campo por campo en orden fijo en lugar de re-serializar el JSON:
/// así la verificación no depende del formateo del archivo (espacios, orden de
/// claves, escapes) y no puede romperse por un cambio de serializador. Mismo
/// enfoque que `relay-control::signing`.
///
/// Las fechas van en RFC 3339 con precisión de segundos: es lo que emite la
/// herramienta de firma y evita que una diferencia de nanosegundos invalide una
/// licencia legítima.
fn canonical_message(payload: &LicensePayload) -> String {
    format!(
        "mkanban-license\nv={}\ncliente={}\ninstance_id={}\nissued_at={}\nexpires_at={}\nmodalidad={}",
        payload.v,
        payload.cliente,
        payload.instance_id,
        payload.issued_at.format("%Y-%m-%dT%H:%M:%SZ"),
        payload.expires_at.format("%Y-%m-%dT%H:%M:%SZ"),
        payload.modalidad,
    )
}

/// Mensaje que la herramienta de firma debe firmar. Expuesto para que el
/// firmador y el verificador no puedan divergir.
pub fn signing_message(payload: &LicensePayload) -> String {
    canonical_message(payload)
}

/// Verifica el contenido crudo de `license.json` contra las claves públicas
/// confiables embebidas en el binario.
///
/// Recibe una **lista** y no una sola clave a propósito: permite rotar sin día
/// de bandera. Con una única clave, cambiarla obliga a publicar una versión y
/// forzar el update en todos los clientes antes del vencimiento más próximo
/// (procedimiento de emergencia del runbook, 2.5). Con varias se puede publicar
/// una versión que confíe en la vieja y la nueva, migrar sin apuro, y retirar la
/// vieja en la siguiente. También habilita tener una clave *online* en el
/// control plane y otra de respaldo guardada fuera de línea.
///
/// El orden no importa: alcanza con que **una** verifique.
pub fn verify(raw: &str, keys: &[VerifyingKey]) -> Result<LicensePayload, LicenseError> {
    let file: LicenseFile = serde_json::from_str(raw).map_err(|_| LicenseError::Malformed)?;

    if file.payload.v != SUPPORTED_VERSION {
        return Err(LicenseError::UnsupportedVersion { found: file.payload.v });
    }

    let sig_bytes = BASE64_STANDARD
        .decode(file.signature.trim())
        .map_err(|_| LicenseError::MalformedSignature)?;
    let signature =
        Signature::from_slice(&sig_bytes).map_err(|_| LicenseError::MalformedSignature)?;

    let message = canonical_message(&file.payload);
    let verified = keys
        .iter()
        .any(|key| key.verify(message.as_bytes(), &signature).is_ok());

    if !verified {
        return Err(LicenseError::InvalidSignature);
    }

    Ok(file.payload)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LicenseStatus {
    /// Operación normal.
    Valid,
    /// Vencida (o ausente/inválida) dentro del período de gracia: banner en la
    /// UI, todo sigue funcionando.
    Grace,
    /// Fuera del período de gracia: no arrancan agentes nuevos. Los datos, el
    /// tablero, el historial y la exportación siguen accesibles.
    Suspended,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Evaluation {
    pub status: LicenseStatus,
    /// Días hasta el vencimiento; negativo si ya venció. `None` cuando no hay
    /// licencia legible.
    pub days_remaining: Option<i64>,
    /// Motivo legible para el banner y los logs. `None` cuando está todo bien.
    pub reason: Option<String>,
}

/// Instante a usar para evaluar, protegido contra un reloj atrasado.
///
/// Se persiste el máximo instante observado; si el reloj del sistema aparece
/// antes de ese valor, se usa el máximo. Sin esto, atrasar la fecha del
/// servidor revive una licencia vencida.
pub fn effective_now(system_now: DateTime<Utc>, last_seen: Option<DateTime<Utc>>) -> DateTime<Utc> {
    match last_seen {
        Some(seen) if seen > system_now => seen,
        _ => system_now,
    }
}

/// Decide el estado a partir de la licencia (si hay una legible) y el instante.
///
/// * `license`: `None` cuando el archivo falta o no verifica.
/// * `degraded_since`: cuándo se observó por primera vez la ausencia o el
///   problema. Solo se usa cuando `license` es `None`; permite que un archivo
///   faltante también respete el período de gracia en vez de suspender de golpe.
pub fn evaluate(
    license: Option<&LicensePayload>,
    now: DateTime<Utc>,
    degraded_since: Option<DateTime<Utc>>,
    grace_days: i64,
) -> Evaluation {
    let grace = Duration::days(grace_days.max(0));

    let Some(payload) = license else {
        // Sin licencia legible. Se cuenta la gracia desde la primera vez que se
        // detectó el problema; si no hay registro previo, se asume que es ahora
        // (falla hacia el aviso, no hacia el bloqueo).
        let since = degraded_since.unwrap_or(now);
        let status = if now >= since + grace {
            LicenseStatus::Suspended
        } else {
            LicenseStatus::Grace
        };
        return Evaluation {
            status,
            days_remaining: None,
            reason: Some("no hay una licencia válida instalada".to_string()),
        };
    };

    if now < payload.expires_at {
        let days = (payload.expires_at - now).num_days();
        return Evaluation {
            status: LicenseStatus::Valid,
            days_remaining: Some(days),
            reason: None,
        };
    }

    let overdue = now - payload.expires_at;
    let days_remaining = Some(-(overdue.num_days()));
    if overdue >= grace {
        Evaluation {
            status: LicenseStatus::Suspended,
            days_remaining,
            reason: Some(format!(
                "la licencia venció hace {} días",
                overdue.num_days()
            )),
        }
    } else {
        Evaluation {
            status: LicenseStatus::Grace,
            days_remaining,
            reason: Some(format!(
                "la licencia venció hace {} días; quedan {} de gracia",
                overdue.num_days(),
                (grace - overdue).num_days()
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;
    use ed25519_dalek::{Signer, SigningKey};
    use rand::rngs::OsRng;

    use super::*;

    fn at(y: i32, m: u32, d: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, 0, 0, 0).unwrap()
    }

    fn payload() -> LicensePayload {
        LicensePayload {
            v: 1,
            cliente: "acme".to_string(),
            instance_id: "01JABCDEF".to_string(),
            issued_at: at(2026, 8, 1),
            expires_at: at(2026, 9, 15),
            modalidad: "onprem".to_string(),
        }
    }

    fn sign_with(key: &SigningKey, payload: &LicensePayload) -> String {
        let sig = key.sign(canonical_message(payload).as_bytes());
        serde_json::to_string(&LicenseFile {
            payload: payload.clone(),
            signature: BASE64_STANDARD.encode(sig.to_bytes()),
        })
        .unwrap()
    }

    // ── Verificación de firma ────────────────────────────────────────────

    #[test]
    fn verifica_una_licencia_legitima() {
        let key = SigningKey::generate(&mut OsRng);
        let raw = sign_with(&key, &payload());

        let out = verify(&raw, &[key.verifying_key()]).expect("debe verificar");
        assert_eq!(out, payload());
    }

    #[test]
    fn rechaza_un_payload_alterado() {
        let key = SigningKey::generate(&mut OsRng);
        let raw = sign_with(&key, &payload());
        // El cliente extiende el vencimiento a mano, conservando la firma.
        let tampered = raw.replace("2026-09-15", "2027-09-15");
        assert_ne!(raw, tampered, "el test debe alterar algo");

        assert_eq!(
            verify(&tampered, &[key.verifying_key()]),
            Err(LicenseError::InvalidSignature)
        );
    }

    #[test]
    fn acepta_cualquiera_de_las_claves_confiables() {
        // Escenario de rotación: el binario confía en la clave vieja y la nueva
        // a la vez, así las licencias emitidas con cualquiera siguen valiendo
        // durante la migración.
        let vieja = SigningKey::generate(&mut OsRng);
        let nueva = SigningKey::generate(&mut OsRng);
        let confiables = [vieja.verifying_key(), nueva.verifying_key()];

        for emisora in [&vieja, &nueva] {
            let raw = sign_with(emisora, &payload());
            assert!(verify(&raw, &confiables).is_ok());
        }
    }

    #[test]
    fn con_lista_vacia_ninguna_licencia_verifica() {
        let key = SigningKey::generate(&mut OsRng);
        let raw = sign_with(&key, &payload());
        assert_eq!(verify(&raw, &[]), Err(LicenseError::InvalidSignature));
    }

    #[test]
    fn rechaza_una_firma_de_otra_clave() {
        let real = SigningKey::generate(&mut OsRng);
        let impostor = SigningKey::generate(&mut OsRng);
        let raw = sign_with(&impostor, &payload());

        assert_eq!(
            verify(&raw, &[real.verifying_key()]),
            Err(LicenseError::InvalidSignature)
        );
    }

    #[test]
    fn rechaza_json_invalido_y_firma_corrupta() {
        let key = SigningKey::generate(&mut OsRng);
        assert_eq!(verify("no soy json", &[key.verifying_key()]), Err(LicenseError::Malformed));

        let raw = sign_with(&key, &payload()).replace(
            &BASE64_STANDARD.encode(key.sign(canonical_message(&payload()).as_bytes()).to_bytes()),
            "no-es-base64!!",
        );
        assert_eq!(
            verify(&raw, &[key.verifying_key()]),
            Err(LicenseError::MalformedSignature)
        );
    }

    #[test]
    fn rechaza_una_version_de_formato_desconocida() {
        let key = SigningKey::generate(&mut OsRng);
        let mut p = payload();
        p.v = 2;
        let raw = sign_with(&key, &p);

        assert_eq!(
            verify(&raw, &[key.verifying_key()]),
            Err(LicenseError::UnsupportedVersion { found: 2 })
        );
    }

    #[test]
    fn el_mensaje_firmado_no_depende_del_formato_del_json() {
        let key = SigningKey::generate(&mut OsRng);
        let raw = sign_with(&key, &payload());
        // Reformatear el archivo (pretty-print) no debe invalidar la licencia.
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let pretty = serde_json::to_string_pretty(&value).unwrap();

        assert!(verify(&pretty, &[key.verifying_key()]).is_ok());
    }

    // ── Máquina de estados ───────────────────────────────────────────────

    #[test]
    fn vigente_antes_del_vencimiento() {
        let p = payload();
        let e = evaluate(Some(&p), at(2026, 9, 1), None, DEFAULT_GRACE_DAYS);
        assert_eq!(e.status, LicenseStatus::Valid);
        assert_eq!(e.days_remaining, Some(14));
        assert!(e.reason.is_none());
    }

    #[test]
    fn gracia_apenas_vence() {
        let p = payload();
        let e = evaluate(Some(&p), at(2026, 9, 18), None, DEFAULT_GRACE_DAYS);
        assert_eq!(e.status, LicenseStatus::Grace);
        assert_eq!(e.days_remaining, Some(-3));
    }

    #[test]
    fn suspendida_al_cumplirse_la_gracia() {
        let p = payload();
        // Exactamente 7 días después del vencimiento ya suspende.
        let e = evaluate(Some(&p), at(2026, 9, 22), None, DEFAULT_GRACE_DAYS);
        assert_eq!(e.status, LicenseStatus::Suspended);
    }

    #[test]
    fn el_ultimo_dia_de_gracia_todavia_no_suspende() {
        let p = payload();
        let casi = at(2026, 9, 22) - Duration::seconds(1);
        assert_eq!(
            evaluate(Some(&p), casi, None, DEFAULT_GRACE_DAYS).status,
            LicenseStatus::Grace
        );
    }

    #[test]
    fn sin_licencia_arranca_en_gracia_y_no_bloquea_de_golpe() {
        let ahora = at(2026, 9, 1);
        let e = evaluate(None, ahora, None, DEFAULT_GRACE_DAYS);
        assert_eq!(e.status, LicenseStatus::Grace);
        assert!(e.reason.is_some());
    }

    #[test]
    fn sin_licencia_suspende_al_cumplirse_la_gracia() {
        let detectado = at(2026, 9, 1);
        let e = evaluate(None, at(2026, 9, 8), Some(detectado), DEFAULT_GRACE_DAYS);
        assert_eq!(e.status, LicenseStatus::Suspended);
    }

    // ── Reloj retrocedido ────────────────────────────────────────────────

    #[test]
    fn un_reloj_atrasado_no_revive_una_licencia_vencida() {
        let p = payload();
        let observado = at(2026, 9, 30); // ya vencida y fuera de gracia
        let reloj_manipulado = at(2026, 9, 1); // el cliente atrasa el servidor

        let now = effective_now(reloj_manipulado, Some(observado));
        assert_eq!(now, observado);
        assert_eq!(
            evaluate(Some(&p), now, None, DEFAULT_GRACE_DAYS).status,
            LicenseStatus::Suspended
        );
    }

    #[test]
    fn el_reloj_avanza_normalmente_sin_interferencia() {
        let anterior = at(2026, 9, 1);
        let ahora = at(2026, 9, 2);
        assert_eq!(effective_now(ahora, Some(anterior)), ahora);
        assert_eq!(effective_now(ahora, None), ahora);
    }
}
