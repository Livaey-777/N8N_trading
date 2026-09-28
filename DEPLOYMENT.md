# Deployment

Two supported setups. In both, **the running n8n instance is the source of truth**; the files in
`workflows/` are version-controlled backups / bootstrap input.

| | Local pilot (Windows/macOS/Linux, no Docker) | 24/7 server (Docker) |
|---|---|---|
| n8n | 1.117.2, global npm install, started by `tools/n8n-local.js` | `docker.n8n.io/n8nio/n8n:1.117.2` |
| PostgreSQL | embedded-postgres 18 on `127.0.0.1:5433` (`tools/local-pg.js`) | `postgres:16-alpine` (volume `pg_data`) |
| Databases | `gold_intel` (system data) + `n8n` (n8n's own), same server | same |

## Secrets

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `OPENROUTER_API_KEY`, optional `FRED_API_KEY`.

* Live only in `.env` (git-ignored) and reach n8n through its **process environment**. Code nodes read
  them with `$env`; they are never written into workflow JSON, documentation, logs or Telegram.
* The PostgreSQL credential is an **n8n credential** (`GI Postgres`, id `GIpostgresCred01`), stored
  encrypted with `N8N_ENCRYPTION_KEY`. Keep that key stable, or stored credentials become unreadable.
* Enter secrets with hidden input (prints only `CONFIGURED` / `unchanged`):
  ```powershell
  powershell -ExecutionPolicy Bypass -File tools\set-secrets.ps1
  ```
  On Linux, edit `.env` with an editor; do not `echo` secrets into shell history.
* Verify with `/status` or the Health Monitor: they report `CONFIGURED / NOT CONFIGURED` only.
* `tools/validate-workflows.js` fails the build if anything resembling a token or key appears in a workflow file.

## A. Local pilot

Requirements: Node.js ≥ 20, `npm i -g n8n@1.117.2`, `npm install` in this folder.

```bash
node tools/setup-local.js                 # .env from .env.example + generated DB password / encryption key
node tools/local-pg.js init               # first time only
node tools/local-pg.js start
node tools/db.js migrate                  # sql/*.sql
node tools/db.js seed-history             # seed/historical_event_reactions.sql
node tools/n8n-local.js import-credentials
node tools/n8n-local.js import-workflows  # n8n stopped; fixed workflow ids
node tools/n8n-local.js start
node tools/n8n-local.js owner-setup       # local test owner (first run only)
```

Then add secrets (above), `node tools/n8n-local.js restart`, and activate the six scheduled workflows,
either in the UI (toggle **Active**) or:

```bash
node tools/n8n-api.js activate giMasterPipeline
node tools/n8n-api.js activate giPreEventEngine
node tools/n8n-api.js activate giPostEventRevw1
node tools/n8n-api.js activate giDailyReport001
node tools/n8n-api.js activate giHealthMonitor1
node tools/n8n-api.js activate giTelegramBot001
```

`GI · AI Analyst`, `GI · Telegram Sender` (sub-workflows) and `GI · Error Handler` (error workflow of all
others) do not need to be active.

The local pilot runs as long as the PC is on. For true 24/7, use the Docker setup on a server/VPS.

### Changing workflows

Edit `src/nodes/**` or `src/workflows/*.js`, then:

```bash
npm test
node tools/build-workflows.js
node tools/validate-workflows.js
node tools/n8n-api.js push workflows/*.json     # updates the running instance in place (ids, activation kept)
```

## B. 24/7 with Docker Compose

Server deployment runbook (import order, credential placeholders, database requirements, rollback, verification
checklist): [deploy/n8n-web/README.md](deploy/n8n-web/README.md).

```bash
cp .env.example .env
# set GI_PG_PASSWORD and N8N_ENCRYPTION_KEY (long random values), then the secrets
docker compose up -d
docker compose logs -f n8n-bootstrap      # one-shot: credential + workflows imported, schedules activated
```

Open `http://localhost:5678` (bound to 127.0.0.1 only) and create the n8n owner account. The first bootstrap takes a
few minutes (each workflow activation boots the n8n CLI).

If a local n8n already runs on the same machine, note that it also listens on **5679** (its internal task-runner
broker) — publish a test stack on another port. When the project folder is inside a virtualised app-data path
(e.g. the Claude desktop app's scratch folder), run Compose with `--project-directory <physical path>` so Docker
Desktop mounts the real files.

What happens on first start:
1. `postgres` initialises an empty volume with `deploy/postgres-init/01-init.sh`: creates database `n8n`,
   applies `sql/*.sql` to `gold_intel`, loads `seed/historical_event_reactions.sql` and `seed/market_history.sql`.
2. `n8n-bootstrap` (same n8n image) imports the Postgres credential (built from the environment in a
   temp file that is deleted immediately) and all workflows, activates the six scheduled workflows,
   and writes a marker in the `n8n_data` volume. **Later starts do nothing**, so UI edits are never overwritten.
3. `n8n` starts after the bootstrap completed successfully; healthcheck `GET /healthz`.

Operations

| Task | Command |
|---|---|
| status / health | `docker compose ps` (healthchecks) · Telegram `/status` |
| logs | `docker compose logs -f n8n` |
| after changing `.env` | `docker compose up -d --force-recreate n8n` |
| update workflows from files (overwrites UI edits!) | `docker compose run --rm --entrypoint n8n n8n-bootstrap import:workflow --separate --input=/gi/workflows`, then **re-activate the six scheduled workflows** (the import deactivates them) with `update:workflow --id=<id> --active=true`, then restart `n8n` — exact commands in [deploy/n8n-web/README.md](deploy/n8n-web/README.md) §9 R1 |
| backup the data store | `docker compose exec postgres pg_dump -U gold_intel gold_intel > backup.sql` |
| export workflows (backup of the source of truth) | `docker compose exec n8n n8n export:workflow --all --separate --output=/home/node/.n8n/export` |
| stop | `docker compose down` (volumes kept) |

Remote access: keep port 5678 on 127.0.0.1 and use an SSH tunnel or a reverse proxy with TLS and
authentication. Telegram needs **no** inbound port (long polling).

## Schedules (all from `.env`, local time `GENERIC_TIMEZONE`)

| Workflow | Trigger | Default |
|---|---|---|
| Master Pipeline — news | `GI_NEWS_INTERVAL_MIN` | 15 min |
| Master Pipeline — market / desk | `GI_MARKET_INTERVAL_MIN` | 10 min |
| Pre-Event — daily forecasts | `GI_PREEVENT_DAILY_HOUR` | 06:00 |
| Pre-Event — refresh & calendar sync | `GI_PREEVENT_REFRESH_INTERVAL_MIN` | 30 min |
| Post-Event Review | `GI_POST_EVENT_INTERVAL_MIN` | 30 min (reviews at 4h / 24h / 3d) |
| Daily Report | `GI_DAILY_REPORT_HOUR` | 07:00 |
| Health Monitor | `GI_HEALTH_INTERVAL_MIN` | 5 min |
| Telegram Bot | `GI_BOT_POLL_SECONDS` | 30 s |

## Maintenance tools

| Command | Purpose |
|---|---|
| `node tools/backfill-history.js --from=2021-01-01 --source=auto --load` | rebuild the historical reaction DB (see SOURCE_MAP.md) |
| `node tools/rescore-events.js [--dry-run]` | re-apply the current deterministic classifier/scoring to stored live events (no network, no AI) |
| `node tools/db.js cleanup-tests` | delete every `is_test` row (synthetic events, test alerts/forecasts/AI runs) |
| `node tools/db.js counts` | row counts per table |
| `node tools/check-sql.js` | executes the changed Postgres-node queries of the built workflows against the DB (always rolled back) |
| `node tools/n8n-api.js executions [workflowId] [n]` | recent executions |

## Troubleshooting

* **Sources failing with `ENOTFOUND` / timeouts**: host DNS / connectivity. The pipeline degrades
  gracefully (source health, `DATA QUALITY` reasons, forecasts `UNDETERMINED` only when a critical input is
  missing) and recovers on the next run. Check with `/status`.
* **`AI: DEGRADED — model(s) no longer available/free`**: update `GI_AI_MODELS` (AI_MODELS.md) and restart.
* **Telegram `NOT_CONFIGURED`**: secrets missing from the n8n process environment. Set them and restart n8n.
* **Workflow errors**: recorded in `error_events`; a technical Telegram alert is sent with a cooldown
  (`GI_TECH_ALERT_COOLDOWN_MIN`). The Error Handler still alerts when the database itself is down.
