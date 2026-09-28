# Import order — Gold Intelligence (9 workflows)

**IMPORT → CONFIGURE CREDENTIALS → VERIFY REFERENCES → ACTIVATE → VERIFY SCHEDULES → TEST → RUN**

This exact sequence was executed on a fresh n8n 1.117.2 + PostgreSQL 16 from the files in `workflows/`.
The package test on 2026-09-28 gave these results:
* 9 imported with ids kept;
* credential linked to 27/27 Postgres nodes;
* references 12/12 calls and 8/8 error links;
* 6 schedules registered;
* first scheduled runs succeeded;
* 0 errors.

## Rules

1. **Use the n8n CLI (`n8n import:workflow`), never the editor's "Import from file".** The workflows reference each
   other by fixed id. The editor assigns new ids and silently breaks:
   * the sub-workflow calls (`giAiAnalystSub01`, `giTelegramSend01`);
   * the error workflow (`giErrorHandler01`);
   * the credential link (`GIpostgresCred01`).
2. **Import deactivates.** n8n 1.117.2 imports every workflow as inactive, even one that was active before
   (verified). Activation is a separate step. After any re-import, activate again.
3. **Only one instance may run the schedules.** Two instances would split the bot's Telegram updates and send
   duplicate alerts and reports. Stop the old instance (the local pilot: `node tools/n8n-local.js stop`) before
   ACTIVATE.
4. **Not n8n Cloud:**
   * secrets and settings are read from `$env`, which n8n Cloud does not provide;
   * there is no CLI;
   * the schedules start about 105 000 executions per 30 days.
5. **Prerequisites:** [DATABASE.md](DATABASE.md) done, and `.env` filled per [CREDENTIALS.md](CREDENTIALS.md).
   n8n must run with that environment, including `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` and `GENERIC_TIMEZONE=Africa/Casablanca`.

## Dependency order

The numbers in the file names are names, not the order.

| Step | File | Workflow id | Depends on | Activate |
|---|---|---|---|---|
| 1 | `09-error-handler.json` | `giErrorHandler01` | — (error workflow of all others) | no |
| 2 | `03-telegram-sender.json` | `giTelegramSend01` | 09 | no (called) |
| 3 | `02-ai-analyst.json` | `giAiAnalystSub01` | 03, 09 | no (called) |
| 4 | `08-health-monitor.json` | `giHealthMonitor1` | 03, 09 | **yes** — every 5 min |
| 5 | `01-master-pipeline.json` | `giMasterPipeline` | 02, 03, 09 | **yes** — news 15 min, market 10 min |
| 6 | `04-pre-event.json` | `giPreEventEngine` | 02, 03, 09 | **yes** — daily 06:00 + refresh 30 min |
| 7 | `05-post-event.json` | `giPostEventRevw1` | 03, 09 | **yes** — 30 min |
| 8 | `06-daily-report.json` | `giDailyReport001` | 02, 03, 09 | **yes** — daily 07:00 |
| 9 | `07-telegram-bot.json` | `giTelegramBot001` | 02, 03, 09 | **yes** — poll 30 s |

Every Postgres node in all 9 uses the credential `GIpostgresCred01` (GI Postgres). Times are Africa/Casablanca.

## Path A — new server with this repository and Docker Compose (recommended)

`docker compose up -d` does steps 1, 2 and 4 automatically on the first boot (`deploy/n8n-bootstrap.sh`):
* the credential is built from `.env`;
* the 9 workflows are imported from `workflows/`, which is byte-identical to this package (`sh verify-package.sh` checks);
* the six schedules are activated.

Then continue with steps 3, 5, 6 and 7 below. Full runbook: [../n8n-web/README.md](../n8n-web/README.md).

## Path B — existing self-hosted n8n (CLI)

Run these where the n8n CLI can read the package. On Docker, copy or mount the package into the container and
run the commands as the `node` user (`docker exec -u node <container> n8n …`).

### 1. IMPORT
```sh
cd deploy/n8n-final
for f in 09-error-handler 03-telegram-sender 02-ai-analyst 08-health-monitor 01-master-pipeline \
         04-pre-event 05-post-event 06-daily-report 07-telegram-bot; do
  n8n import:workflow --input="workflows/$f.json"
done
```
Expected: `Successfully imported 1 workflow.` nine times. On a new instance, n8n also prints
`Could not remove webhooks of workflow "…" because of error: "Could not find workflow"`. That line is
harmless: nothing older existed.

### 2. CONFIGURE CREDENTIALS
Import **GI Postgres** with its fixed id from the template in [CREDENTIALS.md](CREDENTIALS.md) §2
(`n8n import:credentials --input=/tmp/gi-cred.json && rm -f /tmp/gi-cred.json`). The workflows imported in step 1
link to it by id. Then set the secrets in the n8n environment (`.env`), per CREDENTIALS.md §1.

### 3. VERIFY REFERENCES
```sh
sh verify-package.sh          # files, checksums, ids, connections, references, credentials, schedules, no secrets
```
In n8n's database (all three results must match):
```sql
SELECT id, active FROM workflow_entity ORDER BY id;                 -- the 9 ids above, all active = false
SELECT id, name, type FROM credentials_entity;                      -- GIpostgresCred01 | GI Postgres | postgres
WITH refs AS (
  SELECT n->'parameters'->'workflowId'->>'value' AS target FROM workflow_entity w, jsonb_array_elements(w.nodes::jsonb) n
   WHERE n->>'type' = 'n8n-nodes-base.executeWorkflow'
  UNION ALL SELECT settings::jsonb->>'errorWorkflow' FROM workflow_entity WHERE settings::jsonb->>'errorWorkflow' IS NOT NULL)
SELECT count(*) AS refs, count(*) FILTER (WHERE target IN (SELECT id FROM workflow_entity)) AS resolved FROM refs;  -- 20 | 20
```

### 4. ACTIVATE
Stop any other instance first (rule 3). Then:
```sh
for id in giHealthMonitor1 giMasterPipeline giPreEventEngine giPostEventRevw1 giDailyReport001 giTelegramBot001; do
  n8n update:workflow --id="$id" --active=true
done
```
Then **restart n8n**. The CLI notes "Activation … will not take effect if n8n is running"; the restart applies it.

### 5. VERIFY SCHEDULES
* The n8n start log shows `Start Active Workflows:` followed by six `Activated workflow "GI · …"` lines.
* Within 10 minutes, `execution_entity` has `mode = 'trigger'`, `status = 'success'` rows for `giHealthMonitor1`
  (every 5 min) and `giMasterPipeline` (every 10 / 15 min). The first successful scheduled run also proves that
  the credential works.
* On a Compose server: `sh deploy/n8n-web/verify.sh`, EXECUTIONS section.

### 6. TEST
See [VERIFICATION.md](VERIFICATION.md) items 6–10:
* 🧪 Telegram Test arrives on the phone;
* `/start`, `/brief`, `/now`, `/status` answer;
* 🧪 AI Router Test once (one OpenRouter request).

### 7. RUN
Leave it running. After the first 06:00 (PRE_EVENT) and 07:00 (DAILY_REPORT) Africa/Casablanca slots, run the
live check (VERIFICATION.md item 11). The package is production-ready only when PRE_EVENT, DAILY_REPORT and
AI health all pass there.
