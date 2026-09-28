'use strict';
/**
 * 🔮 BIGGEST SCENARIOS (spec §27): the deterministic engine ranks the stored conditional scenarios
 * of upcoming events; the AI may only explain the ranked list, never re-rank or invent scenarios.
 * The rank score is a transparent weighting, not a probability.
 */
const { esc, localTime, untilText, RULE } = require('./telegram');
const { round } = require('./util');
const C = require('./calibration');

const IMPACT_W = { HIGH: 1, MEDIUM: 0.6, LOW: 0.3 };
const SUPPORT_W = { STRONG: 1, MODERATE: 0.75, WEAK: 0.5, 'INSUFFICIENT EVIDENCE': 0.3 };
const KIND_ICON = { BULLISH: '🟢', BEARISH: '🔴', BASE: '⚪' };

/**
 * @param {Array} forecasts active forecasts (next 7 days) with their scenarios
 * @returns {Array} top scenarios, highest rank score first
 */
function rankScenarios(forecasts, nowMs, top = 3) {
  const now = nowMs === undefined ? Date.now() : nowMs;
  const items = [];
  for (const f of forecasts || []) {
    const hours = (Date.parse(f.scheduled_at) - now) / 3600000;
    if (!(hours > 0)) continue;
    const urgency = 1 / (1 + hours / 72);
    const impact = IMPACT_W[f.impact] ?? 0.5;
    for (const s of f.scenarios || []) {
      const support = SUPPORT_W[s.support] ?? 0.4;
      // The side the deterministic forecast leans to ranks first; the opposite tail stays relevant as risk.
      const lean = s.kind === f.forecast_state ? 1 : s.kind === 'BASE' ? (['MIXED', 'NEUTRAL', 'UNDETERMINED'].includes(f.forecast_state) ? 0.9 : 0.6) : 0.8;
      const score = 100 * impact * support * lean * (0.5 + 0.5 * urgency);
      items.push({
        release_key: f.release_key || `${f.event_type}:${f.scheduled_at}`, event_type: f.event_type, label: f.label || f.event_type,
        scheduled_at: f.scheduled_at, impact: f.impact, consensus: f.consensus || null,
        state: f.forecast_state, score: f.pre_event_score, confidence: f.confidence, evidence_quality: f.historical_evidence_quality,
        sample: f.historical_sample_size, kind: s.kind, trigger: s.trigger_text, mechanism: s.mechanism,
        confirmation: s.expected_confirmation, gold_response: s.expected_gold_response, invalidation: s.invalidation,
        support: s.support || 'INSUFFICIENT EVIDENCE', historical_support: s.historical_support || null,
        rank_score: round(score, 1),
        rank_reason: `${f.impact || 'n/a'} impact · support ${s.support || 'n/a'} · ${s.kind === f.forecast_state ? `aligned with the ${f.forecast_state} pre-event lean` : s.kind === 'BASE' ? 'base case' : `counter-scenario to the ${f.forecast_state} lean`} · ${untilText(f.scheduled_at)}`,
      });
    }
  }
  return items.sort((a, b) => b.rank_score - a.rank_score).slice(0, top).map((x, i) => ({ ...x, rank: i + 1 }));
}

/** Attaches the calibrated conditional outcome probabilities (SHORT = first hours, TACTICAL = 3 days). */
function withProbabilities(ranked, cells) {
  return ranked.map((s) => ({
    ...s,
    probability: {
      SHORT: C.scenarioProbability(cells || [], s.event_type, s.kind, 'SHORT'),
      TACTICAL: C.scenarioProbability(cells || [], s.event_type, s.kind, 'TACTICAL'),
    },
  }));
}

const probFact = (p) => (!p || p.status !== 'CALIBRATED'
  ? { status: 'UNAVAILABLE', reason: p && p.reason ? p.reason : 'not calibrated' }
  : { status: 'CALIBRATED', bullish_pct: p.bullish_pct, bearish_pct: p.bearish_pct, neutral_pct: p.neutral_pct, sample: p.n,
    evidence: p.evidence, pooled: Boolean(p.pooled), conditioned_on: p.conditioned_on });

function biggestFacts(ranked, desk) {
  return {
    purpose: 'BIGGEST',
    rule: 'The ranking is deterministic and final. Explain, in the given order, why each ranked scenario matters for gold and what would confirm or invalidate it. Do not re-rank, add or remove scenarios, and do not predict which scenario will happen. Probabilities in the input are empirical, conditional on the scenario confirmation, and authoritative: you may explain them, but never create, change or estimate a probability; the rank score is not a probability.',
    regime: desk ? desk.regime : 'UNDETERMINED',
    scenarios: ranked.map((s) => ({
      rank: s.rank, release_key: s.release_key, event: s.label, time: s.scheduled_at, impact: s.impact, consensus: s.consensus,
      kind: s.kind, trigger: s.trigger, mechanism: s.mechanism, gold_response: s.gold_response, confirmation: s.confirmation,
      invalidation: s.invalidation, support: s.support, historical_support: s.historical_support,
      state: s.state, score: s.score, forecast_confidence: s.confidence, rank_score: s.rank_score,
      conditional_probability: s.probability ? { first_hours: probFact(s.probability.SHORT), three_days: probFact(s.probability.TACTICAL) } : null,
    })),
    deterministic: { confidence: ranked.length ? Math.min(...ranked.map((s) => Number(s.confidence) || 0)) : 0 },
  };
}

function deterministicBiggest(facts) {
  const lines = facts.scenarios.map((s) => `#${s.rank} ${s.event} — ${s.kind}: if ${s.trigger}, then ${s.mechanism}; gold ${s.gold_response}. Support ${s.support}. Invalidation: ${s.invalidation}.`);
  const summary = facts.scenarios.length ? `Top ${facts.scenarios.length} conditional scenarios for the coming week, ranked by event impact, historical support and alignment with the pre-event lean (regime ${facts.regime}).` : 'No upcoming scheduled events with stored scenarios.';
  return {
    summary, facts: lines, historical_context: facts.scenarios.map((s) => `${s.event}: ${s.historical_support || 'no historical support text'}`),
    interpretation: lines.join(' '), dominant_driver: 'NONE', secondary_driver: 'NONE', counter_driver: 'NONE',
    bullish_forces: facts.scenarios.filter((s) => s.kind === 'BULLISH').map((s) => s.trigger),
    bearish_forces: facts.scenarios.filter((s) => s.kind === 'BEARISH').map((s) => s.trigger),
    market_confirmation: 'Confirmation per scenario is listed with each scenario.', regime: facts.regime,
    short_bias: 'UNDETERMINED', tactical_bias: 'UNDETERMINED', swing_bias: 'UNDETERMINED', structural_bias: 'UNDETERMINED',
    bullish_scenario: '', base_scenario: '', bearish_scenario: '',
    invalidation_conditions: facts.scenarios.map((s) => s.invalidation), confidence: facts.deterministic.confidence,
    uncertainty: ['Conditional scenarios, not predictions; the event outcomes are unknown.'], telegram_summary: summary,
  };
}

function probLine(label, p) {
  if (!p || p.status !== 'CALIBRATED') return `  ${esc(label)}: UNAVAILABLE — ${esc((p && p.reason) || 'not calibrated')}`;
  return `  ${esc(label)}: 🟢 ${p.bullish_pct}% · 🔴 ${p.bearish_pct}% · ⚪ ${p.neutral_pct}% <i>(n=${p.n}${p.pooled ? `, pooled ${esc(String(p.class_key).split(':')[0].toLowerCase())}` : ''}, evidence ${esc(p.evidence)})</i>`;
}

function probabilityBlock(prob) {
  if (!prob) return [];
  return ['📊 <b>Conditional probability</b> <i>(if this scenario\'s confirmation occurs; empirical, walk-forward validated)</i>:',
    probLine('first hours', prob.SHORT), probLine('3 days', prob.TACTICAL)];
}

function formatBiggest(ranked, explanation, tz) {
  if (!ranked.length) return `🔮 <b>BIGGEST SCENARIOS</b>\nNo upcoming scheduled events with stored pre-event scenarios in the next 7 days. They are produced by the daily pre-event run.`;
  const lines = [`🔮 <b>BIGGEST SCENARIOS</b> — next 7 days`, `<i>Ranked deterministically (event impact × historical support × pre-event lean × time to event). Rank score is not a probability.</i>`];
  for (const s of ranked) {
    lines.push(RULE,
      `${s.rank}. ${KIND_ICON[s.kind] || ''} <b>${esc(s.kind)}</b> — ${esc(s.label)} · ${esc(localTime(s.scheduled_at, tz))} (${esc(untilText(s.scheduled_at))})`,
      `<b>Trigger:</b> ${esc(s.trigger)}`,
      `<b>Mechanism:</b> ${esc(s.mechanism)}`,
      `<b>Gold:</b> ${esc(s.gold_response)}`,
      `<b>Confirmation:</b> ${esc(s.confirmation)}`,
      `<b>Invalidation:</b> ${esc(s.invalidation)}`,
      `<b>Historical evidence:</b> ${esc(s.support)}${s.historical_support ? ` — ${esc(s.historical_support)}` : ''}`,
      ...probabilityBlock(s.probability),
      `<b>Pre-event lean:</b> ${esc(s.state)} · score ${esc(s.score)} · confidence ${esc(s.confidence)}`,
      `<i>Rank score ${esc(s.rank_score)} — ordering weight, not a probability (${esc(s.rank_reason)})</i>`);
  }
  if (explanation && explanation.text) {
    lines.push(RULE, `🤖 <b>AI EXPLANATION</b> <i>(${esc(explanation.label)})</i>`, esc(explanation.text));
  } else if (explanation) {
    lines.push(RULE, `🤖 <b>AI:</b> ${esc(explanation.label)}`);
  }
  lines.push('<i>Conditional analysis — not knowledge of the outcome, not a trade order. Rank score ≠ probability ≠ confidence.</i>');
  return lines.join('\n');
}

module.exports = { rankScenarios, withProbabilities, biggestFacts, deterministicBiggest, formatBiggest };
