#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
EXAMPLE_FILE="$ROOT_DIR/.env.example"

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  fi
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
    python3 - "$ENV_FILE" "$key" "$value" <<'PY'
import sys
path, key, value = sys.argv[1:4]
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()
content = content.replace(f"{key}=replace-with-long-random-secret", f"{key}={value}")
with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
PY
    echo "Generated $key"
  fi
}

sync_database_url() {
  python3 - "$ENV_FILE" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
lines = path.read_text(encoding='utf-8').splitlines()
values = {}
for line in lines:
    if '=' in line and not line.lstrip().startswith('#'):
        k, v = line.split('=', 1)
        values[k] = v

user = values.get('POSTGRES_USER', 'jean_ci')
password = values.get('POSTGRES_PASSWORD', '')
db = values.get('POSTGRES_DB', 'jean_ci')
database_url = 'postgresql://' + user + ':' + password + '@postgres:5432/' + db

updated = []
found = False
for line in lines:
    if line.startswith('DATABASE_URL='):
        updated.append('DATABASE_URL=' + database_url)
        found = True
    else:
        updated.append(line)
if not found:
    updated.append('DATABASE_URL=' + database_url)

path.write_text('\n'.join(updated) + '\n', encoding='utf-8')
PY
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
echo "- GITHUB_APP_PRIVATE_KEY_B64 (or GITHUB_APP_PRIVATE_KEY_PATH)"
echo "- GITHUB_CLIENT_ID"
echo "- GITHUB_CLIENT_SECRET"
echo "- ADMIN_GITHUB_ID"
echo "- OPENCLAW_GATEWAY_URL"
echo "- OPENCLAW_GATEWAY_TOKEN"
echo
echo "Next steps:"
echo "1. make doctor"
echo "2. docker compose up -d --build"
