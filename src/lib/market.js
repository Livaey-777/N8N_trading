'use strict';
/**
 * Market data parsing, multi-horizon state and event-level market confirmation.
 * Every figure carries its source and resolution; nothing is interpolated or invented.
 */
const { parseCsv } = require('./feeds');
const { pctChange, round, clamp } = require('./util');

// ICE U.S. Dollar Index weights (published methodology).
const DXY_CONST = 50.14348112;
const DXY_WEIGHTS = { EURUSD: -0.576, USDJPY: 0.136, GBPUSD: -0.119, USDCAD: 0.091, USDSEK: 0.042, USDCHF: 0.036 };

function dxyFromPairs(p) {
  for (const k of Object.keys(DXY_WEIGHTS)) if (!(p[k] > 0)) return null;
  let v = DXY_CONST;
  for (const [k, w] of Object.entries(DXY_WEIGHTS)) v *= p[k] ** w;
  return v;
}

/** gold-api.com: {"price":4286.2,"updatedAt":"2026-09-27T00:02:29Z",...} */
function parseGoldApi(json) {
  const price = Number(json && json.price);
  const ts = json && json.updatedAt ? new Date(json.updatedAt) : null;
  if (!(price > 100 && price < 100000) || !ts || Number.isNaN(ts.getTime())) return null;
  return { observed_at: ts.toISOString(), price: round(price, 3), source: 'gold-api.com' };
}

/** Coinbase public exchange rates (units per 1 USD) -> major pairs + ICE-formula DXY proxy. */
function parseCoinbaseRates(json, fetchedAt) {
  const r = json && json.data && json.data.rates;
  if (!r) return [];
  const per = (c) => Number(r[c]);
  const pairs = {
    EURUSD: per('EUR') > 0 ? 1 / per('EUR') : null,
    USDJPY: per('JPY') || null,
    GBPUSD: per('GBP') > 0 ? 1 / per('GBP') : null,
    USDCAD: per('CAD') || null,
    USDSEK: per('SEK') || null,
    USDCHF: per('CHF') || null,
  };
  const out = [];
  for (const [k, v] of Object.entries(pairs)) {
    if (v) out.push({ observed_at: fetchedAt, instrument: k, value: round(v, 6), unit: 'rate', source: 'coinbase-rates', resolution: 'intraday', quality: 'INDICATIVE' });
  }
  const dxy = dxyFromPairs(pairs);
  if (dxy) {
    out.push({ observed_at: fetchedAt, instrument: 'USD_PROXY', value: round(dxy, 4), unit: 'index', source: 'coinbase-rates/ICE-formula', resolution: 'intraday', quality: 'INDICATIVE', details: { method: 'ICE DXY weights applied to indicative fiat rates' } });
  }
  return out;
}

/** US Treasury daily par / real yield curve CSV -> observations (official, daily close). */
function parseTreasuryCsv(csv, kind) {
  const rows = parseCsv(csv);
  const out = [];
  for (const row of rows) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(row.Date || '');
    if (!m) continue;
    // Treasury curves are "as of close" (~3:30pm ET); stamp 20:00 UTC of the curve date.
    const observed = new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), 20, 0)).toISOString();
    const add = (instrument, v) => {
      const n = Number(v);
      if (v !== '' && Number.isFinite(n)) out.push({ observed_at: observed, instrument, value: n, unit: '%', source: 'us-treasury', resolution: 'daily', quality: 'OFFICIAL' });
    };
    if (kind === 'nominal') { add('US2Y', row['2 Yr']); add('US10Y', row['10 Yr']); add('US30Y', row['30 Yr']); }
    else if (kind === 'real') add('US10Y_REAL', row['10 YR']);
  }
  return out;
}

/** CFTC legacy futures-only report (COMEX gold 088691) -> non-commercial net positioning. */
function parseCftcCot(rows) {
  const out = [];
  for (const r of rows || []) {
    const date = r.report_date_as_yyyy_mm_dd ? `${r.report_date_as_yyyy_mm_dd.slice(0, 10)}T20:30:00.000Z` : null;
    const long = Number(r.noncomm_positions_long_all);
    const short = Number(r.noncomm_positions_short_all);
    const oi = Number(r.open_interest_all);
    if (!date || !Number.isFinite(long) || !Number.isFinite(short) || !(oi > 0)) continue;
    out.push({ observed_at: date, instrument: 'GOLD_COT_NONCOMM_NET', value: long - short, unit: 'contracts', source: 'cftc-cot', resolution: 'weekly', quality: 'OFFICIAL', details: { long, short, open_interest: oi, net_pct_oi: round(((long - short) / oi) * 100, 2) } });
  }
  return out;
}

/** FRED observations JSON -> observations (optional; requires FRED_API_KEY). */
function parseFred(json, seriesId, instrument, unit) {
  const out = [];
  for (const o of (json && json.observations) || []) {
    const v = Number(o.value);
    if (o.value === '.' || !Number.isFinite(v)) continue;
    out.push({ observed_at: `${o.date}T21:00:00.000Z`, instrument, value: v, unit, source: `fred:${seriesId}`, resolution: 'daily', quality: 'OFFICIAL' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Series helpers
// ---------------------------------------------------------------------------

/** Latest point at or before t (series sorted ascending by time). */
function valueAt(series, t, maxAgeHours) {
  const target = new Date(t).getTime();
  let lo = 0;
  let hi = series.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const mt = new Date(series[mid].t).getTime();
    if (mt <= target) { best = series[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  if (!best) return null;
  if (maxAgeHours !== undefined && (target - new Date(best.t).getTime()) / 3600000 > maxAgeHours) return null;
  return best;
}

const HORIZON_WINDOWS = {
  '1h': { hours: 1, tol: 0.5 },
  '4h': { hours: 4, tol: 1 },
  '24h': { hours: 24, tol: 6 },
  '5d': { hours: 120, tol: 48 },
  '20d': { hours: 480, tol: 96 },
  '90d': { hours: 2160, tol: 240 },
};

// Flat bands: % for prices/indices, basis points for yields.
const FLAT_BANDS = {
  GOLD: { '1h': 0.15, '4h': 0.25, '24h': 0.4, '5d': 1.0, '20d': 2.0, '90d': 4.0 },
  USD_PROXY: { '1h': 0.08, '4h': 0.12, '24h': 0.2, '5d': 0.5, '20d': 1.0, '90d': 2.0 },
  YIELD_BP: { '24h': 3, '5d': 8, '20d': 15, '90d': 30 },
  WTI: { '24h': 1.0, '5d': 3.0, '20d': 6.0, '90d': 10.0 },
};

function changeOver(series, horizon, isYield) {
  if (!series || !series.length) return null;
  const last = series[series.length - 1];
  const w = HORIZON_WINDOWS[horizon];
  const from = valueAt(series, new Date(new Date(last.t).getTime() - w.hours * 3600000).toISOString());
  if (!from) return null;
  const spanH = (new Date(last.t) - new Date(from.t)) / 3600000;
  if (spanH < w.hours - w.tol || spanH > w.hours + w.tol * 3) return null;
  return isYield ? round((last.v - from.v) * 100, 1) : round(pctChange(from.v, last.v), 3);
}

function state(change, band) {
  if (change === null || change === undefined || band === undefined) return 'UNAVAILABLE';
  if (Math.abs(change) < band) return 'FLAT';
  return change > 0 ? 'UP' : 'DOWN';
}

/**
 * @param {Record<string, Array<{t:string,v:number}>>} series  keyed by GOLD, USD_PROXY, US2Y, US10Y, US10Y_REAL, WTI, VIX, GOLD_COT_NONCOMM_NET
 * @param {string} nowIso
 */
function marketSnapshot(series, nowIso) {
  const now = new Date(nowIso).getTime();
  const snap = { as_of: nowIso, instruments: {}, missing: [] };
  // Never use future-stamped points (partial candles / clock skew) as the latest value.
  const upTo = (arr) => (arr || []).filter((p) => Date.parse(p.t) <= now + 5 * 60000);
  const describe = (key, opts) => {
    const s = upTo(series[key]);
    if (!s.length) { snap.missing.push(key); snap.instruments[key] = { available: false }; return; }
    const last = s[s.length - 1];
    const ageH = (now - new Date(last.t).getTime()) / 3600000;
    const info = { available: true, value: last.v, observed_at: last.t, age_hours: round(ageH, 2), source: last.src || null, resolution: opts.resolution, changes: {}, states: {} };
    for (const h of opts.horizons) {
      const c = changeOver(s, h, opts.isYield);
      info.changes[h] = c;
      info.states[h] = state(c, opts.bands[h]);
    }
    info.stale = ageH > opts.staleHours;
    if (info.stale) snap.missing.push(`${key}(stale)`);
    snap.instruments[key] = info;
  };
  describe('GOLD', { resolution: 'intraday', horizons: ['1h', '4h', '24h', '5d', '20d', '90d'], bands: FLAT_BANDS.GOLD, staleHours: 1 });
  describe('USD_PROXY', { resolution: 'intraday', horizons: ['1h', '4h', '24h', '5d', '20d', '90d'], bands: FLAT_BANDS.USD_PROXY, staleHours: 2 });
  describe('US2Y', { resolution: 'daily', horizons: ['24h', '5d', '20d', '90d'], bands: FLAT_BANDS.YIELD_BP, staleHours: 100, isYield: true });
  describe('US10Y', { resolution: 'daily', horizons: ['24h', '5d', '20d', '90d'], bands: FLAT_BANDS.YIELD_BP, staleHours: 100, isYield: true });
  describe('US30Y', { resolution: 'daily', horizons: ['24h', '5d', '20d', '90d'], bands: FLAT_BANDS.YIELD_BP, staleHours: 100, isYield: true });
  describe('US10Y_REAL', { resolution: 'daily', horizons: ['24h', '5d', '20d', '90d'], bands: FLAT_BANDS.YIELD_BP, staleHours: 100, isYield: true });
  describe('WTI', { resolution: 'daily', horizons: ['24h', '5d', '20d', '90d'], bands: FLAT_BANDS.WTI, staleHours: 100 });
  describe('VIX', { resolution: 'daily', horizons: ['24h', '5d'], bands: { '24h': 5, '5d': 10 }, staleHours: 100 });
  const cot = upTo(series.GOLD_COT_NONCOMM_NET);
  if (cot.length) {
    const last = cot[cot.length - 1];
    const hist = cot.slice(-156).map((p) => p.v).sort((a, b) => a - b);
    const rank = hist.filter((v) => v <= last.v).length / hist.length;
    snap.instruments.GOLD_COT_NONCOMM_NET = {
      available: true, value: last.v, observed_at: last.t, resolution: 'weekly', source: 'cftc-cot',
      percentile_3y: round(rank * 100, 0), sample_weeks: hist.length,
      positioning: hist.length < 26 ? 'INSUFFICIENT_HISTORY' : rank >= 0.85 ? 'CROWDED_LONG' : rank <= 0.15 ? 'LIGHT_LONG' : 'NEUTRAL',
    };
  } else { snap.missing.push('GOLD_COT_NONCOMM_NET'); snap.instruments.GOLD_COT_NONCOMM_NET = { available: false }; }
  const core = ['GOLD', 'USD_PROXY', 'US2Y', 'US10Y', 'US10Y_REAL'];
  const okCore = core.filter((k) => snap.instruments[k].available && !snap.instruments[k].stale).length;
  snap.data_quality = okCore === core.length ? 'GOOD' : okCore >= 3 ? 'PARTIAL' : 'POOR';
  snap.coverage = round(okCore / core.length, 2);
  return snap;
}

/**
 * Compares the expected cross-asset response of an event with what markets did since.
 * @param {{gold:number, usd:number, yields:number}} expected  signs (-1/0/1)
 * @param {Record<string, Array<{t,v}>>} series
 * @param {string} eventTime ISO (first seen)
 * @param {string} nowIso
 */
function confirmEvent(expected, series, eventTime, nowIso) {
  const elapsedMin = (new Date(nowIso) - new Date(eventTime)) / 60000;
  const gold = series.GOLD || [];
  const usd = series.USD_PROXY || [];
  const res = { status: 'DATA_UNAVAILABLE', expected, elapsed_min: Math.round(elapsedMin), gold_move_pct: null, usd_move_pct: null, notes: [] };
  if (!gold.length) { res.notes.push('no gold observations'); return res; }
  if (elapsedMin < 15) { res.status = 'NOT_YET_MEASURABLE'; res.notes.push('less than 15 minutes since first report'); return res; }
  const g0 = valueAt(gold, eventTime, 1);
  const g1 = valueAt(gold, nowIso, 1);
  if (!g0 || !g1 || g0 === g1) {
    res.status = elapsedMin > 60 * 24 ? 'DATA_UNAVAILABLE' : 'NOT_YET_MEASURABLE';
    res.notes.push('no gold observation bracketing the event time');
    return res;
  }
  res.gold_move_pct = round(pctChange(g0.v, g1.v), 3);
  const u0 = valueAt(usd, eventTime, 2);
  const u1 = valueAt(usd, nowIso, 2);
  if (u0 && u1 && u0 !== u1) res.usd_move_pct = round(pctChange(u0.v, u1.v), 3);
  const band = elapsedMin <= 90 ? 0.15 : elapsedMin <= 300 ? 0.25 : 0.4;
  const gDir = Math.abs(res.gold_move_pct) < band ? 0 : Math.sign(res.gold_move_pct);
  const uDir = res.usd_move_pct === null ? null : Math.abs(res.usd_move_pct) < 0.08 ? 0 : Math.sign(res.usd_move_pct);
  // Pre-event drift: did gold already move in the expected direction in the 2h before the event?
  const pre = valueAt(gold, new Date(new Date(eventTime).getTime() - 2 * 3600000).toISOString(), 1);
  const preMove = pre ? pctChange(pre.v, g0.v) : null;
  if (expected.gold === 0) {
    res.status = 'NO_DIRECTIONAL_THESIS';
  } else if (gDir === expected.gold) {
    res.status = uDir !== null && expected.usd !== 0 && uDir === -expected.usd ? 'CONFIRMED' : 'CONFIRMED_GOLD_ONLY';
    if (res.status === 'CONFIRMED_GOLD_ONLY' && uDir !== null && expected.usd !== 0 && uDir !== 0 && uDir === expected.usd) res.status = 'CONFIRMED';
  } else if (gDir === 0) {
    res.status = 'PARTIAL';
    res.notes.push('gold move within noise band');
  } else {
    res.status = 'DIVERGENCE';
    const hyp = [];
    if (preMove !== null && Math.sign(preMove) === expected.gold && Math.abs(preMove) >= 0.3) hyp.push('move largely priced in before the first report (pre-event drift)');
    if (res.usd_move_pct !== null && Math.sign(res.usd_move_pct) === expected.gold && Math.abs(res.usd_move_pct) >= 0.25) hyp.push('USD move dominating the event channel');
    if (!hyp.length) hyp.push('competing drivers or positioning/liquidity flows not captured by the event');
    res.divergence_hypotheses = hyp;
  }
  if (expected.usd !== 0 && uDir !== null && uDir !== 0) {
    res.usd_confirms = uDir === expected.usd;
  }
  res.gold_pre_event_move_pct = preMove === null ? null : round(preMove, 3);
  return res;
}

/** Signed market-driver scores per horizon (for the desk state), gold perspective. */
function marketDriverScores(snap) {
  const i = snap.instruments;
  const tanh = (x) => Math.tanh(x);
  const val = (k, h) => (i[k] && i[k].available && i[k].changes ? i[k].changes[h] : null);
  const out = { SHORT: [], TACTICAL: [], SWING: [], STRUCTURAL: [] };
  const push = (h, name, change, scale, invert) => {
    if (change === null || change === undefined) return;
    out[h].push({ driver: name, change, score: round((invert ? -1 : 1) * tanh(change / scale), 3) });
  };
  push('SHORT', 'USD', val('USD_PROXY', '24h'), 0.5, true);
  push('SHORT', 'US10Y', val('US10Y', '24h'), 6, true);
  push('TACTICAL', 'USD', val('USD_PROXY', '5d'), 1.0, true);
  push('TACTICAL', 'REAL_YIELD', val('US10Y_REAL', '5d'), 12, true);
  push('TACTICAL', 'US2Y', val('US2Y', '5d'), 12, true);
  push('SWING', 'USD', val('USD_PROXY', '20d'), 2.0, true);
  push('SWING', 'REAL_YIELD', val('US10Y_REAL', '20d'), 25, true);
  push('STRUCTURAL', 'REAL_YIELD', val('US10Y_REAL', '90d'), 45, true);
  push('STRUCTURAL', 'USD', val('USD_PROXY', '90d'), 4.0, true);
  const cot = i.GOLD_COT_NONCOMM_NET;
  if (cot && cot.available && cot.positioning === 'CROWDED_LONG') out.TACTICAL.push({ driver: 'POSITIONING', change: cot.percentile_3y, score: -0.35 });
  if (cot && cot.available && cot.positioning === 'LIGHT_LONG') out.TACTICAL.push({ driver: 'POSITIONING', change: cot.percentile_3y, score: 0.35 });
  const agg = {};
  for (const [h, arr] of Object.entries(out)) {
    agg[h] = { drivers: arr, score: arr.length ? round(clamp(arr.reduce((s, x) => s + x.score, 0) / arr.length, -1, 1), 3) : null };
  }
  return agg;
}


/**
 * Explicit DIRECT / PROXY labelling for every report (a proxy is never presented as the true series).
 */
function sourceQuality(snap, opts = {}) {
  const g = snap.instruments.GOLD || {};
  const src = String(g.source || '');
  const gold = !g.available ? 'NOT AVAILABLE'
    : /paxg|binance/i.test(src) ? 'PROXY (PAXG/USDT tokenised gold — not spot XAUUSD)'
      : /dukascopy/i.test(src) ? 'DIRECT (Dukascopy XAUUSD spot)'
        : `DIRECT (spot XAU/USD quote via ${src || 'gold-api.com'})`;
  const u = snap.instruments.USD_PROXY || {};
  const usd = !u.available ? 'NOT AVAILABLE' : 'PROXY (DXY formula on indicative FX — not the official ICE DXY)';
  const level = snap.data_quality === 'GOOD' ? 'GOOD' : snap.data_quality === 'PARTIAL' ? 'PARTIAL' : 'DEGRADED';
  const reasons = (snap.missing || []).filter((x) => !/^(WTI|VIX)$/.test(x)).map((x) => `missing ${x}`);
  // Intraday quotes older than 20 minutes are reported with their age (e.g. last fetch failed).
  for (const [key, label] of [['GOLD', 'gold'], ['USD_PROXY', 'USD']]) {
    const i = snap.instruments[key] || {};
    if (i.available && !i.stale && i.age_hours > 1 / 3) reasons.push(`${label} quote ${Math.round(i.age_hours * 60)} min old`);
  }
  if ((snap.missing || []).includes('WTI')) reasons.push('oil NOT AVAILABLE (optional FRED key)');
  return { level: opts.level || level, gold_source: gold, usd_source: usd, history_source: opts.historySource || null, reasons: [...(opts.reasons || []), ...reasons] };
}

/**
 * Downgrade a stored desk source-quality when the market context itself is old: beyond
 * 3 market intervals -> at least PARTIAL, beyond 12h -> DEGRADED. Never upgrades.
 */
function agedSourceQuality(sq, asOfIso, nowIso, intervalMin) {
  if (!sq) return sq;
  const ageMin = Math.round((Date.parse(nowIso) - Date.parse(asOfIso)) / 60000);
  if (!Number.isFinite(ageMin) || ageMin <= 3 * (intervalMin || 10)) return sq;
  const rank = { GOOD: 0, PARTIAL: 1, DEGRADED: 2 };
  const floor = ageMin > 720 ? 'DEGRADED' : 'PARTIAL';
  const level = (rank[sq.level] ?? 2) >= rank[floor] ? sq.level : floor;
  const age = ageMin >= 120 ? `${Math.round(ageMin / 60)}h` : `${ageMin} min`;
  return { ...sq, level, reasons: [`market context ${age} old`, ...(sq.reasons || [])] };
}

module.exports = {
  sourceQuality, agedSourceQuality,
  dxyFromPairs, parseGoldApi, parseCoinbaseRates, parseTreasuryCsv, parseCftcCot, parseFred,
  valueAt, changeOver, marketSnapshot, confirmEvent, marketDriverScores, FLAT_BANDS,
};
