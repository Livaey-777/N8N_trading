# Rollback — Gold Intelligence n8n package

**R0 — before every import or change.** Create a rollback point and keep `.env`, which holds `N8N_ENCRYPTION_KEY`:
```sh
sh deploy/n8n-web/backup.sh      # Compose: backups/<UTC>/ with gold_intel.dump, n8n.dump, meta.txt (commit + image ids)
```
Existing PostgreSQL: `pg_dump -Fc -U <GI_PG_USER> gold_intel > gold_intel.dump` and the same for `n8n`.
Tested on 2026-09-28: backup → restore returned both databases to the backup state, and the schedules resumed.

## R1 — a workflow misbehaves (instance otherwise fine)

Re-import the previous package's workflow files and **activate again**: n8n's import deactivates every
imported workflow (verified).
```sh
git checkout <previous commit> -- deploy/n8n-final/workflows/
cd deploy/n8n-final
for f in 09-error-handler 03-telegram-sender 02-ai-analyst 08-health-monitor 01-master-pipeline \
         04-pre-event 05-post-event 06-daily-report 07-telegram-bot; do n8n import:workflow --input="workflows/$f.json"; done
for id in giHealthMonitor1 giMasterPipeline giPreEventEngine giPostEventRevw1 giDailyReport001 giTelegramBot001; do
  n8n update:workflow --id="$id" --active=true
done
# restart n8n → "Start Active Workflows" must list all six
cd ../.. && git checkout HEAD -- deploy/n8n-final/workflows/
```
On Compose, prefix each `n8n …` with `docker compose run --rm --entrypoint n8n n8n-bootstrap` and mount the files,
or use the commands in [../n8n-web/README.md](../n8n-web/README.md) §9 R1.

## R2 — the deployment misbehaves (return to the last backup)

```sh
docker compose stop n8n
B=backups/<timestamp>
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < $B/gold_intel.dump
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "${N8N_DB_DATABASE:-n8n}" --clean --if-exists' < $B/n8n.dump
git checkout "$(sed -n 's/^commit=//p' $B/meta.txt)"
docker compose up -d
```
Then check that the start log lists six activated workflows and that Health runs on schedule.

## R3 — abandon the server, back to the local pilot

1. On the server: `docker compose stop n8n`. Do this **first**; never run both instances at once.
2. On the PC: `node tools/n8n-local.js start`, then `/status` from the phone.
3. Keep the server volumes (`docker compose down` without `-v`) until the cause is known.

## Never

* `docker compose down -v`: it deletes both databases.
* Editing the workflows in the editor and then re-importing files: the import overwrites the editor's changes.
* Creating the GI Postgres credential in the editor: the new id breaks every Postgres node.
