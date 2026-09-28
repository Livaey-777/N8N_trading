'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractJson, validateSchema, factualityGuard, routeRequests, OUTPUT_TEMPLATE } = require('../src/lib/ai');
const { sendMessages, chunk, parseCommand, esc } = require('../src/lib/telegram');
const { redact } = require('../src/lib/util');

const good = () => ({
  ...OUTPUT_TEMPLATE,
  summary: 'Gold faces rising real yields ahead of the release while geopolitical risk supports it.',
  interpretation: 'Real yields at 2.83% pressure gold; the safe-haven bid offsets part of it.',
  dominant_driver: 'REAL_YIELD', secondary_driver: 'SAFE_HAVEN', counter_driver: 'SAFE_HAVEN',
  market_confirmation: 'pending', regime: 'RATES / REAL-YIELD PRESSURE', short_bias: 'MIXED', tactical_bias: 'MIXED',
  swing_bias: 'BEARISH', structural_bias: 'NEUTRAL', bullish_scenario: 'Soft print lowers yields.', base_scenario: 'In line.',
  bearish_scenario: 'Hot print lifts yields.', confidence: 80, telegram_summary: 'Mixed pre-event setup: yields versus safe haven.',
});
const facts = { deterministic: { confidence: 45, forecast_state: 'MIXED' }, yields: { real10y: 2.83 } };

test('JSON extraction tolerates fences and prose', () => {
  assert.deepEqual(extractJson('Here:\n```json\n{"a":1,"b":{"c":"}"}}\n```'), { a: 1, b: { c: '}' } });
  assert.equal(extractJson('no json here'), null);
});

test('schema validation rejects missing fields and invalid bias values', () => {
  assert.equal(validateSchema(good()).ok, true);
  const bad = good(); delete bad.summary; bad.short_bias = 'UP';
  const v = validateSchema(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.startsWith('summary')));
  assert.ok(v.errors.some((e) => e.startsWith('short_bias')));
});

test('factuality guard: allows input numbers (rounded), rejects invented numbers / quotes / trade instructions', () => {
  const ok = validateSchema(good()).value;
  assert.equal(factualityGuard(ok, facts).ok, true);
  const invented = { ...ok, interpretation: 'Gold will test 4500 as CPI prints 0.6%.' };
  const g = factualityGuard(invented, facts);
  assert.equal(g.ok, false);
  assert.ok(g.violations.some((x) => x.type === 'UNSUPPORTED_NUMBER'));
  const quote = { ...ok, summary: 'The chair said "we will cut rates aggressively next month" per sources.' };
  assert.ok(factualityGuard(quote, facts).violations.some((x) => x.type === 'UNSUPPORTED_QUOTE'));
  const trade = { ...ok, summary: 'Traders should buy gold now and consider a stop-loss below support.' };
  assert.ok(factualityGuard(trade, facts).violations.some((x) => x.type === 'TRADE_INSTRUCTION'));
});

function fakeHttp(script) {
  let i = 0;
  const calls = [];
  const fn = async (req) => { calls.push(req); const step = script[Math.min(i++, script.length - 1)]; if (step instanceof Error) throw step; return step; };
  fn.calls = calls;
  return fn;
}
const okBody = (o) => ({ statusCode: 200, body: { choices: [{ message: { content: JSON.stringify(o) } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } } });
const req = (useAi = true) => ({ ref: 'r1', purpose: 'PRE_EVENT', use_ai: useAi, facts, deterministic: { ...good(), summary: 'deterministic summary text here' } });

test('AI router: PRIMARY rate-limited -> SECONDARY succeeds; deterministic confidence/state enforced', async () => {
  const http = fakeHttp([{ statusCode: 429, body: { error: { message: 'rate limited' } } }, okBody(good())]);
  const out = await routeRequests({ requests: [req()], models: ['a:free', 'b:free', 'c:free'], apiKey: 'k', http, timeoutMs: 1000, maxTokens: 500, budgetRemaining: 10, secrets: ['k'] });
  const r = out.results[0];
  assert.equal(r.mode, 'AI');
  assert.equal(r.model, 'b:free');
  assert.equal(r.output.confidence, 45, 'confidence must be the deterministic value');
  assert.equal(r.output.ai_confidence, 80);
  assert.equal(r.output.tactical_bias, 'MIXED');
  assert.equal(out.runs.length, 2);
  assert.match(out.runs[0].failure_reason, /PROVIDER_ERROR|RATE_LIMITED/);
});

test('AI router: all models fail -> DETERMINISTIC fallback; invalid output -> next model', async () => {
  const http = fakeHttp([{ statusCode: 404, body: {} }, { statusCode: 200, body: { choices: [{ message: { content: 'not json' } }] } }, new Error('timeout of 1000ms exceeded')]);
  const out = await routeRequests({ requests: [req()], models: ['a', 'b', 'c'], apiKey: 'k', http, timeoutMs: 1000, maxTokens: 500, budgetRemaining: 10, secrets: ['k'] });
  assert.equal(out.results[0].mode, 'DETERMINISTIC');
  assert.equal(out.results[0].fallback_reason, 'ALL_MODELS_FAILED');
  assert.deepEqual(out.runs.map((r) => r.failure_reason.split(':')[0]), ['MODEL_NOT_FOUND', 'INVALID_JSON', 'TIMEOUT']);
});

test('AI router: disagreement with the deterministic state is recorded, not applied', async () => {
  const http = fakeHttp([okBody({ ...good(), tactical_bias: 'BEARISH', short_bias: 'BEARISH' })]);
  const out = await routeRequests({ requests: [req()], models: ['a'], apiKey: 'k', http, timeoutMs: 1000, maxTokens: 500, budgetRemaining: 10, secrets: [] });
  const o = out.results[0].output;
  assert.equal(o.ai_disagreement, true);
  assert.equal(o.tactical_bias, 'MIXED');
  assert.equal(o.ai_tactical_bias, 'BEARISH');
});

test('AI router: not configured / budget exhausted / not eligible never call the provider', async () => {
  const http = fakeHttp([okBody(good())]);
  const a = await routeRequests({ requests: [req()], models: ['a'], apiKey: '', http, timeoutMs: 1, maxTokens: 1, budgetRemaining: 10 });
  const b = await routeRequests({ requests: [req()], models: ['a'], apiKey: 'k', http, timeoutMs: 1, maxTokens: 1, budgetRemaining: 0 });
  const c = await routeRequests({ requests: [req(false)], models: ['a'], apiKey: 'k', http, timeoutMs: 1, maxTokens: 1, budgetRemaining: 10 });
  assert.deepEqual([a, b, c].map((x) => x.results[0].fallback_reason), ['NOT_CONFIGURED', 'DAILY_BUDGET_EXHAUSTED', 'NOT_ELIGIBLE']);
  assert.equal(http.calls.length, 0);
});

test('Telegram sender: 429 honours retry_after, HTML parse error falls back to plain text, 5xx retries', async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  const http = fakeHttp([
    { statusCode: 429, body: { ok: false, parameters: { retry_after: 2 } } },
    { statusCode: 400, body: { ok: false, description: "Bad Request: can't parse entities" } },
    { statusCode: 502, body: {} },
    { statusCode: 200, body: { ok: true, result: { message_id: 7 } } },
  ]);
  const res = await sendMessages({ messages: [{ chat_id: '1', text: '<b>x</b>' }], token: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi', http, sleep, secrets: [] });
  assert.equal(res[0].status, 'SENT');
  assert.deepEqual(res[0].telegram_message_ids, [7]);
  assert.ok(sleeps.includes(2000));
  assert.equal(http.calls[3].body.parse_mode, undefined, 'plain-text retry after parse error');
});

test('Telegram sender: permanent failure is reported without leaking the token', async () => {
  const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
  const http = fakeHttp([{ statusCode: 401, body: { ok: false, description: `Unauthorized for bot${token}` } }]);
  const res = await sendMessages({ messages: [{ chat_id: '1', text: 'hello' }], token, http, sleep: async () => {}, secrets: [token] });
  assert.equal(res[0].status, 'FAILED');
  assert.ok(!String(res[0].error).includes(token));
  const nc = await sendMessages({ messages: [{ chat_id: '1', text: 'hello' }], token: '', http, sleep: async () => {} });
  assert.equal(nc[0].status, 'NOT_CONFIGURED');
});

test('chunking respects the Telegram limit and keeps tags balanced; commands parse', () => {
  const long = Array.from({ length: 400 }, (_, i) => `<b>line ${i}</b> ${'x'.repeat(20)}`).join('\n');
  const parts = chunk(long);
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 4000));
  assert.deepEqual(parseCommand('/event@GoldBot 42'), { command: '/event', args: ['42'], known: true });
  assert.equal(esc('<a&b>'), '&lt;a&amp;b&gt;');
  assert.equal(redact('Bearer abcdefghijklmnop123 and bot123456789:AAAAAAAAAAAAAAAAAAAAAAAA', []), 'Bearer *** and bot***');
});
