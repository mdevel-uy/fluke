//! `fluke-license` — herramienta interna de emisión y verificación de licencias.
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

use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use chrono::{Duration, Utc};
use clap::{Parser, Subcommand};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use license_keystore::{encrypt_seed, load_signing_key as keystore_load, to_json};
use licensing::{LicenseFile, LicensePayload, SUPPORTED_VERSION, signing_message, verify};
use rand::rngs::OsRng;

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
#[command(name = "fluke-license", about = "Emisión y verificación de licencias de mkanban")]
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

/// Carga la clave de firma: pide la passphrase y delega el descifrado en
/// `license-keystore` (compartido con el control plane).
fn load_signing_key(path: &PathBuf) -> Result<SigningKey> {
    let pass = read_passphrase("passphrase: ")?;
    keystore_load(&path.to_string_lossy(), &pass)
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
            fs::write(&out, to_json(&enc)?)
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

    // El roundtrip de cifrado/descifrado vive en el crate license-keystore.
    // Acá se prueba que una licencia firmada por la herramienta verifica —
    // el ciclo firma→verifica de punta a punta.
    #[test]
    fn el_ciclo_completo_produce_una_licencia_que_verifica() {
        let signing = SigningKey::generate(&mut OsRng);

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
