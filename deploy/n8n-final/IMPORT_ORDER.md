# Import — Gold Intelligence (9 workflows)

**CREDENTIALS → IMPORT → VERIFY REFERENCES → ACTIVATE → VERIFY SCHEDULES → TEST → RUN**

One helper does IMPORT through VERIFY SCHEDULES and stops safely at the first problem. Nothing needs editing in
n8n afterwards.

## The one command

| Setup | Command (from the project folder) |
|---|---|
| **Docker server** (`docker-compose.yml`) | first start: `docker compose up -d`, then `sh deploy/n8n-final/import-all.sh` |
| **Windows local pilot** (n8n started by `tools\n8n-local.js`) | `powershell -ExecutionPolicy Bypass -File deploy\n8n-final\import-all.ps1` |

Before running it:
1. Do [CREDENTIAL_SETUP.md](CREDENTIAL_SETUP.md). The helper checks that **GI Postgres** exists, and that `.env`
   has `TELEGRAM_BOT_TOKEN`, `OPENROUTER_API_KEY`, `GI_PG_PASSWORD` and `N8N_ENCRYPTION_KEY`. An empty
   `TELEGRAM_CHAT_ID` only warns, because the bot then starts in setup mode.
2. The database is ready ([DATABASE.md](DATABASE.md)). Docker does this on the first start.
3. **Only one instance may run the schedules.** Stop the other one first; the local pilot stops with
   `node tools\n8n-local.js stop`. Two instances would split the bot's Telegram updates and send duplicate
   alerts and reports.

What the helper does (verified on 2026-09-28 in three fresh setups: Docker with an editor-created credential,
Docker first boot, Windows local pilot under PowerShell):

| Step | What happens | Stops when |
|---|---|---|
| 1 prerequisites | Docker / Node present; the `.env` secrets above set (values never printed) | a value is missing |
| 2 n8n reachable | Docker: container healthy · local: PostgreSQL running (started if needed), n8n status shown | n8n or the database is down |
| 3 package audit | `verify-package.js`: checksums, ids, references, credentials, schedules, no secrets | the package was altered |
| 4 credential | `check-import.js --phase=pre`: **GI Postgres** exists exactly once | missing (or two with that name). `--create-postgres-credential` / `-CreatePostgresCredential` builds it from `.env` |
| 5 rollback point | Docker: `backups/<UTC>/` dump of both databases · local: `backups\<UTC>\workflows-before-import.json` | the backup fails (still nothing changed) |
| 6 IMPORT | stops n8n, then `n8n import:workflow` for the 9 files in dependency order | an import does not confirm |
| 7 ACTIVATE + VERIFY SCHEDULES | activates exactly the 6 scheduled workflows and keeps the 3 others inactive; starts n8n, applying `.env`; waits for six `Activated workflow "GI · …"` lines | fewer than 6 register, or n8n reports an activation problem |
| 8 VERIFY REFERENCES | `check-import.js --phase=post` on n8n's own export: 9 ids; nodes, Code, SQL, schedules and connections identical to the package; 12 calls + 8 error links resolve; 27 Postgres nodes on **one** existing credential; exactly 6 active; no other active "GI ·" copy | anything differs |

It ends with `IMPORT: PASSED`, or `IMPORT: FAILED - <reason>` plus the rollback path (exit code 1).
Running it again is safe: it re-imports the same files and re-verifies.

## Why this method (the rules behind it)

1. **Fixed workflow ids, CLI import.** The workflows call each other by id (`giAiAnalystSub01`,
   `giTelegramSend01`), use `giErrorHandler01` as their error workflow, and the tools and checks address them by
   id. `n8n import:workflow` keeps these ids. **Do not use the editor's "Import from file"**: it creates new ids and
   breaks the calls and the error link.
2. **Import deactivates.** n8n 1.117.2 imports every workflow as inactive (verified). The helper activates the 6
   scheduled ones afterwards, which is why activation is a separate step.
3. **The credential must exist before the import.** At import time, n8n re-links every Postgres node to the one
   credential named **GI Postgres** when the id in the file (`GIpostgresCred01`) does not exist (verified).
4. **Not n8n Cloud.**
   * The secrets are read from `$env`, which n8n Cloud does not provide.
   * There is no CLI.
   * The schedules start about 105 000 executions per 30 days; the 30-second bot poll alone is about 86 400.

## Dependency order

The numbers in the file names are names, not the order.

| Step | File | Workflow id | Depends on | Active after import | Schedule (Africa/Casablanca) |
|---|---|---|---|---|---|
| 1 | `09-error-handler.json` | `giErrorHandler01` | — | no (error workflow of the 8 others) | — |
| 2 | `03-telegram-sender.json` | `giTelegramSend01` | 09 | no (called) | — |
| 3 | `02-ai-analyst.json` | `giAiAnalystSub01` | 03, 09 | no (called) | — |
| 4 | `08-health-monitor.json` | `giHealthMonitor1` | 03, 09 | **yes** | every 5 min |
| 5 | `01-master-pipeline.json` | `giMasterPipeline` | 02, 03, 09 | **yes** | news every 15 min · market every 10 min |
| 6 | `04-pre-event.json` | `giPreEventEngine` | 02, 03, 09 | **yes** | daily 06:00 forecasts · refresh + calendar sync every 30 min |
| 7 | `05-post-event.json` | `giPostEventRevw1` | 03, 09 | **yes** | every 30 min (reviews at 4h / 24h / 3d) |
| 8 | `06-daily-report.json` | `giDailyReport001` | 02, 03, 09 | **yes** | daily 07:00 (report + calibration rebuild) |
| 9 | `07-telegram-bot.json` | `giTelegramBot001` | 02, 03, 09 | **yes** | poll every 30 s |

The intervals and hours come from `.env` (`GI_*_INTERVAL_MIN`, `GI_PREEVENT_DAILY_HOUR=6`, `GI_DAILY_REPORT_HOUR=7`,
`GI_BOT_POLL_SECONDS=30`). Timezone: `GENERIC_TIMEZONE=Africa/Casablanca`, also stored in every workflow.

## Manual fallback (only if the helper cannot run)

The same commands by hand, with the n8n CLI of the target instance. Docker:
`docker compose run --rm -T -v "$PWD/deploy/n8n-final:/pkg:ro" --entrypoint n8n n8n-bootstrap <command>`.
Local pilot: `node tools\n8n-local.js cli <command>`.
```sh
# with n8n stopped
for f in 09-error-handler 03-telegram-sender 02-ai-analyst 08-health-monitor 01-master-pipeline \
         04-pre-event 05-post-event 06-daily-report 07-telegram-bot; do
  n8n import:workflow --input="workflows/$f.json"            # expect: Successfully imported 1 workflow.
done
for id in giHealthMonitor1 giMasterPipeline giPreEventEngine giPostEventRevw1 giDailyReport001 giTelegramBot001; do
  n8n update:workflow --id="$id" --active=true
done
# start n8n → the log shows six  Activated workflow "GI · …"  lines
n8n export:workflow --all --output=/tmp/w.json && n8n export:credentials --all --output=/tmp/c.json
node check-import.js --phase=post --workflows=/tmp/w.json --credentials=/tmp/c.json     # IMPORT CHECK (post): PASSED
```
On a new instance, `Could not remove webhooks of workflow "…": Could not find workflow` is harmless; nothing older
existed.

## After the import

TEST and RUN: [VERIFICATION.md](VERIFICATION.md) §C.
* The first message to send is `/start`, then `/status` and `/brief`.
* The release gate is the first scheduled 06:00 and 07:00 runs, checked with `node tools/verify-live.js --days=2`
  (local) or `sh deploy/n8n-web/verify.sh --days=2` (server).
