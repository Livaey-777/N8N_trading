#!/bin/sh
# First-boot import for the n8n container (see docker-compose.yml, service n8n-bootstrap).
# - Postgres credential "GI Postgres" (id GIpostgresCred01) built from the environment and
#   stored ENCRYPTED by n8n (N8N_ENCRYPTION_KEY). The temporary file is removed immediately.
# - All workflows from /gi/workflows (fixed ids), then the scheduled ones are activated.
# A marker in the n8n volume makes later boots a no-op, so UI edits are never overwritten.
set -eu

MARKER=/home/node/.n8n/.gi-bootstrapped
if [ -f "$MARKER" ]; then
  echo "gold-intel bootstrap: already done ($(cat "$MARKER")) - nothing to do"
  exit 0
fi

: "${GI_PG_PASSWORD:?GI_PG_PASSWORD is empty - refusing to create the Postgres credential without a password}"

umask 077
# BusyBox mktemp (n8n image) requires the template to END with XXXXXX.
TMP=$(mktemp /tmp/gi-cred-XXXXXX)
trap 'rm -f "$TMP"' EXIT

node -e '
const e = process.env;
process.stdout.write(JSON.stringify([{
  id: "GIpostgresCred01", name: "GI Postgres", type: "postgres",
  data: { host: e.GI_PG_HOST || "postgres", port: Number(e.GI_PG_PORT || 5432), database: e.GI_PG_DATABASE || "gold_intel",
          user: e.GI_PG_USER || "gold_intel", password: e.GI_PG_PASSWORD, ssl: "disable", allowUnauthorizedCerts: false,
          maxConnections: 10, sshTunnel: false },
}]));' > "$TMP"

n8n import:credentials --input="$TMP"
rm -f "$TMP"
n8n import:workflow --separate --input=/gi/workflows

for id in giMasterPipeline giPreEventEngine giPostEventRevw1 giDailyReport001 giHealthMonitor1 giTelegramBot001; do
  n8n update:workflow --id="$id" --active=true
done

date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKER"
echo "gold-intel bootstrap: credential + workflows imported, schedules activated"
