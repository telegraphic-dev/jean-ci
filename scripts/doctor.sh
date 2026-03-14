#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

warnings=0
failures=0

die() {
  echo "[fail] $1"
  exit 1
}

warn() {
  echo "[warn] $1"
  warnings=$((warnings + 1))
}

ok() {
  echo "[ok] $1"
}

fail_check() {
  echo "[fail] $1"
  failures=$((failures + 1))
}

looks_placeholder() {
  local value="$1"
  [[ -z "$value" ]] || [[ "$value" == replace-* ]] || [[ "$value" == your_* ]] || [[ "$value" == 000000 ]] || [[ "$value" == 12345678 ]] || [[ "$value" == base64-encoded-pem ]] || [[ "$value" == generated-by-bootstrap ]]
}

get_value() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | tail -n1 | cut -d= -f2-
}

rawurlencode() {
  local string="${1}"
  local strlen=${#string}
  local encoded=""
  local pos c o

  for (( pos=0; pos<strlen; pos++ )); do
    c=${string:$pos:1}
    case "$c" in
      [-_.~a-zA-Z0-9]) o="$c" ;;
      *) printf -v o '%%%02X' "'$c" ;;
    esac
    encoded+="${o}"
  done

  printf '%s' "$encoded"
}

if command -v docker >/dev/null 2>&1; then
  ok "docker installed"
else
  die "docker is not installed"
fi

if docker compose version >/dev/null 2>&1; then
  ok "docker compose available"
else
  die "docker compose is not available"
fi

if [[ -f "$ENV_FILE" ]]; then
  ok ".env present"
else
  die ".env missing (run: make bootstrap)"
fi

required_keys=(
  DATABASE_URL
  BASE_URL
  NEXT_PUBLIC_BASE_URL
  SESSION_SECRET
  GITHUB_APP_ID
  GITHUB_WEBHOOK_SECRET
  GITHUB_CLIENT_ID
  GITHUB_CLIENT_SECRET
  ADMIN_GITHUB_ID
  OPENCLAW_GATEWAY_URL
  OPENCLAW_GATEWAY_TOKEN
  POSTGRES_DB
  POSTGRES_USER
  POSTGRES_PASSWORD
  GITHUB_APP_PRIVATE_KEY_B64
)

for key in "${required_keys[@]}"; do
  if grep -qE "^${key}=" "$ENV_FILE"; then
    value=$(get_value "$key")
    if looks_placeholder "$value"; then
      fail_check "$key still looks like a placeholder"
    else
      ok "$key set"
    fi
  else
    fail_check "$key missing from .env"
  fi
done

if grep -qE '^GITHUB_APP_PRIVATE_KEY_PATH=' "$ENV_FILE"; then
  value=$(get_value "GITHUB_APP_PRIVATE_KEY_PATH")
  if ! looks_placeholder "$value"; then
    warn "GITHUB_APP_PRIVATE_KEY_PATH is ignored by the default docker-compose setup; use GITHUB_APP_PRIVATE_KEY_B64 unless you add your own mount/secret override"
  fi
fi

postgres_user=$(get_value "POSTGRES_USER")
postgres_password=$(get_value "POSTGRES_PASSWORD")
postgres_db=$(get_value "POSTGRES_DB")
actual_database_url=$(get_value "DATABASE_URL")
expected_database_url="postgresql://$(rawurlencode "$postgres_user"):$(rawurlencode "$postgres_password")@postgres:5432/$(rawurlencode "$postgres_db")"

if [[ "$actual_database_url" == "$expected_database_url" ]]; then
  ok "DATABASE_URL is consistent with POSTGRES_* settings"
else
  fail_check "DATABASE_URL does not match POSTGRES_* settings (expected URL-encoded compose value)"
fi

if docker compose config >/dev/null 2>&1; then
  ok "docker compose config is valid"
else
  die "docker compose config is invalid"
fi

echo
if (( failures > 0 )); then
  echo "Doctor found ${failures} blocking issue(s) and ${warnings} warning(s)."
  exit 1
fi

echo "Doctor finished with ${warnings} warning(s)."
