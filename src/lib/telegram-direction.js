'use strict';
/**
 * Telegram views for the multi-horizon direction and calibrated probabilities:
 * GOLD NOW, the GOLD DIRECTION DESK box, the AI ANALYSIS direction summary and the probability
 * block used by BIGGEST SCENARIOS. Score, confidence and probability are always labelled separately.
 */
const { esc, localTime, untilText, RULE, dataQualityLines } = require('./telegram');
const D = require('./direction');
const C = require('./calibration');

const b = (s) => `<b>${esc(s)}</b>`;
const i = (s) => `<i>${esc(s)}</i>`;
const ICON = { BULLISH: '🟢', BEARISH: '🔴', MIXED: '🟠', NEUTRAL: '⚪', UNDETERMINED: '❔' };
const LEGEND = 'Score = analytical pressure (−100…+100) · confidence = reliability of the deterministic assessment (0–100) · probability = calibrated historical frequency, shown only when validated. Not a trade signal.';
const signed = (x) => (x === null || x === undefined ? 'n/a' : `${x > 0 ? '+' : ''}${x}`);
const month = (d) => (d ? String(d).slice(0, 7) : '?');

function leadClass(p) {
  return ['BULLISH', 'BEARISH', 'NEUTRAL'].sort((x, y) => (p.probs ? p.probs[y] - p.probs[x] : 0))[0];
}

/** Probability block: numbers only for CALIBRATED cells; otherwise UNAVAILABLE with the reason. */
function probabilityLines(p, opts = {}) {
  if (!p || p.status !== 'CALIBRATED') {
    return [
      `${b('PROBABILITY:')} UNAVAILABLE`,
      i(`Reason: ${(p && p.reason) || 'insufficient calibrated historical evidence'}`),
      `${b('DIRECTIONAL EVIDENCE:')} INSUFFICIENT`,
    ];
  }
  const lead = leadClass(p);
  const ci = p.ci95 && p.ci95[lead];
  const wf = p.walk_forward || {};
  return [
    `🟢 ${b('BULLISH:')} ${p.bullish_pct}% · 🔴 ${b('BEARISH:')} ${p.bearish_pct}% · ⚪ ${b('NEUTRAL/MIXED:')} ${p.neutral_pct}%`,
    i(`${opts.cases || 'non-overlapping cases'}: ${p.n} (${month(p.window_start)} → ${month(p.window_end)}) · empirical, Laplace-smoothed · walk-forward validated (${wf.n_eval} checks) · evidence ${p.evidence}${ci ? ` · 95% CI ${lead.toLowerCase()} ${ci[0]}–${ci[1]}%` : ''}${p.pooled ? ` · pooled ${String(p.class_key).split(':')[0].toLowerCase()} releases` : ''}`),
    ...((p.warnings || []).length ? [`⚠️ ${esc(p.warnings.join('; '))}`] : []),
  ];
}

/** Compact one-line probability (desk box, per-horizon). */
function probabilityShort(p) {
  const state = p && p.market_state ? ` [market ${p.market_state.toLowerCase()}]` : '';
  if (!p || p.status !== 'CALIBRATED') {
    const why = !p ? '' : /insufficient/.test(p.reason || '') && p.n !== undefined ? ` (only ${p.n} cases)` : /walk-forward/.test(p.reason || '') ? ' (failed walk-forward validation)' : '';
    return `P${state}: unavailable${why}`;
  }
  return `P${state}: B ${p.bullish_pct}% · Be ${p.bearish_pct}% · N ${p.neutral_pct}% (${String(p.evidence).toLowerCase()}, n=${p.n})`;
}

/**
 * Does the calibrated history support the deterministic direction? Stated explicitly so that a
 * direction and a probability that point different ways are never silently mixed.
 */
function consistencyLine(direction, p) {
  if (!p || p.status !== 'CALIBRATED' || !['BULLISH', 'BEARISH'].includes(direction)) return null;
  const own = direction === 'BULLISH' ? p.bullish_pct : p.bearish_pct;
  const other = direction === 'BULLISH' ? p.bearish_pct : p.bullish_pct;
  const d = direction.toLowerCase();
  if (own <= other) return `⚖️ The calibrated history does NOT confirm the ${direction} lean for this horizon (${d} ${own}% vs ${direction === 'BULLISH' ? 'bearish' : 'bullish'} ${other}%, neutral ${p.neutral_pct}%).`;
  if (p.evidence === 'WEAK') return `ℹ️ History leans ${d} (${own}% vs ${other}%) but the evidence is WEAK.`;
  return `✅ The calibrated history is consistent with the ${direction} lean (${d} ${own}% vs ${other}%, evidence ${p.evidence}).`;
}

function deskProbabilities(desk, cells, dq, cfg) {
  const out = {};
  for (const h of D.HORIZONS) out[h] = C.deskProbability(cells, h, desk && desk.horizons && desk.horizons[h] ? desk.horizons[h].market_score : null, { dataQuality: dq, cfg });
  return out;
}

/** ┌─ GOLD DIRECTION DESK ─┐ */
function directionDeskBox(desk, view, probs, interpretation) {
  const lines = ['┌─ <b>GOLD DIRECTION DESK</b> ─┐', `${b('Current regime:')} ${esc(desk.regime)}`];
  for (const r of view) {
    const name = r.horizon.charAt(0) + r.horizon.slice(1).toLowerCase();
    lines.push(`${b(`${name}:`)} ${ICON[r.direction] || ''} ${esc(r.direction)} · score ${esc(signed(r.score))} · confidence ${esc(r.confidence)}`);
    lines.push(`   ${esc(probabilityShort(probs[r.horizon]))}`);
  }
  const t = probs.TACTICAL;
  lines.push(`${b('Calibrated probability (tactical):')} ${t && t.status === 'CALIBRATED' ? esc(`Bullish ${t.bullish_pct}% · Bearish ${t.bearish_pct}% · Neutral/Mixed ${t.neutral_pct}%`) : 'UNAVAILABLE'}`);
  if (interpretation) lines.push(`${b('Interpretation:')} ${esc(interpretation)}`);
  lines.push('└───────────────────────┘');
  return lines;
}

/**
 * GOLD NOW: regime, current direction, calibrated probability, what is bullish / bearish, drivers,
 * confirmation, invalidation, markets, next event, direction desk, data quality.
 */
function formatGoldNow(desk, state, catSummary, next, tz, extra = {}) {
  const dq = extra.dataQuality || null;
  const dqLevel = dq ? dq.level : desk.data_quality;
  const view = D.horizonView(desk, dqLevel);
  const probs = deskProbabilities(desk, extra.cells || [], dqLevel, extra.cfg);
  const interp = D.interpretHorizons(view);
  const T = view.find((r) => r.horizon === 'TACTICAL');
  const tp = probs.TACTICAL;
  const f = forcesText(D.forces(desk));
  const L = extra.layers || desk.layers || {};
  const fc = next && next.forecast;
  const confirm = view.filter((r) => r.confirmation && r.confirmation !== 'UNAVAILABLE')
    .map((r) => `${r.horizon.toLowerCase()} ${r.confirmation}${r.gold_change_pct !== null ? ` (gold ${signed(r.gold_change_pct)}%)` : ''}`).join(' · ') || 'not measurable yet';
  return [
    `🟡 ${b('GOLD NOW')} (${esc(localTime(desk.as_of, tz))})`,
    RULE,
    `${b('REGIME:')} ${esc(desk.regime)}${desk.regime_conflict ? ` — ${esc(desk.regime_conflict)}` : ''}`,
    `${b('CURRENT DIRECTION (tactical, days–2 weeks):')} ${ICON[T.direction] || ''} ${esc(T.direction)} · score ${esc(signed(T.score))} · confidence ${esc(T.confidence)}`,
    interp ? `${b('HORIZON INTERPRETATION:')} ${esc(interp)}` : `${b('HORIZONS:')} all ${esc(T.direction)}`,
    RULE,
    `📊 ${b(`CALIBRATED PROBABILITY — tactical (gold, ${(C.DESK_HORIZONS.TACTICAL || {}).label || 'next 5 days'})`)}`,
    tp && tp.market_state ? i(`Conditioned on today's tactical market-driver state: ${tp.market_state} (USD proxy, real/nominal yields, positioning; news not included)`) : null,
    ...probabilityLines(tp),
    consistencyLine(T.direction, tp),
    RULE,
    `🟢 ${b('BULLISH:')} ${esc(f.bullish)}`,
    `🔴 ${b('BEARISH:')} ${esc(f.bearish)}`,
    `${b('DOMINANT DRIVER:')} ${esc(desk.dominant_driver || 'none')} · ${b('COUNTER-DRIVER:')} ${esc(desk.counter_driver || 'none')}`,
    `${b('MARKET CONFIRMATION:')} ${esc(confirm)}`,
    `${b('INVALIDATION:')} ${esc(D.invalidation(desk, L))}`,
    RULE,
    `${b('GOLD:')} ${state.gold ? `${esc(state.gold.value)} (24h ${esc(signed(state.gold.change_24h_pct))}%, 5d ${esc(signed(state.gold.change_5d_pct))}%)${L.gold ? ` · ${esc(L.gold.state)}` : ''}` : 'unavailable'}`,
    `${b('USD (proxy):')} ${state.usd ? `${esc(state.usd.value)} (5d ${esc(signed(state.usd.change_5d_pct))}%)` : 'unavailable'} · ${b('2Y/10Y:')} ${esc(state.us2y ? `${state.us2y.value}%` : 'n/a')} / ${esc(state.us10y ? `${state.us10y.value}%` : 'n/a')} · ${b('real 10Y:')} ${esc(state.real10y ? `${state.real10y.value}%` : 'n/a')}`,
    `${b('GEOPOLITICS:')} ${L.geopolitics ? `${esc(L.geopolitics.class)} ${esc(L.geopolitics.geopolitical_risk_score)}/100 (${esc(L.geopolitics.trend)})` : 'n/a'} — ${esc(catSummary.GEOPOLITICS || 'no high-relevance events')}`,
    `${b('MACRO:')} ${L.macro ? esc(L.macro.primary) : 'n/a'} — ${esc(catSummary.MACRO || 'no high-relevance events')}`,
    RULE,
    `🧭 ${b('NEXT MAJOR EVENT:')} ${esc(next ? `${next.label} — ${localTime(next.scheduled_at, tz)} (${untilText(next.scheduled_at)})` : 'none scheduled in the next 7 days')}`,
    fc ? `${b('PRE-EVENT LEAN:')} ${ICON[fc.forecast_state] || ''} ${esc(fc.forecast_state)} · score ${esc(signed(fc.pre_event_score))} · confidence ${esc(fc.confidence)} ${i('(see /biggest for calibrated scenario probabilities)')}` : null,
    RULE,
    ...directionDeskBox(desk, view, probs, interp),
    ...dataQualityLines(dq),
    i(LEGEND),
  ].filter((x) => x !== null && x !== undefined).join('\n');
}

function forcesText(fs) {
  return {
    bullish: fs.bullish.length ? fs.bullish.join('; ') : 'no material bullish driver',
    bearish: fs.bearish.length ? fs.bearish.join('; ') : 'no material bearish driver',
  };
}

/** Compact direction summary (AI ANALYSIS view). */
function directionSummary(desk, cells, dq, cfg) {
  if (!desk) return [`${b('CURRENT DIRECTION:')} desk state not computed yet`];
  const view = D.horizonView(desk, dq);
  const probs = deskProbabilities(desk, cells || [], dq, cfg);
  const T = view.find((r) => r.horizon === 'TACTICAL');
  const interp = D.interpretHorizons(view);
  return [
    `${b('CURRENT DIRECTION (tactical):')} ${ICON[T.direction] || ''} ${esc(T.direction)} · score ${esc(signed(T.score))} · confidence ${esc(T.confidence)}`,
    `${b('HORIZONS:')} ${esc(view.map((r) => `${r.horizon.toLowerCase()} ${r.direction}`).join(' · '))}`,
    interp ? `${b('INTERPRETATION:')} ${esc(interp)}` : null,
    `📊 ${b('CALIBRATED PROBABILITY (tactical):')}`,
    ...probabilityLines(probs.TACTICAL),
    consistencyLine(T.direction, probs.TACTICAL),
  ].filter(Boolean);
}

module.exports = { LEGEND, probabilityLines, probabilityShort, consistencyLine, deskProbabilities, directionDeskBox, formatGoldNow, directionSummary };
