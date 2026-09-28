'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { decompress } = require('../src/lib/lzma');
const { parseDukascopyCandles } = require('../src/lib/pricefeeds');
const { dxyFromPairs, parseTreasuryCsv, marketSnapshot, confirmEvent, parseCoinbaseRates, sourceQuality } = require('../src/lib/market');
const { reactionMetrics, directionOf, patternAnalysis, wilsonLower } = require('../src/lib/history');
const { computeDeskState } = require('../src/lib/desk');
const { buildReactionRow } = require('../src/lib/reactions');

test('LZMA decoder reproduces the Python reference output for a real Dukascopy file', () => {
  const raw = fs.readFileSync(path.join(__dirname, 'fixture_xauusd_20260824_min1.bi5'));
  const out = decompress(raw);
  assert.equal(out.length, 34560);
  assert.equal(crypto.createHash('sha1').update(out).digest('hex'), '6d4fc2d0111ed4de1aa9122bcdda393c9ad0e794');
  const candles = parseDukascopyCandles(raw, Date.UTC(2026, 7, 24), 'XAUUSD');
  assert.equal(candles[0].o, 4623.615);
});

test('DXY proxy uses the ICE weights (EUR 1.0, all pairs at 1 -> constant)', () => {
  assert.equal(Math.round(dxyFromPairs({ EURUSD: 1, USDJPY: 1, GBPUSD: 1, USDCAD: 1, USDSEK: 1, USDCHF: 1 }) * 1e6) / 1e6, 50.143481);
  const obs = parseCoinbaseRates({ data: { rates: { EUR: '0.877882', JPY: '157.29', GBP: '0.75484', CAD: '1.414305', SEK: '9.9183', CHF: '0.828398' } } }, '2026-09-27T00:00:00Z');
  const dxy = obs.find((o) => o.instrument === 'USD_PROXY');
  assert.ok(dxy.value > 95 && dxy.value < 110);
  assert.equal(dxy.quality, 'INDICATIVE');
});

test('Treasury CSV parsing includes 2Y, 10Y, 30Y and real 10Y', () => {
  const nominal = parseTreasuryCsv('Date,"2 Yr","10 Yr","30 Yr"\n09/25/2026,4.81,5.17,5.49\n', 'nominal');
  assert.deepEqual(nominal.map((o) => o.instrument), ['US2Y', 'US10Y', 'US30Y']);
  assert.equal(parseTreasuryCsv('Date,"10 YR"\n09/25/2026,2.83\n', 'real')[0].value, 2.83);
});

test('proxies are always labelled as proxies', () => {
  const q = sourceQuality({ instruments: { GOLD: { available: true, source: 'binance-paxgusdt-1d (gold proxy)' }, USD_PROXY: { available: true } }, data_quality: 'PARTIAL', missing: [] });
  assert.match(q.gold_source, /^PROXY/);
  assert.match(q.usd_source, /^PROXY/);
  const d = sourceQuality({ instruments: { GOLD: { available: true, source: 'gold-api.com' }, USD_PROXY: { available: true } }, data_quality: 'GOOD', missing: [] });
  assert.match(d.gold_source, /^DIRECT/);
});

test('reaction direction rules and Wilson bound', () => {
  assert.equal(directionOf(0.3, 0.5), 'BULLISH');
  assert.equal(directionOf(0.3, -0.4), 'MIXED');
  assert.equal(directionOf(0.01, 0.05), 'MIXED');
  const m = reactionMetrics({ gold_before: 100, gold_1h: 100.3, gold_4h: 100.6, usd_before: 1, usd_after: 0.998 });
  assert.equal(m.direction, 'BULLISH');
  assert.equal(m.usd_dir, 'DOWN');
  assert.ok(wilsonLower(0.8, 20) < 0.8 && wilsonLower(0.8, 20) > 0.5);
});

test('pattern analysis: small samples are UNDETERMINED', () => {
  const rows = [{ event_date: '2025-01-01T00:00:00Z', gold_before: 100, gold_1h: 101, gold_4h: 101 }];
  assert.equal(patternAnalysis(rows, {}, { minSample: 8, nowIso: '2026-09-27T00:00:00Z' }).historical_bias, 'UNDETERMINED');
});

test('market confirmation: confirmed, divergence, not yet measurable', () => {
  const t0 = Date.parse('2026-09-27T10:00:00Z');
  const s = (vals) => vals.map((v, i) => ({ t: new Date(t0 + (i - 2) * 30 * 60000).toISOString(), v }));
  const series = { GOLD: s([100, 100, 100, 100.5, 101]), USD_PROXY: s([100, 100, 100, 99.8, 99.6]) };
  const at = new Date(t0).toISOString();
  assert.equal(confirmEvent({ gold: 1, usd: -1, yields: -1 }, series, at, new Date(t0 + 60 * 60000).toISOString()).status, 'CONFIRMED');
  assert.equal(confirmEvent({ gold: -1, usd: 1, yields: 1 }, series, at, new Date(t0 + 60 * 60000).toISOString()).status, 'DIVERGENCE');
  assert.equal(confirmEvent({ gold: 1, usd: -1, yields: -1 }, series, at, new Date(t0 + 5 * 60000).toISOString()).status, 'NOT_YET_MEASURABLE');
});

test('desk state: no data -> UNDETERMINED regime', () => {
  const empty = marketSnapshot({}, '2026-09-27T00:00:00Z');
  assert.equal(computeDeskState([], empty, null, '2026-09-27T00:00:00Z').regime, 'UNDETERMINED');
});

test('desk state: headline volume cannot override a price-confirmed regime (conflict is explicit)', () => {
  const now = '2026-09-27T12:00:00.000Z';
  const s = (a, b) => Array.from({ length: 131 }, (_, k) => { const i = 130 - k; return { t: new Date(Date.parse(now) - i * 86400000).toISOString(), v: i > 20 ? a : a + ((b - a) * (20 - i)) / 20 }; });
  const snap = marketSnapshot({ GOLD: s(4400, 4280), USD_PROXY: s(99, 101), US2Y: s(4.4, 4.81), US10Y: s(4.8, 5.17), US10Y_REAL: s(2.4, 2.83) }, now);
  const war = Array.from({ length: 80 }, (_, i) => ({
    id: i, title: `war headline ${i}`, importance_score: 80, last_seen_at: new Date(Date.parse(now) - (i % 48) * 3600000).toISOString(),
    transmission: [{ channel: 'SAFE_HAVEN', active: true, horizon_effects: { SHORT: 0.8, TACTICAL: 0.6, SWING: 0.3, STRUCTURAL: 0.08 } }],
  }));
  const desk = computeDeskState(war, snap, null, now);
  assert.notEqual(desk.regime, 'SAFE-HAVEN BID');
  assert.ok(desk.confidence <= 85);
  if (desk.regime === 'MIXED / CONFLICTED') assert.ok(desk.regime_conflict === null || /SAFE-HAVEN BID/.test(desk.regime_conflict) || desk.horizons.TACTICAL.conflict);
});

test('reaction row: event time in ET, market-confirmation label and 15m/usd fields', () => {
  const t = Date.parse('2026-09-11T12:30:00Z');
  const mins = (base, step) => Array.from({ length: 280 }, (_, i) => ({ t: t - 20 * 60000 + i * 60000, o: base + i * step, c: base + i * step }));
  const { row } = buildReactionRow({ eventType: 'CPI', eventMs: t, goldMin: mins(4000, -0.5), goldHour: [], usdMin: mins(1.17, 0.00001), usdInvert: true, daily: { US2Y: [], US10Y: [], US10Y_REAL: [], GOLD: [], USD: [] }, sources: { gold: 'test', usd: 'test' } });
  assert.equal(row.event_time, '08:30 ET');
  assert.ok(row.gold_15m !== null && row.usd_4h !== null);
  assert.equal(row.gold_direction, 'BEARISH');
  assert.equal(row.usd_reaction_direction, 'DOWN');
  assert.match(row.market_confirmation, /DIVERGENT/);
});

test('stored desk data quality is downgraded when the market context is old (never upgraded)', () => {
  const { agedSourceQuality } = require('../src/lib/market');
  const sq = { level: 'GOOD', gold_source: 'DIRECT (x)', usd_source: 'PROXY (y)', reasons: [] };
  const now = '2026-09-27T12:00:00.000Z';
  assert.equal(agedSourceQuality(sq, '2026-09-27T11:45:00.000Z', now, 10).level, 'GOOD');
  const partial = agedSourceQuality(sq, '2026-09-27T10:00:00.000Z', now, 10);
  assert.equal(partial.level, 'PARTIAL');
  assert.match(partial.reasons[0], /market context 2h old/);
  assert.equal(agedSourceQuality(sq, '2026-09-26T20:00:00.000Z', now, 10).level, 'DEGRADED');
  assert.equal(agedSourceQuality({ ...sq, level: 'DEGRADED' }, '2026-09-27T11:00:00.000Z', now, 10).level, 'DEGRADED');
});

test('source quality reports the age of an intraday quote when the latest fetch failed', () => {
  const q = sourceQuality({ instruments: { GOLD: { available: true, source: 'gold-api.com', age_hours: 0.8, stale: false }, USD_PROXY: { available: true, age_hours: 0.05 } }, data_quality: 'GOOD', missing: [] });
  assert.ok(q.reasons.includes('gold quote 48 min old'));
  assert.ok(!q.reasons.some((r) => /USD quote/.test(r)));
});

test('desk confidence is reduced by cross-horizon opposition and price divergence', () => {
  const now = '2026-09-27T12:00:00.000Z';
  const s = (a, b, n = 131) => Array.from({ length: n }, (_, k) => { const i = n - 1 - k; return { t: new Date(Date.parse(now) - i * 86400000).toISOString(), v: i > 20 ? a : a + ((b - a) * (20 - i)) / 20 }; });
  // Every market driver and gold itself point the same way -> high confidence.
  const aligned = marketSnapshot({ GOLD: s(4400, 4200), USD_PROXY: s(99, 101), US2Y: s(4.4, 4.81), US10Y: s(4.8, 5.17), US10Y_REAL: s(2.4, 2.83) }, now);
  const a = computeDeskState([], aligned, null, now);
  // Same drivers, but gold rising over the same window (price diverges from the driver-implied bias).
  const diverging = marketSnapshot({ GOLD: s(4200, 4400), USD_PROXY: s(99, 101), US2Y: s(4.4, 4.81), US10Y: s(4.8, 5.17), US10Y_REAL: s(2.4, 2.83) }, now);
  const d = computeDeskState([], diverging, null, now);
  assert.ok(d.confidence < a.confidence, `diverging ${d.confidence} vs aligned ${a.confidence}`);
});

test('market snapshot ignores future-stamped points (e.g. a partial daily proxy candle)', () => {
  const now = '2026-09-27T17:00:00.000Z';
  const snap = marketSnapshot({ GOLD: [
    { t: '2026-09-27T16:09:33.000Z', v: 4286.2, src: 'gold-api.com' },
    { t: '2026-09-27T23:59:59.000Z', v: 4279.85, src: 'binance-paxgusdt-1d (gold proxy)' },
  ] }, now);
  assert.equal(snap.instruments.GOLD.value, 4286.2);
  assert.equal(snap.instruments.GOLD.source, 'gold-api.com');
});

test('daily closes from hourly candles drop the current incomplete day', () => {
  const { dailyClosesFromHours } = require('../src/lib/pricefeeds');
  const h = (iso, c) => ({ t: Date.parse(iso), c });
  const hours = [h('2026-09-25T20:00:00Z', 1), h('2026-09-26T20:00:00Z', 2), h('2026-09-27T15:00:00Z', 3)];
  const out = dailyClosesFromHours(hours, Date.parse('2026-09-27T17:00:00Z'));
  assert.deepEqual(out.map((x) => x.t), ['2026-09-25T23:59:59.000Z', '2026-09-26T23:59:59.000Z']);
  assert.equal(dailyClosesFromHours(hours).length, 3);
});
