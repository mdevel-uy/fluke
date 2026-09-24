#!/usr/bin/env bash
# Updater OTA de Fluke on-premises.
#
# Flujo: pull del tag de canal → si hay imagen nueva: backup de datos →
# restart con la imagen nueva → espera healthcheck → si no levanta sano,
# rollback automático (imagen anterior + restore del backup).
#
# Idempotente y seguro de correr por cron/timer, p. ej.:
#   17 4 * * * /opt/fluke/update.sh >> /var/log/fluke-update.log 2>&1
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

IMAGE="${FK_IMAGE:-${MK_IMAGE:-ghcr.io/mdevel-uy/mkanban}}"
CHANNEL="${FK_CHANNEL:-${MK_CHANNEL:-stable}}"
SERVICE="fluke"
CONTAINER="fluke"
DATA_VOLUME="fk-home"
# Ruta del data dir dentro del volumen: asset_dir() del server en Linux
# (~/.local/share/mkanban) — contiene db.v2.sqlite, config y credenciales.
DATA_SUBDIR=".local/share/mkanban"
BACKUP_DIR="${PWD}/backups"
KEEP_BACKUPS=10
HEALTH_TIMEOUT_SECS=180

log() { echo "[fk-update $(date -u +%FT%TZ)] $*"; }

# Rebrand mkanban → Fluke: los volúmenes pasaron de mk-* a fk-*. Si quedan los
# viejos y no los nuevos, arrancar crearía fk-home vacío y la instancia
# "perdería" sus datos (siguen en mk-home). Abortar hasta migrar a mano.
if docker volume inspect mk-home >/dev/null 2>&1 &&
   ! docker volume inspect "${DATA_VOLUME}" >/dev/null 2>&1; then
  log "ERROR: existe el volumen mk-home pero no ${DATA_VOLUME}."
  log "migrar los volúmenes antes de actualizar (RUNBOOK → Migración a Fluke)."
  exit 1
fi

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
#
# En una instalación nueva el volumen está vacío y no hay nada que respaldar;
# intentar el tar igual aborta el script (set -e) y la app nunca arranca. Por eso
# se consulta el volumen antes en lugar de asumir que el data dir existe.
docker compose stop "${SERVICE}"

# `docker volume inspect` primero: montar el volumen con `docker run` lo crearía
# vacío y sin las etiquetas de compose, lo que hace que el `up` siguiente emita
# un warning de "volume already exists but was not created by Docker Compose".
backup_file=""
if docker volume inspect "${DATA_VOLUME}" >/dev/null 2>&1 &&
   docker run --rm -v "${DATA_VOLUME}:/data:ro" alpine \
     test -d "/data/${DATA_SUBDIR}" 2>/dev/null; then
  mkdir -p "${BACKUP_DIR}"
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  backup_file="fk-data-${stamp}.tgz"
  log "backup → backups/${backup_file}"
  docker run --rm \
    -v "${DATA_VOLUME}:/data:ro" \
    -v "${BACKUP_DIR}:/backup" \
    alpine tar czf "/backup/${backup_file}" -C /data "${DATA_SUBDIR}"

  # Rotación de backups.
  ls -1t "${BACKUP_DIR}"/fk-data-*.tgz 2>/dev/null | tail -n "+$((KEEP_BACKUPS + 1))" | xargs -r rm -f
else
  log "sin datos previos que respaldar (instalación nueva)"
fi

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
  log "instalación nueva fallida: no hay versión previa a la que volver."
  log "revisar 'docker compose logs ${SERVICE}' — la instancia queda detenida."
  exit 1
fi

# Restaurar datos al estado pre-update (las migraciones nuevas pueden haber
# corrido) y volver a apuntar el tag de canal LOCAL a la imagen anterior.
# El próximo pull vuelve a traer el canal remoto, así que esto no pisa nada.
if [[ -n "${backup_file}" ]]; then
  docker run --rm \
    -v "${DATA_VOLUME}:/data" \
    -v "${BACKUP_DIR}:/backup:ro" \
    alpine sh -c "rm -rf '/data/${DATA_SUBDIR}' && tar xzf '/backup/${backup_file}' -C /data"
else
  log "sin backup previo: se conserva el estado actual de los datos"
fi
docker tag "${IMAGE}:previous" "${IMAGE}:${CHANNEL}"
docker compose up -d "${SERVICE}"

log "rollback aplicado (${current_id:7:12}); revisar logs de la versión fallida antes de reintentar"
exit 1
