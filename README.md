# Gold Intelligence — XAUUSD macro-intelligence desk on n8n

A standalone, 24/7 n8n system that watches geopolitics, politics, macro data, monetary and fiscal
policy, gold fundamentals and cross-asset markets, turns them into **gold-specific intelligence**,
builds **conditional pre-event forecasts** from historical analogues, and delivers everything to
Telegram.

**Intelligence only.** No broker, no MT5/NinjaTrader, no orders, no execution logic, no dependency
on any trading platform. Every message ends with "intelligence only, not a trade order".

## Pipeline

```
DATA SOURCES → VALIDATION → NORMALISATION → DEDUP → EVENT CLUSTERING → GOLD RELEVANCE (0-100)
→ IMPORTANCE (0-100: INFORMATIONAL/LOW/MEDIUM/HIGH/CRITICAL) → MARKET CONTEXT
→ 15-CHANNEL GOLD TRANSMISSION → HISTORICAL CONTEXT → PRE-EVENT FORECAST → AI ANALYST
(OpenRouter PRIMARY → SECONDARY → TERTIARY → DETERMINISTIC) → SCENARIOS → TELEGRAM
→ STORAGE (PostgreSQL) → POST-EVENT REVIEW
```

* **Relevance / importance** — keyword taxonomy with false-positive masks, title-dominant evidence,
  source tiers (official → aggregator), corroboration, severity, market sensitivity. Noise caps for
  supervisory notices, local price listings, miner equities, incidental mentions.
* **Transmission** — 15 channels (safe haven, real yields, nominal yields, USD, inflation, monetary policy,
  fiscal policy, liquidity, risk sentiment, central-bank demand, physical demand, energy, trade/supply shock,
  positioning, volatility) with SHORT / TACTICAL / SWING / STRUCTURAL effects; channels with
  both bullish and bearish evidence count as mixed; a headline reporting gold moving *against* the channel
  makes the net pressure MIXED.
* **Desk state** — multi-horizon bias from decayed news + market drivers, regime with hysteresis,
  explicit conflict when headlines contradict a price-confirmed regime, confidence driven by directional
  agreement and price confirmation.
* **Forecast & conditional-scenario engine** — 7 input layers (gold, USD, yields, macro regime,
  geopolitical risk, political state, the event), historical analogue engine (similarity, evidence
  quality, regime match), `pre_event_score` −100…+100 (**not a probability**), deterministic confidence,
  states BULLISH / BEARISH / MIXED / NEUTRAL / UNDETERMINED, scenario support
  STRONG / MODERATE / WEAK / INSUFFICIENT EVIDENCE, forecast memory, updates / invalidations,
  post-event scoring (direction, scenario, market confirmation, timing, error). Weights are **never**
  changed automatically.
* **AI** — interpreter only, schema- and factuality-checked; it can never override the deterministic
  state or confidence (`ai_disagreement` is recorded and shown instead). Usage, tokens (as reported), cost,
  quota states, model health, cache and fallback are tracked and visible in Telegram (`/ai`, `/usage`).
  See [AI_MODELS.md](AI_MODELS.md).
* **Direction and calibrated probability** — per horizon: direction · score (−100…+100) · confidence (0–100),
  plus a BULLISH / BEARISH / NEUTRAL probability **only** from an empirical, walk-forward-validated historical cell
  (≥ `GI_PROB_MIN_SAMPLE` non-overlapping cases); otherwise `PROBABILITY: UNAVAILABLE` with the reason. Score,
  confidence and probability are never derived from one another, and the AI may explain but never create a probability.
  See [docs/CALIBRATION.md](docs/CALIBRATION.md).

## Honest data labels

`GOLD DATA: DIRECT/PROXY`, `USD DATA: PROXY` (DXY formula, never "the DXY"),
`DATA QUALITY: GOOD/PARTIAL/DEGRADED` with reasons, `HISTORICAL REACTIONS: DIRECT/PROXY`.
Missing inputs are shown as `NOT AVAILABLE`; nothing is invented. See [SOURCE_MAP.md](SOURCE_MAP.md).

## Workflows (`workflows/*.json`, fixed ids)

| Workflow | id | Role |
|---|---|---|
| GI · Master Pipeline (news + market) | `giMasterPipeline` | news every 15 min, market/desk every 10 min, 🧪 synthetic event test |
| GI · Pre-Event Engine (forecasts) | `giPreEventEngine` | calendar sync + reconciliation, daily forecasts, refresh/updates/invalidation |
| GI · Post-Event Review | `giPostEventRevw1` | actuals, 4h/24h/3d reaction, forecast scoring, reaction DB |
| GI · Daily Report | `giDailyReport001` | `🥇 XAUUSD DAILY INTELLIGENCE` |
| GI · Health Monitor | `giHealthMonitor1` | component health, job freshness, AI health (model list, provider quota counter, idle-model probes), state-change alerts |
| GI · Telegram Bot (commands) | `giTelegramBot001` | button menu: GOLD NOW · BIGGEST SCENARIOS · TOP NEWS · GEOPOLITICS · POLITICS · MACRO · MARKET STATE · UPCOMING EVENTS · PRE-EVENT BIAS · HISTORICAL PATTERNS · ACTIVE ALERTS · FORECAST REVIEW · AI ANALYSIS · SYSTEM STATUS; AI control center `/ai`, `/usage` |
| GI · AI Analyst (sub-workflow) | `giAiAnalystSub01` | cache → priority/quota gate → OpenRouter router (model-health circuit breaker) + validation; usage/quota recording and alerts; 🧪 router test |
| GI · Telegram Sender (sub-workflow) | `giTelegramSend01` | chunking, retries, dedup, logging, 🧪 test message |
| GI · Error Handler | `giErrorHandler01` | error log + technical alert with cooldown (works without DB) |

Workflow JSON is **generated** from `src/workflows/*.js` + `src/nodes/**` + `src/lib/**`
(`node tools/build-workflows.js`); the library code is bundled into the Code nodes, so the same code
is unit-tested and executed. The running n8n instance is the source of truth; the JSON files are backups.

## Quick start

* Local pilot and Docker 24/7: [DEPLOYMENT.md](DEPLOYMENT.md)
* Server (n8n Web) deployment package: [deploy/n8n-web/README.md](deploy/n8n-web/README.md)
* Telegram bot & message formats: [TELEGRAM.md](TELEGRAM.md)
* Latest verification results: [TEST_REPORT.md](TEST_REPORT.md)
* Scheduled runs + AI fallback health from what the live instance recorded (read-only): `node tools/verify-live.js`

```bash
npm install
npm test                              # unit tests (node:test)
node tools/build-workflows.js         # src -> workflows/*.json
node tools/validate-workflows.js      # structure, versions, ids, connections, expressions, Code syntax, no secrets
```

## Layout

```
src/lib/        engines: taxonomy, classify, scoring, transmission, dedup, desk, market, forecast, history,
                reactions, calendar, analyst, ai, telegram, pricefeeds (+ LZMA for Dukascopy .bi5)
src/nodes/      Code-node bodies per workflow
src/workflows/  workflow definitions (nodes, SQL, connections)
sql/            schema migrations + news sources
seed/           historical reaction DB (362 releases since 2021) + market history
tools/          build/validate, local n8n + PostgreSQL, REST helper, backfill, rescoring, secrets
deploy/         Docker bootstrap scripts
tests/          unit tests
```

## Safety boundaries

* Secrets only in `.env` / the n8n process environment and n8n's encrypted credential store — never in
  workflow JSON, docs, logs or Telegram. Verification shows `CONFIGURED / NOT CONFIGURED` only.
* One OpenRouter key, used as issued; rate limits are respected (no key rotation).
* Test data is flagged `is_test`, never mixed with live events, and removed with `node tools/db.js cleanup-tests`.
