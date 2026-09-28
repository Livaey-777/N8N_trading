'use strict';
/**
 * Telegram views for the AI control center: /usage, /ai menus, AI usage/limit/fallback alerts and
 * the daily-report AI section. Never contains keys; tokens/cost only as reported by the provider.
 */
const { esc, localTime, RULE } = require('./telegram');
const { LEVEL_LABEL, capacityLabel, modelHealth, accountQuota, aiSystemStatus } = require('./aiusage');
const { MAIN_MENU_KEYBOARD } = require('./telegram-menu');

const b = (s) => `<b>${esc(s)}</b>`;
const i = (s) => `<i>${esc(s)}</i>`;
const code = (s) => `<code>${esc(s)}</code>`;
const STATUS_ICON = { HEALTHY: '🟢', DEGRADED: '🟠', RATE_LIMITED: '🟠', OFFLINE: '🔴', UNKNOWN: '⚪', STANDBY: '🟡', LIMITED: '🟠' };
const QUOTA_ICON = { HEALTHY: '🟢', LOW: '🟡', NEAR_LIMIT: '🟠', LIMIT_REACHED: '🔴', UNKNOWN: '⚪', OFFLINE: '🔴' };
const RANK_ICON = ['🥇', '🥈', '🥉'];

const AI_MENU_KEYBOARD = {
  inline_keyboard: [
    [{ text: '📊 USAGE', callback_data: '/ai usage' }, { text: '🩺 HEALTH', callback_data: '/ai health' }],
    [{ text: '🧠 CURRENT MODEL', callback_data: '/ai model' }, { text: '🔄 FALLBACK STATUS', callback_data: '/ai fallback' }],
    [{ text: '⚙️ CONFIGURATION', callback_data: '/ai config' }, { text: '📉 RECENT FAILURES', callback_data: '/ai failures' }],
    [{ text: '📈 FORECASTS BY MODEL', callback_data: '/ai performance' }],
    [{ text: '⬅️ BACK', callback_data: '/start' }],
  ],
};
const BACK_TO_AI = { inline_keyboard: [[{ text: '⬅️ AI MENU', callback_data: '/ai' }]] };

function fmtInt(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return 'n/a';
  return Math.round(Number(n)).toLocaleString('en-US');
}
/** Token text: UNKNOWN when the provider reported none; partial coverage is stated. */
function tokensText(total, reported, requests) {
  const req = Number(requests || 0);
  const rep = Number(reported || 0);
  if (req === 0) return '0';
  if (rep === 0) return 'UNKNOWN (not reported by the provider)';
  if (rep < req) return `${fmtInt(total)} (reported for ${rep}/${req} requests)`;
  return fmtInt(total);
}
function costText(cost, reported, requests) {
  if (!Number(requests || 0)) return '0';
  if (!Number(reported || 0)) return 'UNKNOWN';
  const c = Number(cost || 0);
  return `${c === 0 ? '0' : c.toFixed(6)} credits (provider-reported${Number(reported) < Number(requests) ? `, ${reported}/${requests} requests` : ''})`;
}
function when(iso, tz) { return iso ? localTime(iso, tz) : 'never'; }
function displayStatus(m) {
  if (m.status === 'UNKNOWN' && m.listed && !Number(m.requests_today || 0) && !m.last_success) return 'STANDBY';
  return m.status || 'UNKNOWN';
}
function modelTitle(m) {
  const name = m.display_name ? String(m.display_name).replace(/\s*\(free\)\s*$/i, '') : m.model;
  return `${b(name)}\n${code(m.model)}`;
}

/** Merges configured ranks with health rows and usage aggregates into display rows. */
function modelRows(configured, health, perModel) {
  const hBy = Object.fromEntries((health || []).map((r) => [r.model, r]));
  const uBy = Object.fromEntries((perModel || []).filter((r) => r.provider === 'openrouter').map((r) => [r.model, r]));
  return configured.map((model, idx) => {
    const h = hBy[model] || {};
    const u = uBy[model] || {};
    return { rank: idx + 1, model, provider: 'openrouter', ...h, ...u, status: h.current_status || 'UNKNOWN', reason: h.status_reason || null };
  });
}

function quotaLine(q) {
  if (!q || !q.daily_binding) return 'UNKNOWN';
  const d = q.daily_binding;
  const lim = d.limit ? `${fmtInt(d.used)} / ${fmtInt(d.limit)} ${d.dimension}` : `${fmtInt(d.used)} ${d.dimension} (no limit known)`;
  return `${QUOTA_ICON[q.daily_state] || ''} ${q.daily_state} — ${lim} · ${d.source}`;
}

/**
 * View model for /usage, /ai views and the daily section, from the SQL usage snapshot.
 * Model status is recomputed now (backoff windows expire between checks).
 */
function buildUsageView(snap, cfg, cfgView, nowIso) {
  const s = snap || {};
  const health = (s.health || []).map((r) => { const h = modelHealth(r); return { ...r, current_status: h.status, status_reason: h.reason }; });
  const models = modelRows(cfg.ai.models, health, s.per_model).map((m) => ({ ...m, last_success: m.last_success || m.last_success_request || null }));
  const quota = accountQuota({ key: s.key, usage: s.counters || {}, cfg: cfg.ai, nowIso: nowIso || new Date().toISOString() });
  const t = s.totals || {};
  const lu = s.last_used || null;
  const configured = cfg.secrets.openrouterConfigured;
  return {
    configured, models, quota, key: s.key || null, counters: s.counters || {},
    system: {
      requests_today: Number(t.requests_today || 0), tokens_today: Number(t.tokens_today || 0), tokens_reported_today: Number(t.tokens_reported_today || 0),
      failures_today: Number(t.failures_today || 0), fallback_events_today: Number(t.fallback_events_today || 0),
      deterministic_today: Number(t.deterministic_today || 0), cached_today: Number(t.cached_today || 0),
      cost_today: t.cost_today, cost_reported_today: Number(t.cost_reported_today || 0),
      requests_7d: Number(t.requests_7d || 0), cost_7d: t.cost_7d, cost_7d_reported: Number(t.cost_7d_reported || 0),
      requests_30d: Number(t.requests_30d || 0), cost_30d: t.cost_30d, cost_30d_reported: Number(t.cost_30d_reported || 0),
      last_model: lu ? lu.model : null, last_model_at: lu ? lu.at : null, last_level: lu ? lu.fallback_level : null,
    },
    last24: {
      requests: Number(t.requests_24h || 0), tokens: Number(t.tokens_24h || 0), tokens_reported: Number(t.tokens_reported_24h || 0),
      failures: Number(t.failures_24h || 0), fallbacks: Number(t.fallbacks_24h || 0), deterministic: Number(t.deterministic_24h || 0),
      top_requests: s.top_requests_24h || null, top_tokens: s.top_tokens_24h || null,
    },
    failures: s.failures || [], last_fallback: s.last_fallback || null, performance: s.performance || [],
    limits: cfgView.ai_limits, model_source: cfg.ai.modelSource,
    ai_status: aiSystemStatus({ configured, quotaState: quota.state, modelStatuses: models.map((m) => m.status) }),
  };
}

/** 🤖 AI USAGE CENTER (spec §1, §15, §28). */
function formatUsageCenter(u, tz) {
  const lines = [`🤖 ${b('AI USAGE CENTER')} — ${esc(localTime(new Date().toISOString(), tz))}`];
  if (!u.configured) lines.push(`${b('OPENROUTER_API_KEY:')} NOT CONFIGURED — every analysis uses the deterministic engine.`);
  for (const m of u.models) {
    const st = displayStatus(m);
    lines.push(RULE,
      `${RANK_ICON[m.rank - 1] || '•'} ${b(LEVEL_LABEL[m.rank - 1] || `RANK ${m.rank}`)}`,
      modelTitle(m),
      `${b('Provider:')} OpenRouter · ${b('Status:')} ${STATUS_ICON[st] || ''} ${esc(st)}${m.reason && st !== 'HEALTHY' && st !== 'STANDBY' ? ` — ${esc(m.reason)}` : ''}`,
      `${b('Requests:')} ${fmtInt(m.requests_today || 0)} today · ${fmtInt(m.requests_hour || 0)} last hour`,
      `${b('Tokens today:')} ${esc(tokensText(m.tokens_today, m.tokens_reported_today, m.requests_today))}`,
      `${b('Last request:')} ${esc(when(m.last_request, tz))} · ${b('Last success:')} ${esc(when(m.last_success, tz))}`,
      `${b('Failures:')} ${fmtInt(m.failures_today || 0)} today · ${b('Fallbacks:')} ${fmtInt(m.fallbacks_today || 0)}`,
      `${b('Estimated remaining capacity:')} ${esc(u.configured ? capacityLabel(u.quota.daily_state) : 'UNKNOWN')}${u.configured ? ' (shared account quota)' : ''}`);
  }
  const s = u.system;
  const byRank = (r) => fmtInt((u.models.find((m) => m.rank === r) || {}).requests_today || 0);
  lines.push(RULE, `📦 ${b('SYSTEM')}`,
    `${b('Total AI requests today:')} ${fmtInt(s.requests_today)}`,
    `${b('Total AI tokens today:')} ${esc(tokensText(s.tokens_today, s.tokens_reported_today, s.requests_today))}`,
    `${b('Primary / Secondary / Tertiary:')} ${byRank(1)} / ${byRank(2)} / ${byRank(3)}`,
    `${b('Fallback events:')} ${fmtInt(s.fallback_events_today)} · ${b('AI failures:')} ${fmtInt(s.failures_today)} · ${b('Cache hits:')} ${fmtInt(s.cached_today)}`,
    `${b('Deterministic fallbacks:')} ${fmtInt(s.deterministic_today)}`,
    `${b('Last model used:')} ${s.last_model ? `${code(s.last_model)} (${esc(LEVEL_LABEL[s.last_level] || '')}, ${esc(when(s.last_model_at, tz))})` : 'none yet'}`,
    `${b('Quota:')} ${esc(u.configured ? quotaLine(u.quota) : 'UNKNOWN')}`,
    u.key && u.key.free_requests_limit !== null && u.key.free_requests_limit !== undefined
      ? `${b('Provider counter:')} ${fmtInt(u.key.free_requests_used)} / ${fmtInt(u.key.free_requests_limit)} free-model requests (UTC day, checked ${esc(when(u.key.checked_at, tz))})`
      : `${b('Provider counter:')} not available${u.configured ? ' yet (checked by the Health Monitor)' : ''}`,
    `${b('Cost today:')} ${esc(costText(s.cost_today, s.cost_reported_today, s.requests_today))}`,
    `${b('Cost 7d / 30d:')} ${esc(costText(s.cost_7d, s.cost_7d_reported, s.requests_7d))} / ${esc(costText(s.cost_30d, s.cost_30d_reported, s.requests_30d))}`,
    `${b('AI STATUS:')} ${STATUS_ICON[u.ai_status] || ''} ${esc(u.ai_status)}`);
  const l = u.last24;
  const avail = (r) => {
    const m = u.models.find((x) => x.rank === r);
    if (!m) return 'n/a';
    const req = Number(m.requests_24h || 0);
    return req ? `${Math.round((100 * Number(m.success_24h || 0)) / req)}% (${m.success_24h}/${req})` : 'no requests';
  };
  lines.push(RULE, `🕘 ${b('LAST 24 HOURS')}`,
    `${b('Requests:')} ${fmtInt(l.requests)} · ${b('Tokens:')} ${esc(tokensText(l.tokens, l.tokens_reported, l.requests))}`,
    `${b('Failures:')} ${fmtInt(l.failures)} · ${b('Fallbacks:')} ${fmtInt(l.fallbacks)}`,
    `${b('Top model by requests:')} ${l.top_requests ? code(l.top_requests) : 'none'}`,
    `${b('Top model by tokens:')} ${l.top_tokens ? code(l.top_tokens) : (l.requests ? 'UNKNOWN' : 'none')}`,
    `${b('Primary availability:')} ${esc(avail(1))}`,
    `${b('Secondary availability:')} ${esc(avail(2))}`,
    `${b('Tertiary availability:')} ${esc(avail(3))}`,
    `${b('AI deterministic fallback count:')} ${fmtInt(l.deterministic)}`,
    i('Days are UTC (OpenRouter resets free-model counters at 00:00 UTC). Tokens and cost are shown only as reported by the provider.'));
  return lines.join('\n');
}

function formatAiMenu(u, tz) {
  const active = u.models.find((m) => m.status !== 'OFFLINE' && m.status !== 'RATE_LIMITED');
  return [
    `🤖 ${b('AI CONTROL CENTER')}`,
    `${b('AI status:')} ${STATUS_ICON[u.ai_status] || ''} ${esc(u.ai_status)} · ${b('quota:')} ${esc(u.configured ? u.quota.daily_state : 'UNKNOWN')}`,
    `${b('Current route:')} ${active ? code(active.model) : 'DETERMINISTIC'}`,
    `${b('Requests today:')} ${fmtInt(u.system.requests_today)} · ${b('failures:')} ${fmtInt(u.system.failures_today)} · ${b('fallbacks:')} ${fmtInt(u.system.fallback_events_today)}`,
    '',
    i(`Choose a view below (or /ai usage · /ai health · /ai model · /ai fallback · /ai config · /ai failures · /ai performance). ${localTime(new Date().toISOString(), tz)}`),
  ].join('\n');
}

function formatAiHealth(u, tz) {
  const lines = [`🩺 ${b('AI HEALTH')}`];
  for (const m of u.models) {
    const st = displayStatus(m);
    lines.push(RULE, `${RANK_ICON[m.rank - 1] || '•'} ${b(LEVEL_LABEL[m.rank - 1] || `RANK ${m.rank}`)}`, modelTitle(m),
      `${b('Status:')} ${STATUS_ICON[st] || ''} ${esc(st)}${m.reason && st !== 'STANDBY' ? ` — ${esc(m.reason)}` : st === 'STANDBY' ? ' — available, not used yet' : ''}`,
      `${b('Latency:')} ${m.average_latency ? `${fmtInt(m.average_latency)} ms avg (${fmtInt(m.latency_samples)} successful)` : 'n/a'}`,
      `${b('Last success:')} ${esc(when(m.last_success, tz))} · ${b('Last failure:')} ${esc(when(m.last_failure, tz))}${m.last_error_type ? ` (${esc(m.last_error_type)})` : ''}`,
      `${b('Provider list:')} ${m.listed === true ? 'listed' : m.listed === false ? 'NOT LISTED (MODEL_UNAVAILABLE)' : 'not checked yet'} · ${b('price:')} ${m.free === true ? 'free (0)' : m.free === false ? 'NOT FREE' : 'unknown'}`,
      `${b('Last health check:')} ${esc(when(m.last_health_check, tz))}${m.skip_until && Date.parse(m.skip_until) > Date.now() ? ` · ${b('skipped until')} ${esc(when(m.skip_until, tz))}` : ''}`);
  }
  lines.push(RULE, `⚙️ ${b('DETERMINISTIC:')} 🟢 READY (always available, no network)`);
  if (u.key) lines.push(`${b('API key')} ${code(u.key.key_alias)}: ${esc(u.key.status)}${u.key.checked_at ? ` · checked ${esc(when(u.key.checked_at, tz))}` : ''}`);
  return lines.join('\n');
}

function formatAiModel(u, tz) {
  const active = u.models.find((m) => m.status !== 'OFFLINE' && m.status !== 'RATE_LIMITED' && !(m.skip_until && Date.parse(m.skip_until) > Date.now()));
  const lines = [`🧠 ${b('CURRENT AI ROUTING')}`];
  for (const m of u.models) lines.push(`${b(`${LEVEL_LABEL[m.rank - 1]}:`)} ${code(m.model)} — ${STATUS_ICON[displayStatus(m)] || ''} ${esc(displayStatus(m))}`);
  lines.push(`${b('FALLBACK:')} DETERMINISTIC (always available)`,
    RULE,
    `${b('CURRENTLY ACTIVE:')} ${u.configured ? (active ? code(active.model) : 'DETERMINISTIC (no usable model)') : 'DETERMINISTIC (OPENROUTER_API_KEY not configured)'}`,
    `${b('LAST SUCCESSFUL MODEL:')} ${u.system.last_model ? `${code(u.system.last_model)} (${esc(when(u.system.last_model_at, tz))})` : 'none yet'}`,
    `${b('LAST FALLBACK:')} ${u.last_fallback ? `${esc(when(u.last_fallback.at, tz))} → ${code(u.last_fallback.model)}${u.last_fallback.reason ? ` after ${esc(u.last_fallback.reason)}` : ''}` : 'none'}`,
    i(`Configured via ${u.model_source}. API keys are never shown.`));
  return lines.join('\n');
}

function formatAiFailures(u, tz) {
  const f = u.failures || [];
  if (!f.length) return `📉 ${b('RECENT AI FAILURES')}\nNo AI failures recorded.`;
  return [`📉 ${b('RECENT AI FAILURES')} (last ${f.length})`, ...f.map((x) => [
    `• ${esc(when(x.request_timestamp, tz))} · ${esc(x.provider)} · ${code(x.model)}`,
    `  ${b(x.error_type || 'ERROR')}${x.error_detail ? ` — ${esc(String(x.error_detail).slice(0, 120))}` : ''}`,
    `  fallback: ${esc(LEVEL_LABEL[Math.min(3, Number(x.fallback_level || 0) + 1)])} · resolution: ${esc(x.resolved_by ? (x.resolved_by === 'deterministic' ? 'DETERMINISTIC' : `answered by ${x.resolved_by}`) : 'unresolved / not recorded')}${x.workflow ? ` · ${esc(x.workflow)}` : ''}`,
  ].join('\n'))].join('\n');
}

function formatAiFallback(u, tz) {
  const s = u.system;
  const lines = [`🔄 ${b('FALLBACK STATUS')}`,
    `${b('Fallback events today:')} ${fmtInt(s.fallback_events_today)} · ${b('last hour:')} ${fmtInt(u.counters.fallbacks_1h)} (alert threshold ${fmtInt(u.limits.fallback_threshold)}/h)`,
    `${b('Deterministic fallbacks today:')} ${fmtInt(s.deterministic_today)}`,
    `${b('Last fallback:')} ${u.last_fallback ? `${esc(when(u.last_fallback.at, tz))} → ${code(u.last_fallback.model)}${u.last_fallback.reason ? ` (${esc(u.last_fallback.reason)})` : ''}` : 'none'}`,
    RULE];
  for (const m of u.models) {
    lines.push(`${RANK_ICON[m.rank - 1] || '•'} ${code(m.model)} — ${STATUS_ICON[displayStatus(m)] || ''} ${esc(displayStatus(m))}${m.skip_until && Date.parse(m.skip_until) > Date.now() ? ` · skipped until ${esc(when(m.skip_until, tz))}` : ''}`);
  }
  lines.push(i('Temporary fallbacks are logged silently; an alert is sent only when fallback persists or the primary becomes unhealthy.'));
  return lines.join('\n');
}

function formatAiConfig(u) {
  const L = u.limits;
  const lim = (x, unit) => (Number(x) > 0 ? `${fmtInt(x)} ${unit}` : 'not configured');
  return [`⚙️ ${b('AI CONFIGURATION')}`,
    `${b('OpenRouter key:')} ${u.configured ? 'CONFIGURED' : 'NOT CONFIGURED'}${u.key ? ` (alias ${code(u.key.key_alias)})` : ''}`,
    `${b('Model source:')} ${esc(u.model_source)}`,
    ...u.models.map((m) => `${b(`${LEVEL_LABEL[m.rank - 1]}:`)} ${code(m.model)} — ${m.listed === false ? '❌ not listed' : m.listed ? '✅ listed' : '… not checked'}${m.free === false ? ', ❌ not free' : m.free ? ', free' : ''}`),
    RULE,
    `${b('Max requests/day:')} ${lim(L.max_requests_day, '(AI_MAX_REQUESTS_DAY)')}`,
    `${b('Max requests/hour:')} ${lim(L.max_requests_hour, '(AI_MAX_REQUESTS_HOUR)')}`,
    `${b('Max tokens/day:')} ${lim(L.max_tokens_day, '(AI_MAX_TOKENS_DAY)')}`,
    `${b('Max tokens/request:')} ${fmtInt(L.max_tokens_request)}`,
    `${b('Warning / critical:')} ${L.warning_pct}% / ${L.critical_pct}% of the limit`,
    `${b('Fallback alert threshold:')} ${L.fallback_threshold}/hour`,
    `${b('Health check:')} every ${L.health_check_interval_min} min · probes: ${esc(L.probe)}${L.probe === 'idle' ? ` (only models idle > ${L.probe_idle_hours}h)` : ''}`,
    `${b('Cache TTL:')} ${L.cache_ttl_min ? `${L.cache_ttl_min} min` : 'disabled'} · ${b('alert cooldown:')} ${L.alert_cooldown_min} min`,
    RULE,
    i('Change models or limits in .env (OPENROUTER_PRIMARY_MODEL / _SECONDARY_ / _TERTIARY_, AI_*) and restart n8n. A model that disappears or stops being free is skipped automatically (MODEL_UNAVAILABLE / NOT_FREE) and the next one is used. Keys are never rotated to get around quotas.')].join('\n');
}

function formatAiPerformance(rows) {
  const r = rows || [];
  if (!r.length) return `📈 ${b('FORECASTS BY MODEL')}\nNo stored forecasts yet.`;
  return [`📈 ${b('FORECASTS BY MODEL')}`,
    i('Forecast state, score and confidence are deterministic; this describes the forecasts each model explained. Not a model ranking.'),
    ...r.map((x) => [
      RULE, code(x.model),
      `forecasts ${x.forecasts} · evaluated ${x.evaluated} · correct ${x.correct} · incorrect ${x.incorrect} · mixed ${x.mixed}`,
      `avg confidence ${x.average_confidence ?? 'n/a'} · avg |error| ${x.average_error ?? 'n/a'} · avg latency ${x.average_latency ? `${x.average_latency} ms` : 'n/a'} · fallback rate ${x.fallback_rate === null || x.fallback_rate === undefined ? 'n/a' : `${Math.round(100 * x.fallback_rate)}%`}`,
      i(x.note),
    ].join('\n'))].join('\n');
}

// ---- alerts -----------------------------------------------------------------
function formatQuotaWarning(a, ctx, tz) {
  const d = a.binding || {};
  return [`⚠️ ${b('AI QUOTA WARNING')}`,
    `${b('SCOPE:')} OpenRouter account (shared by all free models)`,
    `${b('PRIMARY:')} ${ctx.primary ? code(ctx.primary) : 'n/a'}`,
    `${b('USAGE:')} ${fmtInt(d.used)} / ${d.limit ? fmtInt(d.limit) : 'n/a'} ${esc(d.dimension || '')}`,
    `${b('LIMIT:')} ${esc(d.source || 'n/a')}`,
    `${b('ESTIMATED REMAINING:')} ${d.remaining === null || d.remaining === undefined ? 'UNKNOWN' : fmtInt(d.remaining)}`,
    `${b('STATUS:')} ${QUOTA_ICON[a.state] || ''} ${esc(a.state.replace('_', ' '))} (was ${esc(a.previous)})`,
    `${b('REQUESTS TODAY:')} ${fmtInt(ctx.requests_today)} · ${b('TOKENS TODAY:')} ${esc(tokensText(ctx.tokens_today, ctx.tokens_reported_today, ctx.requests_today))}`,
    `${b('ACTION:')} lower-priority AI requests are now answered deterministically; fallback will be used if the next request fails. Telegram keeps receiving gold intelligence.`,
    i(`One message per state change · ${localTime(new Date().toISOString(), tz)}`)].join('\n');
}

function formatLimitReached(a, ctx, tz) {
  const d = a.binding || {};
  const model = a.model || ctx.primary;
  return [`🚫 ${b('AI MODEL LIMIT REACHED')}`,
    `${b('MODEL:')} ${model ? code(model) : 'all OpenRouter free models (account limit)'}`,
    `${b('PROVIDER:')} OpenRouter`,
    `${b('REQUESTS:')} ${fmtInt(a.requests_today ?? ctx.requests_today)} today${d.limit ? ` / ${fmtInt(d.limit)} (${esc(d.source)})` : ''}`,
    `${b('TOKENS:')} ${esc(tokensText(a.tokens_today ?? ctx.tokens_today, ctx.tokens_reported_today, ctx.requests_today))}`,
    `${b('REASON:')} ${esc(a.reason || (d.source ? `${d.dimension} limit reached (${d.source})` : 'provider rejected requests'))}`,
    `${b('FALLBACK:')} ${esc(a.scope === 'model' ? (ctx.next_model ? `${LEVEL_LABEL[Math.min(2, (a.rank || 1))]} ${ctx.next_model}` : 'DETERMINISTIC') : 'DETERMINISTIC')}`,
    `${b('NEXT ACTION:')} ${esc(a.scope === 'model' ? 'the next configured model is used; the limited model is retried after its reset' : 'deterministic analysis until the counter resets (00:00 UTC) — no key rotation, provider limits are respected')}`,
    i(localTime(new Date().toISOString(), tz))].join('\n');
}

const REASON_LABEL = { TIMEOUT: 'TIMEOUT', RATE_LIMIT: 'RATE LIMIT', QUOTA_EXHAUSTED: 'RATE LIMIT (daily quota)', API_ERROR: 'API ERROR', INVALID_OUTPUT: 'INVALID OUTPUT', OFFLINE: 'OFFLINE', MODEL_UNAVAILABLE: 'OFFLINE (model unavailable)', AUTH_ERROR: 'API ERROR (authentication)' };
function formatFallbackAlert(a, ctx, tz) {
  const lf = a.lastFailure || {};
  const level = ctx.next_model ? (ctx.next_rank === 2 ? '1' : '2') : 'DETERMINISTIC';
  return [`🔄 ${b('AI FALLBACK')}`,
    `${b('PRIMARY:')} ${a.model ? code(a.model) : 'n/a'}`,
    `${b('REASON:')} ${esc(REASON_LABEL[lf.error_type] || lf.error_type || a.reason || 'unknown')}${lf.detail ? ` — ${esc(String(lf.detail).slice(0, 140))}` : ''}`,
    `${b('TRIGGER:')} ${esc(a.trigger)}`,
    `${b('NEW MODEL:')} ${ctx.next_model ? code(ctx.next_model) : 'DETERMINISTIC'}`,
    `${b('FALLBACK LEVEL:')} ${esc(level)}`,
    i(`Sent only for persistent fallback / unhealthy primary · ${localTime(new Date().toISOString(), tz)}`)].join('\n');
}

/** Builds Telegram messages for decideAlerts() output. */
function alertMessages(alerts, ctx, tz) {
  return (alerts || []).map((a) => {
    const text = a.kind === 'QUOTA_WARNING' ? formatQuotaWarning(a, ctx, tz) : a.kind === 'LIMIT_REACHED' ? formatLimitReached(a, ctx, tz) : formatFallbackAlert(a, ctx, tz);
    const key = a.kind === 'FALLBACK' ? `ai:fallback:${a.model || 'primary'}` : `ai:${a.kind.toLowerCase()}:${a.scope || 'account'}:${a.model || a.state || ''}`;
    return { text, message_type: 'AI_ALERT', dedup_key: key, dedup_window_min: 60, related_ref: 'ai-usage', is_test: false };
  });
}

/** Compact daily-report section (spec §22). */
function dailyAiSection(u) {
  if (!u) return [];
  const st = (r) => {
    const m = u.models.find((x) => x.rank === r);
    return m ? `${code(m.model)} ${STATUS_ICON[displayStatus(m)] || ''} ${esc(displayStatus(m))}` : 'n/a';
  };
  const active = u.models.find((m) => m.status !== 'OFFLINE' && m.status !== 'RATE_LIMITED');
  return [RULE, `🤖 ${b('AI HEALTH')}`,
    `${b('Primary:')} ${st(1)}`, `${b('Secondary:')} ${st(2)}`, `${b('Tertiary:')} ${st(3)}`,
    `${b('Requests today:')} ${fmtInt(u.system.requests_today)} · ${b('Tokens today:')} ${esc(tokensText(u.system.tokens_today, u.system.tokens_reported_today, u.system.requests_today))}`,
    `${b('Fallbacks:')} ${fmtInt(u.system.fallback_events_today)} · ${b('Failures:')} ${fmtInt(u.system.failures_today)}`,
    `${b('Current active model:')} ${u.configured && active ? code(active.model) : 'DETERMINISTIC'} · ${b('AI status:')} ${STATUS_ICON[u.ai_status] || ''} ${esc(u.ai_status)}`];
}

module.exports = {
  AI_MENU_KEYBOARD, MAIN_MENU_KEYBOARD, BACK_TO_AI, modelRows, buildUsageView, tokensText, costText, displayStatus,
  formatUsageCenter, formatAiMenu, formatAiHealth, formatAiModel, formatAiFailures, formatAiFallback, formatAiConfig,
  formatAiPerformance, formatQuotaWarning, formatLimitReached, formatFallbackAlert, alertMessages, dailyAiSection,
};
