#!/usr/bin/env bash
# Deterministic PR guards ejecutados por .github/workflows/factory-guards.yml.
#
# Reglas:
#   1. Si el diff toca shared/types.ts, el body del PR debe contener
#      el marcador [types-regen].
#   2. Si el diff toca Cargo.lock, el body del PR debe contener [lockfile].
#   3. Cada migración nueva bajo crates/db/migrations/ debe empezar con un
#      timestamp de 14 dígitos (YYYYMMDDHHMMSS_).
#   4. No puede haber dos migraciones con el mismo timestamp.
#
# Sad path: si BASE_SHA/HEAD_SHA no existen en el clon local, el script sale
# con código 2 (setup error) — nunca reporta verde por falta de historia.
#
# Uso local:
#   BASE_SHA=$(git merge-base HEAD origin/mdev) \
#   HEAD_SHA=HEAD \
#   PR_BODY="$(gh pr view --json body -q .body)" \
#   bash scripts/factory-guards.sh

set -euo pipefail

TYPES_FILE="shared/types.ts"
TYPES_MARKER="[types-regen]"
LOCKFILE_FILE="Cargo.lock"
LOCKFILE_MARKER="[lockfile]"
MIGRATIONS_DIR="crates/db/migrations"
MIGRATION_PATTERN='^[0-9]{14}_'

BASE_SHA="${BASE_SHA:-}"
HEAD_SHA="${HEAD_SHA:-HEAD}"
PR_BODY="${PR_BODY:-}"

log_error() {
  # Emite tanto formato GitHub como texto humano para que se vea en logs locales.
  echo "::error::$*"
  echo "❌ $*" >&2
}

if [[ -z "$BASE_SHA" ]]; then
  echo "factory-guards: BASE_SHA no seteado" >&2
  exit 2
fi

for ref in "$BASE_SHA" "$HEAD_SHA"; do
  if ! git rev-parse --verify --quiet "${ref}^{commit}" >/dev/null; then
    echo "factory-guards: ref no disponible en el checkout local: $ref" >&2
    echo "  Asegurate de hacer fetch de la base antes de correr el guard." >&2
    exit 2
  fi
done

failed=0

# --- Diff -------------------------------------------------------------------
# changed_files: cualquier archivo tocado (add/mod/del/rename).
# added_files:   solo archivos agregados (para detectar migraciones nuevas).
mapfile -t changed_files < <(git diff --name-only "$BASE_SHA" "$HEAD_SHA")
mapfile -t added_files < <(git diff --name-only --diff-filter=A "$BASE_SHA" "$HEAD_SHA")

contains_path() {
  local needle="$1"
  shift
  local f
  for f in "$@"; do
    [[ "$f" == "$needle" ]] && return 0
  done
  return 1
}

# --- Regla 1: shared/types.ts requiere marcador ------------------------------
if ((${#changed_files[@]} > 0)) && contains_path "$TYPES_FILE" "${changed_files[@]}"; then
  if [[ "$PR_BODY" != *"$TYPES_MARKER"* ]]; then
    log_error "El PR modifica $TYPES_FILE pero el body no incluye el marcador $TYPES_MARKER."
    echo "   shared/types.ts es autogenerado (ts-rs). Si lo regeneraste a propósito," >&2
    echo "   agregá $TYPES_MARKER al body del PR para dejarlo declarado." >&2
    failed=1
  fi
fi

# --- Regla 2: Cargo.lock requiere marcador -----------------------------------
if ((${#changed_files[@]} > 0)) && contains_path "$LOCKFILE_FILE" "${changed_files[@]}"; then
  if [[ "$PR_BODY" != *"$LOCKFILE_MARKER"* ]]; then
    log_error "El PR modifica $LOCKFILE_FILE pero el body no incluye el marcador $LOCKFILE_MARKER."
    echo "   Cargo.lock lo regenera infraestructura porque los workers no tienen toolchain de Rust." >&2
    echo "   Si agregaste una dependencia y regeneraste el lock a propósito, agregá $LOCKFILE_MARKER al body." >&2
    failed=1
  fi
fi

# --- Regla 3: migraciones nuevas con timestamp completo ----------------------
if ((${#added_files[@]} > 0)); then
  for f in "${added_files[@]}"; do
    [[ "$f" == "$MIGRATIONS_DIR"/*.sql ]] || continue
    base="$(basename "$f")"
    if [[ ! "$base" =~ $MIGRATION_PATTERN ]]; then
      log_error "Migración nueva '$f' no matchea ^\\d{14}_ (formato YYYYMMDDHHMMSS_nombre.sql)."
      echo "   Renombrala con el timestamp completo (14 dígitos)." >&2
      failed=1
    fi
  done
fi

# --- Regla 4: sin colisiones de timestamp ------------------------------------
if [[ -d "$MIGRATIONS_DIR" ]]; then
  # Extraemos los primeros 14 dígitos de cada nombre. Migraciones que ya fallan
  # la regla 3 se ignoran acá para no duplicar el error.
  mapfile -t timestamps < <(
    find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' \
      | sed -n 's/^\([0-9]\{14\}\)_.*/\1/p'
  )
  if ((${#timestamps[@]} > 0)); then
    dupes="$(printf '%s\n' "${timestamps[@]}" | sort | uniq -d)"
    if [[ -n "$dupes" ]]; then
      while IFS= read -r ts; do
        colliding="$(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name "${ts}_*.sql" -printf '%f ' )"
        log_error "Colisión de timestamp $ts en migraciones: ${colliding% }"
        echo "   Renombrá una de las migraciones con un timestamp diferente (segundo distinto)." >&2
        failed=1
      done <<<"$dupes"
    fi
  fi
fi

if ((failed != 0)); then
  echo ""
  echo "factory-guards: fallaron una o más reglas — ver mensajes arriba." >&2
  exit 1
fi

echo "factory-guards: OK"
