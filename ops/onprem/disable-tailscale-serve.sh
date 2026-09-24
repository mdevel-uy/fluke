#!/usr/bin/env bash
# Desactiva Tailscale Serve para Fluke.
#
# Uso normal: durante la desinstalación o si querés dejar la app solo por
# HTTP en el tailnet. La app en `FK_BIND_ADDR:FK_PORT` sigue disponible;
# esto solo saca la vía HTTPS por `<host>.<tailnet>.ts.net`.

set -euo pipefail

log() { echo "[ts-serve $(date -u +%FT%TZ)] $*"; }

if ! command -v tailscale >/dev/null 2>&1; then
  log "tailscale no está instalado — nada que desactivar"
  exit 0
fi

if ! tailscale status >/dev/null 2>&1; then
  log "tailscaled no responde — no se puede consultar el estado de serve"
  exit 0
fi

# `tailscale serve reset` borra todos los handlers; equivale al "desactivar"
# porque en este bundle solo definimos uno.
tailscale serve reset
log "serve reset OK"
