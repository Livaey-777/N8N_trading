'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/lib/aiusage');
const { routeRequests, OUTPUT_TEMPLATE, rateLimitHeaders } = require('../src/lib/ai');
const { loadConfig, describeConfig } = require('../src/lib/config');
const TA = require('../src/lib/telegram-ai');
const M = require('../src/lib/telegram-menu');
const B = require('../src/lib/biggest');
const { sendMessages } = require('../src/lib/telegram');

const cfg = loadConfig({});
const NOW = '2026-09-28T12:00:00.000Z';

function fakeHttp(script) {
  let i = 0;
  const calls = [];
  const fn = async (r) => { calls.push(r); const step = script[Math.min(i++, script.length - 1)]; if (step instanceof Error) throw step; return step; };
  fn.calls = calls;
  return fn;
}
const good = () => ({
  ...OUTPUT_TEMPLATE, summary: 'Real yields dominate while the safe-haven bid offsets part of it.', interpretation: 'Real yields pressure gold.',
  dominant_driver: 'REAL_YIELD', secondary_driver: 'SAFE_HAVEN', counter_driver: 'SAFE_HAVEN', market_confirmation: 'pending',
  regime: 'RATES', short_bias: 'MIXED', tactical_bias: 'MIXED', swing_bias: 'BEARISH', structural_bias: 'NEUTRAL',
  bullish_scenario: 'Soft print.', base_scenario: 'In line.', bearish_scenario: 'Hot print.', confidence: 60, telegram_summary: 'Mixed pre-event setup: yields versus safe haven.',
});
const facts = { deterministic: { confidence: 45, forecast_state: 'MIXED' }, current_state: { gold: { value: 4286.2 }, usd: { value: 100.9 }, yields: { us10y: 5.17, us2y: 4.81, real10y: 2.83 }, desk_regime: 'RATES' } };
const req = (over = {}) => ({ ref: 'r1', purpose: 'PRE_EVENT', use_ai: true, facts, deterministic: { ...good(), summary: 'deterministic' }, ...over });
const okBody = (o, usage) => ({ statusCode: 200, headers: {}, body: { choices: [{ message: { content: JSON.stringify(o) } }], usage } });

test('priorities: critical/high events first, daily last; gates tighten with quota pressure', () => {
  assert.equal(A.requestPriority({ purpose: 'EVENT', facts: { event: { importance_class: 'CRITICAL' } } }), A.PRIORITY.CRITICAL_EVENT);
  assert.equal(A.requestPriority({ purpose: 'EVENT', facts: { event: { importance_class: 'HIGH' } } }), A.PRIORITY.HIGH_EVENT);
  assert.equal(A.requestPriority({ purpose: 'DAILY' }), A.PRIORITY.DAILY);
  assert.equal(A.requestPriority({ purpose: 'BIGGEST' }), A.PRIORITY.BIGGEST);
  assert.equal(A.priorityAllowed(A.PRIORITY.DAILY, 'HEALTHY'), true);
  assert.equal(A.priorityAllowed(A.PRIORITY.DAILY, 'LOW'), false);
  assert.equal(A.priorityAllowed(A.PRIORITY.PRE_EVENT, 'LOW'), true);
  assert.equal(A.priorityAllowed(A.PRIORITY.PRE_EVENT, 'NEAR_LIMIT'), false);
  assert.equal(A.priorityAllowed(A.PRIORITY.CRITICAL_EVENT, 'NEAR_LIMIT'), true);
  assert.equal(A.priorityAllowed(A.PRIORITY.CRITICAL_EVENT, 'LIMIT_REACHED'), false);
});

test('error types: per-day quota vs per-minute rate limit, unavailable model, invalid output', () => {
  assert.equal(A.errorTypeOf('RATE_LIMITED: Rate limit exceeded: free-models-per-day'), 'QUOTA_EXHAUSTED');
  assert.equal(A.errorTypeOf('RATE_LIMITED: Rate limit exceeded: free-models-per-min'), 'RATE_LIMIT');
  assert.equal(A.errorTypeOf('MODEL_NOT_FOUND: x is not a valid model ID'), 'MODEL_UNAVAILABLE');
  assert.equal(A.errorTypeOf('TIMEOUT: timeout of 60000ms exceeded'), 'TIMEOUT');
  assert.equal(A.errorTypeOf('NETWORK_ERROR: getaddrinfo ENOTFOUND'), 'OFFLINE');
  assert.equal(A.errorTypeOf('SCHEMA_INVALID'), 'INVALID_OUTPUT');
  assert.equal(A.errorTypeOf('PROVIDER_ERROR: upstream'), 'API_ERROR');
});

test('quota state: thresholds on a real limit; UNKNOWN without one (never fabricated)', () => {
  const q = (used) => A.quotaState({ used, limit: 50, warningPct: 70, criticalPct: 90 }).state;
  assert.equal(q(10), 'HEALTHY');
  assert.equal(q(35), 'LOW');
  assert.equal(q(46), 'NEAR_LIMIT');
  assert.equal(q(50), 'LIMIT_REACHED');
  assert.equal(A.quotaState({ used: 5, limit: null, warningPct: 70, criticalPct: 90 }).state, 'UNKNOWN');
  assert.equal(A.quotaState({ used: 5, limit: 50, warningPct: 70, criticalPct: 90, exhausted: true }).state, 'LIMIT_REACHED');
});

test('account quota prefers the provider counter when it was reported today; hourly burst gates but does not alert', () => {
  const key = { checked_at: '2026-09-28T09:00:00Z', free_requests_used: 40, free_requests_limit: 50, free_requests_remaining: 10 };
  const q = A.accountQuota({ key, usage: { requests_today: 5, requests_hour: 1, free_requests_since_key_check: 3 }, cfg: cfg.ai, nowIso: NOW });
  const prov = q.dims.find((d) => /PROVIDER/.test(d.source));
  assert.equal(prov.used, 43);
  assert.equal(prov.state, 'LOW');
  assert.equal(q.daily_state, 'LOW');
  assert.ok(q.provider_reported);
  const stale = A.accountQuota({ key: { ...key, checked_at: '2026-09-27T09:00:00Z' }, usage: { requests_today: 1 }, cfg: cfg.ai, nowIso: NOW });
  assert.ok(!stale.provider_reported, 'yesterday\'s counter is not used');
  const burst = A.accountQuota({ key: null, usage: { requests_today: 12, requests_hour: 12 }, cfg: cfg.ai, nowIso: NOW });
  assert.equal(burst.state, 'LIMIT_REACHED');
  assert.equal(burst.daily_state, 'HEALTHY');
  assert.ok(!burst.dims.some((d) => d.dimension === 'tokens/day'), 'no token limit configured -> no token dimension');
});

test('model health: success, rate-limit backoff, daily quota until UTC midnight, circuit breaker, unavailable/not free', () => {
  const at = '2026-09-28T10:00:00.000Z';
  let r = A.applyAttempt({}, { success: true, latency_ms: 800, at });
  assert.equal(r.current_status, 'HEALTHY');
  assert.equal(r.average_latency, 800);
  r = A.applyAttempt(r, { success: false, error_type: 'RATE_LIMIT', retry_after_s: 5, at });
  assert.equal(Date.parse(r.skip_until) - Date.parse(at), 60000, 'at least 60 s backoff');
  assert.equal(A.modelHealth(r, Date.parse(at) + 1000).status, 'RATE_LIMITED');
  const q = A.applyAttempt({}, { success: false, error_type: 'QUOTA_EXHAUSTED', at });
  assert.equal(q.skip_until, '2026-09-29T00:00:00.000Z');
  let c = {};
  for (let k = 0; k < 3; k++) c = A.applyAttempt(c, { success: false, error_type: 'TIMEOUT', at });
  assert.equal(c.current_status, 'DEGRADED');
  assert.equal(Date.parse(c.skip_until) - Date.parse(at), 15 * 60000);
  const s = A.routerModelState([{ model: 'm1', listed: false }, { model: 'm2', free: false }, { model: 'm3', success_count: 2 }], ['m1', 'm2', 'm3']);
  assert.ok(s.m1.skip && s.m2.skip && !s.m3.skip);
  assert.equal(s.m1.status, 'OFFLINE');
});

test('router: PRIMARY 429 -> SECONDARY answers; tokens, cost, fallback level and rate-limit headers recorded', async () => {
  const http = fakeHttp([
    { statusCode: 429, headers: { 'X-RateLimit-Limit': '20', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1790000000000', 'Retry-After': '7' }, body: { error: { code: 429, message: 'Rate limit exceeded: free-models-per-min' } } },
    okBody(good(), { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1200, cost: 0 }),
  ]);
  const out = await routeRequests({ requests: [req()], models: ['p:free', 's:free', 't:free'], apiKey: 'k', http, timeoutMs: 1000, maxTokens: 500, budgetRemaining: 10, secrets: ['k'] });
  const r = out.results[0];
  assert.equal(r.mode, 'AI');
  assert.equal(r.model, 's:free');
  assert.equal(r.fallback_level, 1);
  const [a1, a2] = r.attempts;
  assert.equal(A.errorTypeOf(a1.failure_reason), 'RATE_LIMIT');
  assert.equal(a1.ratelimit.remaining, 0);
  assert.equal(a1.retry_after_s, 7);
  assert.equal(a2.total_tokens, 1200);
  assert.equal(a2.cost, 0);
  assert.ok(r.raw_output && r.raw_output.confidence === 60, 'raw AI output kept for the cache');
  assert.equal(r.output.confidence, 45, 'deterministic confidence enforced');
});

test('router: skipped models cost no request; tokens UNKNOWN when not reported; max attempts respected', async () => {
  const http = fakeHttp([okBody(good(), undefined)]);
  const out = await routeRequests({ requests: [req()], models: ['p', 's'], apiKey: 'k', http, timeoutMs: 1000, maxTokens: 500, budgetRemaining: 10,
    modelState: { p: { skip: true, status: 'RATE_LIMITED', reason: 'backoff' } } });
  assert.equal(http.calls.length, 1);
  assert.equal(out.results[0].attempts[0].skipped, true);
  assert.equal(out.results[0].model, 's');
  assert.equal(out.results[0].attempts[1].total_tokens, null);
  const fail = fakeHttp([{ statusCode: 500, headers: {}, body: {} }]);
  const capped = await routeRequests({ requests: [req({ max_attempts: 1 })], models: ['a', 'b', 'c'], apiKey: 'k', http: fail, timeoutMs: 1000, maxTokens: 500, budgetRemaining: 10 });
  assert.equal(fail.calls.length, 1);
  assert.equal(capped.results[0].fallback_reason, 'MAX_ATTEMPTS_REACHED');
  const gated = await routeRequests({ requests: [req({ use_ai: false, skip_reason: 'QUOTA_LOW_PRIORITY_DAILY' })], models: ['a'], apiKey: 'k', http: fail, timeoutMs: 1, maxTokens: 1, budgetRemaining: 10 });
  assert.equal(gated.results[0].fallback_reason, 'QUOTA_LOW_PRIORITY_DAILY');
  assert.equal(rateLimitHeaders({}).limit, null);
});

test('cache fingerprint: immaterial moves reuse, material changes invalidate', () => {
  const base = req();
  const fp = A.fingerprint(base);
  const tiny = { ...base, facts: { ...facts, current_state: { ...facts.current_state, gold: { value: 4288 } } } };
  const big = { ...base, facts: { ...facts, current_state: { ...facts.current_state, gold: { value: 4340 } } } };
  const yields = { ...base, facts: { ...facts, current_state: { ...facts.current_state, yields: { ...facts.current_state.yields, us10y: 5.27 } } } };
  const state = { ...base, facts: { ...facts, deterministic: { ...facts.deterministic, forecast_state: 'BEARISH' } } };
  assert.equal(A.fingerprint(tiny), fp);
  assert.notEqual(A.fingerprint(big), fp);
  assert.notEqual(A.fingerprint(yields), fp);
  assert.notEqual(A.fingerprint(state), fp);
});

test('cache reuse: expiry, new critical event, stale numbers; deterministic fields re-applied', () => {
  const entry = { output: { ...good(), interpretation: 'Real yields at 2.83% pressure gold.' }, created_at: '2026-09-28T11:00:00Z', expires_at: '2026-09-28T14:00:00Z' };
  const nowMs = Date.parse(NOW);
  const ok = A.cacheReuse(entry, req(), { nowMs });
  assert.ok(ok.ok);
  assert.equal(ok.age_min, 60);
  assert.equal(ok.output.confidence, 45);
  assert.equal(ok.output.ai_confidence, 60);
  assert.equal(A.cacheReuse({ ...entry, expires_at: '2026-09-28T11:30:00Z' }, req(), { nowMs }).reason, 'EXPIRED');
  assert.equal(A.cacheReuse(entry, req(), { nowMs, criticalSince: '2026-09-28T11:30:00Z' }).reason, 'NEW_CRITICAL_EVENT');
  const moved = req({ facts: { ...facts, current_state: { ...facts.current_state, yields: { ...facts.current_state.yields, real10y: 2.84 } } } });
  assert.equal(A.cacheReuse(entry, moved, { nowMs }).reason, 'STALE_FACTS', 'a cached number that is no longer in the facts is not reused');
});

test('alerts: one message per state transition, cooldown against flapping, fallback threshold, primary health', () => {
  const c = { ...cfg.ai, alertCooldownMin: 180, fallbackThreshold: 3 };
  const quota = (state, used) => ({ daily_state: state, daily_binding: { dimension: 'requests/day', used, limit: 50, remaining: 50 - used, source: 'PROVIDER (GET /api/v1/key)' } });
  const models = (status) => [{ model: 'p', rank: 1, status }, { model: 's', rank: 2, status: 'HEALTHY' }];
  let r = A.decideAlerts({ prev: null, quota: quota('LOW', 36), models: models('HEALTHY'), usage: {}, cfg: c, nowIso: NOW });
  assert.deepEqual(r.alerts.map((a) => a.kind), ['QUOTA_WARNING']);
  let st = r.state;
  r = A.decideAlerts({ prev: st, quota: quota('LOW', 37), models: models('HEALTHY'), usage: {}, cfg: c, nowIso: '2026-09-28T12:10:00Z' });
  assert.equal(r.alerts.length, 0, 'same state -> no repeat');
  r = A.decideAlerts({ prev: r.state, quota: quota('NEAR_LIMIT', 46), models: models('HEALTHY'), usage: {}, cfg: c, nowIso: '2026-09-28T12:20:00Z' });
  assert.deepEqual(r.alerts.map((a) => a.kind), ['QUOTA_WARNING']);
  r = A.decideAlerts({ prev: r.state, quota: quota('LIMIT_REACHED', 50), models: models('HEALTHY'), usage: {}, cfg: c, nowIso: '2026-09-28T12:30:00Z' });
  assert.deepEqual(r.alerts.map((a) => a.kind), ['LIMIT_REACHED']);
  // Flapping LOW -> HEALTHY -> LOW within the cooldown: no second warning.
  st = A.decideAlerts({ prev: null, quota: quota('LOW', 36), models: models('HEALTHY'), usage: {}, cfg: c, nowIso: NOW }).state;
  st = A.decideAlerts({ prev: st, quota: quota('HEALTHY', 10), models: models('HEALTHY'), usage: {}, cfg: c, nowIso: '2026-09-28T12:05:00Z' }).state;
  assert.equal(A.decideAlerts({ prev: st, quota: quota('LOW', 36), models: models('HEALTHY'), usage: {}, cfg: c, nowIso: '2026-09-28T12:10:00Z' }).alerts.length, 0);
  // Primary becomes unhealthy -> one fallback alert; persistent state -> no repeat.
  r = A.decideAlerts({ prev: null, quota: quota('HEALTHY', 1), models: models('DEGRADED'), usage: {}, cfg: c, nowIso: NOW });
  assert.deepEqual(r.alerts.map((a) => a.kind), ['FALLBACK']);
  assert.equal(A.decideAlerts({ prev: r.state, quota: quota('HEALTHY', 1), models: models('DEGRADED'), usage: {}, cfg: c, nowIso: '2026-09-28T16:00:00Z' }).alerts.length, 0);
  // Fallback count over threshold.
  r = A.decideAlerts({ prev: null, quota: quota('HEALTHY', 1), models: models('HEALTHY'), usage: { fallbacks_1h: 3 }, cfg: c, nowIso: NOW });
  assert.deepEqual(r.alerts.map((a) => a.kind), ['FALLBACK']);
  assert.equal(A.decideAlerts({ prev: null, quota: quota('HEALTHY', 1), models: models('HEALTHY'), usage: { fallbacks_1h: 2 }, cfg: c, nowIso: NOW }).alerts.length, 0);
});

test('model configuration: OPENROUTER_*_MODEL override per rank, GI_AI_MODELS fallback', () => {
  const x = loadConfig({ OPENROUTER_SECONDARY_MODEL: 'x/b:free', GI_AI_MODELS: 'a:free,b:free,c:free' });
  assert.deepEqual(x.ai.models, ['a:free', 'x/b:free', 'c:free']);
  assert.equal(x.ai.modelSource, 'OPENROUTER_*_MODEL');
  assert.equal(loadConfig({}).ai.modelSource, 'GI_AI_MODELS');
  assert.equal(loadConfig({ AI_MAX_REQUESTS_DAY: '45' }).ai.dailyBudget, 45);
  assert.equal(loadConfig({ GI_AI_DAILY_BUDGET: '30' }).ai.dailyBudget, 30);
});

test('usage center / AI views: UNKNOWN tokens and cost, capacity from quota, never a key', () => {
  const secretCfg = loadConfig({ OPENROUTER_API_KEY: 'sk-or-v1-SECRETSECRETSECRET' });
  const snap = {
    counters: { requests_today: 3, requests_hour: 1 }, key: { key_alias: 'openrouter-main', status: 'ACTIVE' },
    health: [{ provider: 'openrouter', model: secretCfg.ai.models[0], success_count: 2, listed: true, free: true, display_name: 'NVIDIA: Nemotron 3 Super (free)' }],
    per_model: [{ provider: 'openrouter', model: secretCfg.ai.models[0], requests_today: 3, tokens_today: 0, tokens_reported_today: 0, requests_24h: 3, success_24h: 2 }],
    totals: { requests_today: 3, tokens_today: 0, tokens_reported_today: 0, requests_24h: 3 }, failures: [], performance: [],
  };
  const u = TA.buildUsageView(snap, secretCfg, describeConfig(secretCfg), NOW);
  assert.equal(u.ai_status, 'HEALTHY');
  const all = [TA.formatUsageCenter(u, 'UTC'), TA.formatAiMenu(u, 'UTC'), TA.formatAiHealth(u, 'UTC'), TA.formatAiModel(u, 'UTC'),
    TA.formatAiFallback(u, 'UTC'), TA.formatAiConfig(u), TA.formatAiFailures(u, 'UTC'), TA.formatAiPerformance([])].join('\n');
  assert.ok(!all.includes('SECRET'), 'no key material in any AI view');
  assert.match(TA.formatUsageCenter(u, 'UTC'), /UNKNOWN \(not reported by the provider\)/);
  assert.match(TA.formatUsageCenter(u, 'UTC'), /Cost today:<\/b> UNKNOWN/);
  assert.match(TA.formatUsageCenter(u, 'UTC'), /STANDBY|UNKNOWN/);
  assert.equal(TA.tokensText(100, 1, 2), '100 (reported for 1/2 requests)');
  const unconfigured = TA.buildUsageView({}, loadConfig({}), describeConfig(loadConfig({})), NOW);
  assert.equal(unconfigured.ai_status, 'OFFLINE');
  assert.match(TA.formatUsageCenter(unconfigured, 'UTC'), /NOT CONFIGURED/);
});

test('menus: every required entry is a button; callback data within Telegram limits', () => {
  const buttons = M.MAIN_MENU_KEYBOARD.inline_keyboard.flat();
  for (const want of ['GOLD NOW', 'BIGGEST SCENARIOS', 'TOP NEWS', 'GEOPOLITICS', 'POLITICS', 'MACRO', 'MARKET STATE', 'UPCOMING EVENTS',
    'PRE-EVENT BIAS', 'HISTORICAL PATTERNS', 'ACTIVE ALERTS', 'FORECAST REVIEW', 'AI ANALYSIS', 'SYSTEM STATUS']) {
    assert.ok(buttons.some((x) => x.text.includes(want)), want);
  }
  for (const kb of [M.MAIN_MENU_KEYBOARD, TA.AI_MENU_KEYBOARD, TA.BACK_TO_AI, M.BACK_TO_MENU]) {
    for (const x of kb.inline_keyboard.flat()) assert.ok(Buffer.byteLength(x.callback_data) <= 64 && x.callback_data.startsWith('/'));
  }
  // Empty-state views render without throwing.
  assert.match(M.formatNews([], 'UTC'), /No gold-relevant events/);
  assert.match(M.formatBias([], 'UTC'), /No active pre-event forecasts/);
  assert.match(M.formatHistory([], null), /empty/);
  assert.match(M.formatAlerts([], [], 'UTC'), /none/);
  assert.match(M.formatReview([], [], {}, 'UTC'), /No forecast has been evaluated/);
  assert.match(M.formatAnalysis([], 'UTC'), /No analyses/);
  assert.match(M.formatMarketState({}, null, null, 'UTC'), /NOT AVAILABLE/);
});

test('biggest scenarios: deterministic ranking (impact × support × lean × time), AI may only explain', () => {
  const now = Date.parse(NOW);
  const f = (id, impact, state, hours, supports) => ({
    release_key: id, event_type: id, impact, forecast_state: state, pre_event_score: state === 'BEARISH' ? -38 : 0, confidence: 60,
    scheduled_at: new Date(now + hours * 3600000).toISOString(),
    scenarios: [['BULLISH', supports[0]], ['BEARISH', supports[1]], ['BASE', supports[2]]].map(([kind, support]) => ({ kind, support, trigger_text: `${id} ${kind}`, mechanism: 'm', expected_gold_response: 'g', invalidation: 'i', expected_confirmation: 'c' })),
  });
  const ranked = B.rankScenarios([f('PCE', 'HIGH', 'BEARISH', 48, ['WEAK', 'MODERATE', 'INSUFFICIENT EVIDENCE']), f('JOLTS', 'MEDIUM', 'MIXED', 24, ['STRONG', 'WEAK', 'WEAK'])], now);
  assert.equal(ranked.length, 3);
  assert.equal(ranked[0].release_key, 'PCE');
  assert.equal(ranked[0].kind, 'BEARISH', 'aligned HIGH-impact scenario with support first');
  assert.deepEqual(ranked.map((s) => s.rank), [1, 2, 3]);
  assert.deepEqual(B.rankScenarios([f('PCE', 'HIGH', 'BEARISH', 48, ['WEAK', 'MODERATE', 'WEAK'])], now).map((s) => s.kind),
    B.rankScenarios([f('PCE', 'HIGH', 'BEARISH', 48, ['WEAK', 'MODERATE', 'WEAK'])], now).map((s) => s.kind), 'deterministic');
  const facts = B.biggestFacts(ranked, { regime: 'RATES' });
  assert.match(facts.rule, /Do not re-rank/);
  const text = B.formatBiggest(ranked, { label: 'deterministic (test)' }, 'UTC');
  assert.match(text, /not a probability/);
  assert.ok(!/probability of|\d+% chance/i.test(text));
  assert.equal(B.rankScenarios([f('OLD', 'HIGH', 'BEARISH', -2, ['WEAK', 'WEAK', 'WEAK'])], now).length, 0, 'released events are excluded');
});

test('Telegram sender: inline keyboard only on the last part of a chunked message', async () => {
  const calls = [];
  const http = async (r) => { calls.push(r); return { statusCode: 200, body: { ok: true, result: { message_id: calls.length } } }; };
  const long = Array.from({ length: 400 }, (_, k) => `line ${k} ${'x'.repeat(20)}`).join('\n');
  const out = await sendMessages({ messages: [{ chat_id: '1', text: long, reply_markup: M.MAIN_MENU_KEYBOARD }], token: 't', http, sleep: async () => {}, secrets: ['t'] });
  assert.equal(out[0].status, 'SENT');
  assert.ok(calls.length >= 2);
  assert.ok(calls.slice(0, -1).every((c) => !c.body.reply_markup));
  assert.ok(calls[calls.length - 1].body.reply_markup);
});

test('callback queries: button presses become commands for authorised chats only; all are answered', () => {
  const { normaliseUpdates, parseCommand } = require('../src/lib/telegram');
  const raw = [
    { update_id: 10, message: { message_id: 1, chat: { id: 111 }, text: '/now' } },
    { update_id: 11, callback_query: { id: 'cb1', data: '/ai health', from: { id: 5 }, message: { message_id: 2, chat: { id: 111 } } } },
    { update_id: 12, callback_query: { id: 'cb2', data: '/usage', from: { id: 6 }, message: { message_id: 3, chat: { id: 999 } } } },
  ];
  const n = normaliseUpdates(raw, ['111'], 1);
  assert.equal(n.new_offset, 13);
  assert.deepEqual(n.callbacks, ['cb1', 'cb2']);
  assert.equal(n.updates.length, 2);
  assert.equal(n.updates[1].via_button, true);
  assert.deepEqual(parseCommand(n.updates[1].message.text), { command: '/ai', args: ['health'], known: true });
  assert.ok(!n.updates.some((u) => String(u.message.chat.id) === '999'), 'unauthorised button press ignored');
});

test('active alerts view: repeated alerts of one event are grouped', () => {
  const rows = [
    { created_at: '2026-09-28T01:16:00Z', status: 'SENT', event_id: 7, title: 'Yields surge', importance_class: 'CRITICAL', net_pressure: 'BEARISH' },
    { created_at: '2026-09-27T19:31:00Z', status: 'SENT', event_id: 7, title: 'Yields surge', importance_class: 'CRITICAL', net_pressure: 'BEARISH' },
    { created_at: '2026-09-27T19:01:00Z', status: 'SENT', event_id: 45, title: 'Hormuz', importance_class: 'HIGH', net_pressure: 'BULLISH' },
  ];
  const text = M.formatAlerts(rows, [], 'UTC');
  assert.equal((text.match(/#7 /g) || []).length, 1);
  assert.match(text, /2 alerts\/updates/);
  assert.ok(text.indexOf('#7 ') < text.indexOf('#45 '), 'latest first');
});

test('daily AI section: compact health lines with the active model and status', () => {
  const c2 = loadConfig({ OPENROUTER_API_KEY: 'x' });
  const u = TA.buildUsageView({ totals: { requests_today: 4, tokens_today: 5000, tokens_reported_today: 4, fallback_events_today: 1, failures_today: 1 },
    health: [{ model: c2.ai.models[0], success_count: 3, listed: true, free: true }] }, c2, describeConfig(c2), NOW);
  const lines = TA.dailyAiSection(u).join('\n');
  assert.match(lines, /AI HEALTH/);
  assert.match(lines, /Requests today:<\/b> 4/);
  assert.match(lines, /5,000/);
  assert.match(lines, new RegExp(c2.ai.models[0].replace(/[.*+?^${}()|[\]\/]/g, '\$&')));
  assert.ok(!lines.includes('OPENROUTER_API_KEY=') && !lines.includes('"x"'));
});

test('request params follow model capabilities: no response_format unless supported; reasoning off by default', () => {
  const { requestParams } = require('../src/lib/ai');
  assert.deepEqual(requestParams({ response_format: false }, 'off'), { reasoning: { enabled: false } });
  assert.deepEqual(requestParams(undefined, 'off'), { reasoning: { enabled: false } }, 'unknown capability -> not sent');
  assert.deepEqual(requestParams({ response_format: true }, 'low'), { response_format: { type: 'json_object' }, reasoning: { effort: 'low', exclude: true } });
  assert.equal(loadConfig({}).ai.reasoning, 'off');
  assert.equal(loadConfig({ AI_REASONING: 'low' }).ai.reasoning, 'low');
});

test('unsupported-feature 400 is an API error (model not benched); provider error text kept and redacted', () => {
  const { classifyFailure, providerErrorText } = require('../src/lib/ai');
  const body = { error: { code: 400, message: 'Provider returned error', metadata: { raw: '{"code":400,"message":"model: x does not support feature: structured-outputs"} key sk-or-v1-abc' } } };
  assert.equal(classifyFailure(400, body, null), 'BAD_REQUEST');
  assert.equal(A.errorTypeOf('BAD_REQUEST: Provider returned error'), 'API_ERROR');
  assert.equal(classifyFailure(400, { error: { message: 'x is not a valid model ID' } }, null), 'MODEL_UNAVAILABLE');
  const t = providerErrorText(body, ['sk-or-v1-abc']);
  assert.match(t, /does not support feature: structured-outputs/);
  assert.ok(!t.includes('sk-or-v1-abc'));
});

test('schema: a null secondary/counter driver means NONE; other nulls are still rejected', () => {
  const { validateSchema } = require('../src/lib/ai');
  const v = validateSchema({ ...good(), counter_driver: null, secondary_driver: null });
  assert.ok(v.ok);
  assert.equal(v.value.counter_driver, 'NONE');
  assert.equal(validateSchema({ ...good(), dominant_driver: null }).ok, false);
  assert.equal(validateSchema({ ...good(), summary: null }).ok, false);
});

test('fallback reasons are shown in plain language (hourly cap vs daily limit)', () => {
  assert.match(A.fallbackReasonText('QUOTA_LIMIT_REACHED_REQUESTS_HOUR_PRIORITY_BIGGEST'), /hourly AI request cap .* reached/);
  assert.match(A.fallbackReasonText('QUOTA_NEAR_LIMIT_REQUESTS_DAY_PRIORITY_DAILY'), /daily AI request limit is near limit/);
  assert.equal(A.fallbackReasonText('ALL_MODELS_FAILED'), 'all configured models failed');
});
