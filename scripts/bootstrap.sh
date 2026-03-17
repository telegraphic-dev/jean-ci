#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
EXAMPLE_FILE="$ROOT_DIR/.env.example"

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
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

get_value() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | tail -n1 | cut -d= -f2-
}

set_value() {
  local key="$1"
  local value="$2"
  local tmp
  tmp=$(mktemp)

  if [[ -f "$ENV_FILE" ]]; then
    grep -v -E "^${key}=" "$ENV_FILE" > "$tmp" || true
  fi
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
}

append_if_missing() {
  local key="$1"
  local value="$2"
  if ! grep -qE "^${key}=" "$ENV_FILE"; then
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    echo "Added $key"
  fi
}

replace_placeholder_if_needed() {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=replace-with-long-random-secret$" "$ENV_FILE"; then
    set_value "$key" "$value"
    echo "Generated $key"
  fi
}

sync_database_url() {
  local user password db encoded_user encoded_password encoded_db database_url
  user=$(get_value "POSTGRES_USER")
  password=$(get_value "POSTGRES_PASSWORD")
  db=$(get_value "POSTGRES_DB")

  encoded_user=$(rawurlencode "$user")
  encoded_password=$(rawurlencode "$password")
  encoded_db=$(rawurlencode "$db")
  database_url="postgresql://${encoded_user}:${encoded_password}@postgres:5432/${encoded_db}"

  set_value "DATABASE_URL" "$database_url"
  echo "Synced DATABASE_URL from POSTGRES_* settings"
}

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$EXAMPLE_FILE" "$ENV_FILE"
  echo "Created .env from .env.example"
else
  echo ".env already exists, leaving existing values in place"
fi

append_if_missing "POSTGRES_DB" "jean_ci"
append_if_missing "POSTGRES_USER" "jean_ci"
append_if_missing "POSTGRES_PASSWORD" "$(random_hex)"
replace_placeholder_if_needed "POSTGRES_PASSWORD" "$(random_hex)"
sync_database_url

append_if_missing "SESSION_SECRET" "$(random_hex)"
append_if_missing "CRON_SECRET" "$(random_hex)"
replace_placeholder_if_needed "SESSION_SECRET" "$(random_hex)"
replace_placeholder_if_needed "CRON_SECRET" "$(random_hex)"
append_if_missing "BASE_URL" "http://localhost:3000"
append_if_missing "NEXT_PUBLIC_BASE_URL" "http://localhost:3000"
append_if_missing "DATA_DIR" "/data"
append_if_missing "PORT" "3000"
append_if_missing "NODE_ENV" "production"

echo
echo "Bootstrap complete. Fill in these real values in .env before production use:"
echo "- GITHUB_APP_ID"
echo "- GITHUB_WEBHOOK_SECRET"
echo "- GITHUB_APP_PRIVATE_KEY_B64"
echo "- GITHUB_CLIENT_ID"
echo "- GITHUB_CLIENT_SECRET"
echo "- ADMIN_GITHUB_ID"
echo "- OPENCLAW_GATEWAY_URL"
echo "- OPENCLAW_GATEWAY_TOKEN"
echo
echo "Next steps:"
echo "1. make doctor"
echo "2. docker compose up -d --build"
