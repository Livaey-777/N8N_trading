# Credential setup — do this once

You set up **three things, once**. After that, the import connects everything automatically.

| # | Provider | Where you set it | Used by |
|---|---|---|---|
| 1 | **PostgreSQL** (database login) | in n8n: a credential named **GI Postgres** | all 9 workflows (27 database nodes) |
| 2 | **Telegram** (bot token + your chat id) | in the file **`.env`** | Telegram Sender, Telegram Bot, Error Handler |
| 3 | **OpenRouter** (AI key) | in the file **`.env`** | AI Analyst, Health Monitor |

Why Telegram and OpenRouter go in `.env` rather than in the n8n credentials screen: the AI router and the Telegram
sender run inside n8n *Code* nodes (fallback chain, retries, message splitting), and n8n never gives a
credential's value to a Code node. The workflows therefore read these two keys from n8n's environment, and every
workflow reads the same line. **Do not create n8n credentials for Telegram or OpenRouter**: nothing would use them.

---

## Step 1 — PostgreSQL credential "GI Postgres" (in n8n)

**Docker server:** skip this step. The first `docker compose up -d` creates **GI Postgres** from `.env`
automatically. **Windows local pilot:** it already exists. To check, open n8n → **Credentials**: **GI Postgres**
should be listed. Otherwise:

1. Create credential: open n8n in the browser → left menu **Overview** → tab **Credentials** →
   **Create credential** (or **Add credential**) → search **Postgres** → choose **Postgres** → **Continue**.
2. Name it: click the title at the top of the dialog and type exactly **`GI Postgres`**. Capital G, I and P,
   one space, nothing else.
3. Enter:

   | Field | Value |
   |---|---|
   | Host | `postgres` on the Docker server · `127.0.0.1` on the Windows local pilot · otherwise your database server |
   | Database | `gold_intel` |
   | User | `gold_intel` (the value of `GI_PG_USER` in `.env`) |
   | Password | the value of `GI_PG_PASSWORD` in `.env` |
   | Maximum Number of Connections | `10` |
   | Ignore SSL Issues | off |
   | SSL | `Disable` (database on the same machine or private network) · `Require` (database on another server) |
   | Port | `5432` on the Docker server · `5433` on the Windows local pilot |
   | SSH Tunnel | off |

4. Save: click **Save**. n8n tests the connection and shows *Connection tested successfully*.
5. Keep **exactly one** credential with this name. If there are two, delete the extra one.

## Step 2 — Telegram (in `.env`)

You need the bot token and your chat id.
* **Bot token:** open Telegram → **@BotFather** → `/mybots` → your bot → **API Token**. After the final checks, use
  **Revoke** there to get a new token, because the old one was shared in a chat.
* **Chat id:** if you already ran the local pilot, it is the `TELEGRAM_CHAT_ID` line of the pilot's `.env`.
  Otherwise leave it empty for now. The bot then starts in *setup mode*: send `/start` to it, it replies with your
  chat id, you put that number in `.env` and do step 4 again.

**Windows local pilot:** run this in the project folder. It asks for each value; the typing stays hidden, and
Enter keeps the current value:
```
powershell -ExecutionPolicy Bypass -File tools\set-secrets.ps1
```
**Docker server:** open `.env` with a text editor (`nano .env`), find these lines and paste each value after the
`=` with no spaces or quotes:
```
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```
Save the file.

## Step 3 — OpenRouter (in `.env`)

Create a key at **openrouter.ai → Keys** (after the final checks, delete the old key and create a new one). Put it
in the same way as step 2: `tools\set-secrets.ps1` asks for it on Windows, or on the Docker server write it after:
```
OPENROUTER_API_KEY=
```
Use one key only. The system never rotates keys to get around limits.

Optional: `FRED_API_KEY=` (fred.stlouisfed.org) adds oil, VIX and broad-dollar data. Leave it empty if you
don't have one.

## Step 4 — apply

The import helper applies `.env` for you. It recreates or restarts n8n at the end. If you change `.env` later
without importing, apply it with:
* Docker server: `docker compose up -d --force-recreate n8n`
* Windows local pilot: `node tools\n8n-local.js restart`

## Step 5 — check without revealing anything

After the import, send `/status` to the bot. The configuration line must read
`Telegram: CONFIGURED · OpenRouter: CONFIGURED`. Values are never shown, only CONFIGURED / NOT CONFIGURED.

---

**Do not edit any workflow nodes.** The import connects all 27 database nodes to **GI Postgres** by name, and
every workflow reads Telegram and OpenRouter from `.env`. There is nothing to connect by hand.

Next: [IMPORT_ORDER.md](IMPORT_ORDER.md) — one command.
