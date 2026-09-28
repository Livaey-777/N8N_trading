#!/bin/sh
# Runs a read-only check inside the Compose network, using the PostgreSQL client bundled in the n8n image
# (no npm install, no Node.js on the host). Sends no AI or Telegram request and writes nothing.
#
#   sh deploy/n8n-web/verify.sh [--days=3]      # scheduled PRE_EVENT / DAILY_REPORT runs + AI fallback health
#   sh deploy/n8n-web/verify.sh --secret-scan   # the configured secret values in files and both databases
#
# Runs as the calling user, so a chmod-600 .env stays readable. COMPOSE_PROJECT_NAME / N8N_IMAGE override
# the defaults (project "gold-intelligence", the pinned n8n image).
set -eu
cd "$(dirname "$0")/../.."
PROJECT=${COMPOSE_PROJECT_NAME:-gold-intelligence}
IMAGE=${N8N_IMAGE:-docker.n8n.io/n8nio/n8n:1.117.2}
TOOL=tools/verify-live.js
if [ "${1:-}" = "--secret-scan" ]; then TOOL=tools/secret-scan.js; shift; fi
exec docker run --rm --network "${PROJECT}_default" --user "$(id -u):$(id -g)" \
  -v "$PWD:/app:ro" -w /app -e GI_PG_HOST=postgres -e GI_PG_PORT=5432 \
  -e NODE_PATH=/usr/local/lib/node_modules/n8n/node_modules \
  --entrypoint node "$IMAGE" "$TOOL" "$@"
