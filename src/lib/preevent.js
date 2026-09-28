'use strict';
/**
 * Shared market-state helpers for pre-event, daily and command outputs.
 * (Pre-event scoring and scenarios live in forecast.js — the Forecast & Conditional Scenario Engine.)
 */

const DISCLAIMER = 'This is conditional scenario analysis based on historical/current data. It is NOT knowledge of undisclosed future news. It is NOT a guaranteed prediction, and not a trade order.';

function fmtPct(x) { return x === null || x === undefined ? 'n/a' : `${x > 0 ? '+' : ''}${x}%`; }
function fmtBp(x) { return x === null || x === undefined ? 'n/a' : `${x > 0 ? '+' : ''}${x}bp`; }

/** Compact current market state from a market.marketSnapshot(). */
function currentState(snap) {
  const i = snap.instruments;
  const g = i.GOLD || {};
  const u = i.USD_PROXY || {};
  const y10 = i.US10Y || {};
  const y2 = i.US2Y || {};
  const r10 = i.US10Y_REAL || {};
  const w = i.WTI || {};
  const cot = i.GOLD_COT_NONCOMM_NET || {};
  return {
    gold: g.available ? { value: g.value, change_24h_pct: g.changes['24h'], change_5d_pct: g.changes['5d'], trend_5d: g.states['5d'], observed_at: g.observed_at } : null,
    usd: u.available ? { value: u.value, change_24h_pct: u.changes['24h'], change_5d_pct: u.changes['5d'], trend_5d: u.states['5d'], basis: 'DXY proxy (ICE formula, indicative FX)' } : null,
    us10y: y10.available ? { value: y10.value, change_5d_bp: y10.changes['5d'], trend_5d: y10.states['5d'], as_of: y10.observed_at } : null,
    us2y: y2.available ? { value: y2.value, change_5d_bp: y2.changes['5d'], trend_5d: y2.states['5d'], as_of: y2.observed_at } : null,
    real10y: r10.available ? { value: r10.value, change_5d_bp: r10.changes['5d'], trend_5d: r10.states['5d'], as_of: r10.observed_at } : null,
    oil: w.available ? { value: w.value, change_5d_pct: w.changes['5d'], trend_5d: w.states['5d'], as_of: w.observed_at } : null,
    positioning: cot.available ? { net_noncommercial: cot.value, percentile_3y: cot.percentile_3y, state: cot.positioning, as_of: cot.observed_at } : null,
    data_quality: snap.data_quality,
  };
}

module.exports = { currentState, fmtPct, fmtBp, DISCLAIMER };
