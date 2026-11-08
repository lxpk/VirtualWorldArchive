#!/bin/bash
# VirtualWorldArchive: deploy or update the Docker Compose stack on the VM.
#
# Run ON the VM:            bash deploy.sh
# Or FROM your computer:    ssh ubuntu@<VM_IP> 'bash -s' < deploy/oracle/deploy.sh
#
# Settings (environment variables, all optional):
#   REPO_URL   git URL to clone   (default: https://github.com/lxpk/virtualworldarchive.git)
#              For a private repo use https://<user>:<token>@github.com/... with a
#              read-only fine-grained token, or set up a deploy key on the VM.
#   BRANCH     branch to deploy   (default: main)
#   APP_DIR    checkout location  (default: ~/virtualworldarchive)
#   HTTPS      1 = put Caddy in front with a free Let's Encrypt cert on
#              <ip-with-dashes>.sslip.io (needed for WebXR / VR headsets).
#              Default 1. Set HTTPS=0 for plain http://<ip>/.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/lxpk/virtualworldarchive.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-$HOME/virtualworldarchive}"
HTTPS="${HTTPS:-1}"

# Use sudo for docker if this user isn't in the docker group yet (first login).
DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. Run deploy/oracle/cloud-init.sh with sudo first." >&2
  exit 1
fi

# --- Get or update the code ---
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --prune origin "$BRANCH"
  git -C "$APP_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

if [ ! -f docker-compose.yml ] && [ ! -f compose.yaml ] && [ ! -f compose.yml ] && [ ! -f docker-compose.yaml ]; then
  echo "No compose file at the root of branch '$BRANCH' yet. Set BRANCH=<branch with the stack>." >&2
  exit 1
fi

# --- .env: create from .env.example once, filling secrets with random values ---
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  # Any KEY=changeme / KEY= (empty) line whose name looks secret gets a random value.
  while IFS= read -r key; do
    val="$(openssl rand -hex 24)"
    sed -i "s|^${key}=.*|${key}=${val}|" .env
  done < <(grep -E '^[A-Z0-9_]*(PASSWORD|SECRET|TOKEN|KEY)[A-Z0-9_]*=(changeme|change_me|)?$' .env | cut -d= -f1)
  chmod 600 .env
  echo "Created .env from .env.example (secrets generated)."
fi

# Public IP, handy for the stack (e.g. PUBLIC_URL) and for the summary below.
PUBLIC_IP="$(curl -fsS --max-time 5 https://ifconfig.me || curl -fsS --max-time 5 https://api.ipify.org || echo unknown)"
export PUBLIC_IP

# --- Optional HTTPS: the stack listens on 8080 on the host, Caddy takes 80/443 ---
set_env() { grep -q "^$1=" .env 2>/dev/null && sed -i "s|^$1=.*|$1=$2|" .env || echo "$1=$2" >> .env; }
if [ "$HTTPS" = "1" ] && [ "$PUBLIC_IP" != "unknown" ]; then
  HOSTNAME_PUBLIC="${PUBLIC_IP//./-}.sslip.io"
  set_env HTTP_PORT 8080
  mkdir -p "$HOME/caddy"
  cat > "$HOME/caddy/Caddyfile" <<CADDY
${HOSTNAME_PUBLIC} {
	encode gzip
	reverse_proxy 127.0.0.1:8080
}
http://${PUBLIC_IP} {
	reverse_proxy 127.0.0.1:8080
}
CADDY
  SITE_URL="https://${HOSTNAME_PUBLIC}/"
else
  $DOCKER rm -f vwa-caddy >/dev/null 2>&1 || true
  [ -f .env ] && sed -i '/^HTTP_PORT=8080$/d' .env
  SITE_URL="http://${PUBLIC_IP}/"
fi

# --- Build natively for arm64 and start ---
$DOCKER compose pull --ignore-buildable 2>/dev/null || $DOCKER compose pull --ignore-pull-failures || true
$DOCKER compose up -d --build --remove-orphans
$DOCKER image prune -f >/dev/null

# Start Caddy after the stack has moved off port 80.
if [ "$HTTPS" = "1" ] && [ "$PUBLIC_IP" != "unknown" ]; then
  $DOCKER rm -f vwa-caddy >/dev/null 2>&1 || true
  $DOCKER run -d --name vwa-caddy --restart unless-stopped --network host \
    -v "$HOME/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
    -v vwa-caddy-data:/data -v vwa-caddy-config:/config \
    caddy:2-alpine >/dev/null
fi

# Wait (up to ~3 min) for the demo world server: the first start builds its
# image and pulls postgres, which takes about a minute.
HEALTH_PORT="$(grep -E '^HTTP_PORT=' .env 2>/dev/null | cut -d= -f2)"
HEALTH_URL="http://127.0.0.1:${HEALTH_PORT:-80}/api/servers/vrarchive"
echo "Waiting for $HEALTH_URL ..."
for _ in $(seq 1 36); do
  body="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null || true)"
  if echo "$body" | grep -q '"running"'; then echo "World server is running."; break; fi
  sleep 5
done
echo "$body" | grep -q '"running"' || echo "World server not reporting running yet; check: docker compose logs -f" >&2

echo
$DOCKER compose ps
echo
echo "Deployed branch '$BRANCH' ($(git rev-parse --short HEAD))."
echo "Open:  ${SITE_URL}"
[ "$HTTPS" = "1" ] && echo "       (also http://${PUBLIC_IP}/ ; the HTTPS cert can take ~30s on first run)"
echo "Logs:  cd $APP_DIR && docker compose logs -f"
