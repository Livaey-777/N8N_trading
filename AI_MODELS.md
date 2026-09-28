# AI models (OpenRouter)

The AI Analyst is an **interpreter**, never the source of truth. Every number, bias, state and
confidence comes from the deterministic engines. The AI turns them into readable analysis; its
output is validated and anything it cannot support is rejected.

## Model chain

Configured in `.env` → `OPENROUTER_PRIMARY_MODEL`, `OPENROUTER_SECONDARY_MODEL`, `OPENROUTER_TERTIARY_MODEL`
(an empty value falls back to the same position of `GI_AI_MODELS`):

| Rank | Model | Verified (2026-09-28, live pilot) |
|---|---|---|
| PRIMARY | `inclusionai/ling-3.0-flash-fin:free` | listed and free; live HTTP 200 (event analysis, 🔮 BIGGEST SCENARIOS) |
| SECONDARY | `nvidia/nemotron-3-ultra-550b-a55b:free` | listed and free; live HTTP 200 as fallback after a primary 400; upstream 429s / invalid output seen later |
| TERTIARY | `poolside/laguna-s-2.1:free` | listed and free; upstream 429s / invalid output seen |
| FALLBACK | deterministic analyst (`src/lib/analyst.js`) | always available, no network |

This chain is set in `.env.example`. The built-in default in `src/lib/config.js` (used only when neither
`OPENROUTER_*_MODEL` nor `GI_AI_MODELS` is set) is still the earlier chain
(`nvidia/nemotron-3-super-120b-a12b:free`, `google/gemma-4-31b-it:free`, `qwen/qwen3.8-27b:free`); it was left
unchanged so the deployed workflow JSON stays identical to the live-verified build. Always set the variables.
Current per-model health from recorded requests: `node tools/verify-live.js` (sends no request).

Free availability changes without notice. The **Health Monitor re-checks the list hourly** (public
models endpoint, no key needed) and reports `AI: DEGRADED — model(s) no longer available/free`
when one disappears or stops being free; such a model is marked `MODEL_UNAVAILABLE` / `NOT_FREE` and
skipped by the router (the next configured model is used). To change models, edit the `OPENROUTER_*_MODEL`
variables and restart n8n. No code or workflow change is needed.

## Routing (`src/lib/ai.js → routeRequests`)

For each request:

1. **Cache** — an unchanged material context reuses the last analysis (see *Cache*).
2. **Priority gate** — under quota pressure only the more important requests may use the AI (see *Priority*).
3. Skip the AI entirely (deterministic output) when: the request is not eligible, `OPENROUTER_API_KEY` is
   not configured, or a budget is spent: `AI_MAX_REQUESTS_DAY` (default 40), `AI_MAX_REQUESTS_HOUR` (12),
   the provider-reported daily counter, or `AI_MAX_TOKENS_DAY` (0 = no token cap).
4. **Model health** — a model under rate-limit backoff, a daily-quota block (until 00:00 UTC), an open circuit
   breaker (3 consecutive failures → 15 min) or no longer listed / free is skipped without spending a request.
5. Try PRIMARY → SECONDARY → TERTIARY in order. A model is abandoned on the first failure of:
   `TIMEOUT`, `NETWORK_ERROR`, `RATE_LIMITED` (429), `INSUFFICIENT_CREDITS` (402), `AUTH_ERROR` (401/403),
   `MODEL_NOT_FOUND` (404), `MODEL_UNAVAILABLE`, `PROVIDER_ERROR` (5xx or provider error body),
   `EMPTY_CONTENT`, `INVALID_JSON`, `SCHEMA_INVALID`, `FACTUALITY_REJECTED`.
6. If all three fail, the deterministic analysis is used and the message says so
   (`deterministic (<reason>)`).

Every attempt is stored in `ai_usage` (provider, model, key alias, tokens and cost **only as reported by the
provider**, latency, status, fallback level, error type, rate-limit headers, workflow, purpose) and in `ai_runs`
(validation details). Daily (`ai_usage_daily`) and hourly (`ai_usage_hourly`) summaries are maintained with each
request; `ai_model_health` holds the per-model health record. Days and hours are **UTC** buckets, because OpenRouter
resets the free-model counter at 00:00 UTC.

**Quotas are respected.** There is one key, used as issued. The system never rotates keys, creates
accounts or retries around a 429; a rate-limited model is skipped for that request and the next
rank (or the deterministic analyst) is used.

## Eligibility (the AI gateway)

Only events that are simultaneously:
* gold relevance ≥ `GI_AI_MIN_RELEVANCE` (70) **and** importance ≥ `GI_AI_MIN_IMPORTANCE` (70),
* validated (`CONFIRMED_OFFICIAL`, `CORROBORATED` or `SINGLE_SOURCE`), deduplicated, alert-selected,
* at most `GI_AI_MAX_EVENTS_PER_RUN` (2) per run,

plus: up to 2 HIGH-impact pre-event forecasts per daily run (not for plain refreshes), and one daily report.

## Request

* `temperature 0.2`, `max_tokens GI_AI_MAX_TOKENS` (2200), `response_format: json_object`,
  `reasoning: { effort: low, exclude: true }`, timeout `GI_AI_TIMEOUT_MS` (60 s).
* The prompt contains only a compact **facts** object (already-computed scores, channels, market state,
  history statistics, scenarios) and the deterministic result. No secrets, no raw feeds, no personal data.

## Validation of the answer

1. **JSON extraction** (tolerates code fences / leading prose) and **schema validation** (required fields,
   bias vocabulary, lengths).
2. **Factuality guard**: every number in the AI text must exist in the facts (with rounding tolerance);
   quoted text must appear in the facts; trade instructions (`buy` / `sell` / `go long` / `go short` /
   `entry` / `stop-loss` / `take-profit` / `target price` combined with `recommend` / `should` /
   `consider` / `enter`) are rejected. The system prompt also forbids entries, stops, targets and sizing.
3. **Deterministic authority** (`enforceDeterministic`):
   * `confidence` is always the deterministic confidence (the AI's own is kept as `ai_confidence`);
   * displayed biases / forecast state are always the deterministic ones;
   * if the AI's lean differs from the deterministic state, `ai_disagreement = true` and a
     `disagreement_reason` is stored and shown (“AI VIEW DIFFERS”). The AI never overrides the result.

## Usage, quota and alerts

| State | Meaning (defaults `AI_USAGE_WARNING_PERCENT=70`, `AI_USAGE_CRITICAL_PERCENT=90`) |
|---|---|
| HEALTHY | more than 30 % of the limit remaining |
| LOW | 10-30 % remaining — daily-summary requests go deterministic |
| NEAR_LIMIT | under 10 % remaining — only CRITICAL/HIGH events use the AI |
| LIMIT_REACHED | limit used up or the provider rejected with a daily-quota error — deterministic until reset |
| UNKNOWN | no provider counter and no configured limit — no percentage is invented |

Sources, in order of preference: **provider** — `GET /api/v1/key` → `free_model_daily_requests {used, limit, remaining}`
(checked by the Health Monitor every `AI_HEALTH_CHECK_INTERVAL`, plus the requests made since); **configured** —
`AI_MAX_REQUESTS_DAY`, `AI_MAX_TOKENS_DAY`; `AI_MAX_REQUESTS_HOUR` is a burst guard for gating only.
The free-model counter is **per account** (shared by all `:free` models), so every model shows the same capacity.

Telegram alerts (`AI_ALERT`), each **once per state change** with `AI_USAGE_ALERT_COOLDOWN_MIN` against flapping:
⚠️ *AI QUOTA WARNING* (→ LOW / NEAR_LIMIT), 🚫 *AI MODEL LIMIT REACHED*, 🔄 *AI FALLBACK* (primary becomes
DEGRADED / RATE_LIMITED / OFFLINE, or ≥ `AI_FALLBACK_THRESHOLD` fallbacks in an hour). Ordinary one-off fallbacks are
logged silently.

Cost: the provider-reported `usage.cost` (credits) per request; shown as UNKNOWN when not reported, never estimated.

## Priority (spec §26)

CRITICAL event → HIGH event → pre-event forecast → 🔮 biggest scenarios → regime change → user-requested analysis →
daily summary. Status, market values, counts, health checks and menus never spend an AI request.

## Cache

Before a call, a fingerprint of the **material** context is computed: desk regime, event class / confirmation /
net pressure / drivers, forecast state, score (±10) and confidence (±10), consensus, geopolitical / political class,
gold ±0.5 %, USD proxy ±0.3 %, 2Y / 10Y / real 10Y ±5 bp. An identical fingerprint within `AI_CACHE_TTL_MIN` reuses
the stored answer — after re-running the factuality guard against the **current** facts (a cached number that is no
longer true forces a new call) and re-applying the deterministic state and confidence. A new CRITICAL event
invalidates all cached answers. Tests are never cached.

## Health checks

Every `AI_HEALTH_CHECK_INTERVAL` minutes the Health Monitor checks the model list (exists? free? name, context),
the key counter, and — only for models without any traffic for `AI_HEALTH_PROBE_IDLE_HOURS` and only while the quota
is HEALTHY — a tiny probe (max 64 tokens, reply must be `{"ok":true}`). `AI_HEALTH_PROBE=off` disables probes.
Health states: HEALTHY / DEGRADED / RATE_LIMITED / OFFLINE / UNKNOWN (shown as STANDBY when available but unused).

## Keys

`OPENROUTER_API_KEY` lives only in the environment; the database stores a non-secret alias (`AI_KEY_ALIAS`) with
status, last success / failure and the provider counter. **No key rotation**: OpenRouter documents that additional
accounts or API keys do not change rate limits, and switching keys to get around a quota is not permitted here.
When the quota is exhausted and no compliant fallback exists, the system runs deterministically.

## Telegram AI control center

`/ai` (menu with buttons: usage, health, current model, fallback status, configuration, recent failures, forecasts by
model), `/usage` and `/ai_usage` (usage center). `/ai performance` shows forecasts per explaining model — descriptive
only, flagged as insufficient below 20 evaluations, never a ranking.

## Proving the fallback chain

Workflow **GI · AI Analyst (sub-workflow)** → trigger **🧪 AI Router Test** runs three real scenarios
against OpenRouter (nothing mocked):

| Scenario | How | Expected |
|---|---|---|
| Normal | configured chain | PRIMARY answers (or the next rank if PRIMARY is rate-limited) |
| Primary unavailable | PRIMARY replaced by a non-existent model id | genuine `MODEL_NOT_FOUND` / `MODEL_UNAVAILABLE` → SECONDARY answers |
| All unavailable | all three replaced by non-existent ids | three genuine failures → DETERMINISTIC |

The overrides exist only inside the test request; the configured chain is never modified.
Results are stored in `ai_runs` / `ai_usage` with `is_test = true` (they did consume real provider requests, so
the daily summaries keep counting them) and removed by `node tools/db.js cleanup-tests`.
