#!/usr/bin/env bash
# Docker firewall hardening — reglas en la chain DOCKER-USER.
#
# Por qué esto y no ufw a secas: Docker publica puertos via iptables (chain
# DOCKER) en la tabla `nat`, ANTES de que ufw opine. Un contenedor con
# `ports: - "5432:5432"` queda accesible desde internet aunque ufw esté
# activo y bloquee 5432 en INPUT.
#
# La chain DOCKER-USER es el punto de filtrado que Docker respeta y que
# sobrevive a `docker restart`: es la primera regla que se evalúa para
# tráfico FORWARD-eado hacia contenedores. Aplicar allowlist acá es
# agnóstico del provider (no depende de Hostinger Firewall, AWS SG,
# Azure NSG, DO Firewall) y funciona igual en cualquier host Linux con
# Docker.
#
# Política aplicada (default deny hacia contenedores):
#   1. Conexiones RELATED,ESTABLISHED (respuestas al tráfico saliente).
#   2. Loopback (`lo`).
#   3. Interfaces de administración (por defecto `tailscale0`).
#   4. Puertos TCP públicos (por defecto 80 y 443 — el reverse proxy del host).
#   5. Puertos UDP públicos (opcional, vacío por defecto).
#   6. Todo lo demás → DROP.
#
# El script es idempotente: correrlo N veces produce el mismo estado.
# Se puede correr por systemd (docker-firewall.service) al boot y en cada
# restart de Docker (via PartOf=docker.service), o a mano tras cambiar la
# config.
#
# Overrides opcionales en /etc/fluke/docker-firewall.conf (KEY=VALUE; se
# acepta /etc/mkanban/docker-firewall.conf como fallback de hosts previos):
#   ADMIN_IFACES=tailscale0,wg0
#   PUBLIC_TCP_PORTS=80,443
#   PUBLIC_UDP_PORTS=51820

set -euo pipefail

CONF_FILE="${DOCKER_FIREWALL_CONF:-/etc/fluke/docker-firewall.conf}"
if [[ -z "${DOCKER_FIREWALL_CONF:-}" && ! -f "$CONF_FILE" ]]; then
  CONF_FILE=/etc/mkanban/docker-firewall.conf
fi
if [[ -f "$CONF_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONF_FILE"
fi

# Defaults alineados con la factory: Tailscale para admin remoto y 80/443
# para el reverse proxy (Traefik). Sin puertos UDP públicos por defecto.
ADMIN_IFACES="${ADMIN_IFACES:-tailscale0}"
PUBLIC_TCP_PORTS="${PUBLIC_TCP_PORTS:-80,443}"
PUBLIC_UDP_PORTS="${PUBLIC_UDP_PORTS:-}"

log() { echo "[docker-firewall $(date -u +%FT%TZ)] $*"; }

apply_rules() {
  # $1: comando (iptables | ip6tables). $2: label (v4 | v6) para logs.
  local ipt="$1"
  local family="$2"

  # DOCKER-USER la crea Docker al arrancar. Si no existe, salir limpio en
  # lugar de fallar: el sad path típico es "systemd arrancó esto antes que
  # docker haya creado la chain". Con Wants/After=docker.service esto no
  # debería pasar, pero mejor no dejar el host inconsistente.
  if ! "$ipt" -w -n -L DOCKER-USER >/dev/null 2>&1; then
    log "chain DOCKER-USER ($family) no existe — skip"
    return 0
  fi

  # Idempotencia: vaciar y reaplicar. `-F` deja intacta la regla final
  # `-j RETURN` que Docker inyecta a nivel de la chain, y encima nuestra
  # última regla es DROP explícito, así que no confiamos en ese RETURN.
  "$ipt" -w -F DOCKER-USER

  # 1) Respuestas al tráfico saliente de los contenedores.
  "$ipt" -w -A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN

  # 2) Loopback (permite un reverse proxy en el host que forwardea a
  #    contenedores publicados en 127.0.0.1:PUERTO).
  "$ipt" -w -A DOCKER-USER -i lo -j RETURN

  # 3) Interfaces de administración (mesh privada). Sólo se agregan las
  #    presentes: en un host recién provisionado sin tailscale, se saltea
  #    sin ruido y el operador puede activarlas más tarde.
  IFS=',' read -r -a admin_arr <<<"$ADMIN_IFACES"
  for iface in "${admin_arr[@]}"; do
    iface="${iface// /}"
    [[ -z "$iface" ]] && continue
    if [[ -d "/sys/class/net/$iface" ]]; then
      "$ipt" -w -A DOCKER-USER -i "$iface" -j RETURN
      log "allow admin iface $iface ($family)"
    else
      log "admin iface $iface ausente ($family) — skip"
    fi
  done

  # 4) Puertos TCP públicos (Traefik u otro reverse proxy en containers).
  if [[ -n "$PUBLIC_TCP_PORTS" ]]; then
    "$ipt" -w -A DOCKER-USER -p tcp -m conntrack --ctstate NEW \
      -m multiport --dports "$PUBLIC_TCP_PORTS" -j RETURN
    log "allow tcp $PUBLIC_TCP_PORTS ($family)"
  fi

  # 5) Puertos UDP públicos (opcional).
  if [[ -n "$PUBLIC_UDP_PORTS" ]]; then
    "$ipt" -w -A DOCKER-USER -p udp \
      -m multiport --dports "$PUBLIC_UDP_PORTS" -j RETURN
    log "allow udp $PUBLIC_UDP_PORTS ($family)"
  fi

  # 6) Default deny hacia contenedores.
  "$ipt" -w -A DOCKER-USER -j DROP

  log "reglas DOCKER-USER aplicadas ($family)"
}

if ! command -v docker >/dev/null 2>&1; then
  echo "docker no está instalado" >&2
  exit 1
fi

# Chequeo mínimo del daemon: si no responde, la chain no está lista y
# aplicar reglas ahora podría dejar un estado a medias.
if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon no responde — abortar" >&2
  exit 1
fi

apply_rules iptables v4

# IPv6 opcional: no todos los hosts lo tienen habilitado en el daemon Docker.
if command -v ip6tables >/dev/null 2>&1; then
  apply_rules ip6tables v6
fi

log "OK"
