#!/bin/sh
# One-step import of the 9 Gold Intelligence workflows into the Docker Compose deployment (docker-compose.yml).
# The host needs only Docker: every n8n / Node step runs inside the pinned n8n image. No secret is printed.
#
#   sh deploy/n8n-final/import-all.sh [--create-postgres-credential] [--no-backup]
#
#   1-4  check, change nothing: Docker + .env secrets set; n8n reachable; package audit; credential "GI Postgres"
#        (--create-postgres-credential builds it from .env when missing)
#   5    rollback point: sh deploy/n8n-web/backup.sh (both databases)
#   6    stop n8n; import the 9 workflows by CLI in dependency order (fixed ids kept; n8n imports them inactive)
#   7    activate exactly the 6 scheduled workflows; recreate n8n (applies .env); confirm six "Activated workflow" lines
#   8    post-import check (check-import.js): ids, identical content, references, credential links, active set
# Any failure stops the script with exit code 1; from step 6 on it prints the rollback command.
set -eu
cd "$(dirname "$0")/../.."
ROOT=$PWD
PKG="$ROOT/deploy/n8n-final"
CREATE_CRED=0
BACKUP=1
for a in "$@"; do
  case "$a" in
    --create-postgres-credential) CREATE_CRED=1 ;;
    --no-backup) BACKUP=0 ;;
    *) echo "unknown option: $a"; exit 2 ;;
  esac
done
ORDER="09-error-handler 03-telegram-sender 02-ai-analyst 08-health-monitor 01-master-pipeline 04-pre-event 05-post-event 06-daily-report 07-telegram-bot"
ACTIVE="giHealthMonitor1 giMasterPipeline giPreEventEngine giPostEventRevw1 giDailyReport001 giTelegramBot001"
PASSIVE="giAiAnalystSub01 giTelegramSend01 giErrorHandler01"
BACKUP_DIR=""
CHANGED=0

step() { printf '\n== %s\n' "$*"; }
fail() {
  printf '\nIMPORT: FAILED - %s\n' "$*" >&2
  if [ "$CHANGED" = 1 ]; then
    printf 'Rollback: deploy/n8n-final/ROLLBACK.md R2 with %s (or re-run this script after fixing the cause).\n' "${BACKUP_DIR:-the latest backups/ folder}" >&2
  fi
  exit 1
}
# Inside the pinned n8n image with this deployment's environment and the package mounted read-only at /pkg.
in_n8n() { docker compose run --rm -T -v "$PKG:/pkg:ro" -e ORDER="$ORDER" -e ACTIVE="$ACTIVE" -e PASSIVE="$PASSIVE" --entrypoint sh n8n-bootstrap -s; }

step "1/8 prerequisites"
command -v docker >/dev/null 2>&1 || fail "docker is not installed"
docker compose version >/dev/null 2>&1 || fail "the docker compose plugin is missing"
[ -f .env ] || fail ".env not found - cp .env.example .env, then follow deploy/n8n-final/CREDENTIAL_SETUP.md"
for k in TELEGRAM_BOT_TOKEN OPENROUTER_API_KEY GI_PG_PASSWORD N8N_ENCRYPTION_KEY; do
  grep -Eq "^$k=.+" .env || fail "$k is empty in .env (CREDENTIAL_SETUP.md)"
  echo "  $k: set"
done
if grep -Eq "^TELEGRAM_CHAT_ID=.+" .env; then echo "  TELEGRAM_CHAT_ID: set"
else echo "  TELEGRAM_CHAT_ID: empty - the bot starts in setup mode: send /start to it, it replies with your chat id (CREDENTIAL_SETUP.md step 2)"; fi

step "2/8 n8n reachable"
docker compose ps --status running --services 2>/dev/null | grep -qx n8n \
  || fail "n8n is not running - start the stack first: docker compose up -d"
docker compose exec -T n8n wget -qO- http://127.0.0.1:5678/healthz >/dev/null 2>&1 || fail "n8n does not answer /healthz"
echo "  n8n healthy"

step "3/8 package audit"
in_n8n <<'EOS' || fail "package audit failed"
node /pkg/verify-package.js
EOS

step "4/8 credential GI Postgres"
if ! in_n8n <<'EOS'
n8n export:credentials --all --output=/tmp/c.json >/dev/null 2>&1 || echo '[]' > /tmp/c.json
node /pkg/check-import.js --phase=pre --credentials=/tmp/c.json
EOS
then
  [ "$CREATE_CRED" = 1 ] || fail "create the credential first (CREDENTIAL_SETUP.md), or re-run with --create-postgres-credential"
  echo "  creating GI Postgres from .env (value never printed)"
  in_n8n <<'EOS' || fail "could not create the credential"
set -e
umask 077
T=$(mktemp /tmp/gi-cred-XXXXXX)
trap 'rm -f "$T"' EXIT
node -e '
const e = process.env;
if (!e.GI_PG_PASSWORD) { console.error("GI_PG_PASSWORD is empty"); process.exit(1); }
process.stdout.write(JSON.stringify([{ id: "GIpostgresCred01", name: "GI Postgres", type: "postgres",
  data: { host: e.GI_PG_HOST || "postgres", port: Number(e.GI_PG_PORT || 5432), database: e.GI_PG_DATABASE || "gold_intel",
          user: e.GI_PG_USER || "gold_intel", password: e.GI_PG_PASSWORD, ssl: "disable", allowUnauthorizedCerts: false,
          maxConnections: 10, sshTunnel: false } }]));' > "$T"
n8n import:credentials --input="$T" 2>&1 | grep -E "Successfully|rror" | grep -v "Error tracking" || true
n8n export:credentials --all --output=/tmp/c.json >/dev/null 2>&1
node /pkg/check-import.js --phase=pre --credentials=/tmp/c.json
EOS
fi

if [ "$BACKUP" = 1 ]; then
  step "5/8 rollback point"
  out=$(sh deploy/n8n-web/backup.sh) || fail "backup failed - nothing was changed"
  echo "$out" | tail -1
  BACKUP_DIR=$(echo "$out" | sed -n 's/^backup OK: //p')
else
  step "5/8 rollback point skipped (--no-backup)"
fi

step "6/8 import the 9 workflows (dependency order)"
CHANGED=1
docker compose stop n8n >/dev/null 2>&1 || fail "could not stop n8n"
in_n8n <<'EOS' || fail "import failed"
for f in $ORDER; do
  out=$(n8n import:workflow --input="/pkg/workflows/$f.json" 2>&1)
  if echo "$out" | grep -q "Successfully imported 1 workflow"; then echo "  imported $f"; else echo "$out" | tail -5; echo "import of $f failed"; exit 1; fi
done
EOS

step "7/8 activate the 6 scheduled workflows"
in_n8n <<'EOS' || fail "activation failed"
for id in $ACTIVE; do n8n update:workflow --id="$id" --active=true >/dev/null 2>&1 || { echo "activate $id failed"; exit 1; }; echo "  active   $id"; done
for id in $PASSIVE; do n8n update:workflow --id="$id" --active=false >/dev/null 2>&1 || { echo "deactivate $id failed"; exit 1; }; echo "  inactive $id (called / error workflow)"; done
EOS
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Recreate (not just start) so the current .env is applied.
docker compose up -d --force-recreate --no-deps n8n >/dev/null 2>&1 || fail "could not start n8n"
n=0
until docker compose exec -T n8n wget -qO- http://127.0.0.1:5678/healthz >/dev/null 2>&1; do
  n=$((n + 1)); [ "$n" -le 100 ] || fail "n8n did not become healthy"; sleep 3
done
n=0
while :; do
  acts=$(docker compose logs --since "$SINCE" n8n 2>/dev/null | grep -c 'Activated workflow "GI' || true)
  [ "$acts" -ge 6 ] && break
  n=$((n + 1)); [ "$n" -le 40 ] || fail "only $acts of 6 schedules registered (docker compose logs n8n)"
  sleep 3
done
if docker compose logs --since "$SINCE" n8n 2>/dev/null | grep -q "problem activating workflow"; then fail "n8n reported an activation problem (docker compose logs n8n)"; fi
echo "  schedules registered: $acts"

step "8/8 post-import check"
in_n8n <<'EOS' || fail "post-import check failed"
n8n export:workflow --all --output=/tmp/w.json >/dev/null 2>&1
n8n export:credentials --all --output=/tmp/c.json >/dev/null 2>&1
node /pkg/check-import.js --phase=post --workflows=/tmp/w.json --credentials=/tmp/c.json --package=/pkg
EOS

printf '\nIMPORT: PASSED - 9 workflows imported, references resolved, 6 schedules active.\n'
printf 'First test: send /start to the Telegram bot, then /status (VERIFICATION.md).\n'
