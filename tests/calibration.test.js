'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/lib/calibration');
const D = require('../src/lib/direction');
const TD = require('../src/lib/telegram-direction');
const B = require('../src/lib/biggest');

const DAY = 86400000;
const T0 = Date.parse('2021-01-04T21:00:00Z');
/** Chronological samples from a repeating outcome pattern. */
const samples = (pattern, n) => Array.from({ length: n }, (_, k) => ({ t: T0 + k * 7 * DAY, end: T0 + k * 7 * DAY + DAY, outcome: pattern[k % pattern.length] }));
const cell = (smp, extra = {}) => C.cellResult({
  kind: 'DESK', horizon: 'TACTICAL', classKey: 'BEARISH', samples: smp, cfg: C.DEFAULTS,
  climatologyAt: () => ({ BULLISH: 10, BEARISH: 10, NEUTRAL: 10 }), method: 'test', conditionedOn: 'test', outcomeDefinition: 'test', ...extra,
});
const BEARISH_SKEW = ['BEARISH', 'BEARISH', 'BULLISH', 'BEARISH', 'NEUTRAL', 'BEARISH', 'BEARISH'];

const desk = (o = {}) => ({
  as_of: '2026-09-28T02:00:00Z', regime: 'RATES / REAL-YIELD PRESSURE', regime_conflict: null, confidence: 76,
  dominant_driver: 'MARKET:REAL_YIELD', counter_driver: 'SAFE_HAVEN', data_quality: 'GOOD',
  horizons: {
    SHORT: { bias: 'BULLISH', score: 0.2, news_score: 0.21, market_score: 0.17, conflict: false, market_confirmation: 'UNAVAILABLE', gold_trend: 'UNAVAILABLE', gold_change_pct: null, market_drivers: [{ driver: 'USD', change: -0.3, score: 0.5 }] },
    TACTICAL: { bias: 'BEARISH', score: -0.46, news_score: 0.1, market_score: -0.61, conflict: false, market_confirmation: 'CONFIRMED', gold_trend: 'DOWN', gold_change_pct: -3.3, market_drivers: [{ driver: 'REAL_YIELD', change: 15, score: -0.85 }, { driver: 'USD', change: 0.68, score: -0.59 }] },
    SWING: { bias: 'BEARISH', score: -0.7, news_score: 0.05, market_score: -0.84, conflict: false, market_confirmation: 'CONFIRMED', gold_trend: 'DOWN', gold_change_pct: -4.7, market_drivers: [] },
    STRUCTURAL: { bias: 'BEARISH', score: -0.3, news_score: 0.06, market_score: -0.41, conflict: false, market_confirmation: 'DIVERGENCE', gold_trend: 'UP', gold_change_pct: 5.1, market_drivers: [] },
    ...(o.horizons || {}),
  },
  layers: { gold: { high_20d: 4423.43, low_20d: 4217.4 } },
  ...o.top,
});

test('1. sufficient historical sample -> CALIBRATED probabilities with interval and walk-forward', () => {
  const c = cell(samples(BEARISH_SKEW, 42));
  assert.equal(c.status, 'CALIBRATED');
  assert.ok(c.bearish_pct > c.bullish_pct && c.bearish_pct > c.neutral_pct);
  assert.equal(c.walk_forward.n_eval, 42 - C.DEFAULTS.warmup);
  assert.ok(Array.isArray(c.ci95.BEARISH) && c.ci95.BEARISH[0] < c.ci95.BEARISH[1]);
  assert.equal(c.n, 42);
  assert.ok(c.window_start && c.window_end && c.method && c.conditioned_on && c.outcome_definition);
});

test('2. insufficient sample -> UNAVAILABLE, no number', () => {
  const c = cell(samples(BEARISH_SKEW, 12));
  assert.equal(c.status, 'UNAVAILABLE');
  assert.equal(c.bullish_pct, null);
  assert.match(c.reason, /insufficient calibrated historical evidence: 12/);
  assert.equal(c.evidence, 'INSUFFICIENT');
});

test('3 + 4. confidence and score are never shown as a probability', () => {
  const text = TD.formatGoldNow(desk(), {}, {}, null, 'UTC', { cells: [], dataQuality: { level: 'GOOD', gold_source: 'DIRECT', usd_source: 'PROXY', reasons: [] } });
  assert.match(text, /PROBABILITY:<\/b> UNAVAILABLE/);
  assert.ok(!/76%|46%|61%/.test(text), 'desk confidence 76, score -46 or market score -61 must not appear as a percentage');
  assert.match(text, /score -46 · confidence \d+/);
  const p = C.deskProbability([], 'TACTICAL', -0.61, {});
  assert.equal(p.status, 'UNAVAILABLE');
  assert.equal(p.bearish_pct, undefined);
});

test('5 + 6. horizon disagreement: short bullish inside a bearish tactical/swing/structural regime', () => {
  const view = D.horizonView(desk(), 'GOOD');
  assert.deepEqual(view.map((r) => r.direction), ['BULLISH', 'BEARISH', 'BEARISH', 'BEARISH']);
  assert.equal(D.interpretHorizons(view), 'SHORT-TERM COUNTERTREND: bullish pressure inside a broader bearish tactical/swing/structural regime.');
  const aligned = D.horizonView(desk({ horizons: { SHORT: { bias: 'BEARISH', score: -0.2, market_confirmation: 'UNAVAILABLE' } } }), 'GOOD');
  assert.equal(D.interpretHorizons(aligned), null, 'no interpretation when all horizons agree');
  const transition = D.horizonView(desk({ horizons: { SWING: { bias: 'BULLISH', score: 0.3, market_confirmation: 'CONFIRMED' } } }), 'GOOD');
  assert.match(D.interpretHorizons(transition), /^TRANSITION: tactical bearish vs swing bullish/);
  // Per-horizon confidence is its own metric: confirmed + agreeing data scores higher than divergence.
  const t = view.find((r) => r.horizon === 'TACTICAL');
  const st = view.find((r) => r.horizon === 'STRUCTURAL');
  assert.ok(t.confidence > st.confidence);
});

test('7. available probabilities always sum to 100', () => {
  for (let k = 0; k < 200; k++) {
    const a = Math.random();
    const b = Math.random() * (1 - a);
    const p = C.percentages({ BULLISH: a, BEARISH: b, NEUTRAL: 1 - a - b });
    assert.equal(p.BULLISH + p.BEARISH + p.NEUTRAL, 100);
  }
  const c = cell(samples(BEARISH_SKEW, 30));
  assert.equal(c.bullish_pct + c.bearish_pct + c.neutral_pct, 100);
});

test('8. missing historical data -> every desk cell UNAVAILABLE; unmeasurable current state -> UNAVAILABLE', () => {
  const cells = C.buildDeskCells({ series: {} });
  assert.ok(cells.length === 12 && cells.every((x) => x.status === 'UNAVAILABLE'));
  assert.match(C.deskProbability(cells, 'SWING', null, {}).reason, /not measurable/);
  assert.ok(C.buildEventCells({ reactions: [] }).every((x) => x.status === 'UNAVAILABLE' && x.n === 0));
});

test('9. contradictory history -> never a confident number', () => {
  const c = cell(samples(['BULLISH', 'BEARISH', 'NEUTRAL'], 45));
  assert.ok(c.status === 'UNAVAILABLE' || (c.evidence === 'WEAK' && c.warnings.some((w) => /split/.test(w))), JSON.stringify({ s: c.status, e: c.evidence, w: c.warnings }));
});

test('10. poor current data quality -> probability only with an uncertainty warning', () => {
  const cells = [cell(samples(BEARISH_SKEW, 42))];
  const p = C.deskProbability(cells, 'TACTICAL', -0.61, { dataQuality: 'DEGRADED' });
  assert.equal(p.status, 'CALIBRATED');
  assert.ok(p.warnings.includes('current market data DEGRADED'));
  assert.match(TD.probabilityLines(p).join('\n'), /⚠️ .*current market data DEGRADED/);
});

test('11. scenario rank score stays separate from the scenario probability', () => {
  const reactions = Array.from({ length: 40 }, (_, k) => ({
    event_type: 'NFP', event_date: new Date(T0 + k * 30 * DAY).toISOString(), gold_before: 100, gold_3d: 99,
    gold_direction: k % 5 === 0 ? 'BULLISH' : 'BEARISH', usd_reaction_direction: 'UP', data_source: {},
  }));
  const cells = C.buildEventCells({ reactions });
  const now = Date.parse('2026-09-28T00:00:00Z');
  const ranked = B.withProbabilities(B.rankScenarios([{ release_key: 'NFP:x', event_type: 'NFP', label: 'NFP', impact: 'HIGH', forecast_state: 'BEARISH',
    pre_event_score: -40, confidence: 60, scheduled_at: new Date(now + 48 * 3600000).toISOString(),
    scenarios: [{ kind: 'BEARISH', support: 'MODERATE', trigger_text: 'hot payrolls', mechanism: 'm', expected_gold_response: 'g', invalidation: 'i', expected_confirmation: 'c' }] }], now), cells);
  const s = ranked[0];
  assert.equal(s.probability.SHORT.status, 'CALIBRATED');
  const text = B.formatBiggest(ranked, { label: 'deterministic (test)' }, 'UTC');
  assert.match(text, /Rank score [\d.]+ — ordering weight, not a probability/);
  assert.match(text, new RegExp(`first hours: 🟢 ${s.probability.SHORT.bullish_pct}% · 🔴 ${s.probability.SHORT.bearish_pct}%`));
  assert.notEqual(String(s.rank_score), String(s.probability.SHORT.bearish_pct));
  const facts = B.biggestFacts(ranked, { regime: 'X' });
  assert.equal(facts.scenarios[0].conditional_probability.first_hours.bearish_pct, s.probability.SHORT.bearish_pct);
  assert.match(facts.rule, /never create, change or estimate a probability/);
});

test('pooled family is used when the event type alone is too small (e.g. PCE -> inflation releases)', () => {
  const mk = (type, k, dir) => ({ event_type: type, event_date: new Date(T0 + k * 9 * DAY).toISOString(), gold_before: 100, gold_3d: 100,
    gold_direction: dir, usd_reaction_direction: 'UP', data_source: {} });
  const reactions = [
    ...Array.from({ length: 6 }, (_, k) => mk('PCE', k, 'BEARISH')),
    ...Array.from({ length: 30 }, (_, k) => mk('CPI', k + 10, k % 4 === 0 ? 'BULLISH' : 'BEARISH')),
  ];
  const cells = C.buildEventCells({ reactions });
  const p = C.scenarioProbability(cells, 'PCE', 'BEARISH', 'SHORT');
  assert.equal(p.status, 'CALIBRATED');
  assert.equal(p.pooled, true);
  assert.equal(p.class_key, 'INFLATION:BEARISH');
  assert.match(p.own_reason, /insufficient/);
});

test('walk-forward uses only earlier cases (no lookahead)', () => {
  const smp = [...samples(['BULLISH'], 15), ...samples(['BEARISH'], 15).map((x, k) => ({ ...x, t: T0 + (15 + k) * 7 * DAY }))];
  const wf = C.walkForward(smp, C.DEFAULTS, null);
  // With lookahead the regime switch would be anticipated; without it the first bearish cases are mispredicted.
  assert.ok(wf.brier > 0.5, `brier ${wf.brier}`);
  assert.equal(wf.n_eval, 20);
});

test('desk cells from daily history: non-overlapping cases, same market-driver scoring as the live desk', () => {
  const days = 420;
  const mk = (base, drift, noise) => Array.from({ length: days }, (_, k) => ({ t: new Date(T0 + k * DAY).toISOString(), v: base + drift * k + noise * Math.sin(k / 3) }));
  const cells = C.buildDeskCells({ series: { GOLD: mk(1800, 0.8, 12), USD_PROXY: mk(95, -0.004, 0.4), US2Y: mk(2, 0.001, 0.05), US10Y: mk(2.5, 0.001, 0.05), US10Y_REAL: mk(0.5, 0.0005, 0.04) } });
  const tact = cells.filter((x) => x.horizon === 'TACTICAL');
  assert.equal(tact.length, 3);
  // Within a cell the cases never overlap: at most one case per 5-day window.
  for (const x of tact) assert.ok(x.n <= Math.ceil(days / 5) + 1, `${x.class_key}: ${x.n} cases in ${days} days`);
  assert.ok(cells.some((x) => x.horizon === 'SHORT' && x.n > 0));
});

test('12. Telegram GOLD NOW answers what / which horizon / drivers / confirmation / invalidation / probability / evidence', () => {
  const cells = [cell(samples(BEARISH_SKEW, 42))];
  const text = TD.formatGoldNow(desk(), { gold: { value: 4217.4, change_24h_pct: -1.6, change_5d_pct: -3.3 } }, {}, null, 'UTC',
    { cells, dataQuality: { level: 'GOOD', gold_source: 'DIRECT (x)', usd_source: 'PROXY (y)', reasons: [] } });
  for (const want of ['GOLD NOW', 'REGIME:', 'CURRENT DIRECTION (tactical', 'HORIZON INTERPRETATION:', 'CALIBRATED PROBABILITY', 'BULLISH:</b>',
    'BEARISH:</b>', 'DOMINANT DRIVER:', 'COUNTER-DRIVER:', 'MARKET CONFIRMATION:', 'INVALIDATION:', 'GOLD DIRECTION DESK', 'Interpretation:',
    'walk-forward validated', 'non-overlapping cases: 42', 'Not a trade signal']) assert.ok(text.includes(want), want);
  assert.match(text, /real yields \+15bp \(tactical\)/);
  assert.match(text, /20-day high 4423\.43/);
  assert.equal((text.match(/<b>/g) || []).length, (text.match(/<\/b>/g) || []).length);
  assert.equal((text.match(/<i>/g) || []).length, (text.match(/<\/i>/g) || []).length);
  assert.ok(text.length < 4000, `length ${text.length}`);
});

test('direction vs calibrated history: disagreement is stated, never hidden', () => {
  const p = { status: 'CALIBRATED', bullish_pct: 31, bearish_pct: 23, neutral_pct: 46, evidence: 'WEAK' };
  assert.match(TD.consistencyLine('BEARISH', p), /does NOT confirm the BEARISH lean/);
  assert.match(TD.consistencyLine('BULLISH', p), /evidence is WEAK/);
  assert.match(TD.consistencyLine('BULLISH', { ...p, evidence: 'MODERATE' }), /consistent with the BULLISH lean/);
  assert.equal(TD.consistencyLine('MIXED', p), null);
  assert.equal(TD.consistencyLine('BEARISH', { status: 'UNAVAILABLE' }), null);
  assert.match(TD.probabilityShort({ ...p, n: 248, market_state: 'NEUTRAL' }), /^P \[market neutral\]: B 31%/);
  assert.equal(TD.probabilityShort({ status: 'UNAVAILABLE', n: 17, market_state: 'BEARISH', reason: 'insufficient calibrated historical evidence: 17 non-overlapping cases (minimum 20)' }), 'P [market bearish]: unavailable (only 17 cases)');
  assert.equal(TD.probabilityShort({ status: 'UNAVAILABLE', n: 64, market_state: 'BEARISH', reason: 'failed walk-forward validation: …' }), 'P [market bearish]: unavailable (failed walk-forward validation)');
});

test('scenario UNAVAILABLE reason covers the event type and its pooled family', () => {
  const mk = (type, k) => ({ event_type: type, event_date: new Date(T0 + k * 9 * DAY).toISOString(), gold_before: 100, gold_3d: 100, gold_direction: 'BEARISH', usd_reaction_direction: 'UP', data_source: {} });
  const cells = C.buildEventCells({ reactions: [...Array.from({ length: 5 }, (_, k) => mk('PCE', k)), ...Array.from({ length: 5 }, (_, k) => mk('CPI', k + 10))] });
  const p = C.scenarioProbability(cells, 'PCE', 'BEARISH', 'SHORT');
  assert.equal(p.status, 'UNAVAILABLE');
  assert.match(p.reason, /^PCE: insufficient calibrated historical evidence: 5 past releases .*; pooled inflation: insufficient calibrated historical evidence: 10 past releases/);
});
