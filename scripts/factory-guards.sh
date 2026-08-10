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
#   5. Ningún archivo de prompts del repo puede introducir en el diff
#      instrucciones de escritura contra GitHub via `gh` (los writes deben
#      declararse en `.vk/actions.json` — issue #549). Se analiza SOLO
#      líneas agregadas y solo en los archivos de prompts listados en
#      PROMPT_FILE_PATTERNS abajo. Las lecturas (`gh pr view`,
#      `gh pr checks`, `gh api` GET) están permitidas.
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

# Archivos considerados "prompts" para el guard gh-write (regla 5). Match por
# path glob del `git diff --name-only`. Cualquier `.rs` cuyo nombre termina en
# `_prompt.rs` o `_prompts.rs`, cualquier `.md` que termina en `_prompt.md` o
# `base_instructions.md`, bajo `crates/`.
PROMPT_FILE_PATTERNS=(
  'crates/**/*_prompt.rs'
  'crates/**/*_prompts.rs'
  'crates/**/*_prompt.md'
  'crates/**/base_instructions.md'
)

# Patrones que representan writes contra GitHub (issue #549). Estos se buscan
# SOLO en líneas agregadas por el diff en archivos que matcheen
# PROMPT_FILE_PATTERNS. Los reads (`gh pr view`, `gh pr checks`, `gh api` GET,
# `gh search`, `gh run view`, etc.) están fuera del set.
GH_WRITE_PATTERNS=(
  'gh[[:space:]]+(pr|issue)[[:space:]]+(create|close|comment|review)'
  'gh[[:space:]]+api[[:space:]]+-X[[:space:]]+(POST|PATCH|DELETE)'
)

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

# --- Regla 5: sin gh-writes agregados en archivos de prompts ----------------
# Solo se auditan las líneas AGREGADAS (líneas `+` en `git diff`, excluyendo
# los headers `+++ b/...`). Los reads siguen permitidos porque no matchean
# GH_WRITE_PATTERNS. Detectar y purgar los existentes fue parte de issue #549;
# esta regla evita regresiones futuras.
path_matches_any_pattern() {
  local path="$1"
  shift
  local pattern
  for pattern in "$@"; do
    # `[[ $path == $pattern ]]` con globstar reproduce el matching de globs.
    # shellcheck disable=SC2053
    if [[ "$path" == $pattern ]]; then
      return 0
    fi
  done
  return 1
}

shopt -s globstar
prompt_files=()
if ((${#changed_files[@]} > 0)); then
  for f in "${changed_files[@]}"; do
    if path_matches_any_pattern "$f" "${PROMPT_FILE_PATTERNS[@]}"; then
      # Solo escaneamos archivos que siguen existiendo tras el diff (los
      # borrados no pueden introducir instrucciones nuevas).
      if git cat-file -e "${HEAD_SHA}:${f}" 2>/dev/null; then
        prompt_files+=("$f")
      fi
    fi
  done
fi
shopt -u globstar

if ((${#prompt_files[@]} > 0)); then
  for f in "${prompt_files[@]}"; do
    # Extraemos las líneas agregadas del diff para este archivo. `git diff -U0`
    # elimina líneas de contexto; `grep '^+'` deja adds y `+++ b/...` header;
    # el `grep -v '^+++'` descarta el header para que no matchee por accidente.
    added_lines="$(git diff -U0 "$BASE_SHA" "$HEAD_SHA" -- "$f" \
      | grep '^+' | grep -v '^+++' || true)"
    [[ -z "$added_lines" ]] && continue
    for pattern in "${GH_WRITE_PATTERNS[@]}"; do
      offending="$(printf '%s\n' "$added_lines" | grep -E "$pattern" || true)"
      if [[ -n "$offending" ]]; then
        log_error "El diff introduce una instrucción de gh-write en el archivo de prompts '$f':"
        while IFS= read -r line; do
          # Cortamos el `+` inicial para leerse más natural en el log.
          echo "     ${line#+}" >&2
        done <<<"$offending"
        echo "   Los writes a GitHub (comentarios, issues, reviews, PRs) deben declararse" >&2
        echo "   en '.vk/actions.json' — nunca embebidos como comando \`gh\` en un prompt." >&2
        echo "   Si el hit es una assertion o docstring de test que describe el ban," >&2
        echo "   armá el literal con \`join(\" \")\` para que la fuente no contenga el patrón." >&2
        failed=1
      fi
    done
  done
fi

if ((failed != 0)); then
  echo ""
  echo "factory-guards: fallaron una o más reglas — ver mensajes arriba." >&2
  exit 1
fi

echo "factory-guards: OK"
