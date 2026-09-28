'use strict';
/**
 * Multi-horizon direction view built ONLY from the deterministic desk state.
 *
 * Three metrics that are never substituted for one another:
 *  - DIRECTION SCORE  -100..+100  analytical pressure (desk horizon score × 100), NOT a probability
 *  - CONFIDENCE          0..100   confidence in the deterministic assessment of that horizon
 *                                 (data coverage, news/market agreement, price confirmation), NOT a probability
 *  - PROBABILITY         0..100 % empirically calibrated outcome frequency (calibration.js) — shown
 *                                 only when a validated calibration cell exists, otherwise UNAVAILABLE
 */
const { clamp } = require('./util');

const HORIZONS = ['SHORT', 'TACTICAL', 'SWING', 'STRUCTURAL'];
const DIRECTIONAL = new Set(['BULLISH', 'BEARISH']);
const DRIVER_NAMES = {
  USD: 'USD proxy', REAL_YIELD: 'real yields', US2Y: '2-year yield', US10Y: '10-year yield', POSITIONING: 'COT positioning',
};

/**
 * Per-horizon confidence (0-90), documented rules:
 *   25 base · +20 market component available · +10 news component available
 *   +15 news and market agree (both |score| >= 0.15, same sign) · -15 news vs market conflict
 *   +20 price CONFIRMED · -20 price DIVERGENCE · -5 price flat
 *   cap 45 when MIXED, 10 when UNDETERMINED; cap by data quality (GOOD 90 · PARTIAL 70 · otherwise 50)
 */
function horizonConfidence(h, dataQuality) {
  if (!h || !h.bias) return 0;
  if (h.bias === 'UNDETERMINED') return 10;
  let c = 25;
  const m = h.market_score;
  const n = h.news_score;
  if (m !== null && m !== undefined) c += 20;
  if (n !== null && n !== undefined) c += 10;
  if (h.conflict) c -= 15;
  else if (m !== null && m !== undefined && n !== null && n !== undefined && Math.abs(m) >= 0.15 && Math.abs(n) >= 0.15 && Math.sign(m) === Math.sign(n)) c += 15;
  const conf = String(h.market_confirmation || '');
  if (conf === 'CONFIRMED') c += 20;
  else if (conf === 'DIVERGENCE') c -= 20;
  else if (/FLAT/.test(conf)) c -= 5;
  if (h.bias === 'MIXED') c = Math.min(c, 45);
  const cap = dataQuality === 'GOOD' ? 90 : dataQuality === 'PARTIAL' ? 70 : 50;
  return Math.round(clamp(c, 0, cap));
}

/** One row per horizon: direction, score (-100..100), confidence (0..100), confirmation, market state score. */
function horizonView(desk, dataQuality) {
  const hz = (desk && desk.horizons) || {};
  return HORIZONS.map((name) => {
    const h = hz[name] || {};
    return {
      horizon: name,
      direction: h.bias || 'UNDETERMINED',
      score: h.score === null || h.score === undefined ? null : Math.round(Number(h.score) * 100),
      confidence: horizonConfidence(h, dataQuality),
      confirmation: h.market_confirmation || 'UNAVAILABLE',
      market_score: h.market_score === undefined ? null : h.market_score,
      news_score: h.news_score === undefined ? null : h.news_score,
      gold_trend: h.gold_trend || null,
      gold_change_pct: h.gold_change_pct === undefined ? null : h.gold_change_pct,
    };
  });
}

const lower = (s) => String(s).toLowerCase();

/** Plain interpretation when horizons genuinely differ; null when they agree. Built from the states only. */
function interpretHorizons(rows) {
  const d = Object.fromEntries(rows.map((r) => [r.horizon, r.direction]));
  const states = HORIZONS.map((h) => d[h]);
  if (new Set(states).size === 1) return null;
  const S = d.SHORT;
  const T = d.TACTICAL;
  const W = d.SWING;
  const St = d.STRUCTURAL;
  const opp = (a, b) => DIRECTIONAL.has(a) && DIRECTIONAL.has(b) && a !== b;
  if (DIRECTIONAL.has(T) && T === W && T === St && opp(S, T)) {
    return `SHORT-TERM COUNTERTREND: ${lower(S)} pressure inside a broader ${lower(T)} tactical/swing/structural regime.`;
  }
  if (DIRECTIONAL.has(T) && T === W && opp(S, T)) {
    return `SHORT-TERM COUNTERTREND: ${lower(S)} pressure inside a ${lower(T)} tactical/swing trend${DIRECTIONAL.has(St) ? `; structural backdrop ${lower(St)}` : ''}.`;
  }
  if (DIRECTIONAL.has(T) && T === W && opp(St, T)) {
    return `CYCLE vs STRUCTURE: ${lower(T)} tactical/swing trend against a ${lower(St)} structural backdrop${DIRECTIONAL.has(S) && S !== T ? `; short term ${lower(S)}` : ''}.`;
  }
  if (opp(T, W)) {
    return `TRANSITION: tactical ${lower(T)} vs swing ${lower(W)} — the medium-term trend is being tested.`;
  }
  const unclear = rows.filter((r) => !DIRECTIONAL.has(r.direction)).map((r) => `${lower(r.horizon)} ${lower(r.direction)}`);
  const clear = rows.filter((r) => DIRECTIONAL.has(r.direction)).map((r) => `${lower(r.horizon)} ${lower(r.direction)}`);
  return `HORIZONS DIFFER: ${clear.join(', ') || 'no directional horizon'}${unclear.length ? `; ${unclear.join(', ')}` : ''} — use the horizon that matches the time frame.`;
}

/** What is pushing gold up / down right now (market drivers per horizon + news pressure), deterministic. */
function forces(desk) {
  const hz = (desk && desk.horizons) || {};
  const bull = [];
  const bear = [];
  const seen = new Set();
  for (const name of ['TACTICAL', 'SWING', 'SHORT', 'STRUCTURAL']) {
    for (const x of (hz[name] && hz[name].market_drivers) || []) {
      const key = `${x.driver}:${name}`;
      if (seen.has(x.driver) || Math.abs(x.score) < 0.15) continue;
      seen.add(x.driver);
      seen.add(key);
      const unit = x.driver === 'USD' ? '%' : x.driver === 'POSITIONING' ? ' pct' : 'bp';
      const text = `${DRIVER_NAMES[x.driver] || x.driver} ${x.change > 0 ? '+' : ''}${x.change}${unit} (${lower(name)})`;
      (x.score > 0 ? bull : bear).push(text);
    }
    const n = hz[name] && hz[name].news_score;
    if (n !== null && n !== undefined && Math.abs(n) >= 0.15 && !seen.has(`news:${Math.sign(n)}`)) {
      seen.add(`news:${Math.sign(n)}`);
      (n > 0 ? bull : bear).push(`news flow (${lower(name)} news score ${n > 0 ? '+' : ''}${Math.round(n * 100)})`);
    }
  }
  return { bullish: bull.slice(0, 4), bearish: bear.slice(0, 4) };
}

/** Deterministic invalidation of the tactical view from the gold layer's 20-day range. */
function invalidation(desk, layers) {
  const T = desk && desk.horizons && desk.horizons.TACTICAL ? desk.horizons.TACTICAL.bias : 'UNDETERMINED';
  const g = layers && layers.gold;
  const hi = g && g.high_20d;
  const lo = g && g.low_20d;
  if (T === 'BEARISH') return `tactical BEARISH view invalidated by gold back above the 20-day high${hi ? ` ${hi}` : ''} or by the tactical market drivers turning positive (USD proxy / real yields falling over 5 days)`;
  if (T === 'BULLISH') return `tactical BULLISH view invalidated by gold below the 20-day low${lo ? ` ${lo}` : ''} or by the tactical market drivers turning negative (USD proxy / real yields rising over 5 days)`;
  return `no directional tactical view; a break of the 20-day range${lo && hi ? ` ${lo}–${hi}` : ''} would set the next direction`;
}

module.exports = { HORIZONS, horizonConfidence, horizonView, interpretHorizons, forces, invalidation };
