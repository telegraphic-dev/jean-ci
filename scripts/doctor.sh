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

private_key_b64_present=false
private_key_path_present=false
private_key_valid=false

if grep -qE '^GITHUB_APP_PRIVATE_KEY_B64=' "$ENV_FILE"; then
  private_key_b64_present=true
  value=$(get_value "GITHUB_APP_PRIVATE_KEY_B64")
  if ! looks_placeholder "$value"; then
    ok "GITHUB_APP_PRIVATE_KEY_B64 set"
    private_key_valid=true
  fi
fi

if grep -qE '^GITHUB_APP_PRIVATE_KEY_PATH=' "$ENV_FILE"; then
  private_key_path_present=true
  value=$(get_value "GITHUB_APP_PRIVATE_KEY_PATH")
  if looks_placeholder "$value"; then
    :
  elif [[ ! -f "$value" ]]; then
    fail_check "GITHUB_APP_PRIVATE_KEY_PATH points to a missing file"
  else
    ok "GITHUB_APP_PRIVATE_KEY_PATH points to an existing file"
    private_key_valid=true
  fi
fi

if ! $private_key_valid; then
  if $private_key_b64_present && $private_key_path_present; then
    fail_check "Neither GITHUB_APP_PRIVATE_KEY_B64 nor GITHUB_APP_PRIVATE_KEY_PATH is configured with a usable value"
  elif $private_key_b64_present; then
    fail_check "GITHUB_APP_PRIVATE_KEY_B64 still looks like a placeholder"
  elif $private_key_path_present; then
    fail_check "GITHUB_APP_PRIVATE_KEY_PATH still looks like a placeholder or points to a missing file"
  else
    fail_check "Either GITHUB_APP_PRIVATE_KEY_B64 or GITHUB_APP_PRIVATE_KEY_PATH must be set"
  fi
fi

python3 - "$ENV_FILE" <<'PY'
from pathlib import Path
from urllib.parse import urlparse
import sys

path = Path(sys.argv[1])
values = {}
for line in path.read_text(encoding='utf-8').splitlines():
    if '=' in line and not line.lstrip().startswith('#'):
        k, v = line.split('=', 1)
        values[k] = v

url = values.get('DATABASE_URL', '')
postgres_user = values.get('POSTGRES_USER', '')
postgres_password = values.get('POSTGRES_PASSWORD', '')
postgres_db = values.get('POSTGRES_DB', '')

parsed = urlparse(url)
errors = []
if parsed.scheme not in ('postgresql', 'postgres'):
    errors.append('DATABASE_URL must use postgres/postgresql scheme')
if parsed.hostname != 'postgres':
    errors.append('DATABASE_URL host should be postgres for docker-compose setup')
if parsed.username != postgres_user:
    errors.append('DATABASE_URL username does not match POSTGRES_USER')
if parsed.password != postgres_password:
    errors.append('DATABASE_URL password does not match POSTGRES_PASSWORD')
expected_db_path = '/' + postgres_db
if parsed.path != expected_db_path:
    errors.append('DATABASE_URL database name does not match POSTGRES_DB')

if errors:
    for error in errors:
        print(f'[fail] {error}')
    raise SystemExit(1)
else:
    print('[ok] DATABASE_URL is consistent with POSTGRES_* settings')
PY

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
