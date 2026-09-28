'use strict';
/**
 * Builds historical_event_reactions rows from real price series. Shared by the
 * backfill tool and the live post-event review so both use identical definitions.
 *
 * Definitions (documented in SOURCE_MAP.md):
 *  gold_before : close of the last 1-minute candle before the release minute
 *  gold_Xm/h/d : close of the candle ending at release + X (24h/3d: last traded price)
 *  usd_before/after : USD proxy before the release and at +60 minutes
 *  2y/10y before/after : official daily Treasury curve, prior business day vs release day
 *  oil before/after : only when an intraday oil series is available, else NULL
 *  pre_*_trend : 5-day change states before the release (UP/DOWN/FLAT)
 */
const { closeAt } = require('./pricefeeds');
const { reactionMetrics, trendState } = require('./history');
const { valueAt } = require('./market');
const { pctChange, round } = require('./util');

const MIN = 60000;

function yieldBeforeAfter(series, eventMs) {
  if (!series || !series.length) return { before: null, after: null };
  const day = new Date(eventMs);
  const eventDay = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  let before = null;
  let after = null;
  for (const p of series) {
    const t = new Date(p.t).getTime();
    const pd = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate());
    if (pd < eventDay) before = p.v;
    else if (pd === eventDay) after = p.v;
    else break;
  }
  return { before, after };
}

function change5d(series, eventMs, isYield) {
  if (!series || !series.length) return null;
  const end = valueAt(series, new Date(eventMs - 60 * MIN).toISOString(), 96);
  const start = valueAt(series, new Date(eventMs - 5 * 86400000).toISOString(), 120);
  if (!end || !start || end === start) return null;
  return isYield ? (end.v - start.v) * 100 : pctChange(start.v, end.v);
}

function change20d(series, eventMs, isYield) {
  if (!series || !series.length) return null;
  const end = valueAt(series, new Date(eventMs - 60 * MIN).toISOString(), 96);
  const start = valueAt(series, new Date(eventMs - 28 * 86400000).toISOString(), 120);
  if (!end || !start || end === start) return null;
  return isYield ? (end.v - start.v) * 100 : pctChange(start.v, end.v);
}

/** Market-only regime label (news history is not available for backfilled dates). */
function marketRegime(realChangeBp20d, usdChangePct20d) {
  const r = realChangeBp20d;
  const u = usdChangePct20d;
  if (r !== null && Math.abs(r) >= 15 && (u === null || Math.abs(r) / 15 >= Math.abs(u) / 1.0)) {
    return r > 0 ? 'RATES / REAL-YIELD PRESSURE' : 'EASING / FALLING-YIELD TAILWIND';
  }
  if (u !== null && Math.abs(u) >= 1.0) return u > 0 ? 'DOLLAR STRENGTH HEADWIND' : 'DOLLAR WEAKNESS TAILWIND';
  if (r === null && u === null) return null;
  return 'QUIET / RANGE';
}

/**
 * @param {object} p
 *  eventType, eventMs, goldMin (1m candles around event), goldHour (1h candles to +4d),
 *  usdMin (1m), usdInvert (bool), oilMin (1m or null), daily: {US2Y,US10Y,US10Y_REAL,GOLD,USD} series [{t,v}],
 *  sources: {gold, usd, oil}, consensus/actual/previous (optional), surpriseBasis
 */
function buildReactionRow(p) {
  const t = p.eventMs;
  const g = p.goldMin || [];
  const gh = p.goldHour || [];
  const at = (mins, maxLag) => closeAt(g, t + mins * MIN - MIN, maxLag);
  const later = (hours) => closeAt(gh.length ? gh : g, t + hours * 3600000 - (gh.length ? 3600000 : MIN), 72 * 60);
  const goldBefore = closeAt(g, t - MIN, 15);
  const inv = (v) => (v === null || v === undefined ? null : p.usdInvert ? 1 / v : v);
  const usdBefore = inv(closeAt(p.usdMin || [], t - MIN, 15));
  const usdAfter = inv(closeAt(p.usdMin || [], t + 59 * MIN, 15));
  const y2 = yieldBeforeAfter(p.daily.US2Y, t);
  const y10 = yieldBeforeAfter(p.daily.US10Y, t);
  const oilBefore = p.oilMin ? closeAt(p.oilMin, t - MIN, 15) : null;
  const oilAfter = p.oilMin ? closeAt(p.oilMin, t + 59 * MIN, 15) : null;
  const row = {
    event_type: p.eventType,
    event_date: new Date(t).toISOString(),
    consensus: p.consensus ?? null,
    actual: p.actual ?? null,
    previous: p.previous ?? null,
    revised_previous: p.revisedPrevious ?? null,
    surprise: p.surprise ?? null,
    surprise_basis: p.surprise !== null && p.surprise !== undefined && p.consensus !== null && p.consensus !== undefined ? 'CONSENSUS' : 'NOT_AVAILABLE',
    gold_before: goldBefore === null ? null : round(goldBefore, 3),
    gold_5m: at(5, 3) === null ? null : round(at(5, 3), 3),
    gold_30m: at(30, 5) === null ? null : round(at(30, 5), 3),
    gold_1h: at(60, 10) === null ? null : round(at(60, 10), 3),
    gold_4h: at(240, 30) === null ? null : round(at(240, 30), 3),
    gold_24h: later(24) === null ? null : round(later(24), 3),
    gold_3d: later(72) === null ? null : round(later(72), 3),
    usd_before: usdBefore === null ? null : round(usdBefore, 6),
    usd_after: usdAfter === null ? null : round(usdAfter, 6),
    usd_instrument: p.sources.usd || null,
    '2y_before': y2.before, '2y_after': y2.after,
    '10y_before': y10.before, '10y_after': y10.after,
    oil_before: oilBefore === null ? null : round(oilBefore, 3),
    oil_after: oilAfter === null ? null : round(oilAfter, 3),
  };
  const m = reactionMetrics(row);
  row.gold_direction = m.direction;
  row.reaction_strength = m.direction ? m.strength : null;
  row.usd_reaction_direction = m.usd_dir;
  row.pre_gold_trend = trendState(change5d(p.daily.GOLD, t, false), 1.0);
  row.pre_usd_trend = trendState(change5d(p.daily.USD, t, false), 0.5);
  row.pre_10y_trend = trendState(change5d(p.daily.US10Y, t, true), 8);
  const rr = change20d(p.daily.US10Y_REAL, t, true);
  const uu = change20d(p.daily.USD, t, false);
  row.regime = marketRegime(rr === null ? null : round(rr, 1), uu === null ? null : round(uu, 2));
  const missing = ['gold_before', 'gold_5m', 'gold_30m', 'gold_1h', 'gold_4h'].filter((k) => row[k] === null);
  row.data_quality = !row.gold_before || !row.gold_1h ? 'INSUFFICIENT' : missing.length ? 'PARTIAL' : 'OK';
  row.data_source = {
    gold: p.sources.gold, usd: p.sources.usd, oil: p.sources.oil || 'NOT_AVAILABLE', yields: 'US Treasury daily par/real curves (official)',
    regime_basis: 'MARKET_ONLY (20d real-yield / USD change)', actual_vintage: p.actualVintage || null,
    reference_period: p.referencePeriod || null, release_source: p.releaseSource || null,
  };
  row.origin = p.origin || 'BACKFILL';
  // Extended fields (forecast engine, spec §4).
  const usdAt = (mins) => { const v = inv(closeAt(p.usdMin || [], t + mins * MIN - MIN, 15)); return v === null ? null : round(v, 6); };
  row.gold_15m = at(15, 4) === null ? null : round(at(15, 4), 3);
  row.usd_5m = usdAt(5);
  row.usd_30m = usdAt(30);
  row.usd_1h = usdAt(60);
  row.usd_4h = usdAt(240);
  row['2y_1h'] = null; // intraday Treasury yields: NOT AVAILABLE from free sources
  row['10y_1h'] = null;
  const real = yieldBeforeAfter(p.daily.US10Y_REAL, t);
  row.real10y_before = real.before;
  row.real10y_after = real.after;
  row.event_time = `${new Date(t).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })} ET`;
  const scale = SURPRISE_SCALE[p.eventType];
  row.surprise_normalized = row.surprise !== null && row.surprise !== undefined && scale ? round(row.surprise / scale, 2) : null;
  row.surprise_normalized_basis = row.surprise_normalized === null ? null : `surprise / typical scale ${scale}`;
  row.macro_regime = row.regime;
  row.market_confirmation = !m.direction || !m.usd_dir ? null
    : (m.usd_dir === 'UP' && m.direction === 'BEARISH') || (m.usd_dir === 'DOWN' && m.direction === 'BULLISH') ? 'CONFIRMED (USD and gold moved inversely)'
      : m.usd_dir === 'FLAT' || m.direction === 'MIXED' ? 'NEUTRAL' : 'DIVERGENT (USD and gold moved together)';
  row.event_notes = p.eventNotes || null;
  if (p.geopoliticalState) row.geopolitical_state = p.geopoliticalState;
  if (p.politicalState) row.political_state = p.politicalState;
  return { row, metrics: m };
}

// Typical surprise scale per event type (consensus units) for surprise_normalized.
const SURPRISE_SCALE = { CPI: 0.1, PCE: 0.1, PPI: 0.2, NFP: 50, GDP: 0.5, JOLTS: 300, FOMC: 0.25, RETAIL_SALES: 0.4, JOBLESS_CLAIMS: 15 };

module.exports = { buildReactionRow, marketRegime, yieldBeforeAfter, change5d, SURPRISE_SCALE };
