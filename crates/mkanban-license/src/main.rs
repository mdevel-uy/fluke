//! `mkanban-license` — herramienta interna de emisión y verificación de licencias.
//!
//! No se distribuye al cliente: el binario del producto solo verifica, con la
//! clave pública embebida. Esta herramienta guarda la clave **privada** cifrada
//! con una passphrase (scrypt + AES-256-GCM), de modo que el archivo en reposo
//! —en la carpeta de respaldo, sea Drive o un gestor de contraseñas— no sea
//! utilizable sin la passphrase. El archivo en claro nunca toca el disco.
//!
//! Comandos:
//!   keygen   genera el par y escribe la privada cifrada + imprime la pública
//!   pubkey   imprime la pública a partir de la privada cifrada
//!   new      firma una licencia
//!   inspect  verifica un license.json contra una clave pública

use std::{fs, path::PathBuf};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use chrono::{Duration, Utc};
use clap::{Parser, Subcommand};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use licensing::{LicenseFile, LicensePayload, SUPPORTED_VERSION, signing_message, verify};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};

/// Parámetros de scrypt. log_n=15 (N=32768) es un balance razonable para una
/// herramienta interactiva; sube el costo de un ataque por diccionario sin
/// hacer la firma perceptiblemente lenta.
const SCRYPT_LOG_N: u8 = 15;
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;

/// Variable de entorno con la passphrase, para uso no interactivo: el control
/// plane que firma renovaciones solo (fase 5b) y la automatización/CI. Cuando
/// está definida se usa en lugar del prompt. Para emisión manual conviene el
/// prompt (no queda en el historial del shell ni en la lista de procesos).
const PASSPHRASE_ENV: &str = "MKANBAN_LICENSE_PASSPHRASE";

/// Pide la passphrase: de la variable de entorno si está, si no del TTY.
fn read_passphrase(prompt: &str) -> Result<String> {
    if let Ok(p) = std::env::var(PASSPHRASE_ENV) {
        if !p.is_empty() {
            return Ok(p);
        }
    }
    rpassword::prompt_password(prompt).context("no se pudo leer la passphrase")
}

#[derive(Parser)]
#[command(name = "mkanban-license", about = "Emisión y verificación de licencias de mkanban")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Genera un par de claves nuevo. Pide una passphrase y escribe la clave
    /// privada cifrada; imprime la clave pública para embeber en el binario.
    Keygen {
        /// Ruta del archivo de clave privada cifrada a crear.
        #[arg(long, default_value = "mkanban-signing.key.enc")]
        out: PathBuf,
    },
    /// Imprime la clave pública a partir de la privada cifrada.
    Pubkey {
        #[arg(long, default_value = "mkanban-signing.key.enc")]
        key: PathBuf,
    },
    /// Firma una licencia nueva y la imprime por stdout.
    New {
        #[arg(long, default_value = "mkanban-signing.key.enc")]
        key: PathBuf,
        #[arg(long)]
        cliente: String,
        #[arg(long)]
        instance: String,
        /// Días de validez desde ahora.
        #[arg(long, default_value_t = 45)]
        dias: i64,
        #[arg(long, default_value = "onprem")]
        modalidad: String,
        /// Escribe a un archivo en lugar de stdout.
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Verifica un archivo de licencia contra una clave pública.
    Inspect {
        /// Archivo license.json a verificar.
        file: PathBuf,
        /// Clave pública en base64. Si se omite, se deriva de --key (pide passphrase).
        #[arg(long)]
        pubkey: Option<String>,
        #[arg(long, default_value = "mkanban-signing.key.enc")]
        key: PathBuf,
    },
}

/// Envoltorio en disco de la clave privada cifrada.
#[derive(Serialize, Deserialize)]
struct EncryptedKey {
    kdf: String,
    scrypt_log_n: u8,
    scrypt_r: u32,
    scrypt_p: u32,
    salt: String,
    nonce: String,
    ciphertext: String,
}

fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; 32]> {
    let params = scrypt::Params::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, 32)
        .map_err(|_| anyhow::anyhow!("parámetros de scrypt inválidos"))?;
    let mut out = [0u8; 32];
    scrypt::scrypt(passphrase.as_bytes(), salt, &params, &mut out)
        .map_err(|_| anyhow::anyhow!("fallo derivando la clave desde la passphrase"))?;
    Ok(out)
}

/// Cifra el seed ed25519 (32 bytes) con la passphrase.
fn encrypt_seed(seed: &[u8; 32], passphrase: &str) -> Result<EncryptedKey> {
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);

    let dk = derive_key(passphrase, &salt)?;
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

fn decrypt_seed(enc: &EncryptedKey, passphrase: &str) -> Result<[u8; 32]> {
    let salt = B64.decode(&enc.salt).context("salt inválido")?;
    let nonce = B64.decode(&enc.nonce).context("nonce inválido")?;
    let ct = B64.decode(&enc.ciphertext).context("ciphertext inválido")?;

    let params = scrypt::Params::new(enc.scrypt_log_n, enc.scrypt_r, enc.scrypt_p, 32)
        .map_err(|_| anyhow::anyhow!("parámetros de scrypt del archivo inválidos"))?;
    let mut dk = [0u8; 32];
    scrypt::scrypt(passphrase.as_bytes(), &salt, &params, &mut dk)
        .map_err(|_| anyhow::anyhow!("fallo derivando la clave"))?;

    let cipher = Aes256Gcm::new(dk.as_slice().into());
    let pt = cipher
        .decrypt(Nonce::from_slice(&nonce), ct.as_slice())
        // GCM autentica: una passphrase equivocada falla acá, no produce basura.
        .map_err(|_| anyhow::anyhow!("passphrase incorrecta o archivo corrupto"))?;

    let seed: [u8; 32] = pt
        .as_slice()
        .try_into()
        .context("la clave descifrada no tiene el largo esperado")?;
    Ok(seed)
}

fn load_signing_key(path: &PathBuf) -> Result<SigningKey> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("no se pudo leer {}", path.display()))?;
    let enc: EncryptedKey = serde_json::from_str(&raw).context("el archivo de clave no es válido")?;
    let pass = read_passphrase("passphrase: ")?;
    let seed = decrypt_seed(&enc, &pass)?;
    Ok(SigningKey::from_bytes(&seed))
}

fn main() -> Result<()> {
    match Cli::parse().cmd {
        Cmd::Keygen { out } => {
            if out.exists() {
                bail!(
                    "{} ya existe — no se sobrescribe una clave existente",
                    out.display()
                );
            }
            let pass = read_passphrase("passphrase nueva: ")?;
            if pass.len() < 8 {
                bail!("la passphrase debe tener al menos 8 caracteres");
            }
            let confirm = if std::env::var(PASSPHRASE_ENV).is_ok() { pass.clone() } else { rpassword::prompt_password("repetir passphrase: ")? };
            if pass != confirm {
                bail!("las passphrases no coinciden");
            }

            let signing = SigningKey::generate(&mut OsRng);
            let enc = encrypt_seed(&signing.to_bytes(), &pass)?;
            fs::write(&out, serde_json::to_string_pretty(&enc)?)
                .with_context(|| format!("no se pudo escribir {}", out.display()))?;

            let pubkey = B64.encode(signing.verifying_key().to_bytes());
            eprintln!("✓ clave privada cifrada escrita en {}", out.display());
            eprintln!("  resguardá ese archivo; sin la passphrase no se puede firmar.");
            eprintln!("\nclave pública (embeber en el binario):");
            println!("{pubkey}");
        }

        Cmd::Pubkey { key } => {
            let signing = load_signing_key(&key)?;
            println!("{}", B64.encode(signing.verifying_key().to_bytes()));
        }

        Cmd::New {
            key,
            cliente,
            instance,
            dias,
            modalidad,
            out,
        } => {
            let signing = load_signing_key(&key)?;
            let now = Utc::now();
            let payload = LicensePayload {
                v: SUPPORTED_VERSION,
                cliente,
                instance_id: instance,
                issued_at: now,
                expires_at: now + Duration::days(dias),
                modalidad,
            };
            let sig = signing.sign(signing_message(&payload).as_bytes());
            let file = LicenseFile {
                payload: payload.clone(),
                signature: B64.encode(sig.to_bytes()),
            };
            let json = serde_json::to_string_pretty(&file)?;

            // Verificación de ida y vuelta antes de entregar: nunca emitir una
            // licencia que la propia clave pública no valide.
            verify(&json, &[signing.verifying_key()])
                .map_err(|e| anyhow::anyhow!("la licencia emitida no verifica: {e}"))?;

            match out {
                Some(path) => {
                    fs::write(&path, &json)?;
                    eprintln!(
                        "✓ licencia para '{}' escrita en {} (vence {})",
                        payload.cliente,
                        path.display(),
                        payload.expires_at.format("%Y-%m-%d")
                    );
                }
                None => println!("{json}"),
            }
        }

        Cmd::Inspect { file, pubkey, key } => {
            let raw = fs::read_to_string(&file)
                .with_context(|| format!("no se pudo leer {}", file.display()))?;
            let vk = match pubkey {
                Some(b64) => {
                    let bytes: [u8; 32] = B64
                        .decode(b64.trim())
                        .context("clave pública en base64 inválida")?
                        .as_slice()
                        .try_into()
                        .context("la clave pública no tiene 32 bytes")?;
                    VerifyingKey::from_bytes(&bytes).context("clave pública inválida")?
                }
                None => load_signing_key(&key)?.verifying_key(),
            };

            match verify(&raw, &[vk]) {
                Ok(p) => {
                    let estado = if Utc::now() < p.expires_at { "vigente" } else { "VENCIDA" };
                    println!("✓ firma válida");
                    println!("  cliente:    {}", p.cliente);
                    println!("  instancia:  {}", p.instance_id);
                    println!("  modalidad:  {}", p.modalidad);
                    println!("  emitida:    {}", p.issued_at.format("%Y-%m-%d"));
                    println!("  vence:      {} ({})", p.expires_at.format("%Y-%m-%d"), estado);
                }
                Err(e) => bail!("licencia inválida: {e}"),
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cifrado_ida_y_vuelta_recupera_el_seed() {
        let seed = SigningKey::generate(&mut OsRng).to_bytes();
        let enc = encrypt_seed(&seed, "una-passphrase-larga").unwrap();
        let back = decrypt_seed(&enc, "una-passphrase-larga").unwrap();
        assert_eq!(seed, back);
    }

    #[test]
    fn una_passphrase_equivocada_no_descifra() {
        // GCM autentica: descifrar con la passphrase equivocada falla en lugar
        // de devolver bytes basura que se tomarían por una clave válida.
        let seed = SigningKey::generate(&mut OsRng).to_bytes();
        let enc = encrypt_seed(&seed, "la-correcta").unwrap();
        assert!(decrypt_seed(&enc, "la-incorrecta").is_err());
    }

    #[test]
    fn el_ciclo_completo_produce_una_licencia_que_verifica() {
        let seed = SigningKey::generate(&mut OsRng).to_bytes();
        let enc = encrypt_seed(&seed, "passphrase-de-prueba").unwrap();
        let signing = SigningKey::from_bytes(&decrypt_seed(&enc, "passphrase-de-prueba").unwrap());

        let now = Utc::now();
        let payload = LicensePayload {
            v: SUPPORTED_VERSION,
            cliente: "acme".into(),
            instance_id: "01ABC".into(),
            issued_at: now,
            expires_at: now + Duration::days(45),
            modalidad: "onprem".into(),
        };
        let sig = signing.sign(signing_message(&payload).as_bytes());
        let file = LicenseFile {
            payload,
            signature: B64.encode(sig.to_bytes()),
        };
        let json = serde_json::to_string(&file).unwrap();

        assert!(verify(&json, &[signing.verifying_key()]).is_ok());
    }
}
