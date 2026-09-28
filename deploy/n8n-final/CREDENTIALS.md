# Credentials — reference

Step-by-step setup for a non-developer: [CREDENTIAL_SETUP.md](CREDENTIAL_SETUP.md). This page is the exact
reference. The package contains **no secret**; every value is set by the owner on the target host.

## Summary

| # | Credential | Mechanism | Shared? | Configured |
|---|---|---|---|---|
| 1 | **GI Postgres** | n8n credential, type **Postgres** (`postgres`); encrypted in n8n with `N8N_ENCRYPTION_KEY` | **one credential for all 27 Postgres nodes in all 9 workflows** | once, in n8n (created automatically on the Docker server) |
| 2 | **Telegram**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | environment variables in `.env`, read through `$env` | one value for the whole instance | once, in `.env` |
| 3 | **OpenRouter**: `OPENROUTER_API_KEY` | environment variable in `.env` | one value for the whole instance | once, in `.env` |
| 4 | **FRED** (optional): `FRED_API_KEY` | environment variable in `.env` | one value | once, in `.env` (empty = oil / VIX / broad dollar NOT AVAILABLE) |
| — | infrastructure: `GI_PG_PASSWORD`, `N8N_ENCRYPTION_KEY` | `.env` (Docker Compose and the local launcher pass them to PostgreSQL and n8n) | — | generated once (`openssl rand -hex 24` / `-hex 32`) |

**Why 2–4 are environment variables and not n8n credentials.** The AI router (PRIMARY → SECONDARY → TERTIARY →
deterministic, model health, rate-limit handling) and the Telegram sender (dedup, 4 000-character chunks, 429 / 5xx
retries, HTML fallback) run inside n8n Code nodes. n8n deliberately never exposes an n8n credential's value to a
Code node. Moving them to credentials would mean rebuilding these verified engines as chains of HTTP Request nodes.

The environment is n8n's supported alternative:
* the values never appear in workflow JSON, exports or execution data (secret scan: 0 occurrences, files + both
  databases);
* n8n needs `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, which `docker-compose.yml` and `tools/n8n-local.js` set;
* keep the editor single-user, reached through an SSH tunnel or HTTPS with authentication: any editor user can read
  environment values from a Code node.

## 1. GI Postgres

| Item | Value |
|---|---|
| Name expected by the workflows | `GI Postgres` (exact) |
| Type | Postgres (`postgres`) |
| Fields | Host · Database `gold_intel` · User `gold_intel` · Password (= `GI_PG_PASSWORD`) · Port (`5432` Docker / `5433` local pilot) · SSL (`Disable` private network / `Require` remote) · Maximum Number of Connections `10` · SSH Tunnel off |
| How the link resolves | the workflow files reference id `GIpostgresCred01` with the name `GI Postgres`. On import, n8n keeps the id when it exists; otherwise it re-links every node to the **one** credential named `GI Postgres` of type Postgres (n8n 1.117.2 `replaceInvalidCredentials`). Create the credential **before** importing. Verified with an editor-created credential (random id): 27/27 nodes re-linked |
| Created automatically | Docker: `deploy/n8n-bootstrap.sh` (first boot) · local pilot: `node tools/n8n-local.js import-credentials` · both helpers: `--create-postgres-credential` / `-CreatePostgresCredential` |

Nodes using it (27):

| Workflow | Nodes |
|---|---|
| 01 Master Pipeline | Load News Context · Check Seen Items & Source Health · Persist Events · Record Run · Load Market Context · Persist Market & Desk |
| 02 AI Analyst | Load AI State · Record AI Usage |
| 03 Telegram Sender | Check Duplicates · Log Messages |
| 04 Pre-Event | Load Calendar State · Upsert Releases · Load Forecast Context · Persist Forecasts |
| 05 Post-Event | Load Due Reviews · Persist Reviews |
| 06 Daily Report | Load Report Data · Persist Daily Report · Load Calibration Inputs · Store Calibration |
| 07 Telegram Bot | Load Bot State · Load Command Data · Save Offset & Log Inbound |
| 08 Health Monitor | Collect Health · Record AI Health · Persist Health |
| 09 Error Handler | Record Error |

## 2. Telegram — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

| Item | Value |
|---|---|
| Variables | `TELEGRAM_BOT_TOKEN` (BotFather token) · `TELEGRAM_CHAT_ID` (comma-separated authorised chats; the first receives alerts; empty = setup mode, `/start` replies with the sender's chat id) |
| Nodes that call Telegram | 03 Telegram Sender → **Send Messages** · 07 Telegram Bot → **Get Updates** (polling, button acknowledgements) · 09 Error Handler → **Send Tech Alert** (works even when the database is down) |
| Also read by | the configuration loader bundled in every Code node: authorised chats, `/status` CONFIGURED flags, redaction of the token from any logged error |

## 3. OpenRouter — `OPENROUTER_API_KEY`

| Item | Value |
|---|---|
| Variable | `OPENROUTER_API_KEY` (one key; no rotation) |
| Model chain (not secret) | `OPENROUTER_PRIMARY_MODEL=inclusionai/ling-3.0-flash-fin:free` · `OPENROUTER_SECONDARY_MODEL=nvidia/nemotron-3-ultra-550b-a55b:free` · `OPENROUTER_TERTIARY_MODEL=poolside/laguna-s-2.1:free` (in `.env.example`) |
| Nodes that call OpenRouter | 02 AI Analyst → **AI Router** (chat completions for every AI request of workflows 01, 04, 06, 07) · 08 Health Monitor → **AI Health Check** (`GET /api/v1/key` counter, model list, tiny idle-model probes) |
| Without the key | every analysis uses the deterministic engine, stated in the message as `DETERMINISTIC (NOT_CONFIGURED)` |

## 4. FRED (optional) — `FRED_API_KEY`

Used only by 01 Master Pipeline → **Compute Market & Desk State**. The call is made inside the Code node, so the
key never appears in node parameters or execution data.

## Checking the configuration

Telegram `/status` → `Telegram: CONFIGURED · OpenRouter: CONFIGURED · FRED: …`, and `/ai config` → `OpenRouter key: CONFIGURED`.
Values are never displayed.

## After the final verification

Regenerate the Telegram bot token (BotFather → Revoke) and the OpenRouter key, both pasted in a chat earlier. Put the
new values in `.env`, apply them (CREDENTIAL_SETUP.md step 4), then check `/status` and send a 🧪 Telegram Test.
