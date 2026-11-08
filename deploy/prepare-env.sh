#!/bin/bash
# Creates or updates the stack's .env (in the current directory) from .env.example.
#   - New keys from .env.example are added; existing values are kept.
#   - Secret-looking keys (PASSWORD/SECRET/TOKEN/KEY) that are empty or
#     "changeme" get random values.
#   - Arguments KEY=VALUE are forced, e.g. HTTP_PORT=8080 PUBLIC_URL=https://...
# Used by deploy/oracle/deploy.sh and .devcontainer/start.sh.
set -euo pipefail
touch .env && chmod 600 .env

set_env() {
  local k="$1" v="$2"
  if grep -q "^${k}=" .env; then
    python3 - "$k" "$v" <<'PY' 2>/dev/null || sed -i "s|^${k}=.*|${k}=${v}|" .env
import sys
k, v = sys.argv[1], sys.argv[2]
lines = open('.env').read().splitlines()
open('.env', 'w').write('\n'.join(f'{k}={v}' if l.startswith(k + '=') else l for l in lines) + '\n')
PY
  else
    echo "${k}=${v}" >> .env
  fi
}

if [ -f .env.example ]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"
    grep -q "^${k}=" .env || echo "${k}=${v}" >> .env
  done < .env.example
fi

# Fill empty / placeholder secrets.
for k in $(grep -oE '^[A-Z0-9_]*(PASSWORD|SECRET|TOKEN|KEY)[A-Z0-9_]*=' .env | tr -d '=' || true); do
  v="$(grep "^${k}=" .env | head -1 | cut -d= -f2-)"
  case "$v" in ""|changeme|change_me|change-me|CHANGEME) set_env "$k" "$(openssl rand -hex 16)";; esac
done

for kv in "$@"; do set_env "${kv%%=*}" "${kv#*=}"; done
