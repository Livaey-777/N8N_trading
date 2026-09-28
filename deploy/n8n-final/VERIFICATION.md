# Verification — Gold Intelligence n8n package

Nothing here is simulated as a result. Each line names where it ran. "Live" means the owner's running instance
with the real Telegram bot and OpenRouter key.

## A. Fresh-import tests of this package — recorded 2026-09-28

Test hosts: clean n8n 1.117.2 + PostgreSQL. There were no real secrets: `.env` held obvious placeholders such as
`TEST-placeholder-not-a-real-token`. The sandbox had no usable internet, since its HTTPS was intercepted, so
Telegram and OpenRouter calls were attempted and failed.

| # | Test | Result | Evidence |
|---|---|---|---|
| A1 | **Docker, credential created in the editor** (random id `NBF9CWGDm7llJUN8`), then `sh import-all.sh` | **PASS** | 8/8 steps, 78 s. All 27 Postgres nodes in 9 workflows re-linked to the editor credential; one credential; 6 active, 3 inactive; 6 schedules registered |
| A2 | Same helper **without** the credential | **PASS (fails safe)** | stopped at step 4 with the instruction, exit 1, **0 workflows imported** |
| A3 | Repeat run over the existing installation | **PASS** | re-import + activation; post-check confirms the content is identical to the package again |
| A4 | **Docker new server**: `docker compose up -d` (bootstrap), then `import-all.sh` | **PASS** | bootstrap imported and activated; helper 8/8 |
| A5 | **Windows local pilot under PowerShell**: `tools/local-pg.js` + `tools/n8n-local.js`, credential created in the editor (random id `6i3SIbLKD7WUSF6N`), then `import-all.ps1` | **PASS** | 8/8 steps, 55 s; 27/27 nodes re-linked; n8n restarted by the launcher; 6 schedules registered |
| A6 | Scheduled runs after import | **PASS** | Health Monitor, Master Pipeline, Pre-Event refresh and Post-Event `trigger` / `success` on the re-linked credential (Docker and local) |
| A7 | Telegram and OpenRouter references | **PASS** | imported bot `/status` → `Telegram: CONFIGURED · OpenRouter: CONFIGURED`; `/ai config` → `OpenRouter key: CONFIGURED`; the Sender made 4 real delivery attempts per message with the configured token |
| A8 | Commands through the imported Telegram Bot workflow | **PASS 54/54** | 30 typed commands + 24 inline buttons → 54 replies; `/start /now /news /biggest /brief /usage /status /ai` all answered; 0 unknown, 0 empty. Delivery `NOT_CONFIGURED` in this part (token unset to avoid network retries) |
| A9 | `/brief` from the imported workflow | **PASS** | exact agreed structure: 🥇 GOLD, REGIME; 📊 NEXT 1 DAY / NEXT 5 DAYS with 🟢 🔴 ⚪ %, Confidence XX/100, Evidence (31/23/46 %, n=247 for 5 days, from the calibration engine); 🧭 BIAS ×4; 🎯 MAIN DRIVER + Counter; 🔥 TOP SCENARIOS 1–3; 📅 NEXT + PRE-EVENT; ✅ MARKET; ⚠️ INVALIDATION; 📡 DATA |
| A10 | Error handling | **PASS** | the only errors were Telegram polling failing on the sandbox's intercepted HTTPS (`self-signed certificate in certificate chain`), all caught by the Error Handler; 19 errors → **1** tech alert (cooldown) |
| A11 | SQL checks on the imported database | **PASS 11/11** | `tools/check-sql.js` (executed, always rolled back) |
| A12 | Secret scan on the imported instance | **PASS** | `verify.sh --secret-scan`: the placeholder token / key / DB password / encryption key appear in no file and in neither database (incl. n8n execution data) |

## B. Repository checks — recorded 2026-09-28

| Check | Result |
|---|---|
| Unit tests `npm test` | **113/113** |
| Workflow validation `node tools/validate-workflows.js` | **9/9 PASSED** (structure, node versions, ids, connections, expressions, Code syntax, references, no embedded secrets) |
| Package audit `sh verify-package.sh` | **PASS** (13 checks; proven to catch injected faults) |
| Secret scan of the full git history (gitleaks 8.28.0 + targeted patterns) | **PASS** — no key, token, password or private key in any commit; `.env` never committed |

## C. On the target instance — checklist after the import

| # | Check | How | Pass when |
|---|---|---|---|
| 1 | Import | `import-all.sh` / `import-all.ps1` | `IMPORT: PASSED` |
| 2 | **First test** | send **`/start`** to the bot | the menu with buttons arrives |
| 3 | Configuration | send `/status` | `Telegram: CONFIGURED · OpenRouter: CONFIGURED`; components listed |
| 4 | Brief | send `/brief` | the agreed structure; percentages or `UNAVAILABLE — <reason>` (never invented) |
| 5 | Commands | `/now`, `/news`, `/biggest`, `/usage`, `/ai` and the menu buttons | every reply arrives; no `409 Conflict` in the n8n log (that would mean a second instance) |
| 6 | Telegram delivery | n8n editor → GI · Telegram Sender → 🧪 Telegram Test → Execute | message on the phone |
| 7 | OpenRouter (one request) | n8n editor → GI · AI Analyst → 🧪 AI Router Test → Execute, once | HTTP 200 from PRIMARY and an `ai_usage` row (`/ai usage`), or a recorded fallback |
| 8 | Errors | `/status` → ERRORS | 0 in the last hour |
| 9 | **Release gate** | after 06:20 and 07:20 Africa/Casablanca: `node tools/verify-live.js --days=2` (local) or `sh deploy/n8n-web/verify.sh --days=2` (server) | PRE_EVENT = PASS, DAILY_REPORT = PASS, PRIMARY HEALTHY, SECONDARY/TERTIARY degradation NONE or TEMPORARY |
| 10 | 24 h soak | the same command the next day | no crashed executions; the second scheduled runs also PASS |

Item 9 is the only part that cannot be tested before the real instance runs. It needs the real bot, the real key
and a real 06:00 / 07:00.
