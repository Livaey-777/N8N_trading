'use strict';
/**
 * Historical reaction database analytics: per-event reaction metrics, the
 * pattern engine (similar past events -> reaction distribution) and
 * conditional distributions used by pre-event scenarios.
 */
const { pctChange, round, clamp } = require('./util');

const DIR_BAND_PCT = 0.15;           // |gold move| below this = no direction
const USD_BAND_PCT = 0.05;           // |USD move| below this = flat
const PRIMARY_HORIZON = 'ret_4h';

function num(v) { return v === null || v === undefined || v === '' ? null : Number(v); }

function reactionMetrics(row) {
  const g0 = num(row.gold_before);
  const r = (k) => (g0 && num(row[k]) ? round(pctChange(g0, num(row[k])), 3) : null);
  const m = {
    ret_5m: r('gold_5m'), ret_30m: r('gold_30m'), ret_1h: r('gold_1h'), ret_4h: r('gold_4h'),
    ret_24h: r('gold_24h'), ret_3d: r('gold_3d'),
  };
  const u0 = num(row.usd_before);
  const u1 = num(row.usd_after);
  m.usd_move_pct = u0 && u1 ? round(pctChange(u0, u1), 3) : null;
  m.usd_dir = m.usd_move_pct === null ? null : Math.abs(m.usd_move_pct) < USD_BAND_PCT ? 'FLAT' : m.usd_move_pct > 0 ? 'UP' : 'DOWN';
  m.direction = directionOf(m.ret_1h, m.ret_4h);
  const a = Math.abs(m.ret_4h === null ? (m.ret_1h || 0) : m.ret_4h);
  m.strength = a < 0.3 ? 'WEAK' : a < 0.8 ? 'MODERATE' : 'STRONG';
  return m;
}

/** BULLISH / BEARISH at the primary horizon; MIXED when flat or when 1h and 4h disagree. */
function directionOf(r1h, r4h) {
  const primary = r4h !== null && r4h !== undefined ? r4h : r1h;
  if (primary === null || primary === undefined) return null;
  if (Math.abs(primary) < DIR_BAND_PCT) return 'MIXED';
  if (r1h !== null && r4h !== null && Math.abs(r1h) >= DIR_BAND_PCT && Math.sign(r1h) !== Math.sign(r4h)) return 'MIXED';
  return primary > 0 ? 'BULLISH' : 'BEARISH';
}

function median(arr) {
  const a = arr.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return round(a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2, 3);
}

/** Wilson score lower bound (one-sided, z=1.64 ~ 95%). */
function wilsonLower(p, n, z = 1.64) {
  if (!n) return 0;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return clamp((centre - margin) / d, 0, 1);
}

function distribution(rows, weights) {
  let wb = 0; let wr = 0; let wm = 0; let wt = 0;
  const counts = { BULLISH: 0, BEARISH: 0, MIXED: 0 };
  rows.forEach((row, i) => {
    const w = weights ? weights[i] : 1;
    const d = row.metrics.direction;
    if (!d) return;
    counts[d]++;
    wt += w;
    if (d === 'BULLISH') wb += w; else if (d === 'BEARISH') wr += w; else wm += w;
  });
  const n = counts.BULLISH + counts.BEARISH + counts.MIXED;
  return {
    n,
    bullish_cases: counts.BULLISH,
    bearish_cases: counts.BEARISH,
    mixed_cases: counts.MIXED,
    p_bull: wt ? round(wb / wt, 3) : null,
    p_bear: wt ? round(wr / wt, 3) : null,
    p_mixed: wt ? round(wm / wt, 3) : null,
    median_ret_1h: median(rows.map((r) => r.metrics.ret_1h)),
    median_ret_4h: median(rows.map((r) => r.metrics.ret_4h)),
    median_ret_24h: median(rows.map((r) => r.metrics.ret_24h)),
    median_abs_ret_4h: median(rows.map((r) => (r.metrics.ret_4h === null ? null : Math.abs(r.metrics.ret_4h)))),
  };
}

function biasFrom(dist, minSample) {
  if (!dist.n || dist.n < minSample) return { bias: 'UNDETERMINED', confidence: 0 };
  const pb = dist.p_bull || 0;
  const pr = dist.p_bear || 0;
  let bias = 'MIXED';
  if (pb >= 0.55 && pb - pr >= 0.15) bias = 'BULLISH';
  else if (pr >= 0.55 && pr - pb >= 0.15) bias = 'BEARISH';
  const pMax = Math.max(pb, pr);
  const conf = Math.round(100 * clamp((wilsonLower(pMax, dist.n) - 0.2) / 0.6, 0, 0.85));
  return { bias, confidence: bias === 'MIXED' ? Math.min(conf, 35) : conf };
}

function trendMatch(a, b) {
  if (!a || !b || a === 'UNAVAILABLE' || b === 'UNAVAILABLE') return null;
  return a === b;
}

/**
 * @param {Array} rows   historical_event_reactions rows for the event type (any order)
 * @param {{pre_gold_trend?:string, pre_usd_trend?:string, pre_10y_trend?:string, regime?:string}} ctx
 * @param {{minSample:number, nowIso:string}} cfg
 */
function patternAnalysis(rows, ctx, cfg) {
  const enriched = rows.map((row) => ({ row, metrics: reactionMetrics(row) })).filter((r) => r.metrics.direction);
  const now = new Date(cfg.nowIso).getTime();
  const weights = enriched.map(({ row }) => {
    let w = 1;
    const g = trendMatch(row.pre_gold_trend, ctx.pre_gold_trend);
    const u = trendMatch(row.pre_usd_trend, ctx.pre_usd_trend);
    const y = trendMatch(row.pre_10y_trend, ctx.pre_10y_trend);
    if (g !== null) w *= g ? 1.3 : 0.8;
    if (u !== null) w *= u ? 1.2 : 0.85;
    if (y !== null) w *= y ? 1.2 : 0.85;
    if (ctx.regime && row.regime) w *= row.regime === ctx.regime ? 1.2 : 1;
    const ageYears = (now - new Date(row.event_date).getTime()) / (365.25 * 86400000);
    w *= 0.5 + 0.5 * Math.exp(-Math.max(ageYears, 0) / 3);
    return w;
  });
  const full = distribution(enriched, weights);
  const fullBias = biasFrom(full, cfg.minSample);
  // Context-matched subset: top half by similarity weight (min 8 cases).
  const order = enriched.map((r, i) => [r, weights[i]]).sort((a, b) => b[1] - a[1]);
  const k = Math.max(Math.min(8, order.length), Math.ceil(order.length / 2));
  const similar = order.slice(0, k);
  const simDist = distribution(similar.map((x) => x[0]), similar.map((x) => x[1]));
  const simBias = biasFrom(simDist, Math.max(5, Math.round(cfg.minSample * 0.6)));
  // Conditional on the market-implied surprise (USD reaction in the first 30-60 min).
  const byUsd = {};
  for (const dir of ['UP', 'DOWN', 'FLAT']) {
    const subset = enriched.filter((r) => r.metrics.usd_dir === dir);
    byUsd[dir] = { ...distribution(subset), label: dir === 'UP' ? 'USD rose after release (hawkish/hot reading)' : dir === 'DOWN' ? 'USD fell after release (dovish/soft reading)' : 'USD flat (in-line / muted)' };
  }
  // Conditional on the consensus surprise where consensus exists.
  const withSurprise = enriched.filter((r) => r.row.surprise !== null && r.row.surprise !== undefined && r.row.surprise_basis === 'CONSENSUS');
  const bySurprise = withSurprise.length ? {
    POSITIVE: distribution(withSurprise.filter((r) => Number(r.row.surprise) > 0)),
    NEGATIVE: distribution(withSurprise.filter((r) => Number(r.row.surprise) < 0)),
    ZERO: distribution(withSurprise.filter((r) => Number(r.row.surprise) === 0)),
  } : null;
  const dates = enriched.map((r) => r.row.event_date).sort();
  return {
    historical_sample_size: full.n,
    bullish_cases: full.bullish_cases,
    bearish_cases: full.bearish_cases,
    mixed_cases: full.mixed_cases,
    historical_bias: fullBias.bias,
    historical_confidence: fullBias.confidence,
    weighted_shares: { bull: full.p_bull, bear: full.p_bear, mixed: full.p_mixed },
    median_returns_pct: { '1h': full.median_ret_1h, '4h': full.median_ret_4h, '24h': full.median_ret_24h, abs_4h: full.median_abs_ret_4h },
    similar_context: { size: simDist.n, bullish_cases: simDist.bullish_cases, bearish_cases: simDist.bearish_cases, mixed_cases: simDist.mixed_cases, bias: simBias.bias, confidence: simBias.confidence, median_ret_4h: simDist.median_ret_4h },
    conditional_on_usd_reaction: byUsd,
    conditional_on_consensus_surprise: bySurprise,
    consensus_coverage: enriched.length ? round(withSurprise.length / enriched.length, 2) : 0,
    period: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    primary_horizon: PRIMARY_HORIZON.replace('ret_', ''),
    method: 'direction = sign of gold 4h return from the pre-release minute (|move|<0.15% or 1h/4h disagreement = MIXED); similarity weights on pre-event gold/USD/10Y 5-day trends, regime and recency',
  };
}

/** 5-day trend states used both at backfill time and for the current context. */
function trendState(changePct, band) {
  if (changePct === null || changePct === undefined || !Number.isFinite(changePct)) return 'UNAVAILABLE';
  if (Math.abs(changePct) < band) return 'FLAT';
  return changePct > 0 ? 'UP' : 'DOWN';
}

module.exports = { reactionMetrics, directionOf, patternAnalysis, wilsonLower, median, trendState, distribution };
