#!/usr/bin/env bash
# Habilita HTTPS de Fluke dentro del tailnet vía Tailscale Serve.
#
# Por qué esto y no un Caddy/Traefik nativo: la API de Notification y la
# instalación como PWA en Chrome exigen contexto seguro (HTTPS o localhost).
# Con acceso por IP de Tailscale sobre HTTP plano `window.isSecureContext`
# es false y el navegador no habilita ni notificaciones ni "Instalar app".
# Tailscale Serve resuelve las tres piezas en una: TLS terminado en el
# tailscaled del host, certificado válido de Let's Encrypt provisto por
# Tailscale para `<host>.<tailnet>.ts.net` (MagicDNS) y renovación
# automática — nada expuesto a internet.
#
# El acceso HTTP directo por IP de tailnet sigue funcionando como fallback
# (Fluke queda publicado en `FK_BIND_ADDR:FK_PORT` como antes); esto
# solamente agrega una vía HTTPS adicional.
#
# Idempotente: correrlo N veces produce el mismo estado. La renovación del
# cert la maneja Tailscale — no hace falta cron propio.
#
# Uso:
#   sudo ./enable-tailscale-serve.sh          # lee .env de al lado
#   sudo FK_PORT=3000 ./enable-tailscale-serve.sh
#
# Requisitos previos (una sola vez por tailnet, en el admin console):
#   - MagicDNS habilitado.
#   - HTTPS Certificates habilitado.
# Sin ambos, `tailscale cert` falla y el script aborta con un error claro.

set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

# Config por-cliente (misma fuente que docker-compose y update.sh).
if [[ -f ./.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source ./.env
  set +a
fi

FK_PORT="${FK_PORT:-3000}"
UPSTREAM="http://127.0.0.1:${FK_PORT}"

log() { echo "[ts-serve $(date -u +%FT%TZ)] $*"; }
err() { echo "[ts-serve $(date -u +%FT%TZ)] ERROR: $*" >&2; }

if ! command -v tailscale >/dev/null 2>&1; then
  err "tailscale no está instalado en el host — instalarlo antes (https://tailscale.com/kb/1031/install-linux)"
  exit 1
fi

# `tailscale status --json` devuelve estado del nodo. Si el daemon no
# corre o el nodo no está logueado, no hay MagicDNS ni cert posible.
if ! tailscale status >/dev/null 2>&1; then
  err "tailscaled no responde o el nodo no está logueado — correr 'sudo tailscale up' primero"
  exit 1
fi

# MagicDNS provee `<host>.<tailnet>.ts.net`. Sin él no hay dominio válido
# al que emitir certificado.
dns_name="$(tailscale status --json 2>/dev/null \
  | grep -oE '"DNSName":\s*"[^"]+"' \
  | head -n 1 \
  | sed -E 's/.*"DNSName":\s*"([^"]+)".*/\1/' \
  | sed 's/\.$//')"

if [[ -z "$dns_name" ]]; then
  err "no se pudo determinar el DNSName del nodo — verificar que MagicDNS esté habilitado en el admin console del tailnet"
  exit 1
fi

# Backend de la app: verificar que efectivamente esté escuchando en
# 127.0.0.1:FK_PORT. Si no, `tailscale serve` acepta la config igual pero
# el usuario verá 502 al abrir la URL — mejor fallar temprano y claro.
if ! (exec 3<>"/dev/tcp/127.0.0.1/${FK_PORT}") 2>/dev/null; then
  err "no hay servicio escuchando en 127.0.0.1:${FK_PORT} — verificar 'docker compose ps' y que fluke esté healthy"
  exit 1
fi
exec 3<&- 2>/dev/null || true

log "nodo tailnet: ${dns_name}"
log "upstream:     ${UPSTREAM}"

# Emisión/renovación del cert la hace Tailscale al primer handshake; el
# `tailscale cert` acá es opcional pero sirve para detectar temprano si
# HTTPS Certificates está deshabilitado en el tailnet (el error del serve
# a secas es menos claro).
if ! tailscale cert "$dns_name" >/dev/null 2>&1; then
  err "falló 'tailscale cert ${dns_name}' — verificar que HTTPS Certificates esté habilitado en el admin console del tailnet"
  err "(Tailscale admin → DNS → HTTPS Certificates → Enable)"
  exit 1
fi

# Idempotencia: si el serve config ya apunta a este upstream, no hace falta
# reconfigurar. `tailscale serve status` (texto plano) menciona el upstream
# de cada handler — más simple y estable que parsear el JSON.
if tailscale serve status 2>/dev/null | grep -qF "$UPSTREAM"; then
  log "serve ya apunta a ${UPSTREAM} — nada que hacer"
  log "URL: https://${dns_name}/"
  exit 0
fi

# Reset limpio antes de configurar — evita quedar con handlers viejos
# apuntando a puertos que ya no existen (p. ej. tras cambiar FK_PORT).
tailscale serve reset >/dev/null 2>&1 || true

# `--bg` deja el serve activo entre reinicios (persiste en el state del
# nodo). `--https=443` termina TLS en el tailscaled del host y proxya al
# upstream local. Tailscale Serve pasa WebSockets nativamente.
tailscale serve --bg --https=443 "$UPSTREAM"

log "serve activo — https://${dns_name}/"
log ""
log "verificación desde otro dispositivo del tailnet:"
log "  curl -sSI https://${dns_name}/ → HTTP/2 200"
log "  en el browser: window.isSecureContext === true"
log ""
log "Tailscale Serve preserva el Host header, así que el chequeo de mismo"
log "origen del server acepta el request sin config extra. Solo hace falta"
log "FK_ALLOWED_ORIGINS si además vas a servir bajo un dominio propio."
