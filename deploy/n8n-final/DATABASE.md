# Database — Gold Intelligence n8n package

PostgreSQL **16** (Docker `postgres:16-alpine`; the local pilot runs 18.4). No extensions.
The schema and seed files live in the repository checkout: `sql/` and `seed/` (two levels up from this folder).

## 1. Two databases, one server

| Database | Owner | Holds |
|---|---|---|
| `gold_intel` | `GI_PG_USER` (default `gold_intel`) | events, forecasts and scenarios, AI usage, calibration cells, Telegram log, health, job runs |
| `n8n` | the same user | n8n's own tables: workflows, the encrypted credential, executions |

## 2. Create and load

**Docker Compose (automatic).** On an empty volume, `deploy/postgres-init/01-init.sh` does all of this. It
creates `n8n`, applies `sql/*.sql` in file-name order and loads both seeds.

**Existing PostgreSQL (by hand), from the repository root:**
```sh
createdb -U <GI_PG_USER> gold_intel
createdb -U <GI_PG_USER> n8n
for f in sql/001_schema.sql sql/002_event_evidence.sql sql/003_forecast_engine.sql sql/004_ai_usage.sql \
         sql/005_calibration.sql sql/010_sources.sql; do
  psql -v ON_ERROR_STOP=1 -U <GI_PG_USER> -d gold_intel -f "$f"
done
psql -v ON_ERROR_STOP=1 -U <GI_PG_USER> -d gold_intel -f seed/historical_event_reactions.sql
psql -v ON_ERROR_STOP=1 -U <GI_PG_USER> -d gold_intel -f seed/market_history.sql
```
Every migration is idempotent (`CREATE … IF NOT EXISTS`, `ON CONFLICT`), so re-running is safe.

## 3. Verify

```sql
SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';  -- 27
SELECT count(*) FROM information_schema.views  WHERE table_schema = 'public';                                -- 5
SELECT count(*) FROM historical_event_reactions;   -- 362
SELECT count(*) FROM sources;                      -- 26
SELECT count(*) >= 6135 FROM market_observations;  -- true
SELECT count(*) >= 2156 FROM gold_observations;    -- true
SELECT to_regclass('ai_usage'), to_regclass('ai_model_health'), to_regclass('calibration_cells');  -- all three exist
```
`schema_migrations` lists only 001, 002, 003 and 010. Migrations 004 and 005 do not write a row, so check
their tables as shown instead of that list.

Query check (every changed Postgres node query, executed and rolled back; 11 of 11 must pass):
`node tools/check-sql.js`. On a server, run it in the Compose network:
```sh
docker run --rm --network gold-intelligence_default -v "$PWD":/app:ro -w /app -e GI_PG_HOST=postgres -e GI_PG_PORT=5432 \
  -e NODE_PATH=/usr/local/lib/node_modules/n8n/node_modules --entrypoint node docker.n8n.io/n8nio/n8n:1.117.2 tools/check-sql.js
```

## 4. Connection fields (credential "GI Postgres")

| Field | Docker server | Windows local pilot |
|---|---|---|
| Host | `postgres` (Compose network name) | `127.0.0.1` |
| Port | `5432` | `5433` (embedded PostgreSQL, `tools/local-pg.js`) |
| Database | `gold_intel` | `gold_intel` |
| User | `GI_PG_USER` (default `gold_intel`) | same |
| Password | `GI_PG_PASSWORD` from `.env` (never in the package) | same |
| SSL | `Disable` on the private network | `Disable` |

n8n's own database (`n8n`) uses the same server and user. It is configured through the environment
(`DB_POSTGRESDB_*` in `docker-compose.yml` / `tools/n8n-local.js`), not through a credential.

## 5. Backup and restore

The existing production data is never wiped: migrations only create missing objects, and the import helpers touch
only n8n's workflow tables.

| | Docker server | Windows local pilot |
|---|---|---|
| Backup | `sh deploy/n8n-web/backup.sh` → `backups/<UTC>/gold_intel.dump` + `n8n.dump` (custom format) | `node tools\n8n-local.js stop` · `node tools\local-pg.js stop` · copy the folder `runtime\pgdata` to a safe place (both databases) · start both again. The embedded PostgreSQL ships no `pg_dump`, so the folder copy is the full backup |
| Restore | see [ROLLBACK.md](ROLLBACK.md) R2 (`pg_restore --clean --if-exists`) | stop n8n and PostgreSQL as above, replace `runtime\pgdata` with the copy, start both. For workflows only: ROLLBACK.md R1 |

Keep `N8N_ENCRYPTION_KEY` with the backups: the `n8n` dump (workflows, the encrypted credential) is unreadable
without it.

## 6. Operation

* The database session timezone is UTC. Local-day logic uses `Africa/Casablanca` explicitly in SQL.
* Size: about 12 MB after the seeds. n8n prunes executions after 14 days (`EXECUTIONS_DATA_MAX_AGE=336`).
* Back up daily (cron example in `deploy/n8n-web/README.md` §10). The import helpers back up automatically before importing.
* The calibration cells are rebuilt by every Daily Report run, from the stored history with fixed rules.
