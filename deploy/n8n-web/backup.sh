#!/bin/sh
# Backs up both databases before any deployment or change (rollback point):
#   gold_intel — events, forecasts, AI usage, calibration, Telegram log;
#   n8n        — workflows, the ENCRYPTED "GI Postgres" credential, executions.
# Output: backups/<UTC timestamp>/ (git-ignored, mode 700). The n8n dump can only be read with the same
# N8N_ENCRYPTION_KEY, so keep the server's .env (never in git) together with the backups.
#
#   sh deploy/n8n-web/backup.sh
set -eu
cd "$(dirname "$0")/../.."
TS=$(date -u +%Y%m%dT%H%M%SZ)
DIR="backups/$TS"
umask 077
mkdir -p "$DIR"
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > "$DIR/gold_intel.dump"
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "${N8N_DB_DATABASE:-n8n}"' > "$DIR/n8n.dump"
{
  echo "created_utc=$TS"
  echo "commit=$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  docker compose images 2>/dev/null | awk 'NR > 1 { print "image=" $1 " " $2 ":" $3 " " $5 }'
} > "$DIR/meta.txt"
for f in "$DIR"/*.dump; do
  [ -s "$f" ] || { echo "backup FAILED: $f is empty" >&2; exit 1; }
done
ls -l "$DIR"
echo "backup OK: $DIR"
