# Rollback — Gold Intelligence n8n package

Every run of the import helper creates a rollback point first (step 5) and changes nothing before it:
* Docker: `backups/<UTC>/` with `gold_intel.dump`, `n8n.dump` and `meta.txt` (commit + image ids);
* Windows local pilot: `backups\<UTC>\workflows-before-import.json`, n8n's export of every workflow as it was.

`backups/` is git-ignored. Keep `.env`: the `n8n` dump and the stored credential can only be read with the same
`N8N_ENCRYPTION_KEY`. Tested on 2026-09-28: restore returned both databases to the backup state, and the schedules
resumed.

## R1 — go back to the previous workflows (instance otherwise fine)

**Simplest:** check out the previous package and run the helper again:
```sh
git checkout <previous commit> -- deploy/n8n-final/
sh deploy/n8n-final/import-all.sh                                     # Docker
powershell -ExecutionPolicy Bypass -File deploy\n8n-final\import-all.ps1   # Windows local pilot
git checkout HEAD -- deploy/n8n-final/                                # afterwards, back to the current files
```

**Windows local pilot, from the rollback point:**
```
node tools\n8n-local.js stop
node tools\n8n-local.js cli import:workflow --input=backups\<UTC>\workflows-before-import.json
node tools\n8n-local.js cli update:workflow --id=giHealthMonitor1 --active=true
```
Repeat the last line for `giMasterPipeline giPreEventEngine giPostEventRevw1 giDailyReport001 giTelegramBot001`,
then run `node tools\n8n-local.js start`. The import deactivates everything, which is why the six are activated
again.

## R2 — go back to the backup (Docker: databases and workflows)

```sh
docker compose stop n8n
B=backups/<UTC>
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < $B/gold_intel.dump
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "${N8N_DB_DATABASE:-n8n}" --clean --if-exists' < $B/n8n.dump
git checkout "$(sed -n 's/^commit=//p' $B/meta.txt)"
docker compose up -d
```
Then check that the n8n log lists six `Activated workflow` lines and that Health Monitor runs on schedule.

## R3 — leave the server, back to the local pilot

1. On the server: `docker compose stop n8n`. Do this **first**; never run two instances at once.
2. On the PC: `node tools\n8n-local.js start`, then `/status` from the phone.
3. Keep the server volumes (`docker compose down` without `-v`) until the cause is known.

## Never

* `docker compose down -v`: it deletes both databases.
* The editor's "Import from file": it creates new workflow ids and breaks the links between workflows.
* A second credential named **GI Postgres**: the import could not tell which one to link.
* Editing workflows in the editor and then re-importing: the import overwrites the editor's changes.
