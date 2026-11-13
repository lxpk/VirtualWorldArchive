#!/bin/bash
# Create .env for the codespace once. The portal listens on 8080 (forwarded by Codespaces).
# ADMIN_PASSWORD stays empty: the first account you register becomes Site Admin.
set -e
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i 's/^HTTP_PORT=.*/HTTP_PORT=8080/' .env
  echo "Created .env for the codespace."
fi
