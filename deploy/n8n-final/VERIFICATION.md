# Verification — Gold Intelligence n8n package

Nothing here is simulated as a result. Each line names where it ran. **"Live" means the owner's running instance.**
The cloud test stacks (throwaway n8n 1.117.2 + PostgreSQL 16, no secrets, no internet) prove the code paths and
the package, not live delivery.

## A. Release gate — must pass on the running instance

The gate is recorded from `node tools/verify-live.js --days=2` (local pilot) or `sh deploy/n8n-web/verify.sh` (server).

| # | Check | Pass when | Status |
|---|---|---|---|
| A1 | First scheduled PRE_EVENT (06:00 Africa/Casablanca) | `PRE_EVENT = PASS` (n8n `trigger` execution at the slot, job row, forecasts stored, Telegram SENT with a message id, no duplicate), or `PASS (nothing due)` | **PENDING** — not readable from the cloud session |
| A2 | First scheduled DAILY_REPORT (07:00) | `DAILY_REPORT = PASS` (trigger execution, report stored, one Telegram delivery, calibration rebuilt) | **PENDING** |
| A3 | AI fallback health | PRIMARY HEALTHY; SECONDARY / TERTIARY degradation `NONE` or `TEMPORARY` (`PERSISTENT` → replace that model in `.env`) | **PENDING** — last recorded 03:24 UTC: PRIMARY HEALTHY, SECONDARY/TERTIARY DEGRADED (upstream 429 / invalid output) |
| A4 | Real Telegram delivery of `/brief` | `/brief` from the phone → reply in the agreed format | **PENDING** (composed and verified in the workflow, B5) |
| A5 | Real OpenRouter request after key regeneration | 🧪 AI Router Test once → HTTP 200 + `ai_usage` row | **PENDING** (verified live on 2026-09-28 03:16 UTC with the old key) |

Record the verify-live SUMMARY here when A1–A3 pass.

## B. Package and regression — recorded 2026-09-28 (cloud session)

| # | Check | Result | Evidence |
|---|---|---|---|
| B1 | Unit tests (`npm test`) | **PASS 113/113** | 105 baseline + 4 verify-live + 4 `/brief` |
| B2 | Workflow validation (`node tools/validate-workflows.js`) | **PASS 9/9** | JSON, node types/versions, ids, connections, no orphans, expressions, Code syntax, references, no embedded secrets |
| B3 | SQL execution (`node tools/check-sql.js`, fresh PostgreSQL 16) | **PASS 11/11** | all rolled back; the checker now seeds its own fixtures, and asserts the Error Handler replay dedup (`duplicate=true`, `send=false`) |
| B4 | Package audit (`sh verify-package.sh`) | **PASS 13/13** | also catches injected faults: broken reference, local path, token, key, checksum |
| B5 | Bot commands through the real Telegram Bot workflow (n8n execution #32) | **PASS 55/55** | 31 typed commands (incl. `/start /now /news /biggest /brief /usage /status /ai`, `/ai *`, `/brief@Bot`) + 24 inline-button callbacks → 55 replies composed and logged; 0 unknown, 0 empty, 0 errors. Delivery `NOT_CONFIGURED` (no token in the test stack) |
| B6 | `/brief` format | **PASS** | every agreed section, in order; NEXT 1 DAY / NEXT 5 DAYS percentages only from CALIBRATED cells (e.g. 31/23/46, n=247, same as the live `/now`); confidence shown as `/100`, never %; UNAVAILABLE with the reason otherwise; 3 top scenarios with conditional probability only when calibrated; ≈1.9 k chars, one message; no trade execution language |
| B7 | Package import (Path B, fresh instance) | **PASS** | 9 CLI imports (ids kept, all inactive) → credential after the workflows (27/27 Postgres nodes linked) → references 12/12 calls + 8/8 error links → 6 activated → 6 schedules registered → scheduled Master 17:40:00 and Health 17:40:34 UTC `success` → 🧪 Telegram Test and 🧪 AI Router Test `success` → 0 errors |
| B8 | Scheduled daily paths (earlier replica, trigger mode at 18:00 local) | **PASS up to delivery** | PRE_EVENT #117 → forecast stored; DAILY_REPORT #124 → report + 66 calibration cells (24 CALIBRATED) |
| B9 | Backup / restore | **PASS** | `backup.sh` → restore → state at backup time, schedules resumed |
| B10 | Secret scan, full git history (gitleaks 8.28.0 + targeted patterns) | **PASS** | no leaks in any commit; `.env` / `runtime/` never committed; no OpenRouter key, Telegram token, database URL with password or private key |
| B11 | Secret scan, files + both databases (`verify.sh --secret-scan`) | **PASS** | CLEAN |

## C. Checklist on the target instance (in order)

| # | Check | How | Pass when |
|---|---|---|---|
| 1 | Package | `sh verify-package.sh` | PACKAGE CHECK: PASSED |
| 2 | Database | [DATABASE.md](DATABASE.md) §3 | 27 tables, 5 views, 362 reactions |
| 3 | Import | [IMPORT_ORDER.md](IMPORT_ORDER.md) steps 1–3 | 9 ids, credential GIpostgresCred01, references 20/20 |
| 4 | Activation | IMPORT_ORDER.md steps 4–5 | six `Activated workflow` lines; Health and Master `trigger/success` |
| 5 | Secrets configured | Telegram `/status` | Telegram and OpenRouter `CONFIGURED` |
| 6 | Telegram delivery | editor → GI · Telegram Sender → 🧪 Telegram Test | arrives on the phone; `telegram_messages` row `SENT` with a message id |
| 7 | Commands | from the phone: `/start`, `/brief`, `/now`, `/news`, `/biggest`, `/status`, `/usage`, `/ai` + menu buttons | every reply arrives; no `409 Conflict` in the n8n log |
| 8 | OpenRouter (one request) | editor → GI · AI Analyst → 🧪 AI Router Test, once | HTTP 200 from PRIMARY and an `ai_usage` row, or a recorded fallback |
| 9 | Errors | `/status` → ERRORS | 0 in the last hour; any alert arrives once |
| 10 | Secrets | `sh deploy/n8n-web/verify.sh --secret-scan` | CLEAN |
| 11 | **Release gate** | after 06:20 and 07:20 Africa/Casablanca: `sh deploy/n8n-web/verify.sh --days=2` | A1–A3 PASS → production-ready |
| 12 | 24 h soak | the same command the next day | no crashed executions; the second scheduled runs also PASS |
