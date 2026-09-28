# FINAL HANDOFF

**PROJECT:** Gold Intelligence / XAUUSD Macro Intelligence. An intelligence-only n8n system: no broker, no orders,
no trade execution.

**STATUS:** FINAL IMPORT-READY PACKAGE — [`deploy/n8n-final/`](../deploy/n8n-final/).
* It was import-tested on fresh n8n 1.117.2 instances: Docker with an editor-created credential, Docker new-server
  bootstrap, and the Windows local pilot under PowerShell.
* After the import nothing needs editing: no node, connection, id, Code, SQL, expression or schedule.
* Still to see on the real instance (VERIFICATION.md C9): the first scheduled 06:00 PRE_EVENT and 07:00 DAILY_REPORT
  with the real bot and key.

## 9 WORKFLOWS

| File | Workflow | Id | Runs |
|---|---|---|---|
| `01-master-pipeline.json` | GI · Master Pipeline (news + market) | `giMasterPipeline` | news every 15 min · market / desk every 10 min |
| `02-ai-analyst.json` | GI · AI Analyst (sub-workflow) | `giAiAnalystSub01` | called: OpenRouter PRIMARY → SECONDARY → TERTIARY → deterministic |
| `03-telegram-sender.json` | GI · Telegram Sender (sub-workflow) | `giTelegramSend01` | called: dedup, chunking, retries, log |
| `04-pre-event.json` | GI · Pre-Event Engine (forecasts) | `giPreEventEngine` | daily 06:00 forecasts · refresh + calendar sync every 30 min |
| `05-post-event.json` | GI · Post-Event Review | `giPostEventRevw1` | every 30 min (4h / 24h / 3d reviews) |
| `06-daily-report.json` | GI · Daily Report | `giDailyReport001` | daily 07:00 + calibration rebuild |
| `07-telegram-bot.json` | GI · Telegram Bot (commands) | `giTelegramBot001` | polls every 30 s: commands + buttons |
| `08-health-monitor.json` | GI · Health Monitor | `giHealthMonitor1` | every 5 min: components, jobs, AI model health, quota |
| `09-error-handler.json` | GI · Error Handler | `giErrorHandler01` | error workflow of the 8 others: log + one tech alert per cooldown |

Timezone Africa/Casablanca.

## CREDENTIALS

Set up once: [CREDENTIAL_SETUP.md](../deploy/n8n-final/CREDENTIAL_SETUP.md). Exact reference:
[CREDENTIALS.md](../deploy/n8n-final/CREDENTIALS.md).
1. **GI Postgres**: n8n credential, type **Postgres**, shared by all 27 database nodes of the 9 workflows. The
   fields are Host, Database `gold_intel`, User, Password (`GI_PG_PASSWORD`) and Port. It is created automatically
   on the Docker server.
2. **Telegram**: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, in `.env`. They are read by Telegram Sender, Telegram
   Bot and Error Handler.
3. **OpenRouter**: `OPENROUTER_API_KEY`, in `.env`. It is read by AI Analyst (AI Router) and Health Monitor (AI Health
   Check). The model chain is Ling → Nemotron Ultra → Laguna, set in `.env.example`.
4. Optional **FRED**: `FRED_API_KEY`, in `.env`.

Infrastructure values, generated once in `.env`: `GI_PG_PASSWORD` and `N8N_ENCRYPTION_KEY`. Keep the encryption
key stable and backed up.

Before production, regenerate the Telegram token (BotFather → Revoke) and the OpenRouter key, both pasted in a chat
earlier.

## DATABASE

PostgreSQL 16, no extensions: [DATABASE.md](../deploy/n8n-final/DATABASE.md).
* Two databases on one server, `gold_intel` (system data) and `n8n` (n8n's own), both owned by `gold_intel`.
* Schema: `sql/001…010` applied in file order. Seeds: `seed/historical_event_reactions.sql` (362 releases) and
  `seed/market_history.sql`.
* Result: 27 tables and 5 views.
* Docker creates and loads all of this on the first start. The local pilot uses `node tools/db.js migrate` and
  `seed-history`.

## IMPORT METHOD

Only after the credential and `.env` are set, and with no second instance running:

| Setup | Command, from the project folder |
|---|---|
| Docker server | `docker compose up -d` (first start), then **`sh deploy/n8n-final/import-all.sh`** |
| Windows local pilot | **`powershell -ExecutionPolicy Bypass -File deploy\n8n-final\import-all.ps1`** |

The helper runs these steps:
1. checks prerequisites and the package;
2. checks that **GI Postgres** exists;
3. backs up;
4. imports the 9 workflows by n8n CLI in dependency order, keeping the fixed ids and re-linking the database nodes
   to GI Postgres by name;
5. activates;
6. verifies.

It ends with `IMPORT: PASSED`, or fails safely with the reason and the rollback path.

Never use the editor's "Import from file": it creates new workflow ids. Details:
[IMPORT_ORDER.md](../deploy/n8n-final/IMPORT_ORDER.md).

## ACTIVATION

The helper activates exactly six workflows: Master Pipeline, Pre-Event, Post-Event, Daily Report, Telegram Bot and
Health Monitor. AI Analyst, Telegram Sender and Error Handler stay inactive: they are called, not scheduled.
n8n's import deactivates workflows, so activation is always a separate step.

The helper restarts n8n and confirms six `Activated workflow "GI · …"` lines. Manual equivalent: `n8n update:workflow
--id=<id> --active=true` for the six, then restart n8n.

## FIRST TEST

Send **`/start`** to the Telegram bot. **Expected result:** the XAUUSD Gold Intelligence Desk menu with inline buttons:
GOLD NOW · BIGGEST SCENARIOS · TOP NEWS · GEOPOLITICS · POLITICS · MACRO · MARKET STATE · UPCOMING EVENTS · PRE-EVENT
BIAS · HISTORICAL PATTERNS · ACTIVE ALERTS · FORECAST REVIEW · AI ANALYSIS · SYSTEM STATUS · AI CONTROL CENTER · AI
USAGE. Then `/status` must show `Telegram: CONFIGURED · OpenRouter: CONFIGURED`.

If `TELEGRAM_CHAT_ID` is still empty, `/start` replies with your chat id instead. Put it in `.env` and apply it
(CREDENTIAL_SETUP.md step 4).

## TELEGRAM

Commands to test:
* **`/start`**, then **`/status`**, **`/brief`**, **`/now`**, **`/news`**, **`/biggest`**, **`/usage`**, **`/ai`**;
* every menu button;
* also `/analysis`, `/bias`, `/events`, `/history PCE`, `/alerts`, `/review`, `/market`, `/daily`, `/ai health`.

`/brief` returns the compact desk view:
* 🥇 GOLD and REGIME;
* 📊 NEXT 1 DAY and NEXT 5 DAYS calibrated Bullish / Bearish / Neutral % with Confidence XX/100 and Evidence,
  or `UNAVAILABLE — <reason>`, never invented;
* 🧭 BIAS per horizon;
* 🎯 MAIN DRIVER and Counter;
* 🔥 TOP SCENARIOS 1–3;
* 📅 NEXT and PRE-EVENT;
* ✅ MARKET;
* ⚠️ INVALIDATION;
* 📡 DATA.

Delivery check: in the n8n editor, **GI · Telegram Sender → 🧪 Telegram Test → Execute**. A message arrives on the phone.

## OPENROUTER

Test procedure, which spends one request:
1. In the n8n editor open **GI · AI Analyst (sub-workflow)**, click **🧪 AI Router Test**, then **Execute workflow**.
2. Expected: a successful run in which PRIMARY `inclusionai/ling-3.0-flash-fin:free` answers HTTP 200, or a
   recorded fallback to SECONDARY / TERTIARY / deterministic with the reason.
3. Send `/ai usage` to the bot. The request appears with tokens (when reported) and latency; `/ai health` shows the
   model state.

Ongoing: the Health Monitor re-checks the model list and the provider's free-request counter hourly, without
spending requests.

## ROLLBACK

[ROLLBACK.md](../deploy/n8n-final/ROLLBACK.md). Every helper run first saves a rollback point in `backups/<UTC>/`:
database dumps on Docker, a workflow export on the local pilot.

| Level | When | How |
|---|---|---|
| R1 | the previous workflows are wanted back | check out the previous package and run the helper again, or restore the workflow export from the rollback point, then activate the six |
| R2 | Docker: go back to the backup | `pg_restore` both dumps, check out the recorded commit, `docker compose up -d` |
| R3 | leave the server | stop the server's n8n **first**, then start the local pilot again |

Never run `docker compose down -v`, which deletes the databases.
