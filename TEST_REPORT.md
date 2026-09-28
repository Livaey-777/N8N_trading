# Test report — FINAL LIVE PILOT

> **2026-09-28 17:45 UTC — cloud session (second pass).** `/brief` implemented and verified through the real bot
> workflow. Regression: tests 113/113, validation 9/9, SQL 11/11, bot 55/55 (31 commands + 24 buttons), gitleaks history
> clean. The final package `deploy/n8n-final/` passed its audit and a real CLI import on a fresh instance. The live release
> gate (scheduled PRE_EVENT / DAILY_REPORT, AI health, real Telegram / OpenRouter) is still **PENDING**: this session
> cannot reach the owner's PC.
>
> **2026-09-28 17:10 UTC — cloud session.** The three remaining live checks (first scheduled PRE_EVENT, first scheduled
> DAILY_REPORT, AI fallback health) are **NOT VERIFIED**: the cloud session cannot reach the owner's PC. They are read with
> `node tools/verify-live.js` on the PC. A throwaway cloud replica proved the scheduled paths in real n8n 1.117.2 up to
> Telegram delivery (no token there), and tested the deployment package and rollback. See the last section.
>
> **2026-09-28 03:30 UTC — READY (local live pilot).** Live OpenRouter, usage tracking, Telegram delivery, the owner's
> commands and buttons, 🔮 BIGGEST SCENARIOS with a real AI explanation and the calibrated-probability output are verified;
> `npm test` 105/105, validation PASSED, `check-sql` 11/11, secret scan CLEAN. See the last two sections. The historical
> sections below are kept as recorded at the time.

Host: owner's Windows 11 PC · n8n 1.117.2 (local, PostgreSQL-backed) · PostgreSQL 18.4 (embedded, 127.0.0.1:5433)
Date: 2026-09-27 (UTC) · All results below come from real runs in the local n8n instance unless marked *unit*.

> **SYSTEM STATUS: PARTIAL** — every component that does not need the owner's secrets passed end-to-end
> on real data. Telegram delivery and live OpenRouter analysis are **NOT RUN** because
> `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and `OPENROUTER_API_KEY` are **NOT CONFIGURED**.
> The system is not declared READY until a real Telegram message has been received.

## Environment condition during the pilot

The PC's internet link was intermittently failing (DNS `ENOTFOUND`/`EAI_AGAIN` after ~12 s, TLS resets,
even against public resolvers and direct IPs). Official sites (BLS, Treasury, CFTC, BEA, Fed) and most
newsrooms were unreachable for long stretches; gold-api.com, Coinbase, OpenRouter and Telegram
answered intermittently. Results below state which runs were affected. The pipeline degraded as
designed (source health, data-quality reasons, no crashes).

## Results

| Component | Result | Evidence |
|---|---|---|
| N8N | **PASS** | 9 workflows imported with fixed ids, validated (§47), visible in the UI (browser check), executions `success` |
| POSTGRES | **PASS** | `gold_intel` schema v3 + `n8n` DB; 362 historical reactions, 6 191 market + 2 160 gold observations |
| MARKET ENGINE | **PASS** (network-degraded) | exec #29/#32/#33/#63: gold-api DIRECT spot, Coinbase → DXY-formula **PROXY**, Treasury 2Y/10Y/30Y/real, COT; regime RATES / REAL-YIELD PRESSURE, tactical & swing BEARISH **CONFIRMED** by gold 5d −1.8 % / 20d −3.1 %, structural DIVERGENCE flagged, confidence 76 |
| NEWS | **PASS** | scheduled exec #75 (17:45 UTC, `trigger`): 24/25 sources OK, 878 items → 336 new → 180 retained → 96 new + 18 updated events, 3 alerts composed (held: Telegram NOT CONFIGURED). Earlier exec #17 during the outage: 18/25 sources timed out, handled as source failures |
| SYNTHETIC EVENT | **PASS** | exec #26: 3 differently-worded reports → **1** CRITICAL event (s3/p3, CONFIRMED_OFFICIAL, relevance 82, importance 93); football item IRRELEVANT; jewellery item LOW, not alerted |
| FORECAST | **PASS** | exec #43: PCE (Wed 30 Sep 13:30) BEARISH, score −38 (not a probability), confidence 63, 19 historical releases, top-8 analogues (similarity 60), evidence quality 52, regime match MEDIUM, data quality PARTIAL (calendar re-sync failed, verified 1h earlier); forecast memory ACTIVE → UPDATED chain |
| AI PRIMARY | **NOT RUN** | `OPENROUTER_API_KEY` NOT CONFIGURED. Model availability verified: `nvidia/nemotron-3-super-120b-a12b:free` listed & free |
| AI SECONDARY | **NOT RUN** | `google/gemma-4-31b-it:free` listed & free |
| AI TERTIARY | **NOT RUN** | `qwen/qwen3.8-27b:free` listed & free |
| AI FALLBACK (DETERMINISTIC) | **PASS** | every run produced deterministic analysis with the reason (`NOT_CONFIGURED`) shown |
| TELEGRAM | **NOT RUN** | NOT CONFIGURED; 54 messages composed and logged with status `NOT_CONFIGURED` |
| DAILY REPORT | **PASS (composed)** / delivery NOT RUN | exec #35: `🥇 XAUUSD DAILY INTELLIGENCE` with regime, 4 biases, macro/geo, markets, confirmation, drivers, events, forecasts, scenarios, DATA QUALITY / GOLD DIRECT / USD PROXY |
| /NOW | **PASS (simulated)** / real bot NOT RUN | exec #38 |
| /STATUS | **PASS (simulated)** / real bot NOT RUN | exec #38: overall, per-component health, scheduler freshness, CONFIGURED/NOT CONFIGURED only |
| ALL COMMANDS | **PASS (simulated)** | all 11 commands answered from stored state (exec #30) |
| POST-EVENT | **PASS** | exec #108: FOMC 2026-09-16 (HIKE to 3.75-4 %, Fed statement), gold 1h −2.07 % / 4h −2.03 % BEARISH (STRONG), USD proxy +0.58 %, 2Y +7 bp, real 10Y +6 bp; Dukascopy unreachable → Binance proxy, labelled PROXY and DATA QUALITY PARTIAL; stored in `historical_event_reactions`. Forecast scoring (direction / scenario / confirmation / timing / error) *unit* PASS; first live scoring after PCE on 30 Sep |
| ERROR HANDLER | **PARTIAL** | cooldown bug fixed (only alertable errors start the cooldown); controlled failure test needs Telegram |
| HEALTH MONITOR | **PASS** | scheduled runs every 5 min (`trigger` mode) |
| 24/7 SCHEDULING | **PASS** | 6 workflows active; scheduled Health (#49, #60) and Market (#63) executions observed |
| DOCKER COMPOSE | **PASS (smoke test 2026-09-28)** | isolated `gi-smoke` stack on :5690: Postgres init + seeds, n8n healthy, 9 workflows imported, scheduled Health + Market runs succeeded; 2 deploy defects fixed (see CONTINUATION_STATE.md) |
| UNIT TESTS | **PASS** | 68/68 (`npm test`) |
| WORKFLOW VALIDATION | **PASS** | `node tools/validate-workflows.js`: JSON, node types/versions, ids, connections, no orphans, expressions, Code syntax, references, **no embedded secrets** |

## Defects found and fixed during the pilot (all rebuilt, re-imported, re-run)

1. Live news could merge into a simulated test event (and never alert) — clustering now separates live and test.
2. Short-lived shocks were labelled STRUCTURAL BULLISH — a horizon under 25 % of the peak effect is NEUTRAL.
3. Alert `DATA QUALITY` ignored the age of the market context — downgraded beyond 3 intervals / 12h, age shown; stale gold quote age shown.
4. A future-stamped partial PAXG daily candle became the "latest" gold price in /now and the daily report — guarded in `marketSnapshot`, backfill and Dukascopy daily closes; row removed from DB and seed.
5. Merged event classification dropped gold flags (price move, local-listing / miner caps) — preserved.
6. "Gold prices plunging amid war" was BULLISH — headline price move against the channel ⇒ MIXED.
7. Company story with incidental tariffs scored as trade policy — masked (relevance 43 → 6).
8. "Fed cut bets rise/fade" and "hike bets mount" not recognised — added.
9. A channel with both bullish and bearish evidence produced a directional net — now MIXED.
10. Desk confidence sat at the cap despite opposing horizons / divergence — agreement now requires price confirmation.
11. `/status` showed "3 active schedules" (count of jobs run) — now the scheduler state from job freshness; header shows the current time.
12. A failed calendar re-sync made a forecast UNDETERMINED even when verified 1h earlier — PARTIAL with reason when ≥ 2 official calendars verified in 24h.
13. Error handler: a LOW-severity or undeliverable error consumed the alert cooldown — fixed.
14. Stored events carried classifications from older builds — `tools/rescore-events.js` re-applied the current engine.
15. Real-news review: a single-source statement was CRITICAL — CRITICAL now requires official confirmation or corroboration; hedged headlines cap at HIGH.
16. "Reported by 13 publishers … (single source)" — one credible newsroom plus ≥ 3 independent publishers is CORROBORATED.
17. Previews / outlook pieces ("could send yields surging", "… leads week of PCE data") scored relevance 100 — capped at 50 / MEDIUM.
18. Conflicts outside the gold-relevant theatres without an energy/trade channel have lower market sensitivity.
19. Post-event review said DATA QUALITY GOOD while measured on a proxy, and claimed an evaluation row that did not exist — both corrected.
20. `seed-history` did not load the market-history seed (fresh installs lacked 5-year context) — fixed; the Dukascopy daily-close path also drops the incomplete day.

## Pending (requires the owner's secrets)

1. `powershell -ExecutionPolicy Bypass -File tools\set-secrets.ps1` → `node tools/n8n-local.js restart`
2. Telegram Sender 🧪 test → confirm receipt in Telegram
3. AI Router 🧪 test: normal / primary unavailable / all unavailable (real OpenRouter errors, nothing mocked)
4. Real alert, pre-event forecast with AI, daily report delivered; `/now` and `/status` from the real bot
5. Error handler controlled failure with cooldown; post-event review once the network is stable
6. `node tools/db.js cleanup-tests`

## Extension: AI usage / quota monitoring + Telegram control center (2026-09-28)

| Component | Result | Evidence |
|---|---|---|
| /usage · /ai_usage | **PASS (simulated)** | usage center renders per-model requests, tokens (UNKNOWN when not reported), capacity, system totals, provider counter, cost, last 24h |
| /ai · /ai health · /ai model · /ai failures · /ai fallback · /ai config · /ai performance | **PASS (simulated)** | all views + inline menu (exec #275) |
| Menu (14 required entries + AI) via buttons | **PASS (simulated)** | 31 commands + 3 button presses → 34 replies; callback normalisation unit-tested |
| Primary / secondary / tertiary / deterministic fallback | **unit PASS**, live NOT RUN | router test with real-shaped 429/5xx responses; live test needs `OPENROUTER_API_KEY` |
| Token / request counting | **unit + SQL PASS**, live NOT RUN | `ai_usage` → daily/hourly aggregates verified in a rolled-back transaction |
| Cache | **unit PASS**, live NOT RUN | fingerprint materiality, expiry, new-critical invalidation, stale-number re-validation |
| Quota warning / limit reached / cooldown | **unit PASS** | one alert per transition; flapping suppressed; no simulated provider data used live |
| Health monitoring | **PASS** | model list verified in n8n (3/3 listed + free); key NOT_CONFIGURED; probes need the key |
| Forecast model tracking | **PASS** | forecast #7: `ai_provider`, `ai_fallback_level`, `ai_tokens` (null = unknown), `ai_status` |
| 🔮 BIGGEST SCENARIOS | **PASS (deterministic)**; AI explanation NOT RUN | ranking deterministic and unit-tested; "not a probability" stated |
| Daily AI section | **PASS** | omitted in auto mode while AI is not configured; format unit-tested |
| Unit tests | **PASS** | 86/86 |
| Workflow validation / SQL execution | **PASS** | 9 workflows; 7/7 queries |

Defects fixed during this extension: repeated alerts for the same event while Telegram was not configured
(NOT_CONFIGURED now counts as handled; FAILED still retries); health alert repeated every cooldown while degraded
(now on state change + reminder every 6 cooldowns).

## Live integration + multi-horizon direction / calibrated probability (2026-09-28)

| Component | Result | Evidence |
|---|---|---|
| OpenRouter (real) | **PASS** | PRIMARY HTTP 200 (3 351 tokens); fallback to SECONDARY on a real 400; all-invalid → DETERMINISTIC |
| Usage tracking / quota | **PASS** | ai_usage + daily/hourly aggregates, provider counter 5/50, hourly guard gated a priority-4 request then allowed it |
| Telegram delivery + inbound | **PASS** | messages SENT with Telegram message ids; the owner's /now, /ai, /start, /analysis, /biggest and buttons logged and answered |
| 🔮 BIGGEST SCENARIOS + real AI | **PASS** | ai_usage bot/BIGGEST SUCCESS (ling-3.0-flash-fin, 4.7 s); "🤖 AI EXPLANATION" in the delivered reply; no probability created by the AI |
| /now multi-horizon + calibrated probability | **PASS** | direction · score · confidence per horizon, interpretation, calibrated tactical probability with market state and consistency line, desk box, data quality |
| Probability rules | **PASS** (unit) | never from confidence/score; UNAVAILABLE below 20 cases or on failed walk-forward; non-overlapping; no look-ahead; percentages sum to 100 |
| Error handler dedup | **PASS** (SQL, rolled back) | replayed crash of execution 496 → duplicate=true, not recorded, no alert; new execution → recorded, alertable |
| Regression | **PASS** | npm test 105/105 · validate PASSED · check-sql 11/11 · secret scan CLEAN |

Observation: on the free tier, SECONDARY/TERTIARY were rate-limited or produced invalid output earlier, so /status shows AI (and
OVERALL) DEGRADED although PRIMARY is healthy; the deterministic engine covers every failure. One AI wording nuance seen: the
BIGGEST explanation called the hot-print scenario's support "the weakest" while the base case had less (INSUFFICIENT) — a
qualitative comparison the factuality guard does not check; no numbers were invented.

## Cloud session: replica + deployment package (2026-09-28)

Environment: cloud container, `docker compose -p gi-replica` from this repository (n8n 1.117.2 + postgres:16-alpine), no
Telegram/OpenRouter secrets, no internet (data sources DEGRADED as designed). Replica-only settings: daily hours 18:00,
lookahead 48 h, one PCE release fixture (30 Sep 12:30 UTC, the time from the live BEA calendar).
**These results support the live checks; they do not replace them.**

| Component | Result | Evidence |
|---|---|---|
| Scheduled PRE_EVENT (replica) | **PASS up to delivery**; delivery NOT RUN (no token) | exec #117 `trigger`/`success` 17:00:19 UTC = 18:00 local → PRE_EVENT_DAILY, forecast #1 PCE stored, message logged `NOT_CONFIGURED`; refresh #113 excluded |
| Scheduled DAILY_REPORT (replica) | **PASS up to delivery**; delivery NOT RUN (no token) | exec #124 `trigger`/`success` → DAILY_SCHEDULED OK, analysis #7, calibration 66 cells / 24 CALIBRATED |
| `tools/verify-live.js` | **PASS** | verdicts FAIL (Telegram NOT_CONFIGURED) for both, which is correct; manual/refresh runs never counted; unit-tested (4 tests) |
| Rollback R1 / R2 | **PASS** | CLI import deactivates workflows (found, runbook + DEPLOYMENT.md fixed); restore from `backup.sh` returns to the backup state, schedules resume |
| Secret scan (Compose network) | **PASS** | CLEAN |
| AI fallback health | **NOT VERIFIED** | no recorded requests in the replica (no key); openrouter.ai is also blocked by the cloud sandbox |
| Unit tests | **PASS** | 109/109 |
| Workflow validation / rebuild | **PASS** | validation PASSED; rebuild byte-identical |

Defects fixed: IPv6-less hosts crash-looped n8n (`N8N_LISTEN_ADDRESS=0.0.0.0`); `.env.example` named the old model chain;
DEPLOYMENT.md's workflow-update command left every schedule inactive; image override for blocked registries (`N8N_IMAGE`).

## Cloud session, second pass: /brief + final package (2026-09-28 17:00–17:45 UTC)

| Component | Result | Evidence |
|---|---|---|
| `/brief` | **PASS** (workflow); real delivery PENDING | agreed sections in order; percentages only from CALIBRATED cells (NEXT 5 DAYS 31/23/46, n=247); confidence `/100`; UNAVAILABLE + reason otherwise; 4 unit tests; bot execution #32 composed it (1 888 chars) |
| Bot commands | **PASS 55/55** | 31 typed (all commands, `/ai *`, `/brief@Bot`) + 24 inline buttons → 55 replies, 0 unknown, 0 empty, 0 errors (delivery NOT_CONFIGURED: no token) |
| Unit tests | **PASS 113/113** | + `tests/brief.test.js` |
| Workflow validation | **PASS 9/9** | structure unchanged; only bundled Code-node text |
| SQL checks | **PASS 11/11** | fresh PostgreSQL 16; checker made self-contained, asserts Error Handler dedup |
| Package audit | **PASS 13/13** | `deploy/n8n-final/verify-package.sh`; catches injected faults |
| Package import (CLI, fresh instance) | **PASS** | 9 imports, credential after (27/27 links), references 20/20, 6 activated, scheduled Master + Health `success`, 🧪 Telegram / AI Router tests `success`, 0 errors |
| Secret scan, history | **PASS** | gitleaks 8.28.0 over all commits + targeted patterns: none |
| Live gate (PRE_EVENT, DAILY_REPORT, AI health, real Telegram, real OpenRouter) | **PENDING** | not reachable from the cloud session |
