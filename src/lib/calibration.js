'use strict';
/**
 * Calibrated directional probabilities — empirical, walk-forward validated, never derived from a
 * direction score or a confidence value.
 *
 * Two families of cells:
 *  - DESK: gold's forward direction over the horizon (1 / 5 / 20 / 90 days) conditioned on the
 *    historical MARKET-DRIVER state of that horizon (same marketDriverScores() as the live desk:
 *    USD proxy, real / nominal yields, positioning). News is not part of the condition (no archive).
 *  - EVENT_SCENARIO: gold's reaction to a scheduled release (SHORT = first hours, TACTICAL = 3 days)
 *    conditioned on the scenario's market confirmation (USD up after the release = hawkish/hot
 *    scenario, USD down = dovish/soft, USD flat = base case).
 *
 * Estimator: Laplace-smoothed frequencies over NON-OVERLAPPING cases (overlapping windows would
 * inflate the sample). A cell is CALIBRATED only when (1) it has >= minSample cases, (2) a
 * chronological walk-forward check (each case predicted from earlier cases only) has >= minEval
 * predictions, and (3) its out-of-sample Brier score is no worse than an uninformed 1/3 split.
 * Otherwise the probability is UNAVAILABLE and the reason is stated.
 */
const { round } = require('./util');
const { marketSnapshot, marketDriverScores, valueAt, FLAT_BANDS } = require('./market');

const CLASSES = ['BULLISH', 'BEARISH', 'NEUTRAL'];
const UNIFORM = { BULLISH: 1 / 3, BEARISH: 1 / 3, NEUTRAL: 1 / 3 };
/**
 * minSample = 20: with 20 independent cases the 95 % Wilson interval of a 50 % share is about
 * ±21 points — the widest interval that still distinguishes a 3-way split; below it, percentages
 * mostly reflect noise. Configurable (GI_PROB_MIN_SAMPLE); never lower than 10.
 */
const DEFAULTS = { minSample: 20, minEval: 10, warmup: 10, marketThreshold: 0.15 };
const DESK_HORIZONS = {
  SHORT: { days: 1, band: FLAT_BANDS.GOLD['24h'], label: 'next 24 hours' },
  TACTICAL: { days: 5, band: FLAT_BANDS.GOLD['5d'], label: 'next 5 days' },
  SWING: { days: 20, band: FLAT_BANDS.GOLD['20d'], label: 'next 20 days' },
  STRUCTURAL: { days: 90, band: FLAT_BANDS.GOLD['90d'], label: 'next 90 days' },
};
// Event TACTICAL band: the 24h flat band scaled by sqrt(3 days) (volatility grows with sqrt(time)).
const EVENT_HORIZONS = {
  SHORT: { label: 'first 4 hours after the release', band: null },
  TACTICAL: { label: '3 days after the release', band: round(FLAT_BANDS.GOLD['24h'] * Math.sqrt(3), 2) },
};
const FAMILIES = { CPI: 'INFLATION', PCE: 'INFLATION', PPI: 'INFLATION', NFP: 'LABOR', JOLTS: 'LABOR', GDP: 'GROWTH', FOMC: 'POLICY' };
const SCENARIO_BY_USD = { DOWN: 'BULLISH', UP: 'BEARISH', FLAT: 'BASE' };

const pct = (a, b) => (Number(a) > 0 && Number.isFinite(Number(b)) ? ((Number(b) - Number(a)) / Number(a)) * 100 : null);

function classifyMove(changePct, band) {
  if (changePct === null || changePct === undefined || !Number.isFinite(changePct)) return null;
  if (Math.abs(changePct) < band) return 'NEUTRAL';
  return changePct > 0 ? 'BULLISH' : 'BEARISH';
}

function bucketOf(score, threshold) {
  if (score === null || score === undefined || !Number.isFinite(Number(score))) return null;
  if (score >= threshold) return 'BULLISH';
  if (score <= -threshold) return 'BEARISH';
  return 'NEUTRAL';
}

function countsOf(samples) {
  const c = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 };
  for (const s of samples) if (c[s.outcome] !== undefined) c[s.outcome] += 1;
  return c;
}

/** Laplace (add-one) smoothing: small samples are pulled towards 1/3 each, never to 0 % or 100 %. */
function laplace(counts) {
  const n = CLASSES.reduce((s, c) => s + (counts[c] || 0), 0);
  return Object.fromEntries(CLASSES.map((c) => [c, ((counts[c] || 0) + 1) / (n + 3)]));
}

function brier(p, outcome) {
  return CLASSES.reduce((s, c) => s + ((p[c] || 0) - (c === outcome ? 1 : 0)) ** 2, 0);
}

/** Wilson 95 % interval in percent for k successes out of n. */
function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [round(Math.max(0, (c - m) / d) * 100, 1), round(Math.min(1, (c + m) / d) * 100, 1)];
}

/** Integer percentages that always sum to 100 (largest-remainder method). */
function percentages(p) {
  const raw = CLASSES.map((c) => ({ c, v: (p[c] || 0) * 100 }));
  const out = Object.fromEntries(raw.map(({ c, v }) => [c, Math.floor(v)]));
  let rest = 100 - CLASSES.reduce((s, c) => s + out[c], 0);
  for (const { c } of raw.slice().sort((a, b) => (b.v - Math.floor(b.v)) - (a.v - Math.floor(a.v)))) {
    if (rest <= 0) break;
    out[c] += 1;
    rest -= 1;
  }
  return out;
}

/** Chronological greedy selection of non-overlapping cases (a case starts after the previous one ended). */
function nonOverlapping(rows) {
  const out = [];
  let lastEnd = -Infinity;
  for (const r of rows.slice().sort((a, b) => a.t - b.t)) {
    if (r.t >= lastEnd) { out.push(r); lastEnd = r.end; }
  }
  return out;
}

/**
 * Walk-forward check: case k is predicted from cases 0..k-1 only (their outcomes ended before k
 * started). Baselines: uninformed 1/3 split and the unconditional base rate known at that time.
 */
function walkForward(samples, cfg, climatologyAt) {
  let n = 0;
  let b = 0;
  let bu = 0;
  let bc = 0;
  for (let k = cfg.warmup; k < samples.length; k++) {
    const p = laplace(countsOf(samples.slice(0, k)));
    const o = samples[k].outcome;
    b += brier(p, o);
    bu += brier(UNIFORM, o);
    bc += brier(climatologyAt ? laplace(climatologyAt(samples[k].t)) : UNIFORM, o);
    n += 1;
  }
  if (!n) return { n_eval: 0 };
  return {
    n_eval: n, brier: round(b / n, 4), brier_uniform: round(bu / n, 4), brier_climatology: round(bc / n, 4),
    skill_vs_uniform: round(1 - b / bu, 3), skill_vs_climatology: bc > 0 ? round(1 - b / bc, 3) : null,
  };
}

function isoDay(ms) { return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null; }

/** Builds one cell from chronological non-overlapping samples. */
function cellResult({ kind, horizon, classKey, samples, cfg, climatologyAt, method, conditionedOn, outcomeDefinition, dataSource }) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  const counts = countsOf(samples);
  const base = {
    kind, horizon, class_key: classKey, counts, n: samples.length,
    window_start: samples.length ? isoDay(samples[0].t) : null, window_end: samples.length ? isoDay(samples[samples.length - 1].t) : null,
    method, conditioned_on: conditionedOn, outcome_definition: outcomeDefinition, data_source: dataSource || null, warnings: [],
    bullish_pct: null, bearish_pct: null, neutral_pct: null, probs: null, ci95: null, walk_forward: null,
  };
  if (samples.length < c.minSample) {
    const unit = kind === 'EVENT_SCENARIO' ? 'past releases' : 'non-overlapping cases';
    return { ...base, status: 'UNAVAILABLE', evidence: 'INSUFFICIENT', reason: `insufficient calibrated historical evidence: ${samples.length} ${unit} (minimum ${c.minSample})` };
  }
  const wf = walkForward(samples, c, climatologyAt);
  if (wf.n_eval < c.minEval) {
    return { ...base, status: 'UNAVAILABLE', evidence: 'INSUFFICIENT', walk_forward: wf, reason: `calibration could not be validated out of sample (${wf.n_eval} checks, minimum ${c.minEval})` };
  }
  if (wf.brier > wf.brier_uniform) {
    return { ...base, status: 'UNAVAILABLE', evidence: 'INSUFFICIENT', walk_forward: wf, reason: 'failed walk-forward validation: historical frequencies predicted worse than an uninformed one-third split' };
  }
  const probs = laplace(counts);
  const p = percentages(probs);
  const ci95 = Object.fromEntries(CLASSES.map((k) => [k, wilson(counts[k], samples.length)]));
  const sorted = CLASSES.map((k) => probs[k]).sort((a, b) => b - a);
  const warnings = [];
  if (wf.skill_vs_climatology !== null && wf.skill_vs_climatology <= 0) warnings.push('no out-of-sample edge over the unconditional base rate');
  if (sorted[0] < 0.45 && sorted[0] - sorted[1] < 0.1) warnings.push('historical outcomes are split (contradictory evidence)');
  if (dataSource && /PROXY/i.test(dataSource)) warnings.push('history measured on a PROXY series');
  // Evidence = how informative the calibrated numbers are: an edge over the unconditional base
  // rate (out of sample) is required for MODERATE; without it the numbers are just the base rate.
  const edge = wf.skill_vs_climatology === null ? 0 : wf.skill_vs_climatology;
  const evidence = edge > 0.05 && sorted[0] >= 0.55 && samples.length >= 2 * c.minSample ? 'STRONG'
    : edge > 0 && sorted[0] >= 0.45 ? 'MODERATE' : 'WEAK';
  return {
    ...base, status: 'CALIBRATED', probs: Object.fromEntries(CLASSES.map((k) => [k, round(probs[k], 4)])), ci95, walk_forward: wf,
    bullish_pct: p.BULLISH, bearish_pct: p.BEARISH, neutral_pct: p.NEUTRAL, evidence, warnings, reason: null,
  };
}

function upToIndex(series, tMs) {
  let lo = 0;
  let hi = series.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Date.parse(series[mid].t) <= tMs) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/** Last observation per UTC day. */
function dailyCloses(series) {
  const m = new Map();
  for (const p of (series || []).slice().sort((a, b) => Date.parse(a.t) - Date.parse(b.t))) m.set(String(p.t).slice(0, 10), p);
  return Array.from(m.values());
}

/**
 * DESK cells: for every historical day, the market-driver state per horizon (exactly the live
 * marketDriverScores on the data known that day) and gold's direction over the following horizon.
 * @param {{series: object, cfg?: object, nowIso?: string, goldSource?: string}} p  series keyed like marketSnapshot()
 */
function buildDeskCells({ series, cfg, goldSource }) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  const sorted = Object.fromEntries(Object.entries(series || {}).map(([k, v]) => [k, (v || []).slice().sort((a, b) => Date.parse(a.t) - Date.parse(b.t))]));
  const gold = dailyCloses(sorted.GOLD);
  const rows = { SHORT: [], TACTICAL: [], SWING: [], STRUCTURAL: [] };
  for (const g of gold) {
    const tMs = Date.parse(g.t);
    const cut = {};
    for (const [k, arr] of Object.entries(sorted)) cut[k] = arr.slice(0, upToIndex(arr, tMs) + 1);
    const md = marketDriverScores(marketSnapshot(cut, new Date(tMs).toISOString()));
    for (const [h, def] of Object.entries(DESK_HORIZONS)) {
      const bucket = bucketOf(md[h] && md[h].score, c.marketThreshold);
      if (!bucket) continue;
      const target = tMs + def.days * 86400000;
      const fwd = valueAt(gold, new Date(target).toISOString(), 72);
      if (!fwd || Date.parse(fwd.t) <= tMs || Date.parse(fwd.t) < target - 72 * 3600000) continue;
      const outcome = classifyMove(pct(g.v, fwd.v), def.band);
      if (outcome) rows[h].push({ t: tMs, end: Date.parse(fwd.t), bucket, outcome });
    }
  }
  const cells = [];
  for (const [h, def] of Object.entries(DESK_HORIZONS)) {
    const all = nonOverlapping(rows[h]);
    const climatologyAt = (t) => countsOf(all.filter((r) => r.end <= t));
    for (const bucket of ['BULLISH', 'BEARISH', 'NEUTRAL']) {
      cells.push(cellResult({
        kind: 'DESK', horizon: h, classKey: bucket, samples: nonOverlapping(rows[h].filter((r) => r.bucket === bucket)), cfg: c, climatologyAt,
        method: 'empirical frequency (Laplace-smoothed), non-overlapping windows, walk-forward validated',
        conditionedOn: `${h} market-driver state ${bucket} (USD proxy, real/nominal yields, positioning; |score| >= ${c.marketThreshold}); news not included`,
        outcomeDefinition: `gold ${def.label}: up / down beyond ±${def.band}% = BULLISH / BEARISH, otherwise NEUTRAL`,
        dataSource: goldSource || null,
      }));
    }
  }
  return cells;
}

/**
 * EVENT_SCENARIO cells from the historical reaction database, per event type and per family
 * (pooled: CPI+PCE+PPI inflation, NFP+JOLTS labour, GDP, FOMC).
 */
function buildEventCells({ reactions, cfg }) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  const rows = (reactions || []).filter((r) => Number(r.gold_before) > 0 && SCENARIO_BY_USD[r.usd_reaction_direction]).map((r) => {
    const t = Date.parse(r.event_date);
    const short = r.gold_direction === 'BULLISH' ? 'BULLISH' : r.gold_direction === 'BEARISH' ? 'BEARISH' : r.gold_direction === 'MIXED' ? 'NEUTRAL' : null;
    return {
      t, type: r.event_type, family: FAMILIES[r.event_type] || r.event_type, scenario: SCENARIO_BY_USD[r.usd_reaction_direction],
      outcome: { SHORT: short, TACTICAL: classifyMove(pct(r.gold_before, r.gold_3d), EVENT_HORIZONS.TACTICAL.band) },
      source: JSON.stringify(r.data_source || ''),
    };
  });
  const proxy = rows.some((r) => /paxg|binance/i.test(r.source));
  const cells = [];
  // Own event types, plus pooled families that combine two or more types (INFLATION, LABOR).
  const types = [...new Set(rows.map((r) => r.type))];
  const families = [...new Set(Object.values(FAMILIES))].filter((f) => Object.values(FAMILIES).filter((x) => x === f).length > 1);
  const groups = [...types, ...families];
  for (const h of Object.keys(EVENT_HORIZONS)) {
    for (const key of groups) {
      const isType = Boolean(FAMILIES[key]) || types.includes(key);
      const inGroup = rows.filter((r) => (isType ? r.type === key : r.family === key) && r.outcome[h]);
      const climatologyAt = (t) => countsOf(inGroup.filter((r) => r.t < t).map((r) => ({ outcome: r.outcome[h] })));
      for (const scen of ['BULLISH', 'BEARISH', 'BASE']) {
        const samples = inGroup.filter((r) => r.scenario === scen).map((r) => ({ t: r.t, end: r.t, outcome: r.outcome[h] })).sort((a, b) => a.t - b.t);
        const pooled = !isType;
        cells.push(cellResult({
          kind: 'EVENT_SCENARIO', horizon: h, classKey: `${key}:${scen}`, samples, cfg: c, climatologyAt,
          method: `empirical conditional frequency (Laplace-smoothed), walk-forward validated${pooled ? `, pooled ${key.toLowerCase()} releases` : ''}`,
          conditionedOn: `${key} release where the ${scen === 'BULLISH' ? 'dovish/soft' : scen === 'BEARISH' ? 'hawkish/hot' : 'in-line'} scenario's confirmation occurred (USD proxy ${scen === 'BULLISH' ? 'fell' : scen === 'BEARISH' ? 'rose' : 'was flat'} after the release)`,
          outcomeDefinition: h === 'SHORT' ? 'gold direction over the first hours (1h and 4h agree, beyond noise) — otherwise NEUTRAL/MIXED'
            : `gold ${EVENT_HORIZONS.TACTICAL.label}: beyond ±${EVENT_HORIZONS.TACTICAL.band}% = BULLISH / BEARISH, otherwise NEUTRAL`,
          dataSource: proxy ? 'PROXY (PAXG/USDT gold, inverted EUR/USDT USD)' : 'DIRECT',
        }));
      }
    }
  }
  return cells;
}

/** Current desk probability for one horizon: the cell of today's market-driver state. */
function deskProbability(cells, horizon, marketScore, opts = {}) {
  const c = { ...DEFAULTS, ...(opts.cfg || {}) };
  const bucket = bucketOf(marketScore, c.marketThreshold);
  const def = DESK_HORIZONS[horizon];
  if (!bucket) return { status: 'UNAVAILABLE', horizon, horizon_label: def && def.label, evidence: 'INSUFFICIENT', reason: 'current market-driver state not measurable for this horizon', warnings: [] };
  const cell = (cells || []).find((x) => x.kind === 'DESK' && x.horizon === horizon && x.class_key === bucket);
  if (!cell) return { status: 'UNAVAILABLE', horizon, market_state: bucket, horizon_label: def && def.label, evidence: 'INSUFFICIENT', reason: 'calibration not built yet', warnings: [] };
  const warnings = [...(cell.warnings || [])];
  if (cell.status === 'CALIBRATED' && opts.dataQuality && opts.dataQuality !== 'GOOD') warnings.push(`current market data ${opts.dataQuality}`);
  return { ...cell, market_state: bucket, horizon_label: def.label, warnings };
}

/** Scenario outcome probability: the event type's own cell, else its pooled family, else UNAVAILABLE. */
function scenarioProbability(cells, eventType, scenarioKind, horizon) {
  const find = (key) => (cells || []).find((x) => x.kind === 'EVENT_SCENARIO' && x.horizon === horizon && x.class_key === `${key}:${scenarioKind}`);
  const own = find(eventType);
  if (own && own.status === 'CALIBRATED') return { ...own, pooled: false };
  const fam = FAMILIES[eventType] ? find(FAMILIES[eventType]) : null;
  if (fam && fam.status === 'CALIBRATED') return { ...fam, pooled: true, own_reason: own ? own.reason : 'no own cell' };
  const best = own || fam;
  if (best) {
    const reason = own && fam ? `${eventType}: ${own.reason}; pooled ${String(FAMILIES[eventType]).toLowerCase()}: ${fam.reason}` : best.reason;
    return { ...best, reason, pooled: Boolean(!own && fam) };
  }
  return { status: 'UNAVAILABLE', horizon, evidence: 'INSUFFICIENT', reason: 'calibration not built yet', warnings: [] };
}

module.exports = {
  CLASSES, DEFAULTS, DESK_HORIZONS, EVENT_HORIZONS, FAMILIES, SCENARIO_BY_USD,
  classifyMove, bucketOf, countsOf, laplace, brier, wilson, percentages, nonOverlapping, walkForward, cellResult,
  dailyCloses, buildDeskCells, buildEventCells, deskProbability, scenarioProbability,
};
