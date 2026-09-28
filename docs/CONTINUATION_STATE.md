# Continuation state — Gold Intelligence (n8n)

## HANDOFF (read first) — updated 2026-09-28 by a cloud session

**CURRENT STATUS: LOCAL LIVE PILOT VERIFIED · 3 LIVE CHECKS NOT YET VERIFIED · DEPLOYMENT PACKAGE PREPARED
(NOT PRODUCTION-READY)**

Baseline: `05babb7` (the verified local live pilot). The cloud session worked on branch `claude/pensive-ritchie-1tp4df`.
It had **no access to the owner's PC**: only the cloud environment exists, with no bridge to the PC, and the local
n8n and PostgreSQL listen on 127.0.0.1. So the three remaining live checks could not be read from here.
It built a read-only tool that reads them from the live instance and tested it on a throwaway replica.

| Remaining live check | Status | How to verify |
|---|---|---|
| First scheduled PRE_EVENT (06:00 Africa/Casablanca = 05:00 UTC) | **NOT VERIFIED** (no access) | owner: `node tools/verify-live.js` on the PC |
| First scheduled DAILY_REPORT (07:00 Africa/Casablanca = 06:00 UTC) | **NOT VERIFIED** (no access) | same command |
| AI fallback health (PRIMARY / SECONDARY / TERTIARY) | **NOT VERIFIED** (no access). Last recorded state (03:24 UTC): PRIMARY HEALTHY; SECONDARY and TERTIARY DEGRADED (upstream 429 / invalid output) | same command |

**Exact next step.** The owner runs, in the project folder on the PC, with the local n8n + PostgreSQL running:
```
git pull            (or fetch the branch above)
node tools/verify-live.js --days=2
```
and pastes the output. It contains no secret (values are redacted, chat ids and message text are never
selected). It sends no OpenRouter or Telegram request and writes nothing: the sessions are read-only.

**What `tools/verify-live.js` decides:**
* a run counts as scheduled only with n8n `mode = 'trigger'` and a start within −5/+20 min of the slot. A run
  started from the editor through the "⏱ Daily …" trigger also writes a PRE_EVENT_DAILY / DAILY_SCHEDULED job
  row, so the job name alone proves nothing;
* per run: the execution id, n8n status and job row, the forecasts or report stored, the Telegram rows
  (SENT + message id) and duplicates (the same dedup key SENT twice, or two scheduled runs in one slot);
* no slot run: it tells "n8n was not running at the slot" (no trigger executions within ±30 min) apart from
  "the trigger did not fire";
* PRE_EVENT with nothing due inside the 36 h lookahead: an empty run is correct and reads
  `PASS (nothing due)`; forecast delivery is then not exercised by that run;
* per model: successes and failures, last success and last failure, failure types, rate-limit evidence
  (HTTP 429, headers, retry-after), fallback use, the health record, the current health (the same
  `modelHealth()` as `/status`) and the degradation (NONE / TEMPORARY / PERSISTENT / UNDETERMINED, with the
  rule applied).

Owner actions still open: regenerate the Telegram bot token and the OpenRouter key (pasted in a chat), after the
checks. Then decide the server (§ n8n Web below).

### Cloud replica test (2026-09-28 16:10–17:10 UTC) — supporting evidence, NOT the live checks

This was a throwaway `docker compose -p gi-replica` stack in the cloud container, built from this repository. It
had no Telegram/OpenRouter secrets and no internet: the sandbox proxy is reachable from the host only, so the data
sources failed and were handled as DEGRADED. Replica-only settings:
* `GI_PREEVENT_DAILY_HOUR=18` and `GI_DAILY_REPORT_HOUR=18`;
* `GI_PREEVENT_LOOKAHEAD_HOURS=48`;
* one `macro_releases` fixture: PCE on 30 Sep 12:30 UTC, the time recorded by the live BEA calendar.

| Check | Result | Evidence |
|---|---|---|
| Scheduled PRE_EVENT path | **PASS except delivery** | execution #117 `mode=trigger` `success` at 17:00:19 UTC (= 18:00 Africa/Casablanca) → job PRE_EVENT_DAILY; due 1 → forecast #1 PCE stored (UNDETERMINED: calendar unverifiable offline, reason recorded); message composed + logged; Telegram `NOT_CONFIGURED` (no token in the replica) → the tool correctly reports FAIL. Refresh #113 at the same minute was told apart and not counted |
| Scheduled DAILY_REPORT path | **PASS except delivery** | execution #124 `trigger` `success` at 17:00:45 UTC → job DAILY_SCHEDULED OK; report analysis #7 stored; calibration rebuilt: 66 cells, 24 CALIBRATED (same as the live pilot); Telegram `NOT_CONFIGURED` → FAIL (correct) |
| Duplicates / errors | PASS | no duplicate dedup key SENT, one scheduled run per slot, 0 error_events, every execution `success` |
| `tools/verify-live.js` | PASS | correct verdicts on real trigger executions; manual / refresh runs excluded; 0 false redactions after a fix |
| Rollback R1 (re-import) | PASS after a doc fix | **`n8n import:workflow` deactivates the imported workflow** (active t → f, verified). Re-activation + restart → all 6 active. DEPLOYMENT.md's update command lacked the re-activation and would have stopped every schedule; fixed |
| Rollback R2 (restore) | PASS | `backup.sh` → 2 non-empty dumps; restore → forecasts 1→0, job rows 14→1, executions 39→3 (the 16:25 state), 362 reactions, 6 workflows re-activated, Health ran on schedule at 17:05 |
| Secret scan in the Compose network | PASS | `verify.sh --secret-scan`: CLEAN (files + both databases) |
| Memory | info | n8n ≈ 300 MB, PostgreSQL ≈ 70 MB after the 17:00 burst |

Defects found and fixed in this session (deployment and tooling only; no workflow or engine change, and the
workflow JSON is byte-identical to the live-verified build):
1. `docker-compose.yml`: n8n crash-looped on a host without IPv6 ("n8n's address '::' is not available") →
   `N8N_LISTEN_ADDRESS=0.0.0.0`, still published on 127.0.0.1 only.
2. `docker-compose.yml`: the image can be overridden (`N8N_IMAGE`), because `docker.n8n.io` was unreachable from
   the test host; Docker Hub `n8nio/n8n:1.117.2` worked.
3. `.env.example` still named the earlier model chain (nemotron-super / gemma / qwen). A server built from it would
   not run the verified chain → now Ling / Nemotron Ultra / Laguna. `AI_MODELS.md` updated; the fallback string in
   `src/lib/config.js` was left unchanged on purpose (changing it would regenerate all 9 workflow files).
4. DEPLOYMENT.md's "update workflows from files" command left every workflow inactive (see R1) → fixed.
5. `tools/db.js` honours `GI_PG_HOST` / `GI_PG_PORT` from the process environment (Compose network). `tools/secret-scan.js`
   skips `backups/` (compressed dumps, not text). `backups/` is git-ignored.

Tests: `npm test` **109 / 109** (105 + 4 for the verification tool). `node tools/validate-workflows.js` PASSED.
Rebuilding the workflows leaves no diff.

### n8n Web deployment package

Runbook: [deploy/n8n-web/README.md](../deploy/n8n-web/README.md). It covers the target, the 9 workflows with their
import order and method, the credential placeholders, database requirements, deployment steps with cutover,
a verification checklist, rollback R1–R3 and operations. It adds `backup.sh`, `verify.sh` and
`credentials.template.json`.

Two decisions are recorded there:
* "n8n Web" = **self-hosted n8n 1.117.2 on a VPS**, with the editor over HTTPS.
* **n8n Cloud is not supported as-is**:
  * 35 Code nodes read secrets and settings from `$env`;
  * workflow ids are fixed;
  * the schedules start about 105 000 executions per 30 days, 86 400 of them from the 30 s bot poll.

Only one instance may run the schedules at a time: stop the local pilot before the server starts.

## Previous handoff (2026-09-28 03:30 UTC, local session)

Repository: https://github.com/Livaey-777/N8N_trading (branch `main`). Verified baseline commit:
`05babb79a0625f2dc4cab0e6b4aa424d092bf68c`.

**VERIFIED (live, local n8n 1.117.2 + PostgreSQL):**
- infrastructure: n8n, PostgreSQL;
- AI: OpenRouter, the AI router, the fallback chain, calibration;
- Telegram: BIGGEST SCENARIOS (with a real AI explanation), /now, /news, /start, /usage, /status.

**Checks at handoff:**
- `npm test`: 105 / 105 pass.
- `node tools/validate-workflows.js`: PASSED (9 workflows, no embedded secrets).
- `node tools/check-sql.js`: 11 / 11.
- Secret scan CLEAN (`node tools/secret-scan.js`), covering the files, logs and both databases.
- Pre-push scan: no `.env` credential value in any committed file. `.env`, `runtime/` and `node_modules/` are git-ignored.

**REMAINING:**
1. The first real scheduled PRE_EVENT run (daily 06:00 Africa/Casablanca).
2. The first real scheduled DAILY_REPORT run (daily 07:00 Africa/Casablanca).
3. Final AI fallback health verification: SECONDARY / TERTIARY were DEGRADED after upstream 429s / invalid output, and PRIMARY is HEALTHY.
4. Credential regeneration: the owner revokes the Telegram bot token (BotFather /revoke) and the OpenRouter key that were pasted in chat, then sets new ones with `tools\set-secrets.ps1`.
5. n8n Web deployment (server; Docker Compose smoke-tested PASS, see DEPLOYMENT.md).

**Exact next step for a new Claude session.** Secrets are not in the repository. The owner enters them locally; never
print, echo or commit them.
1. Clone the repository and run `npm install`.
2. Run `npm test`, expecting 105 / 105.
3. Set up the local environment, following DEPLOYMENT.md:
   - `node tools/setup-local.js`
   - owner: `powershell -ExecutionPolicy Bypass -File tools\set-secrets.ps1`
   - `node tools/db.js migrate`
   - `node tools/db.js seed-history`
   - `node tools/n8n-local.js start`
4. `node tools/build-workflows.js`, then import or push the workflows.
5. Then continue with REMAINING item 3 (AI fallback health) and items 1–2 (scheduled runs).

---

Last updated: 2026-09-28 03:30 UTC. Status: **READY (local live pilot)** — every acceptance condition met: real OpenRouter
request, usage tracking, real Telegram delivery and inbound commands/buttons from the owner's phone, 🔮 BIGGEST SCENARIOS with a
real AI explanation, multi-horizon direction + calibrated probability verified in delivered Telegram output, full regression green.
Not yet done: a server (VPS) deployment, and the first *scheduled* Pre-Event (06:00) and Daily Report (07:00, Africa/Casablanca) runs.

## Completed

| Area | Files |
|---|---|
| Storage: `ai_usage`, `ai_usage_daily`, `ai_usage_hourly`, `ai_model_health`, `ai_api_keys`, `ai_cache`; forecast AI columns; views `forecast_ai_usage`, `forecast_performance_by_model` | `sql/004_ai_usage.sql` (applied) |
| Config: `OPENROUTER_{PRIMARY,SECONDARY,TERTIARY}_MODEL` (fallback `GI_AI_MODELS`), `AI_MAX_REQUESTS_DAY/HOUR`, `AI_MAX_TOKENS_DAY/REQUEST`, `AI_USAGE_WARNING/CRITICAL_PERCENT`, `AI_FALLBACK_THRESHOLD`, `AI_HEALTH_CHECK_INTERVAL`, `AI_HEALTH_PROBE(_IDLE_HOURS)`, `AI_CACHE_TTL_MIN`, `AI_USAGE_ALERT_COOLDOWN_MIN`, `AI_DAILY_REPORT_SECTION`, `AI_KEY_ALIAS`, `AI_BOT_TIMEOUT_MS` | `src/lib/config.js`, `.env.example` |
| Engine: priorities, priority gate, error types, quota states (provider counter preferred, UNKNOWN without a limit), model-health state machine + circuit breaker, cache fingerprint + re-validation, alert state machine (one per transition + cooldown), AI system status | `src/lib/aiusage.js` |
| Router: skips unhealthy models without spending a request, records tokens / cost / rate-limit headers / fallback level, raw output kept for the cache, per-request timeout / max attempts | `src/lib/ai.js` |
| AI Analyst sub-workflow: Prepare → Load AI State → Router → Record AI Usage → (alert → Telegram) → Return | `src/workflows/ai-analyst.js`, `src/nodes/ai/{prepare,router,return,alert-payload}.js`, `src/workflows/shared/ai-sql.js` |
| Health Monitor: AI Health Check (model list, `GET /api/v1/key` counter, idle-model tiny probes, quota, alerts) + Record AI Health; health alert now on state change + 6×cooldown reminder | `src/workflows/health.js`, `src/nodes/health/{ai-check,evaluate,alert-payload}.js` |
| Telegram: inline keyboards (sender), callback queries (normalised in `normaliseUpdates`, answered, authorised chats only), immediate offset confirmation | `src/lib/telegram.js`, `src/nodes/bot/get-updates.js`, `src/nodes/bot/simulate.js` |
| Telegram menu (14 required entries + AI) and views: TOP NEWS, MARKET STATE, PRE-EVENT BIAS, HISTORICAL PATTERNS, ACTIVE ALERTS (grouped), FORECAST REVIEW, AI ANALYSIS | `src/lib/telegram-menu.js`, `src/nodes/bot/build-replies.js` |
| AI control center: `/ai` (+ usage / health / model / fallback / config / failures / performance), `/usage`, `/ai_usage`, AI alerts | `src/lib/telegram-ai.js` |
| 🔮 BIGGEST SCENARIOS: deterministic ranking, AI only explains (bot → AI Analyst → merge) | `src/lib/biggest.js`, `src/nodes/bot/{ai-payload,merge-ai,outgoing}.js`, `src/workflows/telegram-bot.js` |
| Daily report 🤖 AI HEALTH section (auto / always / never) | `src/workflows/daily.js`, `src/nodes/daily/{build,compose}.js` |
| Forecast AI tracking (provider, model, fallback level, tokens, latency, status) | `src/nodes/preevent/compose.js`, `src/workflows/pre-event.js` |
| Alert dedup fix: NOT_CONFIGURED / duplicate deliveries mark the event as alerted (FAILED still retries) | `src/nodes/master/record-payload.js` |
| SQL execution checker (rolled back) | `tools/check-sql.js` |
| Docs | `AI_MODELS.md`, `TELEGRAM.md`, `README.md`, `DEPLOYMENT.md`, `TEST_REPORT.md`, `docs/CALIBRATION.md`, this file |
| Multi-horizon direction + calibrated probability (see below) | `src/lib/{calibration,direction,telegram-direction}.js`, `sql/005_calibration.sql`, `src/nodes/daily/calibration.js`, `src/workflows/shared/calibration-sql.js`, `tools/calibrate.js` |

## Current tests (2026-09-28)

* Latest (2026-09-28 03:30 UTC): `npm test` **105 / 105**, validate PASSED (9 workflows), `check-sql` **11 / 11**, secret scan CLEAN.
* Earlier: `npm test`: **86 / 86 pass** (18 new in `tests/ai-usage.test.js`: priorities/gates, error types, quota thresholds,
  provider-counter preference, model health/backoff/circuit breaker, router fallback with tokens/cost/headers, skip
  without request, max attempts, cache fingerprint + reuse/expiry/critical/stale facts, alert transitions + cooldown +
  fallback threshold, model config, usage views without secrets, menu completeness + callback limits, biggest
  ranking determinism, keyboard on last chunk, callback normalisation, alerts grouping, daily section).
* `node tools/validate-workflows.js`: PASSED (9 workflows, no embedded secrets).
* `node tools/check-sql.js`: 7 / 7 queries execute against the real database (rolled back).
* n8n (local, without secrets): AI Router Test → deterministic fallback recorded (`ai_usage`, daily summary);
  Health Check → model list verified (all 3 listed + free, display names), key NOT_CONFIGURED, AI component
  NOT_CONFIGURED; Synthetic Event Test OK; bot simulation of 31 commands + 3 button presses → 34 replies, inbound
  logged as COMMAND / BUTTON; Pre-Event Test → forecast #7 with `ai_status = DETERMINISTIC:NOT_CONFIGURED`;
  Daily Report Test → AI section correctly omitted (auto, not configured).
* Secret scan of the repository: only a fake token inside a redaction test fixture.

## Docker smoke test (2026-09-28) — PASS (after 2 fixes)

Separate Compose project `gi-smoke`, throwaway `.env` (random DB password + encryption key, no API secrets),
`env_file` reset so the real `.env` is never read. Host port **5690** — the planned port 5679 is occupied by the
**live n8n's internal task-runner broker** (PID 26292 listens on 5678 and 5679), so it could not be used.
Override and throwaway env live in the session scratchpad, not in the repository. Stack removed afterwards.

| Check | Result | Evidence |
|---|---|---|
| 1. PostgreSQL starts | **PASS** | healthy; init applied 001/002/003/004/010 SQL, loaded both seeds (362 reactions, 6 135 market, 2 156 gold rows, 0 future-dated) |
| 2. n8n starts | **PASS** | container healthcheck healthy, `/healthz` 200 on 127.0.0.1:5690 |
| 3. Isolated from live :5678 | **PASS** | own network/volumes; DB host `postgres` (compose network); live n8n PID 26292 unchanged, live `/healthz` 200 throughout |
| 4. Real `.env` not read | **PASS** | sha256 + mtime unchanged; container DB password and encryption key equal the throwaway values; no Telegram/OpenRouter/FRED variables in any container |
| 5. Workflows load / run | **PASS** | bootstrap imported 1 credential + 9 workflows, 6 activated; scheduled Health Monitor and Master Pipeline (market) executions **succeeded** in Docker, writing to the smoke DB (MARKET job OK, 19 health rows, 3/3 AI models listed) |
| 6. No live data / instance modified | **PASS** | live workflows identical to the baseline (id, active, versionId, updatedAt); live pipeline kept running (last MARKET OK); unrelated `apppmta-*` containers untouched |

Defects found and fixed by the smoke test:
1. `deploy/n8n-bootstrap.sh`: BusyBox `mktemp` rejects a suffix after `XXXXXX` → template changed; the script now
   refuses to create the Postgres credential when `GI_PG_PASSWORD` is empty.
2. `docker-compose.yml`: `GI_PG_DATABASE/USER/PASSWORD` reached the bootstrap only through `env_file`, so the
   credential could be created without a password ("client password must be a string") → now passed explicitly.

Observations (not failures):
* This project folder lives under the Claude app's **virtualised** `AppData\Roaming` path; Docker Desktop resolves
  bind mounts to the real path, where the files are not. Compose must be run with
  `--project-directory <physical LocalCache path>` here (or from a normal folder on a server). The first attempt
  without it mounted empty directories and was discarded.
* That first attempt made Docker create **six empty placeholder directories** at the real path
  `C:\Users\hp\AppData\Roaming\Claude\scratch-workspaces\…\scratch-2026-09-26-b63388\`: `deploy/`,
  `deploy/n8n-bootstrap.sh/`, `deploy/postgres-init/`, `deploy/postgres-init/01-init.sh/`, `seed/`, `sql/`,
  `workflows/` (all empty). Removing them was blocked by the permission classifier; they do not affect the project
  files (the working copy is intact). The owner may delete them.
* n8n logged "Task runner connection attempt failed with status code 403" a few times at start-up before the runner
  registered; Code nodes then executed normally (same timing warnings exist on the live instance).
* First bootstrap takes several minutes (each `n8n update:workflow` boots the CLI).

## Live integration (2026-09-28)

Credentials: OPENROUTER_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID — CONFIGURED in `.env` (git-ignored; values never
printed). Model chain (`OPENROUTER_*_MODEL`): inclusionai/ling-3.0-flash-fin:free → nvidia/nemotron-3-ultra-550b-a55b:free →
poolside/laguna-s-2.1:free → deterministic (all listed and free on 2026-09-28).

| Check | Result | Evidence |
|---|---|---|
| n8n | PASS | readiness 200 after restart; 6 schedules active |
| Code nodes in-process | PASS | owner decision: `N8N_RUNNERS_ENABLED=false` locally (runner handshake failed with 403 under memory pressure: CPU 100 %, 0.5 GB free); 0 runner 403s since; Error Handler, bot and pipeline Code nodes execute |
| Stuck executions | PASS | marked crashed/canceled by n8n; 11 recovery error runs → exactly 1 TECH_ALERT sent (cooldown), no duplicate alerts |
| Telegram connectivity | PASS | getMe ok (bot identity verified; username not recorded in the public repository) |
| Telegram delivery | PASS | 🧪 Telegram Test message SENT (message id returned); TEST_ALERT, AI_ALERT, TECH_ALERT also delivered |
| OpenRouter (real) | PASS | synthetic CRITICAL event → PRIMARY ling-3.0-flash-fin HTTP 200, 5 850 ms, 1 449 in / 1 902 out / 3 351 tokens, cost 0 (provider-reported), fallback level 0, schema + factuality OK; AI summary delivered in the test alert |
| Fallback (real errors) | PASS | invalid primary → HTTP 400 → SECONDARY nemotron-3-ultra HTTP 200, 1 935 tokens, fallback level 1; all invalid → 3 × 400 → DETERMINISTIC |
| Provider quota counter | PASS | GET /api/v1/key: 5 / 50 free-model requests (UTC day) at 02:11, quota HEALTHY |
| Usage tracking | PASS | ai_usage, ai_usage_daily, ai_usage_hourly, model health, key status populated; tokens only when reported |
| Duplicate protection | PASS | AI_ALERT: 1 SENT, 2 SKIPPED_DUPLICATE |
| Secret scan | PASS | `node tools/secret-scan.js`: CLEAN (files, logs, gold_intel + n8n databases incl. execution data); .env and runtime/ git-ignored |
| BIGGEST SCENARIOS (AI) | PASS | 03:16 UTC: PRIMARY ling-3.0-flash-fin HTTP 200, 3 288 tokens, 4.7 s, `ai_usage` workflow=bot, event_type=BIGGEST, SUCCESS; delivered reply (2 parts, Telegram message id returned) ends with "🤖 AI EXPLANATION (inclusionai/ling-3.0-flash-fin:free)". Before that the hourly guard (12/h) correctly kept it deterministic |
| /start, buttons, /usage, /ai, /now from the phone | PASS | owner used the real bot 02:32–02:54 UTC: /now, /ai, AI-usage button, /start, news buttons, /analysis, /biggest — inbound COMMAND/BUTTON rows logged, every reply SENT |

Defects found live and fixed (rebuilt, pushed): (1) `response_format` sent to models that do not support structured
outputs → provider 400; now only sent when the model list says supported. (2) reasoning tokens exhausted the completion
budget → reasoning off by default (`AI_REASONING`), cap 3 000 tokens. (3) "does not support feature" 400 misclassified as
MODEL_UNAVAILABLE (1 h bench) → API error; provider error text kept (redacted). (4) Health Monitor overwrote router counters
(race) → metadata-only writes; stale ranks cleared. (5) `counter_driver: null` rejected → normalised to NONE (other nulls
still rejected). (6) fallback reasons shown in plain language.

Operational finding: on the free tier the three models are often rate-limited upstream (HTTP 429) or return answers that
fail validation (e.g. invented historical dates rejected by the factuality guard); together with the hourly cap, many event
analyses fall back to the deterministic engine. Options for the owner: raise AI_MAX_REQUESTS_HOUR (within the 50/day
provider limit), choose other free models, or buy ≥ 10 OpenRouter credits (1 000 free requests/day).

## Multi-horizon direction + calibrated probability (2026-09-28)

Method, thresholds and results: [docs/CALIBRATION.md](CALIBRATION.md). Score, confidence and probability are separate; a
probability is shown only from a CALIBRATED cell (≥ GI_PROB_MIN_SAMPLE = 20 non-overlapping cases + walk-forward validation),
otherwise `PROBABILITY: UNAVAILABLE` with the reason. The AI receives the cells as facts and may not create or change them.

| Check | Result | Evidence |
|---|---|---|
| Calibration cells | PASS | 66 cells stored (24 CALIBRATED); rebuilt by the Daily Report and `node tools/calibrate.js` |
| Tests | PASS | `npm test` 105 / 105 (the 12 requested cases + pooled fallback, no look-ahead, consistency line, combined reasons, short-form reasons) |
| /now (delivered) | PASS | regime; tactical BEARISH · score −24 · confidence 75; countertrend interpretation; tactical P 31 / 23 / 46 (n=248, WEAK) conditioned on market state BEARISH; "⚖️ The calibrated history does NOT confirm the BEARISH lean"; drivers, confirmation, invalidation; GOLD DIRECTION DESK with per-horizon market state; swing "unavailable (failed walk-forward validation)", structural "unavailable (only 17 cases)" |
| /biggest (delivered) | PASS | per scenario: first-hours / 3-day conditional probability (e.g. BEARISH 23/54/23, n=49, pooled inflation, MODERATE) separate from "Rank score … ordering weight, not a probability"; UNAVAILABLE reasons cover PCE and the pooled family; real AI explanation |
| /analysis, /ai, /start, buttons, /history PCE, /review | PASS | delivered (message ids returned); owner's own phone use logged |

Defects fixed in this step:
- **Direction vs probability:** a direction and a probability pointing different ways were not reconciled. There is now an explicit consistency line.
- **Market state:** the market state behind each desk probability was not named. It is now.
- **UNAVAILABLE reasons:** these now cover the event type and its pooled family, and use "past releases" wording.
- **Desk box:** the short form now says why a probability is unavailable.
- **Evidence text:** a missing space in the analogue text ("cases,80%") is fixed.
- **Error handler (live finding):** n8n re-reports crashed executions after every restart. The same crashed runs were stored twice, which kept /status DEGRADED for an hour after a restart. There is now one record and one alert per execution (verified: a replay returns `duplicate=true` and records nothing).
- **/status wording:** it said "never ran (activate the workflow)" for active daily jobs that had not reached their first scheduled hour. It now says "no scheduled run yet — runs daily at 06:00 / 07:00 (Africa/Casablanca)".

## Current state of /status (03:24 UTC)

OVERALL DEGRADED only because the free SECONDARY and TERTIARY models failed earlier (upstream 429 / invalid output). PRIMARY is
HEALTHY again; ERRORS OK (0 in the last hour); pipelines, market data, Telegram, database OK. DAILY_REPORT / PRE_EVENT: no scheduled
run yet (first at 07:00 / 06:00 Africa/Casablanca).

## Remaining (updated 2026-09-28, cloud session)

1. **Owner: run `node tools/verify-live.js --days=2` on the PC** and paste the output. It verifies the first scheduled
   PRE_EVENT (06:00) and DAILY_REPORT (07:00, Africa/Casablanca) runs and the AI fallback health from recorded data.
   If the PC or n8n was off at a slot, the tool says so; the next slot is the next day.
2. Fix only real defects the output shows; otherwise stop changing core logic.
3. Owner: regenerate the credentials that were pasted into the chat (BotFather /revoke → new token; new OpenRouter key), then
   `tools\set-secrets.ps1` and `node tools/n8n-local.js restart`. Never add a second key to raise quota.
4. Optional capacity: free models are often rate-limited upstream; raise AI_MAX_REQUESTS_HOUR within the 50/day provider limit,
   choose other free models, or buy ≥ 10 OpenRouter credits (1 000 free requests/day).
5. Server deployment with [deploy/n8n-web/README.md](../deploy/n8n-web/README.md) (self-hosted VPS). Checklist items 10–12 must
   pass on the server before it is called production-ready.
6. Owner may delete the six empty Docker placeholder directories (see Docker smoke test).

## Exact next action

Owner runs `node tools/verify-live.js --days=2` on the PC (local n8n + PostgreSQL running) and shares the output.
A new Claude session reads the SUMMARY block: PRE_EVENT / DAILY_REPORT = PASS · PASS (nothing due) · FAIL · NOT VERIFIED,
and one line per AI model with its current health and degradation (TEMPORARY / PERSISTENT).
