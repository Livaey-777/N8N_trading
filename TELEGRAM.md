# Telegram

Outbound intelligence messages and a small command bot. Long polling (`getUpdates`), so no public
webhook or open port is needed. Intelligence only: no message ever contains an order or a trade
instruction.

## Setup

1. In Telegram, open **@BotFather** → `/newbot` → copy the bot token.
2. Store secrets without printing them (hidden input, writes `.env` only):
   ```powershell
   powershell -ExecutionPolicy Bypass -File tools\set-secrets.ps1
   ```
   `TELEGRAM_CHAT_ID` may be left empty at first.
3. Restart n8n so the environment is reloaded: `node tools/n8n-local.js restart`
   (Docker: `docker compose up -d --force-recreate n8n`).
4. **Chat-ID discovery (setup mode).** While no chat ID is configured, the bot answers `/start` from any
   chat with that chat's own ID and nothing else. Put the ID into `TELEGRAM_CHAT_ID` with the script
   above and restart. Setup mode ends as soon as at least one ID is configured.
5. `TELEGRAM_CHAT_ID` accepts a comma-separated list. **All listed chats may use commands; the first one
   receives alerts, forecasts and reports.**

Verification never prints secrets: `/status` and the Health Monitor report only
`Telegram: CONFIGURED / NOT CONFIGURED`.

## Menu and commands (authorised chats only; everyone else is ignored and logged as `IGNORED`)

`/start` (also `/` and `/menu`) shows the menu as **inline buttons**; a button press arrives as a callback query, is
acknowledged immediately (no spinner) and is answered exactly like the typed command.

| Button | Command | Reply (built from stored state) |
|---|---|---|
| 📍 GOLD NOW | `/now` | regime; current (tactical) direction · score · confidence; horizon interpretation (only when horizons differ); calibrated tactical probability with the market state it is conditioned on — or UNAVAILABLE + reason — and a line stating whether history confirms the lean; bullish / bearish forces, dominant / counter driver, market confirmation, invalidation; gold / USD (proxy) / yields / real yield; geopolitics / macro; next major event + pre-event lean; ┌─ GOLD DIRECTION DESK ─┐ box (per horizon direction · score · confidence · probability); data quality. See [docs/CALIBRATION.md](docs/CALIBRATION.md) |
| 🔮 BIGGEST SCENARIOS | `/biggest` | top 3 conditional scenarios of the week, **ranked deterministically** (event impact × historical support × pre-event lean × time to event; the rank score is not a probability), with trigger, mechanism, gold response, confirmation, invalidation and historical evidence, and a **conditional probability** per scenario (first hours / 3 days) from calibrated cells only — shown separately from the rank score; the AI Analyst only **explains** the ranking and may not create or change a probability (cached, priority 4) |
| 📰 TOP NEWS | `/news` | most important gold-relevant events of the last 24h |
| 🌍 GEOPOLITICS · 🏛 POLITICS · 📈 MACRO | `/geopolitics` `/politics` `/macro` | top events of the last 48h per category |
| 💹 MARKET STATE | `/market` | instruments, COT positioning, regime and per-horizon market confirmation, DATA QUALITY / GOLD DATA / USD DATA labels |
| 🗓 UPCOMING EVENTS | `/events` | releases of the next 7 days with consensus and forecast summary |
| 🧭 PRE-EVENT BIAS | `/bias` | active deterministic forecasts: state, score, confidence, history, regime match, data quality, triggers |
| 📚 HISTORICAL PATTERNS | `/history [TYPE]` | reaction statistics per event type (n, up/down/mixed at 4h, medians, USD-conditional), source label |
| 🚨 ACTIVE ALERTS | `/alerts` | alerts of the last 24h (grouped per event, delivery status) and alert-grade events now |
| 🧾 FORECAST REVIEW | `/review` | latest evaluated forecasts, latest measured releases, descriptive performance |
| 🤖 AI ANALYSIS | `/analysis` | current direction summary (horizons, tactical calibrated probability, consistency) + latest stored analyses (AI or deterministic, with the reason) — spends no AI request |
| 🩺 SYSTEM STATUS | `/status` | health per component, scheduler freshness, configuration (CONFIGURED/NOT CONFIGURED only) |
| 🎛 AI CONTROL CENTER | `/ai` | AI menu (buttons): `/ai usage` · `/ai health` · `/ai model` · `/ai fallback` · `/ai config` · `/ai failures` · `/ai performance` |
| 📊 AI USAGE | `/usage`, `/ai_usage` | 🤖 AI USAGE CENTER: per model requests (today / hour), tokens (UNKNOWN when not reported), last request / success, failures, fallbacks, capacity; system totals, quota, provider counter, cost; last 24 hours |

Also available: `/daily`, `/gold`, `/scenarios`, `/event <id>`.

Only 🔮 BIGGEST SCENARIOS may call the AI; every other reply is built from stored state. Polling interval:
`GI_BOT_POLL_SECONDS` (30 s) with `GI_BOT_LONGPOLL_SECONDS` long-poll; each batch is confirmed immediately so an
overlapping poll never answers the same update twice.

## Message types

| Type | When | Header |
|---|---|---|
| `ALERT` (update flagged in the text) | an event passes relevance ≥ 60, importance ≥ 65, confirmation, new or materially changed, freshness ≤ 6h, cooldown `GI_ALERT_COOLDOWN_MIN` | `XAUUSD GOLD INTELLIGENCE` |
| `PRE_EVENT` | daily pre-event run (`GI_PREEVENT_DAILY_HOUR`) for scheduled releases in the next `GI_PREEVENT_LOOKAHEAD_HOURS` (36h) | `XAUUSD PRE-EVENT INTELLIGENCE` (━━━ sections) |
| `FORECAST_UPDATE` | refresh detects a material change: state change, score move ≥ 20, consensus change, geopolitical-risk class or market-regime change | `FORECAST UPDATE` |
| `FORECAST_INVALIDATED` | a directional forecast flips direction, becomes UNDETERMINED (other than missing consensus), or the score reverses sign by ≥ 25 | `FORECAST INVALIDATED` |
| `PRE_EVENT_REFRESH` | T-minus check for HIGH-impact releases `GI_PREEVENT_REFRESH_LEAD_MIN` (90 min) before the release | `T-minus check` |
| `CALENDAR_NOTICE` | release rescheduled, time changed or cancelled | calendar notice |
| `EVENT_REVIEW` | post-event review at 4h / 24h / 3d | `EVENT REVIEW` |
| `DAILY` | `GI_DAILY_REPORT_HOUR` local | `🥇 XAUUSD DAILY INTELLIGENCE` |
| `REGIME_CHANGE` | desk regime changes (with hysteresis) | regime change |
| `TECH_ALERT` | workflow error (Error Handler) or health state change (Health Monitor); error alerts share a cooldown `GI_TECH_ALERT_COOLDOWN_MIN`, LOW-severity bot-polling glitches are logged only | `⚠️` technical alert |
| `TEST` / `TEST_ALERT` | 🧪 test triggers | 🧪 prefix |
| `AI_ALERT` | AI quota warning, model limit reached, persistent fallback — once per state change, `AI_USAGE_ALERT_COOLDOWN_MIN` | ⚠️ / 🚫 / 🔄 |
| `COMMAND_REPLY` | bot commands and button presses (menus carry inline keyboards) | — |

Every analytical message carries `DATA QUALITY: GOOD/PARTIAL/DEGRADED` with reasons,
`GOLD DATA: DIRECT/PROXY`, `USD DATA: PROXY`, the deterministic confidence, whether the AI was used
(model) or why not, and "intelligence only, not a trade order". Test messages are prefixed 🧪.

## Delivery guarantees (`src/lib/telegram.js → sendMessages`, workflow *GI · Telegram Sender*)

* HTML parse mode; text split into ≤ 4000-character parts on line boundaries, 1.1 s between parts; an inline
  keyboard is attached to the last part only.
* Up to 4 attempts per part: network errors and 5xx → exponential backoff (1 s, 3 s, 9 s);
  429 → waits Telegram's `retry_after` (max 30 s); HTML parse error → resent once as plain text;
  other 4xx → no retry (logged).
* **No spam**: messages carry a `dedup_key` + window; an identical key already `SENT` inside its window is skipped.
  Alerts additionally use the event's material signature + cooldown `GI_ALERT_COOLDOWN_MIN`.
* Every message (sent, failed, skipped, not configured) is logged in `telegram_messages`; the bot token
  is redacted from any stored error.
* If Telegram is not configured, all messages are stored with status `NOT_CONFIGURED` and the rest of the
  pipeline continues normally.
