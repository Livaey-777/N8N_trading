# Credentials — Gold Intelligence n8n package

This package contains **no secret**. Every value below is a placeholder that the owner sets on the target
host. Never commit `.env`, never paste a secret into a workflow, a document, a chat or Telegram.

## 1. Secrets in the n8n process environment (`.env`)

The workflows read these at runtime through `$env`. They are never stored in workflow JSON, so n8n must run
with `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` (set in `docker-compose.yml`).

| Variable | Placeholder | Used by | Source |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | `<TELEGRAM_BOT_TOKEN>` | 03 Telegram Sender (Send Messages) · 07 Telegram Bot (Get Updates) · 09 Error Handler (Send Tech Alert) | BotFather. Use a **newly regenerated** token (the old one was pasted in a chat) |
| `TELEGRAM_CHAT_ID` | `<TELEGRAM_CHAT_ID>` | same three; the bot answers only these chats | comma-separated list; the first receives alerts |
| `OPENROUTER_API_KEY` | `<OPENROUTER_API_KEY>` | 02 AI Analyst (AI Router) · 08 Health Monitor (AI Health Check: key counter, idle probes) | openrouter.ai → Keys. Use a **newly regenerated** key. One key only; no rotation to raise limits |
| `FRED_API_KEY` | `<FRED_API_KEY>` (optional) | 01 Master Pipeline (market requests: WTI, VIX, broad dollar) | fred.stlouisfed.org |
| `GI_PG_PASSWORD` | `<GI_PG_PASSWORD>` | PostgreSQL, n8n's own database, credential *GI Postgres* | `openssl rand -hex 24` |
| `N8N_ENCRYPTION_KEY` | `<N8N_ENCRYPTION_KEY>` | n8n (encrypts stored credentials) | `openssl rand -hex 32`. **Keep it stable and back it up**; without it, stored credentials and n8n backups are unreadable |

Every other setting (schedules, thresholds, the AI model chain, timezone `Africa/Casablanca`) is in
[.env.example](.env.example) with its verified value.

Set secrets with hidden input:
* Windows local pilot: `powershell -ExecutionPolicy Bypass -File tools\set-secrets.ps1`
* Linux: edit `.env` with an editor (`chmod 600 .env`); do not `echo` secrets into the shell history.

Check what n8n sees without revealing values: Telegram `/status` or `/ai config` print `CONFIGURED` / `NOT CONFIGURED` only.

## 2. The n8n credential "GI Postgres"

| Field | Value |
|---|---|
| id | `GIpostgresCred01` (fixed; every Postgres node in all 9 workflows references this id) |
| name | `GI Postgres` |
| type | `postgres` |
| host / port | `<GI_PG_HOST>` / `5432` (`postgres` inside the Compose network) |
| database / user | `gold_intel` / `<GI_PG_USER>` (default `gold_intel`) |
| password | `<GI_PG_PASSWORD>` |
| ssl | `disable` on a private Docker network; `require` if the database is reached over a network |

**Docker Compose:** `deploy/n8n-bootstrap.sh` creates it from `.env` on the first boot. Nothing to type.

**Existing n8n (CLI):** create it with the fixed id from this template. Write it to a private temporary file,
import it, then delete the file:

```json
[{ "id": "GIpostgresCred01", "name": "GI Postgres", "type": "postgres",
   "data": { "host": "<GI_PG_HOST>", "port": 5432, "database": "gold_intel", "user": "<GI_PG_USER>",
             "password": "<GI_PG_PASSWORD>", "ssl": "disable", "allowUnauthorizedCerts": false,
             "maxConnections": 10, "sshTunnel": false } }]
```
```sh
umask 077; nano /tmp/gi-cred.json                    # paste the template, fill the <…> values
n8n import:credentials --input=/tmp/gi-cred.json && rm -f /tmp/gi-cred.json
```

**Never create this credential in the editor.** The editor assigns a new id, and the 9 workflows would lose
their database connection.

## 3. After the final verification

The owner regenerates the Telegram bot token (BotFather `/revoke`) and the OpenRouter key, puts the new values
in `.env` and restarts n8n. Then Telegram `/status` must show both as `CONFIGURED`, and a 🧪 Telegram Test must
arrive.
