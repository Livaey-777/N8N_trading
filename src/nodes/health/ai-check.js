'use strict';
// AI HEALTH CHECK (every AI_HEALTH_CHECK_INTERVAL; always on a manual run):
//  1. provider model list (public, no key): model exists? still free? display name, context
//  2. GET /api/v1/key (key required): authoritative free-model daily counter (used / limit / remaining)
//  3. tiny probe request (max 64 tokens) ONLY for configured models idle longer than
//     AI_HEALTH_PROBE_IDLE_HOURS, and only while the quota is HEALTHY/UNKNOWN (no full analysis)
// Then: per-model health state, account quota state, usage/limit/fallback alerts (state changes only).
const { loadConfig, secretsFrom } = require('../../lib/config');
const { makeHttp } = require('../../lib/http');
const { redact } = require('../../lib/util');
const { extractJson, classifyFailure, rateLimitHeaders, requestParams, providerErrorText } = require('../../lib/ai');
const A = require('../../lib/aiusage');
const TA = require('../../lib/telegram-ai');

const cfg = loadConfig($env);
const secrets = secretsFrom($env);
const h = $('Collect Health').first().json;
const manual = h.mode === 'MANUAL';
const nowIso = () => new Date().toISOString();
const minsSince = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 60000 : Infinity);
const http = makeHttp(this.helpers, { userAgent: cfg.http.userAgent, timeoutMs: 20000 });
const configured = cfg.ai.models;
const counters = {
  requests_today: 0, requests_hour: 0, tokens_today: 0, tokens_reported_today: 0, free_requests_since_key_check: 0,
  quota_exhausted_today: false, fallbacks_1h: 0, failures_today: 0, ...(h.ai_counters || {}),
};
const healthBy = Object.fromEntries((h.ai_health || []).map((r) => [r.model, r]));
let modelsCheck = h.models_check || null;
const due = manual || !modelsCheck || minsSince(modelsCheck.at) >= cfg.ai.healthCheckIntervalMin;
const notes = [];

// 1) Model list (free-model availability changes without notice).
if (due) {
  try {
    const r = await http({ url: 'https://openrouter.ai/api/v1/models' });
    if (r.statusCode === 200 && r.body && Array.isArray(r.body.data)) {
      const byId = Object.fromEntries(r.body.data.map((m) => [m.id, m]));
      modelsCheck = {
        at: nowIso(),
        models: configured.map((id) => {
          const m = byId[id];
          const free = Boolean(m && m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0);
          const sp = (m && m.supported_parameters) || [];
          return { id, available: Boolean(m), free: m ? free : null, name: m ? m.name : null, context_length: m ? m.context_length : null,
            response_format: sp.includes('response_format') || sp.includes('structured_outputs') };
        }),
      };
    } else {
      notes.push(`model list HTTP ${r.statusCode}`);
      modelsCheck = { ...(modelsCheck || {}), at: nowIso(), error: `models endpoint HTTP ${r.statusCode}` };
    }
  } catch (e) {
    notes.push(`model list: ${e.message.slice(0, 100)}`);
    modelsCheck = { ...(modelsCheck || {}), at: nowIso(), error: e.message.slice(0, 120) };
  }
}
const listBy = Object.fromEntries(((modelsCheck && modelsCheck.models) || []).map((m) => [m.id, m]));

// 2) Key status + authoritative free-model counter.
let key = h.ai_key || null;
let keyUpdate = null;
if (due && cfg.secrets.openrouterConfigured) {
  try {
    const r = await http({ url: 'https://openrouter.ai/api/v1/key', headers: { Authorization: `Bearer ${secrets.openrouterKey}` } });
    if (r.statusCode === 200 && r.body && r.body.data) {
      const d = r.body.data;
      const f = d.free_model_daily_requests || {};
      const num = (x) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? null : Number(x));
      keyUpdate = {
        key_alias: cfg.ai.keyAlias, provider: 'openrouter', checked_at: nowIso(),
        status: num(f.remaining) === 0 ? 'LIMIT_REACHED' : 'ACTIVE',
        is_free_tier: typeof d.is_free_tier === 'boolean' ? d.is_free_tier : null,
        free_requests_used: num(f.used), free_requests_limit: num(f.limit), free_requests_remaining: num(f.remaining),
        credit_limit: num(d.limit), credit_limit_remaining: num(d.limit_remaining), usage_daily: num(d.usage_daily), usage_monthly: num(d.usage_monthly),
      };
      key = { ...(key || {}), ...keyUpdate };
      counters.free_requests_since_key_check = 0;
    } else if (r.statusCode === 401 || r.statusCode === 403) {
      keyUpdate = { key_alias: cfg.ai.keyAlias, provider: 'openrouter', status: 'INVALID', last_failure: nowIso(), last_error: `key check HTTP ${r.statusCode}` };
    } else notes.push(`key check HTTP ${r.statusCode}`);
  } catch (e) {
    notes.push(`key check: ${redact(e.message, secrets.list()).slice(0, 100)}`);
  }
} else if (!cfg.secrets.openrouterConfigured) {
  keyUpdate = { key_alias: cfg.ai.keyAlias, provider: 'openrouter', status: 'NOT_CONFIGURED' };
}

// Health rows for the configured chain (list/free/name from the provider list).
const rows = configured.map((m, i) => {
  const L = listBy[m];
  const base = healthBy[m] || { provider: 'openrouter', model: m, success_count: 0, failure_count: 0, consecutive_failures: 0, latency_samples: 0 };
  return {
    ...base, rank: i + 1, current_fallback_level: i,
    ...(L ? { listed: L.available, free: L.available ? L.free : base.free, display_name: L.name || base.display_name, context_length: L.context_length || base.context_length } : {}),
    ...(due ? { last_health_check: nowIso() } : {}),
  };
});

// 3) Tiny probes for idle models only (a probe spends one free request).
const usage = [];
const quotaBefore = A.accountQuota({ key, usage: counters, cfg: cfg.ai, nowIso: nowIso() });
const probed = [];
if (due && cfg.secrets.openrouterConfigured && cfg.ai.probeMode === 'idle' && ['HEALTHY', 'UNKNOWN'].includes(quotaBefore.state)
  && (!keyUpdate || keyUpdate.status !== 'INVALID')) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.listed === false || r.free === false) continue;
    const lastSeen = Math.max(...[r.last_success, r.last_failure, r.last_probe_at].filter(Boolean).map((x) => Date.parse(x)), 0);
    if ((Date.now() - lastSeen) / 3600000 < cfg.ai.probeIdleHours) continue;
    if (r.skip_until && Date.parse(r.skip_until) > Date.now()) continue;
    const t0 = Date.now();
    let status = null;
    let body = null;
    let headers = {};
    let err = null;
    try {
      const resp = await http({
        url: 'https://openrouter.ai/api/v1/chat/completions', method: 'POST', timeout: 30000,
        headers: { Authorization: `Bearer ${secrets.openrouterKey}`, 'Content-Type': 'application/json', 'X-Title': 'Gold Intelligence n8n (health probe)' },
        body: {
          model: r.model, temperature: 0, max_tokens: 64, ...requestParams({ response_format: Boolean((listBy[r.model] || {}).response_format) }, cfg.ai.reasoning),
          messages: [{ role: 'system', content: 'Health check. Reply with exactly {"ok":true} and nothing else.' }, { role: 'user', content: 'ping' }],
        },
      });
      status = resp.statusCode; body = resp.body; headers = resp.headers || {};
    } catch (e) { err = e; }
    const latency = Date.now() - t0;
    const content = body && body.choices && body.choices[0] && body.choices[0].message ? body.choices[0].message.content : null;
    const parsed = typeof content === 'string' ? extractJson(content) : null;
    const ok = !err && status === 200 && !(body && body.error) && Boolean(parsed && parsed.ok === true);
    let reason = null;
    if (!ok) {
      if (err || status !== 200 || (body && body.error)) {
        const base = classifyFailure(status, body, err);
        reason = body && body.error ? `${base}: ${providerErrorText(body, secrets.list())}` : `${base}${err ? `: ${redact(err.message, secrets.list()).slice(0, 100)}` : ''}`;
      } else reason = content ? 'INVALID_JSON (probe reply was not {"ok":true})' : 'EMPTY_CONTENT';
    }
    const et = ok ? null : A.errorTypeOf(reason);
    const u = (body && body.usage) || {};
    const rl = rateLimitHeaders(headers);
    const at = new Date(t0).toISOString();
    usage.push({
      provider: 'openrouter', model: r.model, key_alias: cfg.ai.keyAlias, request_timestamp: at,
      input_tokens: u.prompt_tokens ?? null, output_tokens: u.completion_tokens ?? null, total_tokens: u.total_tokens ?? null,
      cost: Number.isFinite(Number(u.cost)) && u.cost !== null ? Number(u.cost) : null,
      request_status: ok ? 'SUCCESS' : 'FAILED', latency_ms: latency, fallback_level: i, error_type: et, error_detail: reason,
      http_status: status, ratelimit_limit: rl.limit, ratelimit_remaining: rl.remaining, ratelimit_reset: rl.reset, retry_after_s: rl.retry_after_s,
      workflow: 'health_probe', event_type: 'HEALTH_PROBE', priority: null, related_ref: `probe:${r.model}`, is_test: false,
    });
    counters.requests_today += 1;
    counters.requests_hour += 1;
    if (Number.isFinite(u.total_tokens)) { counters.tokens_today += u.total_tokens; counters.tokens_reported_today += 1; }
    if (/:free$/.test(r.model)) counters.free_requests_since_key_check += 1;
    if (et === 'QUOTA_EXHAUSTED') counters.quota_exhausted_today = true;
    rows[i] = { ...A.applyAttempt(r, { success: ok, error_type: et, latency_ms: latency, retry_after_s: rl.retry_after_s, ratelimit_reset: rl.reset, at },
      { healthIntervalMin: cfg.ai.healthCheckIntervalMin }), last_probe_at: at };
    rows[i].write = 'full';
    probed.push(`${r.model}: ${ok ? `OK ${latency}ms` : et}`);
  }
}
// Rows that were not probed are written as metadata only, so this check never overwrites counters
// that the AI router updated concurrently (live race found 2026-09-28).
const modelHealth = rows.map((r) => {
  const s = A.modelHealth(r);
  return { ...r, write: r.write || 'meta', current_status: s.status, status_reason: s.reason };
});

// Account quota + AI component + alerts.
const quota = A.accountQuota({ key, usage: counters, cfg: cfg.ai, nowIso: nowIso() });
const aiStatus = A.aiSystemStatus({ configured: cfg.secrets.openrouterConfigured, quotaState: quota.state, modelStatuses: modelHealth.map((m) => m.current_status) });
const statusLine = modelHealth.map((m) => `${['P', 'S', 'T'][m.rank - 1] || m.rank}:${m.current_status}`).join(' ');
const b = quota.daily_binding;
const quotaText = b ? `${b.used}/${b.limit ?? '?'} ${b.dimension} (${/PROVIDER/.test(b.source) ? 'provider' : 'configured'})` : 'quota UNKNOWN';
let component;
if (!cfg.secrets.openrouterConfigured) component = { component: 'AI', status: 'NOT_CONFIGURED', detail: 'OPENROUTER_API_KEY not set — deterministic mode' };
else if (keyUpdate && keyUpdate.status === 'INVALID') component = { component: 'AI', status: 'DEGRADED', detail: 'OpenRouter key rejected (401/403) — deterministic mode' };
else {
  const unavailable = modelHealth.filter((m) => m.listed === false || m.free === false).map((m) => `${m.model} ${m.listed === false ? 'MODEL_UNAVAILABLE' : 'NOT_FREE'}`);
  component = {
    component: 'AI',
    status: aiStatus === 'HEALTHY' ? 'OK' : 'DEGRADED',
    detail: `${aiStatus} · ${statusLine} · quota ${quota.daily_state} ${quotaText}${unavailable.length ? ` · ${unavailable.join(', ')}` : ''}${probed.length ? ` · probes: ${probed.join('; ')}` : ''}`,
    metrics: { quota_state: quota.daily_state, requests_today: counters.requests_today, provider_reported: quota.provider_reported },
  };
}

let alertState = null;
let messages = [];
if (cfg.secrets.openrouterConfigured) {
  const perModel = h.ai_per_model_today || {};
  const decided = A.decideAlerts({
    prev: h.ai_alert_state, quota,
    models: modelHealth.map((m) => ({ model: m.model, rank: m.rank, display_name: m.display_name, status: m.current_status, reason: m.status_reason,
      requests_today: (perModel[m.model] || {}).requests_today || 0, tokens_today: (perModel[m.model] || {}).tokens_today || 0 })),
    usage: counters, lastFailures: h.ai_last_failures || {}, cfg: cfg.ai, nowIso: nowIso(),
  });
  alertState = decided.state;
  const next = modelHealth.find((m) => m.rank > 1 && !A.routerModelState([m], [m.model])[m.model].skip);
  // Manual health runs record state but never alert.
  if (!manual) {
    messages = TA.alertMessages(decided.alerts, {
      primary: configured[0], requests_today: counters.requests_today, tokens_today: counters.tokens_today,
      tokens_reported_today: counters.tokens_reported_today, next_model: next ? next.model : null, next_rank: next ? next.rank : null,
    }, cfg.timezone);
  }
}

return [{
  json: {
    record: { usage, model_health: modelHealth, key_update: keyUpdate, alert_state: alertState, quota_state: quota.daily_state, configured_models: configured },
    ai_component: component,
    ai_messages: messages,
    models_check: modelsCheck,
    checked: due, probes: probed, notes,
  },
}];
