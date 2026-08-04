#!/usr/bin/env bash
# Updater OTA de mkanban on-premises (mkanban.dev).
#
# Flujo: pull del tag de canal → si hay imagen nueva: backup de datos →
# restart con la imagen nueva → espera healthcheck → si no levanta sano,
# rollback automático (imagen anterior + restore del backup).
#
# Idempotente y seguro de correr por cron/timer, p. ej.:
#   17 4 * * * /opt/mkanban/update.sh >> /var/log/mkanban-update.log 2>&1
#
# Las migraciones de esquema corren dentro del binario al arranque y son
# forward-only: el rollback restaura el backup de la DB tomado justo antes
# del update, por eso el backup no es opcional.

set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

# Config por-cliente (credenciales GHCR, canal, plan).
set -a
# shellcheck disable=SC1091
source ./.env
set +a

IMAGE="${MK_IMAGE:-ghcr.io/mdevel-uy/mkanban}"
CHANNEL="${MK_CHANNEL:-stable}"
SERVICE="mkanban"
CONTAINER="mkanban"
DATA_VOLUME="mk-home"
# Ruta del data dir dentro del volumen: asset_dir() del server en Linux
# (~/.local/share/mkanban) — contiene db.v2.sqlite, config y credenciales.
DATA_SUBDIR=".local/share/mkanban"
BACKUP_DIR="${PWD}/backups"
KEEP_BACKUPS=10
HEALTH_TIMEOUT_SECS=180

log() { echo "[mk-update $(date -u +%FT%TZ)] $*"; }

if [[ -n "${GHCR_TOKEN:-}" ]]; then
  echo "${GHCR_TOKEN}" | docker login ghcr.io -u "${GHCR_USER:-token}" --password-stdin >/dev/null
fi

current_id="$(docker inspect --format '{{.Image}}' "${CONTAINER}" 2>/dev/null || true)"

log "pull ${IMAGE}:${CHANNEL}"
docker compose pull --quiet "${SERVICE}"
new_id="$(docker image inspect --format '{{.Id}}' "${IMAGE}:${CHANNEL}")"

if [[ "${current_id}" == "${new_id}" ]]; then
  log "ya al día (${new_id:7:12})"
  exit 0
fi

new_version="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "${IMAGE}:${CHANNEL}" 2>/dev/null || true)"
log "imagen nueva detectada: ${current_id:7:12} → ${new_id:7:12} ${new_version:+(v${new_version})}"

# Punto de rollback: conservar la imagen corriente bajo un tag local.
if [[ -n "${current_id}" ]]; then
  docker tag "${current_id}" "${IMAGE}:previous"
fi

# Backup del data dir (DB sqlite + config + credenciales) con la app parada:
# journal mode Delete ⇒ el archivo se copia limpio con el proceso detenido.
mkdir -p "${BACKUP_DIR}"
stamp="$(date -u +%Y%m%d-%H%M%S)"
backup_file="mk-data-${stamp}.tgz"
log "backup → backups/${backup_file}"
docker compose stop "${SERVICE}"
docker run --rm \
  -v "${DATA_VOLUME}:/data:ro" \
  -v "${BACKUP_DIR}:/backup" \
  alpine tar czf "/backup/${backup_file}" -C /data "${DATA_SUBDIR}"

# Rotación de backups.
ls -1t "${BACKUP_DIR}"/mk-data-*.tgz 2>/dev/null | tail -n "+$((KEEP_BACKUPS + 1))" | xargs -r rm -f

log "arrancando versión nueva"
docker compose up -d "${SERVICE}"

deadline=$((SECONDS + HEALTH_TIMEOUT_SECS))
while ((SECONDS < deadline)); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "${CONTAINER}" 2>/dev/null || echo unknown)"
  if [[ "${status}" == "healthy" ]]; then
    log "update OK (${new_id:7:12} healthy)"
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 5
done

log "ERROR: healthcheck no pasó en ${HEALTH_TIMEOUT_SECS}s — rollback"
docker compose stop "${SERVICE}" || true

if [[ -z "${current_id}" ]]; then
  log "sin imagen previa para rollback; instancia detenida, intervención manual requerida"
  exit 1
fi

# Restaurar datos al estado pre-update (las migraciones nuevas pueden haber
# corrido) y volver a apuntar el tag de canal LOCAL a la imagen anterior.
# El próximo pull vuelve a traer el canal remoto, así que esto no pisa nada.
docker run --rm \
  -v "${DATA_VOLUME}:/data" \
  -v "${BACKUP_DIR}:/backup:ro" \
  alpine sh -c "rm -rf '/data/${DATA_SUBDIR}' && tar xzf '/backup/${backup_file}' -C /data"
docker tag "${IMAGE}:previous" "${IMAGE}:${CHANNEL}"
docker compose up -d "${SERVICE}"

log "rollback aplicado (${current_id:7:12}); revisar logs de la versión fallida antes de reintentar"
exit 1
