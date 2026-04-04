#!/usr/bin/env sh
set -eu

# Generate VAPID keys and upsert WEB_PUSH_* vars into a dotenv file
# Intended for docker compose env loading.
#
# Usage:
#   sh backend/scripts/gen_vapid_env.sh
#   sh backend/scripts/gen_vapid_env.sh --subject mailto:you@example.com
#   sh backend/scripts/gen_vapid_env.sh --env-file .env.local
#
# Defaults:
#   subject:  mailto:admin@example.com
#   env file: <repo_root>/.env

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"

SUBJECT="mailto:admin@example.com"
ENV_FILE="$REPO_ROOT/.env"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --subject)
      shift
      [ "$#" -gt 0 ] || { echo "Missing value for --subject" >&2; exit 1; }
      SUBJECT="$1"
      ;;
    --env-file)
      shift
      [ "$#" -gt 0 ] || { echo "Missing value for --env-file" >&2; exit 1; }
      ENV_FILE="$1"
      ;;
    -h|--help)
      echo "Usage: sh backend/scripts/gen_vapid_env.sh [--subject mailto:you@example.com] [--env-file .env]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
  shift
done

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 1
fi

GEN_SCRIPT="$SCRIPT_DIR/generate_vapid.py"
if [ ! -f "$GEN_SCRIPT" ]; then
  echo "Missing generator script: $GEN_SCRIPT" >&2
  exit 1
fi

GEN_OUTPUT="$(python3 "$GEN_SCRIPT" --subject "$SUBJECT")"

extract_var() {
  key="$1"
  printf "%s\n" "$GEN_OUTPUT" | grep "^${key}=" | tail -n 1 || true
}

WEB_PUSH_ENABLED_LINE="$(extract_var WEB_PUSH_ENABLED)"
WEB_PUSH_VAPID_PUBLIC_KEY_LINE="$(extract_var WEB_PUSH_VAPID_PUBLIC_KEY)"
WEB_PUSH_VAPID_PRIVATE_KEY_LINE="$(extract_var WEB_PUSH_VAPID_PRIVATE_KEY)"
WEB_PUSH_VAPID_SUBJECT_LINE="$(extract_var WEB_PUSH_VAPID_SUBJECT)"

for line in \
  "$WEB_PUSH_ENABLED_LINE" \
  "$WEB_PUSH_VAPID_PUBLIC_KEY_LINE" \
  "$WEB_PUSH_VAPID_PRIVATE_KEY_LINE" \
  "$WEB_PUSH_VAPID_SUBJECT_LINE"
do
  if [ -z "$line" ]; then
    echo "Failed to parse generated VAPID output." >&2
    echo "$GEN_OUTPUT" >&2
    exit 1
  fi
done

mkdir -p "$(dirname -- "$ENV_FILE")"
touch "$ENV_FILE"

upsert_env_line() {
  line="$1"
  key="${line%%=*}"
  value="${line#*=}"

  tmp_file="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { replaced = 0 }
    $0 ~ ("^" k "=") {
      print k "=" v
      replaced = 1
      next
    }
    { print }
    END {
      if (!replaced) print k "=" v
    }
  ' "$ENV_FILE" > "$tmp_file"
  mv "$tmp_file" "$ENV_FILE"
}

upsert_env_line "$WEB_PUSH_ENABLED_LINE"
upsert_env_line "$WEB_PUSH_VAPID_PUBLIC_KEY_LINE"
upsert_env_line "$WEB_PUSH_VAPID_PRIVATE_KEY_LINE"
upsert_env_line "$WEB_PUSH_VAPID_SUBJECT_LINE"

echo "Updated: $ENV_FILE"
echo "Set:"
echo "  WEB_PUSH_ENABLED"
echo "  WEB_PUSH_VAPID_PUBLIC_KEY"
echo "  WEB_PUSH_VAPID_PRIVATE_KEY"
echo "  WEB_PUSH_VAPID_SUBJECT"
echo ""
echo "Next:"
echo "  docker compose -f docker-compose.dev.yml restart backend"