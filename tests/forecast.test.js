'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildForecast, compareForecasts, snapshotOf, scoreForecast, analogueEngine } = require('../src/lib/forecast');
const { marketSnapshot } = require('../src/lib/market');

const NOW = '2026-09-27T12:00:00.000Z';
const day = 86400000;
// Flat, then the whole move happens over the last 20 days (like the real 2026-09 repricing).
function series(start, end, n = 130, hours = 24) {
  const out = [];
  for (let i = n; i >= 0; i--) out.push({ t: new Date(Date.parse(NOW) - i * hours * 3600000).toISOString(), v: i > 20 ? start : start + ((end - start) * (20 - i)) / 20, src: 'gold-api.com' });
  return out;
}
function snapFor({ goldEnd = 4280, usdEnd = 101, realEnd = 2.83, stale = false, missingUsd = false } = {}) {
  const shift = stale ? 5 * day : 0;
  const mk = (s) => s.map((p) => ({ ...p, t: new Date(Date.parse(p.t) - shift).toISOString() }));
  return marketSnapshot({
    GOLD: mk(series(4400, goldEnd)), USD_PROXY: missingUsd ? [] : mk(series(99, usdEnd)), US2Y: mk(series(4.4, 4.81)),
    US10Y: mk(series(4.8, 5.17)), US10Y_REAL: mk(series(2.4, realEnd)),
  }, NOW);
}
function histRow(i, { dir = 'BULLISH', usd = 'DOWN', gold = 'DOWN', usdTrend = 'UP', y10 = 'UP', regime = 'RATES / REAL-YIELD PRESSURE' } = {}) {
  const r4 = dir === 'BULLISH' ? 0.5 : dir === 'BEARISH' ? -0.5 : 0.02;
  return {
    event_type: 'NFP', event_date: new Date(Date.parse('2022-01-07T13:30:00Z') + i * 30 * day).toISOString(),
    gold_before: 2000, gold_5m: 2000, gold_30m: 2000 * (1 + r4 / 200), gold_1h: 2000 * (1 + r4 / 150), gold_4h: 2000 * (1 + r4 / 100),
    usd_before: 1, usd_after: usd === 'UP' ? 1.002 : usd === 'DOWN' ? 0.998 : 1, pre_gold_trend: gold, pre_usd_trend: usdTrend, pre_10y_trend: y10,
    regime, data_quality: 'OK', data_source: { gold: 'Binance PAXG/USDT' },
  };
}
const release = (over = {}) => ({ id: 1, release_key: 'NFP:2026-10-02T12:30Z', event_type: 'NFP', title: 'Employment Situation', scheduled_at: '2026-10-02T12:30:00.000Z', impact: 'HIGH', consensus: '120K', previous: '162K', ...over });
const ctx = { pre_gold_trend: 'DOWN', pre_usd_trend: 'UP', pre_10y_trend: 'UP', regime: 'RATES / REAL-YIELD PRESSURE' };
const run = (over = {}) => buildForecast({
  release: release(over.release), snap: over.snap || snapFor(), desk: { regime: 'RATES / REAL-YIELD PRESSURE', confidence: 70 }, events: over.events || [],
  historyRows: over.rows !== undefined ? over.rows : Array.from({ length: 30 }, (_, i) => histRow(i, { dir: i % 5 === 0 ? 'BEARISH' : 'BULLISH', usd: i % 5 === 0 ? 'UP' : 'DOWN' })),
  cpiRows: [{ event_date: '2026-09-11T12:30:00Z', actual: 0.4 }], nfpRows: [{ event_date: '2026-09-04T12:30:00Z', actual: 162 }],
  us2ySeries: series(4.4, 4.81), dailyGold: series(4400, 4280), recentUsdReactions: [], calendarOk: over.calendarOk !== undefined ? over.calendarOk : true, calendarNote: over.calendarNote || null,
  cfg: { minSample: 8 }, nowIso: NOW, context: over.context || ctx,
});

test('score is bounded, confidence deterministic, never presented as a probability', () => {
  const f = run();
  assert.ok(f.pre_event_score >= -100 && f.pre_event_score <= 100);
  assert.ok(f.pre_event_confidence >= 0 && f.pre_event_confidence <= 85);
  assert.match(f.note, /NOT a probability/);
  assert.ok(f.scenarios.bullish.historical_support.includes('not a probability'));
  assert.equal(f.disclaimer.some((l) => /NOT knowledge of undisclosed future news/.test(l)), true);
});

test('insufficient history -> UNDETERMINED', () => {
  const f = run({ rows: [histRow(1), histRow(2)] });
  assert.equal(f.forecast_state, 'UNDETERMINED');
  assert.ok(f.undetermined_reasons.includes('insufficient historical sample'));
  assert.ok(f.pre_event_confidence <= 30);
});

test('missing consensus within 36h -> UNDETERMINED with an explicit reason', () => {
  const f = run({ release: { consensus: null, scheduled_at: '2026-09-28T12:30:00.000Z' } });
  assert.equal(f.forecast_state, 'UNDETERMINED');
  assert.ok(f.undetermined_reasons.includes('no reliable consensus'));
  assert.ok(f.data_quality.reasons.includes('missing consensus'));
});

test('stale market data -> UNDETERMINED (weekday)', () => {
  const f = buildForecast({ ...{}, release: release(), snap: snapFor({ stale: true }), desk: null, events: [], historyRows: Array.from({ length: 20 }, (_, i) => histRow(i)), cpiRows: [], nfpRows: [], us2ySeries: [], dailyGold: [], recentUsdReactions: [], calendarOk: true, cfg: { minSample: 8 }, nowIso: '2026-09-29T12:00:00.000Z', context: ctx });
  assert.equal(f.forecast_state, 'UNDETERMINED');
  assert.ok(f.undetermined_reasons.includes('data stale'));
});

test('source failure (calendar) -> UNDETERMINED; missing market data lowers quality', () => {
  assert.ok(run({ calendarOk: false }).undetermined_reasons.includes('source failure'));
  const noUsd = run({ snap: snapFor({ missingUsd: true }) });
  assert.ok(noUsd.data_quality.reasons.some((r) => r.includes('USD_PROXY')));
});

test('high-quality similar sample yields higher evidence quality than many dissimilar cases', () => {
  const similar = analogueEngine(Array.from({ length: 10 }, (_, i) => histRow(i)), { ...ctx, inflation_state: 'INFLATIONARY', labor_state: 'STRENGTHENING', policy_state: 'HAWKISH' }, { minSample: 8 });
  const dissimilar = analogueEngine(Array.from({ length: 50 }, (_, i) => histRow(i, { gold: 'UP', usdTrend: 'DOWN', y10: 'DOWN', regime: 'DOLLAR WEAKNESS TAILWIND', dir: i % 2 ? 'BULLISH' : 'BEARISH' })), { ...ctx, inflation_state: 'INFLATIONARY', labor_state: 'STRENGTHENING', policy_state: 'HAWKISH' }, { minSample: 8 });
  assert.ok(similar.historical_evidence_quality > dissimilar.historical_evidence_quality);
  assert.equal(similar.regime_match, 'HIGH');
  assert.equal(dissimilar.regime_match, 'LOW');
});

test('conflicting analogues (history vs current drivers) -> MIXED, capped confidence', () => {
  const f = run();
  // History here is strongly bullish while USD / yields / macro are bearish.
  assert.equal(f.history_vs_current_conflict, true);
  assert.ok(['MIXED', 'NEUTRAL', 'UNDETERMINED'].includes(f.forecast_state));
  assert.ok(f.pre_event_confidence <= 55);
});

test('regime mismatch: analogues from a different regime are down-weighted (regime match LOW)', () => {
  const rows = Array.from({ length: 30 }, (_, i) => histRow(i, { gold: 'UP', usdTrend: 'DOWN', y10: 'DOWN', regime: 'DOLLAR WEAKNESS TAILWIND' }));
  const f = run({ rows });
  assert.equal(f.analogues.regime_match, 'LOW');
});

test('scenario support levels are categorical, never probabilities', () => {
  const f = run();
  for (const k of ['bullish', 'bearish', 'base']) assert.ok(['STRONG', 'MODERATE', 'WEAK', 'INSUFFICIENT EVIDENCE'].includes(f.scenarios[k].support));
  assert.equal(f.scenarios.bullish.support, 'STRONG');
});

test('forecast update and invalidation detection', () => {
  const prev = { forecast_state: 'BULLISH', pre_event_score: 30, confidence: 60, consensus: null, snapshot: { usd: 100, us2y: 4.6, real10y: 2.6, geo_class: 'LOW', regime: 'QUIET / RANGE' } };
  const next = run();
  const cmp = compareForecasts(prev, next);
  assert.equal(cmp.material, true);
  assert.ok(cmp.changes.some((c) => /consensus now available/.test(c)));
  assert.ok(cmp.changes.some((c) => /USD proxy/.test(c)));
  assert.ok(cmp.changes.some((c) => /2Y/.test(c)));
  const bearNext = { ...next, forecast_state: 'BEARISH', pre_event_score: -30 };
  assert.equal(compareForecasts(prev, bearNext).invalidated, true);
  const same = compareForecasts({ ...snapshotOf(next), forecast_state: next.forecast_state, pre_event_score: next.pre_event_score, consensus: '120K', snapshot: snapshotOf(next) }, next);
  assert.equal(same.material, false);
});

test('post-event scoring: correct, scenario-only (MIXED) and undetermined outcomes', () => {
  const m = { direction: 'BEARISH', ret_1h: -0.4, ret_4h: -0.6, usd_dir: 'UP', usd_move_pct: 0.3 };
  const bear = scoreForecast({ forecast_state: 'BEARISH', pre_event_score: -30 }, m, { surprise: null, event_type: 'NFP' });
  assert.equal(bear.forecast_result, 'CORRECT');
  assert.equal(bear.market_confirmation_correct, true);
  assert.equal(bear.timing_quality, 'SUSTAINED');
  const bull = scoreForecast({ forecast_state: 'BULLISH', pre_event_score: 25 }, m, { surprise: 60, event_type: 'NFP' });
  assert.equal(bull.forecast_result, 'MIXED', 'bias wrong but the (hot print) bearish scenario was right');
  assert.equal(bull.realized_scenario, 'BEARISH');
  assert.match(bull.lesson, /never changed automatically/);
  const und = scoreForecast({ forecast_state: 'UNDETERMINED', pre_event_score: 5 }, m, { event_type: 'NFP' });
  assert.equal(und.forecast_result, 'UNDETERMINED');
});

test('a failed calendar re-sync after a recent verification is PARTIAL data quality, not UNDETERMINED', () => {
  const f = run({ calendarOk: true, calendarNote: 'calendar re-sync failed this run (last verified 3h ago)' });
  assert.ok(!f.undetermined_reasons.includes('source failure'));
  assert.ok(f.data_quality.reasons.includes('calendar re-sync failed this run (last verified 3h ago)'));
  assert.notEqual(f.data_quality.level, 'GOOD');
});
