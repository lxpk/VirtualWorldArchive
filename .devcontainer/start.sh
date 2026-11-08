#!/bin/bash
# Starts the Virtual World Archive stack inside a GitHub Codespace and makes
# the site public so anyone with the link can join the demo.
# Re-run any time with:  bash .devcontainer/start.sh
set -uo pipefail
cd "$(dirname "$0")/.."
exec > >(tee -a /tmp/vwa-start.log) 2>&1

PORT=8080
if [ -n "${CODESPACE_NAME:-}" ]; then
  URL="https://${CODESPACE_NAME}-${PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
else
  URL="http://localhost:${PORT}"
fi

echo "Waiting for Docker..."
for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done

bash deploy/prepare-env.sh "HTTP_PORT=${PORT}" "PUBLIC_URL=${URL}"

if ! docker compose up -d --build; then
  echo "docker compose failed; see the output above." >&2
  exit 1
fi

if [ -n "${CODESPACE_NAME:-}" ]; then
  gh codespace ports visibility "${PORT}:public" -c "$CODESPACE_NAME" \
    || echo "Could not make the port public automatically. In the PORTS tab, right-click port ${PORT} > Port Visibility > Public."
fi

echo "Waiting for the VR Archive world server (first start takes a minute or two)..."
ok=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/servers/vrarchive" 2>/dev/null | grep -q '"running"'; then ok=1; break; fi
  sleep 5
done
[ "$ok" = 1 ] && echo "World server is running." || echo "World server isn't reporting running yet. Check: docker compose logs -f" >&2

echo
echo "================================================================"
echo " Virtual World Archive: ${URL}/"
grep -E '^ADMIN_(EMAIL|PASSWORD)=' .env | sed 's/^/ /' || true
echo "================================================================"
