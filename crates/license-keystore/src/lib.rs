//! Cifrado en reposo de la clave privada de firma ed25519.
//!
//! El seed de 32 bytes se cifra con AES-256-GCM bajo una clave derivada de una
//! passphrase con scrypt. El archivo `.enc` en reposo (Drive, gestor de
//! contraseñas, secrets del servidor) no sirve sin la passphrase, y GCM
//! autentica: una passphrase equivocada **falla** en vez de producir bytes
//! basura que se tomarían por una clave.

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::SigningKey;
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};

/// Parámetros de scrypt. log_n=15 (N=32768): balance para una operación
/// interactiva; sube el costo de un ataque por diccionario sin lentitud notable.
const SCRYPT_LOG_N: u8 = 15;
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;

/// Envoltorio serializable de la clave privada cifrada (contenido del `.enc`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedKey {
    pub kdf: String,
    pub scrypt_log_n: u8,
    pub scrypt_r: u32,
    pub scrypt_p: u32,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

fn derive_key(passphrase: &str, salt: &[u8], log_n: u8, r: u32, p: u32) -> Result<[u8; 32]> {
    let params = scrypt::Params::new(log_n, r, p, 32)
        .map_err(|_| anyhow::anyhow!("parámetros de scrypt inválidos"))?;
    let mut out = [0u8; 32];
    scrypt::scrypt(passphrase.as_bytes(), salt, &params, &mut out)
        .map_err(|_| anyhow::anyhow!("fallo derivando la clave desde la passphrase"))?;
    Ok(out)
}

/// Cifra el seed ed25519 (32 bytes) con la passphrase.
pub fn encrypt_seed(seed: &[u8; 32], passphrase: &str) -> Result<EncryptedKey> {
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);

    let dk = derive_key(passphrase, &salt, SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P)?;
    let cipher = Aes256Gcm::new(dk.as_slice().into());
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), seed.as_slice())
        .map_err(|_| anyhow::anyhow!("fallo cifrando la clave"))?;

    Ok(EncryptedKey {
        kdf: "scrypt".into(),
        scrypt_log_n: SCRYPT_LOG_N,
        scrypt_r: SCRYPT_R,
        scrypt_p: SCRYPT_P,
        salt: B64.encode(salt),
        nonce: B64.encode(nonce),
        ciphertext: B64.encode(ct),
    })
}

/// Descifra el seed. Una passphrase equivocada falla (GCM autentica).
pub fn decrypt_seed(enc: &EncryptedKey, passphrase: &str) -> Result<[u8; 32]> {
    let salt = B64.decode(&enc.salt).context("salt inválido")?;
    let nonce = B64.decode(&enc.nonce).context("nonce inválido")?;
    let ct = B64.decode(&enc.ciphertext).context("ciphertext inválido")?;

    let dk = derive_key(passphrase, &salt, enc.scrypt_log_n, enc.scrypt_r, enc.scrypt_p)?;
    let cipher = Aes256Gcm::new(dk.as_slice().into());
    let pt = cipher
        .decrypt(Nonce::from_slice(&nonce), ct.as_slice())
        .map_err(|_| anyhow::anyhow!("passphrase incorrecta o archivo corrupto"))?;

    let seed: [u8; 32] = pt
        .as_slice()
        .try_into()
        .context("la clave descifrada no tiene el largo esperado")?;
    Ok(seed)
}

/// Lee un archivo `.enc`, lo descifra con la passphrase y arma la `SigningKey`.
pub fn load_signing_key(path: &str, passphrase: &str) -> Result<SigningKey> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("no se pudo leer {path}"))?;
    let enc: EncryptedKey =
        serde_json::from_str(&raw).context("el archivo de clave no es un keystore válido")?;
    let seed = decrypt_seed(&enc, passphrase)?;
    Ok(SigningKey::from_bytes(&seed))
}

/// Serializa un keystore a JSON con indentación (para escribir el `.enc`).
pub fn to_json(enc: &EncryptedKey) -> Result<String> {
    serde_json::to_string_pretty(enc).context("no se pudo serializar el keystore")
}

/// Valida que una passphrase no sea trivial. Usada por la herramienta de keygen.
pub fn check_passphrase_strength(pass: &str) -> Result<()> {
    if pass.len() < 8 {
        bail!("la passphrase debe tener al menos 8 caracteres");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;

    use super::*;

    #[test]
    fn ida_y_vuelta_recupera_el_seed() {
        let seed = SigningKey::generate(&mut OsRng).to_bytes();
        let enc = encrypt_seed(&seed, "una-passphrase-larga").unwrap();
        assert_eq!(decrypt_seed(&enc, "una-passphrase-larga").unwrap(), seed);
    }

    #[test]
    fn passphrase_equivocada_falla() {
        let seed = SigningKey::generate(&mut OsRng).to_bytes();
        let enc = encrypt_seed(&seed, "la-correcta").unwrap();
        assert!(decrypt_seed(&enc, "la-incorrecta").is_err());
    }

    #[test]
    fn el_keystore_serializa_y_reconstruye() {
        let seed = SigningKey::generate(&mut OsRng).to_bytes();
        let enc = encrypt_seed(&seed, "pass-de-prueba").unwrap();
        let json = to_json(&enc).unwrap();
        let back: EncryptedKey = serde_json::from_str(&json).unwrap();
        assert_eq!(decrypt_seed(&back, "pass-de-prueba").unwrap(), seed);
    }
}
