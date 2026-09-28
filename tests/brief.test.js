'use strict';
// 📋 GOLD BRIEF (/brief): agreed section order, probabilities only from calibrated cells, compact, no trade language.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/lib/calibration');
const D = require('../src/lib/direction');
const TD = require('../src/lib/telegram-direction');
const B = require('../src/lib/biggest');

const DAY = 86400000;
const T0 = Date.parse('2021-01-04T21:00:00Z');
const samples = (pattern, n) => Array.from({ length: n }, (_, k) => ({ t: T0 + k * 7 * DAY, end: T0 + k * 7 * DAY + DAY, outcome: pattern[k % pattern.length] }));
const cell = (kind, horizon, classKey, pattern, n) => C.cellResult({
  kind, horizon, classKey, samples: samples(pattern, n), cfg: C.DEFAULTS,
  climatologyAt: () => ({ BULLISH: 10, BEARISH: 10, NEUTRAL: 10 }), method: 'test', conditionedOn: 'test', outcomeDefinition: 'test',
});
const BEARISH_SKEW = ['BEARISH', 'BEARISH', 'BULLISH', 'BEARISH', 'NEUTRAL', 'BEARISH', 'BEARISH'];
const BULLISH_SKEW = ['BULLISH', 'NEUTRAL', 'BULLISH', 'BEARISH', 'BULLISH', 'NEUTRAL', 'BULLISH'];

const desk = {
  as_of: '2026-09-28T02:00:00Z', regime: 'RATES / REAL-YIELD PRESSURE', confidence: 76,
  dominant_driver: 'MARKET:REAL_YIELD', counter_driver: 'SAFE_HAVEN', data_quality: 'GOOD',
  horizons: {
    SHORT: { bias: 'BULLISH', score: 0.2, market_score: 0.17, market_confirmation: 'UNAVAILABLE', gold_change_pct: null },
    TACTICAL: { bias: 'BEARISH', score: -0.46, market_score: -0.61, market_confirmation: 'CONFIRMED', gold_change_pct: -3.3, market_drivers: [{ driver: 'REAL_YIELD', change: 15, score: -0.85 }] },
    SWING: { bias: 'BEARISH', score: -0.7, market_score: -0.84, market_confirmation: 'CONFIRMED', gold_change_pct: -4.7 },
    STRUCTURAL: { bias: 'BEARISH', score: -0.3, market_score: -0.41, market_confirmation: 'DIVERGENCE', gold_change_pct: 5.1 },
  },
  layers: { gold: { high_20d: 4423.43, low_20d: 4217.4 } },
};
const state = { gold: { value: 4217.4, change_24h_pct: -1.6 } };
const dq = { level: 'PARTIAL', gold_source: 'DIRECT (gold-api)', usd_source: 'PROXY (DXY formula)', reasons: ['oil NOT AVAILABLE (FRED_API_KEY not configured)'] };
const soon = (h) => new Date(Date.now() + h * 3600000).toISOString();
const scen = (kind, trigger) => ({ kind, trigger_text: trigger, mechanism: 'm', expected_confirmation: 'c', expected_gold_response: 'g', invalidation: 'i', support: 'MODERATE' });
const forecast = (key, type, h, extra = {}) => ({
  release_key: key, event_type: type, label: type, scheduled_at: soon(h), impact: 'HIGH', forecast_state: 'BEARISH', pre_event_score: -38,
  confidence: 63, scenarios: [scen('BEARISH', `${type} hot print lifts USD and real yields`), scen('BULLISH', `${type} soft print`), scen('BASE', 'in line')], ...extra,
});
const next = { label: 'PCE', scheduled_at: soon(44), impact: 'HIGH', forecast: { forecast_state: 'BEARISH', pre_event_score: -38, confidence: 63 } };
const probSection = (text) => text.slice(text.indexOf('CALIBRATED PROBABILITY'), text.indexOf('🧭'));

test('/brief: every agreed section, in the agreed order, as one compact message', () => {
  const cells = [cell('DESK', 'SHORT', 'BULLISH', BULLISH_SKEW, 42), cell('DESK', 'TACTICAL', 'BEARISH', BEARISH_SKEW, 42)];
  const ranked = B.withProbabilities(B.rankScenarios([forecast('PCE:1', 'PCE', 44), forecast('NFP:1', 'NFP', 100)]), []);
  const text = TD.formatBrief(desk, state, ranked, next, 'UTC', { cells, dataQuality: dq, cfg: {} });
  const order = ['📋 <b>GOLD BRIEF</b>', '🥇 <b>GOLD</b>', 'REGIME:', '📊 <b>CALIBRATED PROBABILITY</b>', 'NEXT 1 DAY', 'NEXT 5 DAYS', '🧭 <b>BIAS</b>',
    'SHORT:', 'TACTICAL:', 'SWING:', 'STRUCTURAL:', '🎯 <b>MAIN DRIVER:</b>', 'Counter:', '🔥 <b>TOP SCENARIOS</b>', '📅 <b>NEXT EVENT:</b>',
    'PRE-EVENT:', '✅ <b>MARKET:</b>', '⚠️ <b>INVALIDATION:</b>', '📡 <b>DATA:</b>'];
  let at = -1;
  for (const want of order) {
    const k = text.indexOf(want, at + 1);
    assert.ok(k > at, `${want} missing or out of order`);
    at = k;
  }
  assert.match(text, /PRE-EVENT:<\/b> 🔴 BEARISH · score -38 · confidence 63/);
  assert.equal((text.match(/<b>/g) || []).length, (text.match(/<\/b>/g) || []).length);
  assert.equal((text.match(/<i>/g) || []).length, (text.match(/<\/i>/g) || []).length);
  assert.ok(text.length < 2500, `compact: ${text.length} chars`);
  assert.equal((text.match(/^\d\. /gm) || []).length, 3, 'exactly three top scenarios');
});

test('/brief: percentages come only from the calibrated cells; confidence is the desk value, never a %', () => {
  const short = cell('DESK', 'SHORT', 'BULLISH', BULLISH_SKEW, 42);
  const tact = cell('DESK', 'TACTICAL', 'BEARISH', BEARISH_SKEW, 42);
  const text = TD.formatBrief(desk, state, [], next, 'UTC', { cells: [short, tact], dataQuality: dq, cfg: {} });
  const view = D.horizonView(desk, dq.level);
  const p = probSection(text);
  for (const [c, h] of [[short, 'SHORT'], [tact, 'TACTICAL']]) {
    assert.ok(p.includes(`Bullish: ${c.bullish_pct}%\nBearish: ${c.bearish_pct}%\nNeutral: ${c.neutral_pct}%`), `${h} percentages`);
    assert.ok(p.includes(`Confidence: ${view.find((r) => r.horizon === h).confidence}/100`), `${h} confidence`);
    assert.ok(p.includes(`Evidence: ${c.evidence} · n=42`), `${h} evidence`);
  }
  assert.equal(short.bullish_pct + short.bearish_pct + short.neutral_pct, 100);
  assert.ok(!/(76|46|61)%/.test(text), 'desk confidence and scores never shown as a percentage');
});

test('/brief: without a validated cell the probability is UNAVAILABLE with the reason — no number', () => {
  const few = cell('DESK', 'TACTICAL', 'BEARISH', BEARISH_SKEW, 12); // below the 20-case minimum
  const text = TD.formatBrief(desk, state, [], null, 'UTC', { cells: [few], dataQuality: dq, cfg: {} });
  const p = probSection(text);
  assert.ok(!/\d%/.test(p), 'no percentage in the probability section');
  assert.match(p, /NEXT 1 DAY<\/b>\nBullish \/ Bearish \/ Neutral: UNAVAILABLE — calibration not built yet/);
  assert.match(p, /NEXT 5 DAYS<\/b>\nBullish \/ Bearish \/ Neutral: UNAVAILABLE — only 12 cases/);
  assert.equal((p.match(/Evidence: INSUFFICIENT/g) || []).length, 2);
  assert.match(text, /none — no active pre-event forecasts/);
  assert.match(text, /PRE-EVENT:<\/b> no forecast yet/);
});

test('/brief: scenario probabilities are conditional and only shown when calibrated; no trade language', () => {
  const pceCell = cell('EVENT_SCENARIO', 'SHORT', 'PCE:BEARISH', BEARISH_SKEW, 42);
  const ranked = B.withProbabilities(B.rankScenarios([forecast('PCE:1', 'PCE', 44)]), [pceCell]);
  const text = TD.formatBrief(desk, state, ranked, next, 'UTC', { cells: [pceCell], dataQuality: dq, cfg: {} });
  const bearish = text.split('\n').findIndex((l) => /^\d\. 🔴 BEARISH · PCE/.test(l));
  assert.ok(bearish >= 0, 'PCE bearish scenario listed');
  assert.equal(text.split('\n')[bearish + 1].trim(), `if confirmed, first hours: 🟢 ${pceCell.bullish_pct}% · 🔴 ${pceCell.bearish_pct}% · ⚪ ${pceCell.neutral_pct}% (n=42)`);
  assert.match(text, /conditional probability: unavailable/, 'uncalibrated scenarios say so');
  assert.ok(!/\b(buy|sell|entry|stop[- ]?loss|take[- ]?profit|leverage|lot size|place an order)\b/i.test(text), 'no trade execution language');
  assert.match(text, /not a trade signal/);
});
