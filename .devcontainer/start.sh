#!/bin/bash
# Start the stack each time the codespace starts. First run builds images (~1-2 min).
cd "$(dirname "$0")/.."
for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done
docker compose up -d --build
echo
echo "Virtual World Archive is starting on port 8080 (see the Ports tab)."
echo "Register the first account to become Site Admin. Logs: docker compose logs -f archive"
