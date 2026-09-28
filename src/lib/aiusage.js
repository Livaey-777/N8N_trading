'use strict';
/**
 * AI usage / quota monitoring: request priorities, quota states, error types, model health,
 * the router's circuit breaker, the AI result cache and the usage-alert state machine.
 *
 * Honesty rules:
 *  - token / cost figures come only from provider responses (null = unknown, never estimated);
 *  - a quota percentage exists only for a provider-reported limit (GET /api/v1/key) or a limit
 *    configured in .env; otherwise the state is UNKNOWN;
 *  - no API-key rotation: OpenRouter governs capacity per account, extra keys add no capacity.
 */
const { hashOf, round } = require('./util');
const { factualityGuard, enforceDeterministic } = require('./ai');

const LEVEL_LABEL = ['PRIMARY', 'SECONDARY', 'TERTIARY', 'DETERMINISTIC'];
const DETERMINISTIC_LEVEL = 3;

// §26 priority (1 = most important). TEST requests are exempt from the priority gate.
const PRIORITY = { TEST: 0, CRITICAL_EVENT: 1, HIGH_EVENT: 2, PRE_EVENT: 3, BIGGEST: 4, REGIME: 5, USER_DEEP: 6, DAILY: 7 };
const PRIORITY_LABEL = Object.fromEntries(Object.entries(PRIORITY).map(([k, v]) => [v, k]));

function requestPriority(req) {
  const p = String(req.purpose || '').toUpperCase();
  if (req.is_test || p === 'TEST') return PRIORITY.TEST;
  if (p === 'EVENT') return req.facts && req.facts.event && req.facts.event.importance_class === 'CRITICAL' ? PRIORITY.CRITICAL_EVENT : PRIORITY.HIGH_EVENT;
  if (p === 'PRE_EVENT') return PRIORITY.PRE_EVENT;
  if (p === 'BIGGEST') return PRIORITY.BIGGEST;
  if (p === 'REGIME') return PRIORITY.REGIME;
  if (p === 'DAILY') return PRIORITY.DAILY;
  return PRIORITY.USER_DEEP;
}

/** Which priorities may still use the AI at a given account quota state. */
function priorityAllowed(priority, state) {
  if (priority === PRIORITY.TEST) return state !== 'LIMIT_REACHED';
  if (state === 'LIMIT_REACHED' || state === 'OFFLINE') return false;
  if (state === 'NEAR_LIMIT') return priority <= PRIORITY.HIGH_EVENT;
  if (state === 'LOW') return priority <= PRIORITY.USER_DEEP;
  return true;
}

/** Normalised error type for a router failure reason (spec: TIMEOUT / RATE LIMIT / API ERROR / INVALID OUTPUT / OFFLINE). */
function errorTypeOf(reason) {
  const r = String(reason || '');
  if (!r) return null;
  if (/free-models-per-day|per[- _]day|daily limit|quota/i.test(r) || /^INSUFFICIENT_CREDITS/.test(r)) return 'QUOTA_EXHAUSTED';
  if (/^RATE_LIMITED|rate limit|429/i.test(r)) return 'RATE_LIMIT';
  if (/^TIMEOUT/.test(r)) return 'TIMEOUT';
  if (/^NETWORK_ERROR/.test(r)) return 'OFFLINE';
  if (/^BAD_REQUEST/.test(r)) return 'API_ERROR';
  if (/^MODEL_NOT_FOUND|^MODEL_UNAVAILABLE|no endpoints found|not a valid model/i.test(r)) return 'MODEL_UNAVAILABLE';
  if (/^AUTH_ERROR/.test(r)) return 'AUTH_ERROR';
  if (/^INVALID_JSON|^EMPTY_CONTENT|^SCHEMA_INVALID|^FACTUALITY_REJECTED/.test(r)) return 'INVALID_OUTPUT';
  return 'API_ERROR';
}

const STATE_RANK = { UNKNOWN: 0, HEALTHY: 1, LOW: 2, NEAR_LIMIT: 3, OFFLINE: 4, LIMIT_REACHED: 5 };

/** Quota state of one dimension. Without a real limit the state is UNKNOWN (never fabricated). */
function quotaState({ used, limit, warningPct, criticalPct, exhausted }) {
  if (exhausted) return { state: 'LIMIT_REACHED', used, limit: limit || null, remaining: limit ? Math.max(0, limit - used) : 0, pct_used: limit ? round((100 * used) / limit, 1) : null };
  if (!limit || limit <= 0 || used === null || used === undefined) return { state: 'UNKNOWN', used: used ?? null, limit: null, remaining: null, pct_used: null };
  const pct = (100 * used) / limit;
  const state = used >= limit ? 'LIMIT_REACHED' : pct >= criticalPct ? 'NEAR_LIMIT' : pct >= warningPct ? 'LOW' : 'HEALTHY';
  return { state, used, limit, remaining: Math.max(0, limit - used), pct_used: round(pct, 1) };
}

function worstState(states) {
  const known = states.filter((s) => s && s !== 'UNKNOWN');
  if (!known.length) return 'UNKNOWN';
  return known.sort((a, b) => STATE_RANK[b] - STATE_RANK[a])[0];
}

function utcDay(iso) { return String(iso || '').slice(0, 10); }

/**
 * Account-level quota (OpenRouter's free-model counter is shared by all :free models).
 * @param {object} p
 *  key:   ai_api_keys row (provider data from GET /api/v1/key) or null
 *  usage: { requests_today, requests_hour, tokens_today, free_requests_since_key_check, quota_exhausted_today }
 *  cfg:   cfg.ai
 */
function accountQuota({ key, usage, cfg, nowIso }) {
  const dims = [];
  const u = usage || {};
  const w = cfg.warningPct;
  const c = cfg.criticalPct;
  const keyToday = key && key.checked_at && utcDay(new Date(key.checked_at).toISOString()) === utcDay(nowIso)
    && key.free_requests_limit !== null && key.free_requests_limit !== undefined;
  if (keyToday) {
    const used = Number(key.free_requests_used || 0) + Number(u.free_requests_since_key_check || 0);
    dims.push({ dimension: 'requests/day', source: 'PROVIDER (GET /api/v1/key)', daily: true,
      ...quotaState({ used, limit: Number(key.free_requests_limit), warningPct: w, criticalPct: c }) });
  }
  if (cfg.dailyBudget <= 0) dims.push({ dimension: 'requests/day', source: 'CONFIGURED (AI_MAX_REQUESTS_DAY=0: AI disabled)', daily: true, state: 'LIMIT_REACHED', used: u.requests_today || 0, limit: 0, remaining: 0, pct_used: null });
  else dims.push({ dimension: 'requests/day', source: 'CONFIGURED (AI_MAX_REQUESTS_DAY)', daily: true, ...quotaState({ used: u.requests_today || 0, limit: cfg.dailyBudget, warningPct: w, criticalPct: c }) });
  if (cfg.maxRequestsHour > 0) dims.push({ dimension: 'requests/hour', source: 'CONFIGURED (AI_MAX_REQUESTS_HOUR)', daily: false, ...quotaState({ used: u.requests_hour || 0, limit: cfg.maxRequestsHour, warningPct: w, criticalPct: c }) });
  if (cfg.maxTokensDay > 0) dims.push({ dimension: 'tokens/day', source: 'CONFIGURED (AI_MAX_TOKENS_DAY)', daily: true, ...quotaState({ used: u.tokens_today || 0, limit: cfg.maxTokensDay, warningPct: w, criticalPct: c }) });
  if (u.quota_exhausted_today) dims.push({ dimension: 'requests/day', source: 'PROVIDER (quota-exhausted response today)', daily: true, state: 'LIMIT_REACHED', used: u.requests_today || 0, limit: keyToday ? Number(key.free_requests_limit) : null, remaining: 0, pct_used: null });
  const daily = dims.filter((d) => d.daily);
  const binding = (list) => list.slice().sort((a, b) => STATE_RANK[b.state] - STATE_RANK[a.state]
    || (a.remaining === null ? 1 : 0) - (b.remaining === null ? 1 : 0)
    || (b.pct_used ?? -1) - (a.pct_used ?? -1))[0] || null;
  const requestDims = dims.filter((d) => /^requests/.test(d.dimension) && d.remaining !== null);
  return {
    state: worstState(dims.map((d) => d.state)),            // gating: includes the hourly burst guard
    daily_state: worstState(daily.map((d) => d.state)),      // alerts: daily dimensions only (no hourly flapping)
    dims,
    binding: binding(dims),
    daily_binding: binding(daily),
    remaining_requests: requestDims.length ? Math.min(...requestDims.map((d) => d.remaining)) : null,
    provider_reported: keyToday,
  };
}

/** AVAILABLE / LOW / NONE / UNKNOWN capacity label for a model from the account quota. */
function capacityLabel(state) {
  if (state === 'HEALTHY') return 'AVAILABLE';
  if (state === 'LOW' || state === 'NEAR_LIMIT') return 'LOW';
  if (state === 'LIMIT_REACHED') return 'NONE (limit reached)';
  return 'UNKNOWN';
}

/** Current health state of a model from its record and the latest provider model-list check. */
function modelHealth(row, nowMs) {
  const r = row || {};
  const now = nowMs === undefined ? Date.now() : nowMs;
  const skipUntil = r.skip_until ? Date.parse(r.skip_until) : 0;
  if (r.listed === false) return { status: 'OFFLINE', reason: 'MODEL_UNAVAILABLE (not in the provider model list)' };
  if (r.free === false) return { status: 'OFFLINE', reason: 'NOT_FREE (provider price is no longer 0 — skipped to stay free-first)' };
  const lastFail = r.last_failure ? Date.parse(r.last_failure) : 0;
  const lastOk = r.last_success ? Date.parse(r.last_success) : 0;
  if (r.last_error_type === 'QUOTA_EXHAUSTED' && lastFail >= lastOk && skipUntil > now) return { status: 'RATE_LIMITED', reason: 'daily limit reached (provider)' };
  if (r.last_error_type === 'RATE_LIMIT' && lastFail >= lastOk && skipUntil > now) return { status: 'RATE_LIMITED', reason: 'rate limited by provider' };
  const cf = Number(r.consecutive_failures || 0);
  if (cf >= 3) {
    const offline = ['OFFLINE', 'MODEL_UNAVAILABLE', 'AUTH_ERROR'].includes(r.last_error_type);
    return { status: offline ? 'OFFLINE' : 'DEGRADED', reason: `${cf} consecutive failures (last: ${r.last_error_type || 'unknown'})` };
  }
  if (cf > 0) return { status: 'DEGRADED', reason: `${cf} recent failure${cf === 1 ? '' : 's'} (last: ${r.last_error_type || 'unknown'})` };
  if (Number(r.success_count || 0) > 0) return { status: 'HEALTHY', reason: null };
  return { status: 'UNKNOWN', reason: r.listed ? 'available, not used yet (standby)' : 'not checked yet' };
}

function nextUtcMidnight(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/**
 * Applies one provider attempt to a model-health row (returns a new row).
 * attempt: { success, error_type, latency_ms, retry_after_s, ratelimit_reset, at }
 */
function applyAttempt(row, attempt, opts = {}) {
  const r = { ...(row || {}) };
  const at = attempt.at || new Date().toISOString();
  const now = Date.parse(at);
  r.success_count = Number(r.success_count || 0);
  r.failure_count = Number(r.failure_count || 0);
  r.consecutive_failures = Number(r.consecutive_failures || 0);
  if (attempt.success) {
    r.success_count += 1;
    r.consecutive_failures = 0;
    r.last_success = at;
    r.skip_until = null;
    if (Number.isFinite(attempt.latency_ms)) {
      const n = Number(r.latency_samples || 0);
      r.average_latency = Math.round(((Number(r.average_latency || 0) * n) + attempt.latency_ms) / (n + 1));
      r.latency_samples = n + 1;
    }
  } else {
    r.failure_count += 1;
    r.consecutive_failures += 1;
    r.last_failure = at;
    r.last_error_type = attempt.error_type || 'API_ERROR';
    let until = null;
    if (attempt.error_type === 'QUOTA_EXHAUSTED') until = attempt.ratelimit_reset ? Date.parse(attempt.ratelimit_reset) : nextUtcMidnight(now);
    else if (attempt.error_type === 'RATE_LIMIT') until = now + 1000 * Math.max(60, Number(attempt.retry_after_s) || 0);
    else if (attempt.error_type === 'MODEL_UNAVAILABLE') until = now + 60000 * (opts.healthIntervalMin || 60);
    else if (r.consecutive_failures >= 3) until = now + 15 * 60000; // circuit breaker
    r.skip_until = until ? new Date(until).toISOString() : null;
  }
  const h = modelHealth(r, now);
  r.current_status = h.status;
  r.status_reason = h.reason;
  return r;
}

/** Router view: which configured models to skip right now (saves requests and latency). */
function routerModelState(rows, models, nowMs) {
  const now = nowMs === undefined ? Date.now() : nowMs;
  const byModel = Object.fromEntries((rows || []).map((r) => [r.model, r]));
  const out = {};
  for (const m of models) {
    const r = byModel[m];
    const h = modelHealth(r, now);
    const skipUntil = r && r.skip_until ? Date.parse(r.skip_until) : 0;
    const skip = (r && (r.listed === false || r.free === false)) || skipUntil > now;
    out[m] = { skip, status: h.status, reason: skip ? (h.reason || `backoff until ${new Date(skipUntil).toISOString()}`) : null, skip_until: skipUntil > now ? new Date(skipUntil).toISOString() : null };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cache: context fingerprint of the MATERIAL inputs (spec §25)
// ---------------------------------------------------------------------------
const bucketPct = (v, stepPct) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Math.log(Number(v)) / Math.log(1 + stepPct / 100)) : null);
const bucketBp = (v, stepBp) => (Number.isFinite(Number(v)) ? Math.round((Number(v) * 100) / stepBp) : null);
const bucketN = (v, step) => (Number.isFinite(Number(v)) ? Math.round(Number(v) / step) : null);

function marketKey(facts) {
  const ms = facts.market_state || {};
  const cs = facts.current_state || {};
  const gold = (ms.gold && ms.gold.value) ?? (cs.gold && cs.gold.value);
  const usd = (ms.usd && ms.usd.value) ?? (cs.usd && cs.usd.value);
  const y10 = (ms.us10y && ms.us10y.value) ?? (cs.yields && cs.yields.us10y);
  const y2 = (ms.us2y && ms.us2y.value) ?? (cs.yields && cs.yields.us2y);
  const r10 = (ms.real10y && ms.real10y.value) ?? (cs.yields && cs.yields.real10y);
  // Material moves: gold 0.5 %, USD proxy 0.3 %, yields 5 bp.
  return [bucketPct(gold, 0.5), bucketPct(usd, 0.3), bucketBp(y10, 5), bucketBp(y2, 5), bucketBp(r10, 5)];
}

function materialKey(req) {
  const f = req.facts || {};
  const p = String(req.purpose || '');
  const det = f.deterministic || {};
  if (p === 'EVENT' || p === 'TEST') {
    const e = f.event || {};
    const t = f.transmission || {};
    return {
      e: [e.importance_class, e.confirmation_status, Math.min(Number(e.publisher_count) || 0, 5), e.subcategory],
      t: [t.net_pressure, t.dominant_driver, t.counter_driver, f.market_confirmation && f.market_confirmation.status],
      d: [f.desk_context && f.desk_context.regime, bucketN(det.confidence, 10)],
    };
  }
  if (p === 'PRE_EVENT') {
    const e = f.event || {};
    const cs = f.current_state || {};
    return {
      e: [e.release_key || e.event_type, e.scheduled_at, e.available_consensus],
      d: [det.forecast_state, bucketN(det.pre_event_score, 10), bucketN(det.confidence, 10), det.data_quality && det.data_quality.level],
      c: [cs.desk_regime, cs.macro_regime && cs.macro_regime.primary, cs.geopolitics && cs.geopolitics.class, cs.politics && cs.politics.class],
    };
  }
  if (p === 'DAILY') {
    return {
      r: [f.regime, f.dominant_driver, f.counter_driver, bucketN(det.confidence, 10)],
      h: Object.entries(f.horizons || {}).map(([k, v]) => `${k}:${v.bias}:${v.market_confirmation}`),
      ev: (f.top_events || []).slice(0, 8).map((e) => `${e.id}:${e.importance_class}:${e.net_pressure}`),
      up: (f.upcoming_events || []).slice(0, 6).map((u) => `${u.event_type}:${u.scheduled_at}`),
    };
  }
  if (p === 'BIGGEST') {
    return { s: (f.scenarios || []).map((s) => [s.release_key, s.state, bucketN(s.score, 10), s.rank]), r: f.regime };
  }
  return { f: JSON.stringify(f).length, d: det };
}

function fingerprint(req) {
  return hashOf('gi-ai-v1', req.purpose, req.ref, JSON.stringify(materialKey(req)), JSON.stringify(marketKey(req.facts || {})));
}

/**
 * Validates a cache entry for reuse with the CURRENT facts. Numbers and quotes of the cached
 * answer are re-checked against today's facts; the deterministic fields are re-applied.
 * @returns {{ok:boolean, reason:string|null, output:object|null, age_min:number|null}}
 */
function cacheReuse(entry, req, { nowMs, criticalSince } = {}) {
  if (!entry) return { ok: false, reason: 'MISS', output: null, age_min: null };
  const now = nowMs === undefined ? Date.now() : nowMs;
  if (Date.parse(entry.expires_at) <= now) return { ok: false, reason: 'EXPIRED', output: null, age_min: null };
  if (criticalSince && Date.parse(criticalSince) > Date.parse(entry.created_at)) return { ok: false, reason: 'NEW_CRITICAL_EVENT', output: null, age_min: null };
  const out = JSON.parse(JSON.stringify(entry.output));
  const guard = factualityGuard(out, req.facts);
  if (!guard.ok) return { ok: false, reason: 'STALE_FACTS', output: null, age_min: null };
  enforceDeterministic(out, req.facts);
  return { ok: true, reason: null, output: out, age_min: Math.round((now - Date.parse(entry.created_at)) / 60000) };
}

// ---------------------------------------------------------------------------
// Alerts (spec §7-9, §30): one message per state transition, with cooldown.
// ---------------------------------------------------------------------------
const ALERT_SEVERITY = { HEALTHY: 0, UNKNOWN: 0, LOW: 1, NEAR_LIMIT: 2, LIMIT_REACHED: 3 };

/**
 * @param {object} p
 *  prev:      stored alert state (kv 'ai_alert_state') or null
 *  quota:     accountQuota() result
 *  models:    [{ model, rank, display_name, status, reason, requests_today, tokens_today }]
 *  usage:     { requests_today, tokens_today, fallbacks_1h, failures_today }
 *  lastFailures: { [model]: { error_type, at, detail } }
 *  cfg:       cfg.ai
 * @returns {{ alerts: Array<{kind, ...}>, state: object }}
 */
function decideAlerts({ prev, quota, models, usage, lastFailures, cfg, nowIso }) {
  const now = Date.parse(nowIso);
  const st = JSON.parse(JSON.stringify(prev || {}));
  st.models = st.models || {};
  const alerts = [];
  const cooled = (iso) => !iso || (now - Date.parse(iso)) / 60000 >= cfg.alertCooldownMin;
  // 1) Account quota (daily dimensions only).
  const prevQ = st.quota_state || 'UNKNOWN';
  const curQ = quota.daily_state;
  const sevPrev = ALERT_SEVERITY[prevQ] ?? 0;
  const sevCur = ALERT_SEVERITY[curQ] ?? 0;
  if (sevCur > sevPrev) {
    const sameOrLowerRecently = st.last_quota_alert_severity !== undefined && sevCur <= st.last_quota_alert_severity && !cooled(st.last_quota_alert_at);
    if (!sameOrLowerRecently) {
      alerts.push({ kind: curQ === 'LIMIT_REACHED' ? 'LIMIT_REACHED' : 'QUOTA_WARNING', state: curQ, previous: prevQ, binding: quota.daily_binding, scope: 'account' });
      st.last_quota_alert_at = nowIso;
      st.last_quota_alert_severity = sevCur;
    }
  }
  if (curQ !== prevQ) { st.quota_state = curQ; st.quota_state_at = nowIso; }
  // 2) Per-model provider limit reached (quota-exhausted responses).
  for (const m of models || []) {
    const ms = st.models[m.model] || {};
    const lf = (lastFailures || {})[m.model];
    const limited = m.status === 'RATE_LIMITED' && lf && lf.error_type === 'QUOTA_EXHAUSTED';
    if (limited && !ms.limit_alerted && !alerts.some((a) => a.kind === 'LIMIT_REACHED')) {
      alerts.push({ kind: 'LIMIT_REACHED', scope: 'model', model: m.model, rank: m.rank, display_name: m.display_name, reason: lf.detail || 'provider reported the daily limit', requests_today: m.requests_today, tokens_today: m.tokens_today });
      ms.limit_alerted = nowIso;
    } else if (!limited && ms.limit_alerted) delete ms.limit_alerted;
    // 3) Primary health transitions -> persistent fallback.
    const prevStatus = ms.status || 'UNKNOWN';
    if (m.rank === 1 && ['DEGRADED', 'RATE_LIMITED', 'OFFLINE'].includes(m.status) && !['DEGRADED', 'RATE_LIMITED', 'OFFLINE'].includes(prevStatus)
      && cooled(st.last_fallback_alert_at) && !(limited && alerts.some((a) => a.kind === 'LIMIT_REACHED'))) {
      alerts.push({ kind: 'FALLBACK', trigger: `primary ${m.status}`, model: m.model, display_name: m.display_name, reason: m.reason, lastFailure: lf || null });
      st.last_fallback_alert_at = nowIso;
    }
    ms.status = m.status;
    st.models[m.model] = ms;
  }
  // 4) Fallback count over threshold in the last hour (only once per cooldown).
  if ((usage && usage.fallbacks_1h) >= cfg.fallbackThreshold && cooled(st.last_fallback_alert_at) && !alerts.some((a) => a.kind === 'FALLBACK')) {
    const primary = (models || []).find((m) => m.rank === 1);
    alerts.push({ kind: 'FALLBACK', trigger: `${usage.fallbacks_1h} fallbacks in the last hour (threshold ${cfg.fallbackThreshold})`, model: primary && primary.model, display_name: primary && primary.display_name, reason: primary && primary.reason, lastFailure: primary ? (lastFailures || {})[primary.model] : null });
    st.last_fallback_alert_at = nowIso;
  }
  st.checked_at = nowIso;
  return { alerts, state: st };
}

/** Plain-language text for a deterministic-fallback reason (Telegram). */
function fallbackReasonText(reason) {
  const r = String(reason || '');
  const m = /^QUOTA_([A-Z_]+?)_(REQUESTS_HOUR|REQUESTS_DAY|TOKENS_DAY|UNKNOWN)_PRIORITY_/.exec(r);
  if (m) {
    const what = { REQUESTS_HOUR: 'hourly AI request cap (AI_MAX_REQUESTS_HOUR)', REQUESTS_DAY: 'daily AI request limit', TOKENS_DAY: 'daily token cap', UNKNOWN: 'AI quota' }[m[2]];
    return `${what} ${m[1] === 'LIMIT_REACHED' ? 'reached' : `is ${m[1].replace('_', ' ').toLowerCase()}`} — lower-priority AI requests wait`;
  }
  const map = {
    NOT_CONFIGURED: 'OPENROUTER_API_KEY not configured', ALL_MODELS_FAILED: 'all configured models failed',
    DAILY_BUDGET_EXHAUSTED: 'daily AI request limit reached', HOURLY_BUDGET_EXHAUSTED: 'hourly AI request cap reached',
    PROVIDER_DAILY_LIMIT: 'provider daily free-model limit reached', TOKEN_BUDGET_EXHAUSTED: 'daily token cap reached',
    MAX_ATTEMPTS_REACHED: 'models did not answer in time', NOT_ELIGIBLE: 'not eligible for AI',
  };
  return map[r] || r || 'no AI result';
}

/** AI system status from model health + account quota (spec §1: HEALTHY / LIMITED / DEGRADED / OFFLINE). */
function aiSystemStatus({ configured, quotaState: q, modelStatuses }) {
  if (!configured) return 'OFFLINE';
  const usable = (modelStatuses || []).filter((s) => s === 'HEALTHY' || s === 'UNKNOWN' || s === 'DEGRADED');
  if (q === 'LIMIT_REACHED' || !usable.length) return 'OFFLINE';
  if (q === 'LOW' || q === 'NEAR_LIMIT') return 'LIMITED';
  if ((modelStatuses || []).some((s) => s !== 'HEALTHY' && s !== 'UNKNOWN')) return 'DEGRADED';
  return 'HEALTHY';
}

module.exports = {
  LEVEL_LABEL, DETERMINISTIC_LEVEL, PRIORITY, PRIORITY_LABEL, requestPriority, priorityAllowed, errorTypeOf,
  quotaState, worstState, accountQuota, capacityLabel, modelHealth, applyAttempt, routerModelState,
  marketKey, materialKey, fingerprint, cacheReuse, decideAlerts, aiSystemStatus, nextUtcMidnight, STATE_RANK, fallbackReasonText,
};
