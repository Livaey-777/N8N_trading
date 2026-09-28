'use strict';
/**
 * GOLD FORECAST & CONDITIONAL SCENARIO ENGINE
 *
 * Evidence-based, deterministic pre-event scenario forecasts:
 *   input layers (gold, USD, yields, macro regime, geopolitics, politics, event)
 *   -> historical analogue engine (similarity, regime match, evidence quality)
 *   -> pre_event_score (-100..+100, NOT a probability) + deterministic confidence
 *   -> forecast state (BULLISH/BEARISH/MIXED/NEUTRAL/UNDETERMINED + reasons)
 *   -> conditional scenarios with support levels (STRONG/MODERATE/WEAK/INSUFFICIENT EVIDENCE)
 *   -> update / invalidation detection, post-event scoring helpers.
 * It never predicts the outcome of an unreleased event and never presents scores as probabilities.
 */
const { round, clamp, pctChange } = require('./util');
const { reactionMetrics, median, wilsonLower } = require('./history');
const { valueAt } = require('./market');
const { EVENT_TYPES } = require('./calendar');

const DATA_EVENTS = new Set(['CPI', 'PCE', 'PPI', 'NFP', 'GDP', 'JOLTS', 'RETAIL_SALES', 'ISM_MANUFACTURING', 'ISM_SERVICES', 'JOBLESS_CLAIMS']);
const STATE_THRESHOLD = 12;
const DISCLAIMER_LINES = [
  'This is conditional scenario analysis based on historical/current data.',
  'It is NOT knowledge of undisclosed future news.',
  'It is NOT a guaranteed prediction.',
];

// Event-specific causal templates (spec §22).
const CAUSAL = {
  CPI: { chain: 'Inflation → Rate expectations → Yields → USD → Gold', soft: 'CPI softer than expected', hot: 'CPI hotter than expected', field: 'CPI m/m (and core)', watch: 'core vs headline, services ex-shelter' },
  PCE: { chain: 'Inflation → Fed expectations → Yields → USD → Gold', soft: 'core PCE softer than expected', hot: 'core PCE hotter than expected', field: 'core PCE m/m', watch: 'core PCE vs CPI-implied estimate, real spending' },
  PPI: { chain: 'Producer inflation → Inflation expectations → Yields → USD → Gold', soft: 'PPI softer than expected', hot: 'PPI hotter than expected', field: 'PPI m/m', watch: 'core PPI, pass-through components' },
  NFP: { chain: 'Employment → Fed expectations → Yields → USD → Gold', soft: 'payrolls miss / unemployment rises', hot: 'payrolls beat / unemployment falls', field: 'nonfarm payrolls', watch: 'unemployment rate, average hourly earnings, revisions' },
  JOLTS: { chain: 'Labour demand → Fed expectations → Yields → USD → Gold', soft: 'job openings below expectations', hot: 'job openings above expectations', field: 'JOLTS openings', watch: 'quits rate, layoffs' },
  GDP: { chain: 'Growth → Policy expectations → Yields → USD → Gold', soft: 'GDP below expectations', hot: 'GDP above expectations', field: 'GDP q/q', watch: 'core PCE prices in the GDP report, final sales' },
  FOMC: { chain: 'Policy decision → Forward guidance → Yield curve → USD → Gold', soft: 'decision / guidance more dovish than priced', hot: 'decision / guidance more hawkish than priced', field: 'fed funds target + guidance', watch: 'statement changes, projections/dots, press-conference tone, dissents' },
  FED_CHAIR_SPEECH: { chain: 'Guidance → Rate expectations → Yields → USD → Gold', soft: 'remarks lean dovish', hot: 'remarks lean hawkish', field: null, watch: 'policy-path comments' },
  RETAIL_SALES: { chain: 'Consumption → Growth/policy expectations → Yields → USD → Gold', soft: 'retail sales below expectations', hot: 'retail sales above expectations', field: 'retail sales m/m', watch: 'control group' },
  ISM_MANUFACTURING: { chain: 'Activity → Growth/inflation expectations → Yields → USD → Gold', soft: 'ISM below expectations', hot: 'ISM above expectations', field: 'ISM index', watch: 'prices paid, employment' },
  ISM_SERVICES: { chain: 'Activity → Growth/inflation expectations → Yields → USD → Gold', soft: 'ISM services below expectations', hot: 'ISM services above expectations', field: 'ISM services index', watch: 'prices paid, employment' },
  JOBLESS_CLAIMS: { chain: 'Layoffs → Fed expectations → Yields → USD → Gold', soft: 'claims above expectations', hot: 'claims below expectations', field: 'initial claims', watch: 'continuing claims' },
  ECB: { chain: 'ECB decision → EUR → USD cross → Gold (USD terms)', soft: 'ECB more dovish than priced', hot: 'ECB more hawkish than priced', field: 'ECB rate', watch: 'EUR/USD reaction', foreign: true },
  BOE: { chain: 'BoE decision → GBP → USD cross → Gold (USD terms)', soft: 'BoE more dovish than priced', hot: 'BoE more hawkish than priced', field: 'Bank Rate', watch: 'GBP/USD reaction', foreign: true },
  BOJ: { chain: 'BoJ decision → JPY → USD cross → Gold (USD terms)', soft: 'BoJ more dovish than priced', hot: 'BoJ more hawkish than priced', field: 'BoJ rate', watch: 'USD/JPY reaction', foreign: true },
  GEOPOLITICAL_DEADLINE: { chain: 'Risk → Safe haven → USD / yields / oil → Gold', soft: 'escalation / deadline passes without agreement', hot: 'de-escalation / agreement / extension', field: null, watch: 'official statements, oil, shipping', geo: true },
  OIL_SHOCK: { chain: 'Oil → Inflation → Policy expectations → Yields → USD → Gold', soft: 'oil falls', hot: 'oil spikes', field: null, watch: 'breakevens, 2Y' },
};

// ---------------------------------------------------------------------------
// Layer helpers
// ---------------------------------------------------------------------------
function changeBetween(series, fromIso, toIso, isYield) {
  const a = valueAt(series, fromIso);
  const b = valueAt(series, toIso);
  if (!a || !b || a === b) return null;
  return isYield ? round((b.v - a.v) * 100, 1) : round(pctChange(a.v, b.v), 3);
}

function goldLayer(snap, dailyGold, nowIso) {
  const g = snap.instruments.GOLD;
  if (!g || !g.available) return { state: 'UNDETERMINED', available: false };
  const closes = (dailyGold || []).slice(-21).map((p) => p.v);
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((s, x) => s + x, 0) / (rets.length || 1);
  const sd = rets.length > 5 ? Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1)) : null;
  const hi = closes.length ? Math.max(...closes, g.value) : null;
  const lo = closes.length ? Math.min(...closes, g.value) : null;
  const c5 = g.changes['5d'];
  const c20 = g.changes['20d'];
  let state = 'RANGE';
  if (c5 === null && c20 === null) state = 'UNDETERMINED';
  else if ((c20 !== null && c20 >= 2) || (c5 !== null && c5 >= 1.5)) state = 'UPTREND';
  else if ((c20 !== null && c20 <= -2) || (c5 !== null && c5 <= -1.5)) state = 'DOWNTREND';
  return {
    available: true, value: g.value, observed_at: g.observed_at, state,
    ret_1d: g.changes['24h'], ret_5d: c5, ret_20d: c20, ret_90d: g.changes['90d'],
    vol_20d_annualised_pct: sd === null ? null : round(sd * Math.sqrt(252) * 100, 1),
    high_20d: hi, low_20d: lo,
    dist_from_high_pct: hi ? round(pctChange(hi, g.value), 2) : null,
    dist_from_low_pct: lo ? round(pctChange(lo, g.value), 2) : null,
    momentum: c5 === null ? 'UNDETERMINED' : c5 > 1 ? 'POSITIVE' : c5 < -1 ? 'NEGATIVE' : 'FLAT',
    note: 'context only — not a technical trading signal',
  };
}

function usdLayer(snap, recentReactions) {
  const u = snap.instruments.USD_PROXY;
  if (!u || !u.available || (u.changes['5d'] === null && u.changes['20d'] === null)) return { class: 'UNDETERMINED', available: Boolean(u && u.available) };
  const c5 = u.changes['5d'];
  const c20 = u.changes['20d'];
  const score = (c5 !== null ? -Math.tanh(c5 / 1.0) * 0.6 : 0) + (c20 !== null ? -Math.tanh(c20 / 2.0) * 0.4 : 0);
  const cls = score >= 0.2 ? 'USD SUPPORTIVE FOR GOLD' : score <= -0.2 ? 'USD PRESSURE ON GOLD' : 'USD NEUTRAL';
  return {
    available: true, class: cls, score: round(score, 3), value: u.value, chg_24h_pct: u.changes['24h'], chg_5d_pct: c5, chg_20d_pct: c20,
    momentum: c5 === null ? 'UNDETERMINED' : c5 > 0.3 ? 'STRENGTHENING' : c5 < -0.3 ? 'WEAKENING' : 'STABLE',
    recent_release_reactions: (recentReactions || []).slice(0, 3),
    basis: 'DXY proxy (ICE weights on indicative FX)',
  };
}

function yieldLayer(snap) {
  const y2 = snap.instruments.US2Y || {};
  const y10 = snap.instruments.US10Y || {};
  const y30 = snap.instruments.US30Y || {};
  const r10 = snap.instruments.US10Y_REAL || {};
  if (!y10.available && !r10.available && !y2.available) return { class: 'UNDETERMINED', available: false };
  const ch = (x, h) => (x.available && x.changes ? x.changes[h] : null);
  const parts = [];
  if (ch(r10, '5d') !== null) parts.push(-Math.tanh(ch(r10, '5d') / 12) * 0.5);
  if (ch(y2, '5d') !== null) parts.push(-Math.tanh(ch(y2, '5d') / 12) * 0.3);
  if (ch(r10, '20d') !== null) parts.push(-Math.tanh(ch(r10, '20d') / 25) * 0.2);
  const score = parts.length ? parts.reduce((s, x) => s + x, 0) : null;
  const cls = score === null ? 'UNDETERMINED' : score >= 0.15 ? 'YIELDS SUPPORTIVE' : score <= -0.15 ? 'YIELDS PRESSURING GOLD' : 'YIELDS NEUTRAL';
  const spread = y2.available && y10.available ? round((y10.value - y2.value) * 100, 0) : null;
  let curveTrend = 'UNDETERMINED';
  if (ch(y2, '20d') !== null && ch(y10, '20d') !== null) {
    const d = ch(y10, '20d') - ch(y2, '20d');
    curveTrend = d > 5 ? 'STEEPENING' : d < -5 ? 'FLATTENING' : 'STABLE';
  }
  return {
    available: true, class: cls, score: score === null ? null : round(score, 3),
    us2y: y2.available ? y2.value : null, us10y: y10.available ? y10.value : null, us30y: y30.available ? y30.value : null, real10y: r10.available ? r10.value : null,
    chg_5d_bp: { us2y: ch(y2, '5d'), us10y: ch(y10, '5d'), real10y: ch(r10, '5d') },
    chg_20d_bp: { us2y: ch(y2, '20d'), us10y: ch(y10, '20d'), real10y: ch(r10, '20d') },
    curve_2s10s_bp: spread, curve_state: spread === null ? 'UNDETERMINED' : spread < -10 ? 'INVERTED' : spread < 25 ? 'FLAT' : 'NORMAL', curve_trend: curveTrend,
    as_of: y10.observed_at || r10.observed_at || null, resolution: 'daily (official Treasury curve)',
  };
}

/** Latest actual before `beforeIso` from a list of {event_date, actual}. */
function latestActual(rows, beforeIso) {
  let best = null;
  for (const r of rows || []) {
    if (r.actual === null || r.actual === undefined) continue;
    if (beforeIso && Date.parse(r.event_date) >= Date.parse(beforeIso)) continue;
    if (!best || Date.parse(r.event_date) > Date.parse(best.event_date)) best = r;
  }
  return best;
}

function inflationStateFrom(cpiRow) {
  if (!cpiRow) return 'UNDETERMINED';
  const a = Number(cpiRow.actual);
  return a >= 0.3 ? 'INFLATIONARY' : a <= 0.1 ? 'DISINFLATION' : 'STABLE';
}
function laborStateFrom(nfpRow) {
  if (!nfpRow) return 'UNDETERMINED';
  const a = Number(nfpRow.actual);
  return a >= 150 ? 'STRENGTHENING' : a < 50 ? 'COOLING' : 'STEADY';
}
function policyStateFrom(us2ySeries, atIso) {
  const c = changeBetween(us2ySeries || [], new Date(Date.parse(atIso) - 28 * 86400000).toISOString(), atIso, true);
  if (c === null) return 'UNDETERMINED';
  return c >= 15 ? 'HAWKISH' : c <= -15 ? 'DOVISH' : 'STABLE';
}

/**
 * Macro regime classification (spec layer 4) from official releases, 2Y repricing and news tone.
 */
function macroLayer({ cpiRows, nfpRows, us2ySeries, events, snap, nowIso }) {
  const cpi = latestActual(cpiRows, nowIso);
  const nfp = latestActual(nfpRows, nowIso);
  const inflation = inflationStateFrom(cpi);
  const labor = laborStateFrom(nfp);
  const policy = policyStateFrom(us2ySeries, nowIso);
  const since = (days) => Date.parse(nowIso) - days * 86400000;
  let growthStrong = 0; let growthWeak = 0; let liq = 0; let riskOff = 0;
  for (const e of events || []) {
    if (Date.parse(e.last_seen_at) < since(30)) continue;
    for (const c of e.transmission || []) {
      if (!c.active) continue;
      if (c.tags && c.tags.includes('GROWTH')) { if (c.signed < 0) growthStrong++; else if (c.signed > 0) growthWeak++; }
      if (c.channel === 'LIQUIDITY' && c.signed < 0 && Date.parse(e.last_seen_at) >= since(7)) liq++;
      if (c.channel === 'RISK_SENTIMENT' && c.signed > 0 && Date.parse(e.last_seen_at) >= since(3)) riskOff++;
    }
  }
  const vix = snap.instruments.VIX;
  const tags = [];
  if (inflation === 'INFLATIONARY') tags.push('inflationary'); else if (inflation === 'DISINFLATION') tags.push('disinflation');
  if (labor === 'STRENGTHENING') tags.push('labor strengthening'); else if (labor === 'COOLING') tags.push('labor cooling');
  if (growthStrong >= 2 && growthStrong > growthWeak * 1.5) tags.push('growth acceleration');
  else if (growthWeak >= 2 && growthWeak > growthStrong * 1.5) tags.push('growth slowdown');
  if (policy === 'HAWKISH') tags.push('hawkish monetary expectations'); else if (policy === 'DOVISH') tags.push('dovish monetary expectations');
  if (liq >= 2 || (vix && vix.available && vix.value >= 30)) tags.push('liquidity stress');
  if (riskOff >= 3) tags.push('normal risk-off');
  const conflicted = (tags.includes('hawkish monetary expectations') && (tags.includes('labor cooling') || tags.includes('growth slowdown')))
    || (tags.includes('dovish monetary expectations') && tags.includes('inflationary'));
  if (conflicted) tags.push('conflicted macro');
  const order = ['liquidity stress', 'conflicted macro', 'hawkish monetary expectations', 'dovish monetary expectations', 'inflationary', 'disinflation', 'labor strengthening', 'labor cooling', 'growth acceleration', 'growth slowdown', 'normal risk-off'];
  const primary = order.find((t) => tags.includes(t)) || 'UNDETERMINED';
  let score = 0;
  if (tags.includes('hawkish monetary expectations')) score -= 0.6;
  if (tags.includes('dovish monetary expectations')) score += 0.6;
  if (tags.includes('inflationary')) score -= 0.15;
  if (tags.includes('disinflation')) score += 0.25;
  if (tags.includes('labor strengthening')) score -= 0.15;
  if (tags.includes('labor cooling')) score += 0.2;
  if (tags.includes('growth slowdown')) score += 0.15;
  if (tags.includes('growth acceleration')) score -= 0.15;
  if (tags.includes('normal risk-off')) score += 0.2;
  if (tags.includes('liquidity stress')) score -= 0.1;
  return {
    primary, tags, conflicted, score: round(clamp(score, -1, 1), 3),
    inflation_state: inflation, labor_state: labor, policy_state: policy,
    evidence: [
      cpi ? `latest CPI m/m ${cpi.actual}% (${String(cpi.event_date).slice(0, 10)}, BLS)` : 'CPI actual not available',
      nfp ? `latest payrolls ${nfp.actual}K (${String(nfp.event_date).slice(0, 10)}, BLS)` : 'payrolls actual not available',
      `2Y 20-day repricing: ${policy}`,
    ],
  };
}

function riskScore(events, nowIso, category, filterFn) {
  const now = Date.parse(nowIso);
  let recent = 0; let prior = 0;
  const top = [];
  for (const e of events || []) {
    if (e.category !== category || (filterFn && !filterFn(e))) continue;
    const age = (now - Date.parse(e.last_seen_at)) / 3600000;
    if (age > 168) continue;
    const intensity = ((e.importance_score || 0) / 100) * ((e.gold_relevance_score || 0) / 100);
    const esc = (e.transmission || []).filter((c) => c.active && ['SAFE_HAVEN', 'ENERGY', 'TRADE_SUPPLY_SHOCK', 'FISCAL_POLICY', 'MONETARY_POLICY'].includes(c.channel))
      .reduce((s, c) => s + Math.max(0, c.signed), 0);
    const w = intensity * (0.5 + Math.min(esc, 1)) * 0.5 ** (age / 48);
    top.push({ id: e.id, title: e.title, importance: e.importance_score, net_pressure: e.net_pressure, weight: round(w, 3), recent: age <= 24 });
  }
  // Only the ten strongest events per window count, so headline volume alone cannot saturate the score.
  const strongest = (arr) => arr.map((x) => x.weight).sort((x, y) => y - x).slice(0, 10).reduce((acc, x) => acc + x, 0);
  recent = strongest(top.filter((x) => x.recent));
  prior = strongest(top.filter((x) => !x.recent)) * (24 / 144);
  const score = Math.round(100 * (1 - Math.exp(-(recent + prior * 3) / 2.5)));
  const trend = recent > prior * 1.4 + 0.05 ? 'ESCALATING' : recent < prior * 0.6 ? 'DE-ESCALATING' : 'STABLE';
  top.sort((a, b) => b.weight - a.weight);
  return { score, trend, top: top.slice(0, 5) };
}

function geoLayer(events, nowIso) {
  const r = riskScore(events, nowIso, 'GEOPOLITICS');
  const cls = r.score >= 75 ? 'CRITICAL' : r.score >= 50 ? 'HIGH' : r.score >= 25 ? 'MEDIUM' : 'LOW';
  return { geopolitical_risk_score: r.score, class: cls, trend: r.trend, top_events: r.top };
}

function politicalLayer(events, nowIso) {
  const relevant = new Set(['FISCAL', 'TRADE_POLICY', 'CB_INDEPENDENCE', 'TAXATION', 'LEADERSHIP', 'ELECTION', 'INSTITUTIONAL']);
  const r = riskScore(events, nowIso, 'POLITICS', (e) => relevant.has(e.subcategory) && (e.gold_relevance_score || 0) >= 45);
  const themes = {};
  for (const e of events || []) {
    if (e.category === 'POLITICS' && relevant.has(e.subcategory) && Date.parse(e.last_seen_at) > Date.parse(nowIso) - 7 * 86400000) themes[e.subcategory] = (themes[e.subcategory] || 0) + 1;
  }
  const cls = r.score >= 60 ? 'HIGH' : r.score >= 30 ? 'MEDIUM' : 'LOW';
  return { political_risk_score: r.score, class: cls, trend: r.trend, themes, top_events: r.top };
}

// ---------------------------------------------------------------------------
// Historical analogue engine
// ---------------------------------------------------------------------------
const SIM_FEATURES = [
  ['pre_gold_trend', 20], ['pre_usd_trend', 15], ['pre_10y_trend', 15], ['regime', 15],
  ['inflation_state', 10], ['labor_state', 10], ['policy_state', 10], ['geopolitical_state', 5],
];
const NA = new Set([null, undefined, 'UNAVAILABLE', 'UNDETERMINED', 'NOT_AVAILABLE', 'UNKNOWN']);

function featureMatch(a, b) {
  if (NA.has(a) || NA.has(b)) return null;
  if (a === b) return 1;
  if ((a === 'FLAT' || b === 'FLAT' || a === 'STABLE' || b === 'STABLE' || a === 'STEADY' || b === 'STEADY')) return 0.5;
  return 0;
}

/** Adds macro-state features to historical rows (as they were known at each event date). */
function annotateHistory(rows, { cpiRows, nfpRows, us2ySeries }) {
  return rows.map((r) => ({
    ...r,
    inflation_state: r.inflation_state || inflationStateFrom(latestActual(cpiRows, r.event_date)),
    labor_state: r.labor_state || laborStateFrom(latestActual(nfpRows, r.event_date)),
    policy_state: r.policy_state || policyStateFrom(us2ySeries, r.event_date),
    geopolitical_state: r.geopolitical_state || 'NOT_AVAILABLE',
  }));
}

function similarity(row, ctx) {
  let num = 0; let den = 0; let available = 0;
  const detail = {};
  for (const [f, w] of SIM_FEATURES) {
    const m = featureMatch(row[f], ctx[f]);
    detail[f] = m;
    if (m === null) continue;
    num += w * m; den += w; available++;
  }
  return { score: den ? Math.round((100 * num) / den) : 0, features_compared: available, detail };
}

function analogueEngine(rows, ctx, cfg) {
  const enriched = rows.map((row) => ({ row, m: reactionMetrics(row) })).filter((x) => x.m.direction && x.m.ret_4h !== null);
  const sims = enriched.map((x) => ({ ...x, sim: similarity(x.row, ctx) }));
  sims.sort((a, b) => b.sim.score - a.sim.score || Date.parse(b.row.event_date) - Date.parse(a.row.event_date));
  const n = sims.length;
  const k = Math.min(n, Math.max(8, Math.round(n * 0.35)));
  const top = sims.slice(0, k);
  const w = (x) => (x.sim.score / 100) ** 2;
  const wsum = top.reduce((s, x) => s + w(x), 0);
  const wsq = top.reduce((s, x) => s + w(x) ** 2, 0);
  const nEff = wsq ? round((wsum * wsum) / wsq, 1) : 0;
  const share = (arr, dir) => {
    const t = arr.reduce((s, x) => s + w(x), 0);
    return t ? arr.filter((x) => x.m.direction === dir).reduce((s, x) => s + w(x), 0) / t : 0;
  };
  const dist = (arr) => ({
    n: arr.length,
    bullish_cases: arr.filter((x) => x.m.direction === 'BULLISH').length,
    bearish_cases: arr.filter((x) => x.m.direction === 'BEARISH').length,
    mixed_cases: arr.filter((x) => x.m.direction === 'MIXED').length,
    average_gold_reaction_4h: arr.length ? round(arr.reduce((s, x) => s + x.m.ret_4h, 0) / arr.length, 3) : null,
    median_gold_reaction_4h: median(arr.map((x) => x.m.ret_4h)),
  });
  const uncond = dist(sims);
  const cond = dist(top);
  const pBull = share(top, 'BULLISH');
  const pBear = share(top, 'BEARISH');
  let histBias = 'UNDETERMINED';
  if (n >= cfg.minSample) histBias = pBull >= 0.55 && pBull - pBear >= 0.15 ? 'BULLISH' : pBear >= 0.55 && pBear - pBull >= 0.15 ? 'BEARISH' : 'MIXED';
  const meanSim = top.length ? top.reduce((s, x) => s + x.sim.score, 0) / top.length : 0;
  const regimeShare = top.length ? top.filter((x) => featureMatch(x.row.regime, ctx.regime) === 1).length / top.length : 0;
  const completeness = n ? sims.filter((x) => x.row.data_quality === 'OK' && x.m.usd_dir && x.m.ret_1h !== null).length / n : 0;
  const srcQ = n ? sims.reduce((s, x) => s + (/dukascopy/i.test(JSON.stringify(x.row.data_source || '')) ? 1 : /paxg|binance/i.test(JSON.stringify(x.row.data_source || '')) ? 0.8 : 0.9), 0) / n : 0;
  const consistency = Math.abs(pBull - pBear);
  const eq = Math.round(100 * (0.30 * Math.min(1, nEff / 20) + 0.25 * (meanSim / 100) + 0.15 * completeness + 0.10 * regimeShare + 0.10 * srcQ + 0.10 * consistency));
  const regimeMatch = meanSim >= 70 ? 'HIGH' : meanSim >= 50 ? 'MEDIUM' : 'LOW';
  // Conditional subsets for scenarios (market-implied surprise via USD reaction).
  const byUsd = {};
  for (const d of ['UP', 'DOWN', 'FLAT']) {
    const sub = top.filter((x) => x.m.usd_dir === d);
    const subAll = sims.filter((x) => x.m.usd_dir === d);
    byUsd[d] = { analogue: { ...dist(sub), p_bull: round(share(sub, 'BULLISH'), 3), p_bear: round(share(sub, 'BEARISH'), 3), p_mixed: round(share(sub, 'MIXED'), 3) }, unconditional: dist(subAll) };
  }
  const extremes = sims.slice().sort((a, b) => b.m.ret_4h - a.m.ret_4h);
  const fmt = (x) => ({ date: x.row.event_date, similarity: x.sim.score, ret_1h: x.m.ret_1h, ret_4h: x.m.ret_4h, direction: x.m.direction, usd_dir: x.m.usd_dir, regime: x.row.regime });
  return {
    historical_sample_size: n,
    effective_sample: nEff,
    unconditional: uncond,
    conditional: { ...cond, weighted_p_bull: round(pBull, 3), weighted_p_bear: round(pBear, 3), top_k: k },
    bullish_cases: uncond.bullish_cases, bearish_cases: uncond.bearish_cases, mixed_cases: uncond.mixed_cases,
    average_gold_reaction: uncond.average_gold_reaction_4h, median_gold_reaction: uncond.median_gold_reaction_4h,
    largest_upside_reaction: extremes.length ? fmt(extremes[0]) : null,
    largest_downside_reaction: extremes.length ? fmt(extremes[extremes.length - 1]) : null,
    best_analogues: top.slice(0, 5).map(fmt),
    historical_similarity_score: Math.round(meanSim),
    historical_bias: histBias,
    historical_evidence_quality: n ? eq : 0,
    regime_match: n ? regimeMatch : 'LOW',
    conditional_on_usd_reaction: byUsd,
    evidence_components: { n_eff: nEff, mean_similarity: Math.round(meanSim), completeness: round(completeness, 2), regime_share: round(regimeShare, 2), source_quality: round(srcQ, 2), consistency: round(consistency, 2) },
    period: n ? { from: sims.map((x) => x.row.event_date).sort()[0], to: sims.map((x) => x.row.event_date).sort().slice(-1)[0] } : null,
  };
}

function scenarioSupport(sub, expected) {
  if (!sub || !sub.n) return { support: 'INSUFFICIENT EVIDENCE', confidence: 0, n: 0, share: null };
  const key = expected === 'BULLISH' ? 'p_bull' : expected === 'BEARISH' ? 'p_bear' : 'p_mixed';
  const share = sub[key] || 0;
  let support = 'INSUFFICIENT EVIDENCE';
  if (sub.n >= 8 && share >= 0.65) support = 'STRONG';
  else if (sub.n >= 5 && share >= 0.55) support = 'MODERATE';
  else if (sub.n >= 3 && share >= 0.45) support = 'WEAK';
  return { support, confidence: Math.round(Math.min(80, 100 * wilsonLower(share, sub.n))), n: sub.n, share: round(share, 2) };
}

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------
function dataQuality({ snap, release, analogues, calendarOk, calendarNote, isDataEvent, nowIso }) {
  const reasons = [];
  const inst = snap.instruments;
  const missing = ['GOLD', 'USD_PROXY', 'US2Y', 'US10Y', 'US10Y_REAL'].filter((k) => !inst[k] || !inst[k].available);
  if (missing.length) reasons.push(`missing market data: ${missing.join(', ')}`);
  const stale = ['GOLD', 'USD_PROXY', 'US10Y'].filter((k) => inst[k] && inst[k].available && inst[k].stale);
  const weekend = [0, 6].includes(new Date(nowIso).getUTCDay());
  if (stale.length && !weekend) reasons.push(`stale data: ${stale.join(', ')}`);
  const hoursTo = (Date.parse(release.scheduled_at) - Date.parse(nowIso)) / 3600000;
  if (isDataEvent && !release.consensus && hoursTo <= 36) reasons.push('missing consensus');
  if (analogues.historical_sample_size === 0) reasons.push('no historical sample');
  else if (analogues.historical_sample_size < 8) reasons.push('insufficient history');
  if (calendarOk === false) reasons.push('source failure (calendar sync)');
  else if (calendarNote) reasons.push(calendarNote);
  const critical = !inst.GOLD || !inst.GOLD.available || ((!inst.USD_PROXY || !inst.USD_PROXY.available) && (!inst.US10Y || !inst.US10Y.available));
  const level = critical ? 'CRITICAL' : reasons.length >= 2 ? 'DEGRADED' : reasons.length === 1 ? 'PARTIAL' : 'GOOD';
  return { level, reasons, hours_to_event: round(hoursTo, 1) };
}

/**
 * @param {object} p
 *  release, snap, desk, events, historyRows (same type), cpiRows, nfpRows, us2ySeries, dailyGold, recentUsdReactions,
 *  calendarOk, calendarNote (verified-recently note), cfg:{minSample}, nowIso
 */
function buildForecast(p) {
  const type = p.release.event_type;
  const causal = CAUSAL[type] || CAUSAL.GEOPOLITICAL_DEADLINE;
  const meta = EVENT_TYPES[type] || { label: type, impact: p.release.impact };
  const isData = DATA_EVENTS.has(type);
  const gold = goldLayer(p.snap, p.dailyGold, p.nowIso);
  const usd = usdLayer(p.snap, p.recentUsdReactions);
  const yields = yieldLayer(p.snap);
  const macro = macroLayer({ cpiRows: p.cpiRows, nfpRows: p.nfpRows, us2ySeries: p.us2ySeries, events: p.events, snap: p.snap, nowIso: p.nowIso });
  const geo = geoLayer(p.events, p.nowIso);
  const pol = politicalLayer(p.events, p.nowIso);
  const cot = p.snap.instruments.GOLD_COT_NONCOMM_NET;
  const ctx = {
    pre_gold_trend: p.context.pre_gold_trend, pre_usd_trend: p.context.pre_usd_trend, pre_10y_trend: p.context.pre_10y_trend,
    regime: p.context.regime, inflation_state: macro.inflation_state, labor_state: macro.labor_state, policy_state: macro.policy_state,
    geopolitical_state: geo.class,
  };
  const annotated = annotateHistory(p.historyRows || [], p);
  const an = analogueEngine(annotated, ctx, p.cfg);
  const eq = an.historical_evidence_quality;
  // Components (signed, gold perspective), weights per event family.
  const W = causal.geo ? { hist: 0, usd: 0.15, yields: 0.15, macro: 0.1, geo: 0.45, pol: 0.1, pos: 0.05 }
    : { hist: 0.30 * (eq / 100), usd: 0.15, yields: 0.20, macro: 0.15, geo: 0.10, pol: 0.05, pos: 0.05 };
  const comps = [];
  const add = (name, score, weight, note) => { if (score !== null && score !== undefined && weight > 0) comps.push({ name, score: round(clamp(score, -1, 1), 3), weight: round(weight, 3), note }); };
  if (an.historical_sample_size) add('historical_analogues', an.conditional.weighted_p_bull - an.conditional.weighted_p_bear, W.hist, `similarity-weighted top ${an.conditional.top_k} of ${an.historical_sample_size} (evidence quality ${eq})`);
  if (usd.available && usd.score !== undefined) add('usd_state', usd.score, W.usd, usd.class);
  if (yields.available && yields.score !== null) add('yield_state', yields.score, W.yields, yields.class);
  if (macro.primary !== 'UNDETERMINED') add('macro_regime', macro.score, W.macro, `${macro.primary} (${macro.tags.join(', ') || 'none'})`);
  add('geopolitical_risk', clamp((geo.geopolitical_risk_score - 35) / 60, -0.3, 1) * (geo.trend === 'ESCALATING' ? 1.2 : geo.trend === 'DE-ESCALATING' ? 0.6 : 1), W.geo, `${geo.class} (${geo.geopolitical_risk_score}/100, ${geo.trend})`);
  if (pol.political_risk_score > 0) add('political_risk', pol.political_risk_score / 200, W.pol, `${pol.class} (${pol.political_risk_score}/100)`);
  if (cot && cot.available && ['CROWDED_LONG', 'LIGHT_LONG'].includes(cot.positioning)) add('positioning', cot.positioning === 'CROWDED_LONG' ? -0.35 : 0.35, W.pos, `CFTC non-commercial net ${cot.percentile_3y}th pct (3y)`);
  const wsum = comps.reduce((s, c) => s + c.weight, 0);
  const raw = wsum ? comps.reduce((s, c) => s + c.weight * c.score, 0) / wsum : 0;
  const score = Math.round(100 * raw);
  const mass = comps.reduce((s, c) => s + Math.abs(c.weight * c.score), 0);
  const agreeMass = comps.filter((c) => Math.sign(c.score) === Math.sign(raw) && raw !== 0).reduce((s, c) => s + Math.abs(c.weight * c.score), 0);
  const agreement = mass ? agreeMass / mass : 0;
  const contradiction = mass ? 1 - agreement : 0;
  const dq = dataQuality({ snap: p.snap, release: p.release, analogues: an, calendarOk: p.calendarOk, calendarNote: p.calendarNote, isDataEvent: isData, nowIso: p.nowIso });
  // UNDETERMINED rules (spec §10).
  const und = [];
  if (!causal.geo && an.historical_sample_size < p.cfg.minSample) und.push('insufficient historical sample');
  if (dq.level === 'CRITICAL') und.push('insufficient market data');
  if (dq.reasons.some((r) => r.startsWith('stale data'))) und.push('data stale');
  if (!causal.geo && an.historical_sample_size >= p.cfg.minSample && eq < 25) und.push('event type has weak historical analogues');
  if (dq.reasons.some((r) => r.startsWith('source failure'))) und.push('source failure');
  if (dq.reasons.includes('missing consensus')) und.push('no reliable consensus');
  const histComp = comps.find((c) => c.name === 'historical_analogues');
  if (an.regime_match === 'LOW' && histComp && Math.abs(histComp.weight * histComp.score) >= 0.5 * mass && mass > 0) und.push('current regime differs materially from historical sample');
  if (contradiction >= 0.45 && Math.abs(score) < 20 && comps.length >= 3) und.push('conflicting signals');
  // History vs current drivers pointing opposite ways is a genuine conflict: explain it, don't force it.
  const histOpposes = Boolean(histComp && Math.sign(histComp.score) === -Math.sign(raw) && Math.abs(histComp.score) >= 0.25 && raw !== 0);
  let state;
  if (und.length) state = 'UNDETERMINED';
  else if (Math.abs(score) < STATE_THRESHOLD) state = contradiction >= 0.35 ? 'MIXED' : 'NEUTRAL';
  else if (contradiction >= 0.3 && Math.abs(score) < 25) state = 'MIXED';
  else if (histOpposes && Math.abs(histComp.weight * histComp.score) >= 0.3 * (mass - Math.abs(histComp.weight * histComp.score)) && Math.abs(score) < 40) state = 'MIXED';
  else state = score > 0 ? 'BULLISH' : 'BEARISH';
  // Deterministic confidence (spec §12) — not AI opinion.
  const mdq = { GOOD: 1, PARTIAL: 0.6, DEGRADED: 0.3, CRITICAL: 0 }[dq.level];
  const srcq = 0.5 + (p.release.consensus || !isData ? 0.3 : 0) + (p.calendarOk === false ? 0 : 0.2);
  const regimeClarity = p.desk && !['MIXED / CONFLICTED', 'UNDETERMINED', 'QUIET / RANGE'].includes(p.desk.regime) ? clamp((p.desk.confidence || 50) / 100, 0, 1) : 0.3;
  const relevance = (meta.impact === 'HIGH' ? 1 : 0.6);
  let confidence = Math.round(100 * (0.30 * (eq / 100) + 0.15 * mdq + 0.10 * srcq + 0.10 * regimeClarity + 0.20 * agreement + 0.15 * relevance) - 50 * contradiction);
  if (histOpposes) confidence = Math.min(confidence, 55);
  if (state === 'UNDETERMINED') confidence = Math.min(confidence, 30);
  if (state === 'MIXED') confidence = Math.min(confidence, 45);
  confidence = clamp(confidence, 0, 85);
  // Scenarios (spec §7-8) with historical support levels (spec §13).
  const cond = an.conditional_on_usd_reaction;
  const foreign = Boolean(causal.foreign);
  const bullSup = causal.geo ? { support: 'INSUFFICIENT EVIDENCE', confidence: 0, n: 0 } : scenarioSupport(cond[foreign ? 'DOWN' : 'DOWN'].analogue, 'BULLISH');
  const bearSup = causal.geo ? { support: 'INSUFFICIENT EVIDENCE', confidence: 0, n: 0 } : scenarioSupport(cond.UP.analogue, 'BEARISH');
  const baseSup = causal.geo ? { support: 'INSUFFICIENT EVIDENCE', confidence: 0, n: 0 } : scenarioSupport(cond.FLAT.analogue, 'MIXED');
  const cons = p.release.consensus ? `consensus ${p.release.consensus}` : 'consensus not available';
  const prev = p.release.previous ? `, previous ${p.release.previous}` : '';
  const sup = (s, d, label) => (s.n ? `${label}: ${s.n} similar case${s.n === 1 ? '' : 's'}, ${Math.round((s.share || 0) * 100)}% ${d.toLowerCase()} at 4h (similarity-weighted; not a probability)` : `${label}: no similar historical cases`);
  const bullTrigger = causal.geo ? causal.soft : foreign ? causal.hot : causal.soft;
  const bearTrigger = causal.geo ? causal.hot : foreign ? causal.soft : causal.hot;
  const scenarios = {
    bullish: {
      trigger: `${bullTrigger} (${cons}${prev})`,
      mechanism: causal.geo ? 'risk premium ↑ → safe-haven demand ↑; oil/inflation channel may add support'
        : foreign ? 'foreign currency ↑ → USD cross ↓ → gold ↑ in USD terms' : 'lower expected rate path → 2Y / real yields ↓ → USD ↓ → gold supported',
      causal_chain: causal.chain,
      historical_support: sup(bullSup, 'BULLISH', 'USD fell after release'),
      expected_market_confirmation: causal.geo ? 'oil ↑, USD mixed, gold bid within hours' : 'USD proxy ↓ ≥0.15% and 2Y ↓ within 30-60 min',
      gold_response: 'upside pressure while the confirmation holds',
      confidence: bullSup.confidence,
      support: bullSup.support,
      invalidation: causal.geo ? 'gold fails to hold gains once headlines settle; oil reverses' : 'USD and 2Y rise despite the soft print, or gold gives back its gain within 1-2h',
    },
    bearish: {
      trigger: `${bearTrigger} (${cons}${prev})`,
      mechanism: causal.geo ? 'risk premium unwinds → safe-haven demand ↓'
        : foreign ? 'foreign currency ↓ → USD cross ↑ → gold ↓ in USD terms' : 'higher expected rate path → 2Y / real yields ↑ → USD ↑ → gold pressured',
      causal_chain: causal.chain,
      historical_support: sup(bearSup, 'BEARISH', 'USD rose after release'),
      expected_market_confirmation: causal.geo ? 'oil ↓, equities ↑, gold offered' : 'USD proxy ↑ ≥0.15% and 2Y ↑ within 30-60 min',
      gold_response: 'downside pressure while the confirmation holds',
      confidence: bearSup.confidence,
      support: bearSup.support,
      invalidation: causal.geo ? 'escalation headlines resume' : 'USD/yields fade the first move and gold recovers the pre-release level within 1-2h',
    },
    base: {
      trigger: `${meta.label} broadly in line (${cons}${prev})`,
      mechanism: 'no material repricing; initial volatility, then the market follows the yields/USD reaction and pre-existing drivers',
      causal_chain: causal.chain,
      expected_reaction: 'two-way volatility in the first 15 minutes, then range',
      historical_support: sup(baseSup, 'MIXED', 'USD flat after release'),
      market_confirmation: 'USD and 2Y inside noise bands after 60 minutes',
      gold_response: 'range-bound / trend-following',
      confidence: baseSup.confidence,
      support: baseSup.support,
      invalidation: 'a decisive USD/yield move on details or revisions; break of the pre-release range',
    },
  };
  const dominant = comps.slice().sort((a, b) => Math.abs(b.weight * b.score) - Math.abs(a.weight * a.score))[0];
  const whatMatters = [
    causal.field ? `${causal.field} vs ${cons}` : 'official statements and their credibility',
    'USD proxy and 2Y direction in the first 30 minutes (the confirmation signal)',
    dominant ? `the dominant pre-event driver: ${dominant.name.replace(/_/g, ' ')} (${dominant.note})` : 'no dominant pre-event driver',
    causal.watch,
  ];
  const confirmation = [
    `Bullish confirmation: ${scenarios.bullish.expected_market_confirmation}`,
    `Bearish confirmation: ${scenarios.bearish.expected_market_confirmation}`,
  ];
  const invalidation = [];
  if (state === 'BULLISH') invalidation.push('USD proxy and 2Y rise after the release', 'real yields reprice higher by ≥10bp before/after the event');
  if (state === 'BEARISH') invalidation.push('USD proxy and 2Y fall after the release', 'geopolitical escalation lifts safe-haven demand');
  invalidation.push('a larger concurrent driver (geopolitical headline, Fed communication) overrides the release');
  if (geo.geopolitical_risk_score >= 50) invalidation.push('de-escalation headlines remove the geopolitical premium');
  return {
    event: {
      release_id: p.release.id || null, release_key: p.release.release_key, event_type: type, event_name: meta.label, title: p.release.title,
      event_datetime: p.release.scheduled_at, importance: p.release.impact, expected_market_sensitivity: relevance,
      available_consensus: p.release.consensus || 'NOT AVAILABLE', previous: p.release.previous || 'NOT AVAILABLE',
      revised_previous: p.release.revised_previous || 'NOT AVAILABLE', market_pricing: 'NOT AVAILABLE (no free market-implied pricing source)',
      causal_chain: causal.chain,
    },
    layers: { gold, usd, yields, macro, geopolitics: geo, politics: pol, positioning: cot && cot.available ? { percentile_3y: cot.percentile_3y, state: cot.positioning } : null },
    context: ctx,
    analogues: an,
    components: comps,
    pre_event_score: score,
    pre_event_confidence: confidence,
    forecast_state: state,
    undetermined_reasons: und,
    agreement: round(agreement, 2),
    history_vs_current_conflict: histOpposes,
    contradiction: round(contradiction, 2),
    data_quality: dq,
    scenarios,
    what_matters_most: whatMatters,
    confirmation_conditions: confirmation,
    invalidation_conditions: invalidation,
    disclaimer: DISCLAIMER_LINES,
    note: 'pre_event_score is a weighted evidence score (-100..+100), NOT a probability.',
  };
}

// ---------------------------------------------------------------------------
// Update / invalidation (spec §27-28)
// ---------------------------------------------------------------------------
function compareForecasts(prev, next) {
  const changes = [];
  if ((prev.consensus || null) !== (next.event.available_consensus === 'NOT AVAILABLE' ? null : next.event.available_consensus)) {
    changes.push(`consensus ${prev.consensus ? `changed ${prev.consensus} → ` : 'now available: '}${next.event.available_consensus}`);
  }
  if (prev.forecast_state !== next.forecast_state) changes.push(`state ${prev.forecast_state} → ${next.forecast_state}`);
  const dScore = next.pre_event_score - (prev.pre_event_score || 0);
  if (Math.abs(dScore) >= 20) changes.push(`score ${prev.pre_event_score} → ${next.pre_event_score}`);
  const ps = prev.snapshot || {};
  const nl = next.layers;
  if (ps.usd !== undefined && ps.usd !== null && nl.usd.value) {
    const d = pctChange(ps.usd, nl.usd.value);
    if (d !== null && Math.abs(d) >= 0.5) changes.push(`USD proxy ${d > 0 ? '+' : ''}${round(d, 2)}% since the forecast`);
  }
  for (const [k, label] of [['us2y', '2Y'], ['real10y', 'real 10Y']]) {
    if (ps[k] !== undefined && ps[k] !== null && nl.yields[k] !== null && nl.yields[k] !== undefined) {
      const d = round((nl.yields[k] - ps[k]) * 100, 0);
      if (Math.abs(d) >= 10) changes.push(`${label} ${d > 0 ? '+' : ''}${d}bp since the forecast`);
    }
  }
  if (ps.geo_class && ps.geo_class !== nl.geopolitics.class) changes.push(`geopolitical risk ${ps.geo_class} → ${nl.geopolitics.class}`);
  if (ps.regime && next.context.regime && ps.regime !== next.context.regime) changes.push(`market regime ${ps.regime} → ${next.context.regime}`);
  const directional = (s) => s === 'BULLISH' || s === 'BEARISH';
  const invalidated = directional(prev.forecast_state) && (
    (directional(next.forecast_state) && next.forecast_state !== prev.forecast_state)
    || (next.forecast_state === 'UNDETERMINED' && next.undetermined_reasons.some((r) => !/consensus/.test(r)))
    || Math.sign(next.pre_event_score) === -Math.sign(prev.pre_event_score || 0) && Math.abs(dScore) >= 25);
  const material = invalidated || prev.forecast_state !== next.forecast_state || Math.abs(dScore) >= 20 || changes.some((c) => /consensus|geopolitical|regime/.test(c));
  return { material, invalidated, changes, score_change: dScore };
}

function snapshotOf(f) {
  return {
    usd: f.layers.usd.value || null, us2y: f.layers.yields.us2y, real10y: f.layers.yields.real10y, gold: f.layers.gold.value || null,
    geo_class: f.layers.geopolitics.class, regime: f.context.regime, consensus: f.event.available_consensus,
  };
}

// ---------------------------------------------------------------------------
// Post-event scoring (spec §16, §29)
// ---------------------------------------------------------------------------
function realizedScenario(metrics, surprise, type) {
  if (surprise !== null && surprise !== undefined && surprise !== 0 && DATA_EVENTS.has(type)) {
    const hotIsPositive = type !== 'JOBLESS_CLAIMS';
    const hot = hotIsPositive ? surprise > 0 : surprise < 0;
    return hot ? 'BEARISH' : 'BULLISH';
  }
  if (metrics.usd_dir === 'UP') return 'BEARISH';
  if (metrics.usd_dir === 'DOWN') return 'BULLISH';
  if (metrics.usd_dir === 'FLAT') return 'BASE';
  return null;
}

function timingQuality(m) {
  const band = 0.15;
  const s1 = m.ret_1h === null ? null : Math.abs(m.ret_1h) < band ? 0 : Math.sign(m.ret_1h);
  const s4 = m.ret_4h === null ? null : Math.abs(m.ret_4h) < band ? 0 : Math.sign(m.ret_4h);
  if (s1 === null || s4 === null) return 'UNDETERMINED';
  if (s1 === 0 && s4 === 0) return 'MUTED';
  if (s1 === 0) return 'DELAYED';
  if (s4 === 0 || s1 !== s4) return 'REVERSED';
  return 'SUSTAINED';
}

function scoreForecast(forecast, metrics, release) {
  const realized = metrics.direction;
  const state = forecast.forecast_state;
  const directional = state === 'BULLISH' || state === 'BEARISH';
  const directionCorrect = directional && realized ? state === realized : null;
  const scen = realizedScenario(metrics, release.surprise, release.event_type);
  const expectedForScen = scen === 'BULLISH' ? 'BULLISH' : scen === 'BEARISH' ? 'BEARISH' : scen === 'BASE' ? 'MIXED' : null;
  const scenarioCorrect = expectedForScen && realized ? expectedForScen === realized : null;
  let mcCorrect = null;
  if (metrics.usd_dir && metrics.usd_dir !== 'FLAT' && realized && realized !== 'MIXED') {
    mcCorrect = (metrics.usd_dir === 'UP' && realized === 'BEARISH') || (metrics.usd_dir === 'DOWN' && realized === 'BULLISH');
  }
  const signal = metrics.ret_4h === null ? null : clamp(metrics.ret_4h / 0.5, -1, 1);
  const forecastError = signal === null ? null : round(Math.abs((forecast.pre_event_score || 0) / 100 - signal), 3);
  const timing = timingQuality(metrics);
  let result = 'UNDETERMINED';
  if (state === 'UNDETERMINED' || !realized) result = 'UNDETERMINED';
  else if (directional) result = directionCorrect ? 'CORRECT' : scenarioCorrect ? 'MIXED' : 'INCORRECT';
  else result = realized === 'MIXED' ? 'CORRECT' : scenarioCorrect ? 'MIXED' : 'INCORRECT';
  const why = [];
  if (release.surprise !== null && release.surprise !== undefined) why.push(`actual vs consensus surprise ${release.surprise > 0 ? '+' : ''}${release.surprise}`);
  if (metrics.usd_dir) why.push(`USD reaction ${metrics.usd_dir}${metrics.usd_move_pct !== null ? ` (${metrics.usd_move_pct > 0 ? '+' : ''}${metrics.usd_move_pct}%)` : ''}`);
  why.push(`gold ${metrics.ret_4h > 0 ? '+' : ''}${metrics.ret_4h}% at 4h (${realized || 'n/a'}, timing ${timing})`);
  let lesson;
  if (result === 'CORRECT') lesson = 'The pre-event evidence and the realised reaction agreed; no change warranted from one observation.';
  else if (result === 'MIXED') lesson = 'The conditional scenario played out while the unconditional lean did not — for this event type the first USD/2Y reaction mattered more than the pre-event lean.';
  else if (result === 'INCORRECT') lesson = timing === 'REVERSED' ? 'The first move reversed within 4h — the initial reaction was not a reliable guide.' : 'The reaction contradicted both the lean and the USD channel; check for competing drivers before weighting this event type.';
  else lesson = 'Forecast was UNDETERMINED or data insufficient — nothing to score.';
  lesson += ' Stored for review; production weights are never changed automatically.';
  return {
    forecast_direction_correct: directionCorrect,
    realized_scenario: scen,
    scenario_correct: scenarioCorrect,
    market_confirmation_correct: mcCorrect,
    timing_quality: timing,
    forecast_error: forecastError,
    forecast_result: result,
    why: why.join('; '),
    lesson,
  };
}

module.exports = {
  buildForecast, compareForecasts, snapshotOf, scoreForecast, realizedScenario, timingQuality, analogueEngine, annotateHistory,
  similarity, scenarioSupport, goldLayer, usdLayer, yieldLayer, macroLayer, geoLayer, politicalLayer, dataQuality,
  inflationStateFrom, laborStateFrom, policyStateFrom, CAUSAL, DATA_EVENTS, DISCLAIMER_LINES,
};
