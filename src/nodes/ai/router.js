'use strict';
// AI Router: cache → priority/quota gate → PRIMARY → SECONDARY → TERTIARY → DETERMINISTIC.
// Records every attempt (tokens / cost only as reported), updates model health (circuit breaker),
// and decides usage / limit / fallback alerts (one per state change, with cooldown). No secrets in outputs.
const { loadConfig, secretsFrom } = require('../../lib/config');
const { routeRequests } = require('../../lib/ai');
const A = require('../../lib/aiusage');
const TA = require('../../lib/telegram-ai');
const { makeHttp } = require('../../lib/http');
const { redact } = require('../../lib/util');

const st = $input.first().json;
const payload = (st.prepared && st.prepared.payload) || {};
const cfg = loadConfig($env);
const secrets = secretsFrom($env);
const now = () => new Date().toISOString();
const http = makeHttp(this.helpers, { userAgent: cfg.http.userAgent });
const requests = Array.isArray(payload.requests) ? payload.requests : [];
const configured = cfg.ai.models;
const rankOf = (m) => configured.indexOf(m) + 1 || null;
const real = (u) => u.provider === 'openrouter' && (u.request_status === 'SUCCESS' || u.request_status === 'FAILED');
const counters = {
  requests_today: 0, requests_hour: 0, tokens_today: 0, tokens_reported_today: 0, free_requests_since_key_check: 0,
  quota_exhausted_today: false, fallbacks_1h: 0, failures_today: 0, ...(st.counters || {}),
};
const mc = st.models_check && Array.isArray(st.models_check.models) ? Object.fromEntries(st.models_check.models.map((m) => [m.id, m])) : {};
const healthBy = Object.fromEntries((st.health || []).map((r) => [r.model, r]));
// Capabilities from the provider model list (Health Monitor): unknown -> response_format not sent.
const modelCaps = Object.fromEntries(Object.entries(mc).map(([id, m]) => [id, { response_format: Boolean(m.response_format) }]));
const healthRow = (model) => {
  if (!healthBy[model]) {
    const m = mc[model] || {};
    healthBy[model] = {
      provider: 'openrouter', model, display_name: m.name || null, listed: m.available ?? null, free: m.free ?? null,
      context_length: m.context_length || null, success_count: 0, failure_count: 0, consecutive_failures: 0, latency_samples: 0, current_status: 'UNKNOWN',
    };
  }
  return healthBy[model];
};
const lastFailures = { ...(st.last_failures || {}) };
const results = new Array(requests.length);
const runs = [];
const usage = [];
const cacheUpserts = [];
const cacheHits = [];
let keyUpdate = null;
const setKey = (patch) => { keyUpdate = { key_alias: cfg.ai.keyAlias, provider: 'openrouter', ...(keyUpdate || {}), ...patch }; };

// Highest priority first, so a nearly exhausted budget goes to the most important requests.
const order = requests.map((r, idx) => ({ r, idx })).sort((a, b) => (a.r.priority ?? 9) - (b.r.priority ?? 9) || a.idx - b.idx);
for (const { r: original, idx } of order) {
  const req = { ...original };
  const base = { workflow: req.workflow, event_type: req.purpose, priority: req.priority, related_ref: req.ref, fingerprint: req.fingerprint, is_test: Boolean(req.is_test) };
  const quotaNow = A.accountQuota({ key: st.key, usage: counters, cfg: cfg.ai, nowIso: now() });
  let cacheMiss = null;
  // 1) Cache: identical material context, still valid, numbers re-checked against the current facts.
  if (req.use_ai && req.fingerprint && st.cache && st.cache[req.fingerprint] && cfg.secrets.openrouterConfigured) {
    const entry = st.cache[req.fingerprint];
    const reuse = A.cacheReuse(entry, req, { criticalSince: st.critical_since });
    if (reuse.ok) {
      const rank = rankOf(entry.model);
      results[idx] = {
        ref: req.ref, purpose: req.purpose, mode: 'AI', cached: true, cache_age_min: reuse.age_min, model: entry.model, model_rank: rank,
        fallback_level: rank ? rank - 1 : null, output: reuse.output, attempts: [], fallback_reason: null, priority: req.priority, fingerprint: req.fingerprint, models: configured,
      };
      usage.push({ ...base, provider: entry.provider || 'openrouter', model: entry.model, key_alias: cfg.ai.keyAlias, request_timestamp: now(), request_status: 'CACHED', fallback_level: rank ? rank - 1 : 0, latency_ms: 0 });
      cacheHits.push(req.fingerprint);
      continue;
    }
    cacheMiss = reuse.reason;
  }
  // 2) Priority gate under quota pressure (spec §26).
  if (req.use_ai && cfg.secrets.openrouterConfigured && !A.priorityAllowed(req.priority ?? 9, quotaNow.state)) {
    req.use_ai = false;
    const dim = quotaNow.binding ? String(quotaNow.binding.dimension).replace('/', '_').toUpperCase() : 'UNKNOWN';
    req.skip_reason = `QUOTA_${quotaNow.state}_${dim}_PRIORITY_${A.PRIORITY_LABEL[req.priority] || req.priority}`;
  }
  // 3) Budgets: configured day / hour caps and the provider-reported remaining counter.
  let budget = cfg.ai.dailyBudget - counters.requests_today;
  let budgetReason = 'DAILY_BUDGET_EXHAUSTED';
  if (cfg.ai.maxRequestsHour > 0 && cfg.ai.maxRequestsHour - counters.requests_hour < budget) {
    budget = cfg.ai.maxRequestsHour - counters.requests_hour;
    budgetReason = 'HOURLY_BUDGET_EXHAUSTED';
  }
  const provDim = quotaNow.dims.find((d) => /^PROVIDER \(GET/.test(d.source));
  if (provDim && provDim.remaining !== null && provDim.remaining < budget) { budget = provDim.remaining; budgetReason = 'PROVIDER_DAILY_LIMIT'; }
  if (counters.quota_exhausted_today) { budget = 0; budgetReason = 'PROVIDER_DAILY_LIMIT'; }
  const tokenLeft = cfg.ai.maxTokensDay > 0 ? cfg.ai.maxTokensDay - counters.tokens_today : null;
  // Only test requests may override the model chain (used to prove fallback on real provider errors).
  const models = req.is_test && Array.isArray(req.models_override) && req.models_override.length ? req.models_override : configured;
  const modelState = A.routerModelState(models.filter((m) => healthBy[m]).map((m) => healthBy[m]), models);
  const out = await routeRequests({
    requests: [req], models, apiKey: secrets.openrouterKey, http,
    timeoutMs: cfg.ai.timeoutMs, maxTokens: cfg.ai.maxTokens,
    budgetRemaining: Math.max(0, budget), budgetReason, tokenBudgetRemaining: tokenLeft, modelState,
    modelCaps, reasoning: cfg.ai.reasoning,
    secrets: secrets.list(),
  });
  const res = out.results[0];
  runs.push(...out.runs);
  for (const a of res.attempts.filter((x) => !x.skipped)) {
    const et = a.success ? null : A.errorTypeOf(a.failure_reason);
    const rl = a.ratelimit || {};
    const detail = a.success ? null : redact(String(a.failure_reason || ''), secrets.list()).slice(0, 300);
    usage.push({
      ...base, provider: 'openrouter', model: a.model, key_alias: cfg.ai.keyAlias, request_timestamp: a.at,
      input_tokens: a.prompt_tokens, output_tokens: a.completion_tokens, total_tokens: a.total_tokens, cost: a.cost,
      request_status: a.success ? 'SUCCESS' : 'FAILED', latency_ms: a.latency_ms, fallback_level: a.rank - 1,
      error_type: et, error_detail: detail, http_status: a.http_status,
      ratelimit_limit: rl.limit, ratelimit_remaining: rl.remaining, ratelimit_reset: rl.reset, retry_after_s: a.retry_after_s,
    });
    counters.requests_today += 1;
    counters.requests_hour += 1;
    if (Number.isFinite(a.total_tokens)) { counters.tokens_today += a.total_tokens; counters.tokens_reported_today += 1; }
    if (/:free$/.test(a.model)) counters.free_requests_since_key_check += 1;
    if (et === 'QUOTA_EXHAUSTED') counters.quota_exhausted_today = true;
    if (!a.success) {
      counters.failures_today += 1;
      lastFailures[a.model] = { error_type: et, detail: (detail || '').slice(0, 200), at: a.at };
    }
    if (configured.includes(a.model)) {
      healthBy[a.model] = A.applyAttempt(healthRow(a.model),
        { success: a.success, error_type: et, latency_ms: a.latency_ms, retry_after_s: a.retry_after_s, ratelimit_reset: rl.reset, at: a.at },
        { healthIntervalMin: cfg.ai.healthCheckIntervalMin });
    }
    if (a.success) setKey({ status: 'ACTIVE', last_success: a.at });
    else if (et === 'AUTH_ERROR') setKey({ status: 'INVALID', last_failure: a.at, last_error: 'authentication failed (HTTP 401/403)' });
    else if (et === 'QUOTA_EXHAUSTED') setKey({ status: 'LIMIT_REACHED', last_failure: a.at, last_error: 'free-model daily limit reached (provider)' });
  }
  if (res.mode === 'AI' && res.model_rank > 1) counters.fallbacks_1h += 1;
  if (res.mode !== 'AI' && original.use_ai) {
    usage.push({ ...base, provider: 'deterministic', model: 'deterministic', key_alias: null, request_timestamp: now(), request_status: 'FALLBACK', fallback_level: A.DETERMINISTIC_LEVEL, error_type: res.fallback_reason, latency_ms: 0 });
    if (res.fallback_reason === 'ALL_MODELS_FAILED' || res.fallback_reason === 'MAX_ATTEMPTS_REACHED') counters.fallbacks_1h += 1;
  }
  if (res.mode === 'AI' && req.fingerprint && res.raw_output) {
    const f = req.facts || {};
    const regime = (f.desk_context && f.desk_context.regime) || (f.current_state && f.current_state.desk_regime) || f.regime || null;
    cacheUpserts.push({ fingerprint: req.fingerprint, purpose: req.purpose, ref: req.ref, provider: 'openrouter', model: res.model, output: res.raw_output, regime, ttl_min: cfg.ai.cacheTtlMin });
  }
  const { raw_output: _raw, ...clean } = res;
  results[idx] = { ...clean, priority: req.priority, fingerprint: req.fingerprint, cache_miss_reason: cacheMiss, models };
}

// Model health for every configured model (ranks follow the current configuration; backoffs expire).
const modelHealth = configured.map((m, i) => {
  const row = { ...healthRow(m), rank: i + 1, current_fallback_level: i };
  const h = A.modelHealth(row);
  return { ...row, current_status: h.status, status_reason: h.reason };
});
const quota = A.accountQuota({ key: st.key, usage: counters, cfg: cfg.ai, nowIso: now() });
let alertState = null;
let messages = [];
if (cfg.secrets.openrouterConfigured) {
  const perModel = st.per_model_today || {};
  const batch = (m) => usage.filter((u) => u.model === m && real(u));
  const models = modelHealth.map((m) => ({
    model: m.model, rank: m.rank, display_name: m.display_name, status: m.current_status, reason: m.status_reason,
    requests_today: Number((perModel[m.model] || {}).requests_today || 0) + batch(m.model).length,
    tokens_today: Number((perModel[m.model] || {}).tokens_today || 0) + batch(m.model).reduce((s, u) => s + (Number(u.total_tokens) || 0), 0),
  }));
  const decided = A.decideAlerts({ prev: st.alert_state, quota, models, usage: counters, lastFailures, cfg: cfg.ai, nowIso: now() });
  alertState = decided.state;
  const next = modelHealth.find((m) => m.rank > 1 && !A.routerModelState([m], [m.model])[m.model].skip);
  messages = TA.alertMessages(decided.alerts, {
    primary: configured[0], requests_today: counters.requests_today, tokens_today: counters.tokens_today,
    tokens_reported_today: counters.tokens_reported_today, next_model: next ? next.model : null, next_rank: next ? next.rank : null,
  }, cfg.timezone);
}

return [{
  json: {
    results,
    record: {
      runs, usage, model_health: modelHealth, cache_upserts: cacheUpserts, cache_hits: [...new Set(cacheHits)], key_update: keyUpdate,
      alert_state: alertState, quota_state: quota.daily_state, configured_models: configured,
    },
    alert_payload: { messages },
    quota: { state: quota.state, daily_state: quota.daily_state, binding: quota.daily_binding, remaining_requests: quota.remaining_requests, provider_reported: quota.provider_reported },
    budget: { daily: cfg.ai.dailyBudget, used_today: counters.requests_today, hourly: cfg.ai.maxRequestsHour, used_hour: counters.requests_hour },
    openrouter: cfg.secrets.openrouterConfigured ? 'CONFIGURED' : 'NOT CONFIGURED',
  },
}];
