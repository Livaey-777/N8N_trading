'use strict';
/**
 * Facts packages for the AI gateway and the deterministic analyst that produces
 * the same output schema when AI is not used or fails. All numbers originate
 * from the verified structured inputs.
 */
const { currentState, fmtPct, fmtBp } = require('./preevent');
const { round } = require('./util');

const CHANNEL_NAMES = {
  SAFE_HAVEN: 'safe-haven demand', REAL_YIELD: 'real yields', NOMINAL_YIELD: 'nominal Treasury yields', USD: 'US dollar',
  INFLATION: 'inflation', MONETARY_POLICY: 'monetary-policy path', FISCAL_POLICY: 'fiscal risk', LIQUIDITY: 'liquidity',
  RISK_SENTIMENT: 'risk sentiment', CENTRAL_BANK_DEMAND: 'central-bank gold demand', PHYSICAL_DEMAND: 'physical / ETF demand',
  ENERGY: 'energy prices', TRADE_SUPPLY_SHOCK: 'trade / supply shock', POSITIONING: 'positioning', VOLATILITY: 'volatility',
};
const CHANNEL_MECHANISM = {
  SAFE_HAVEN: { up: 'escalation raises the geopolitical risk premium and hedging demand', down: 'de-escalation unwinds the risk premium' },
  REAL_YIELD: { up: 'falling real yields lower the opportunity cost of holding gold', down: 'rising real yields raise the opportunity cost of holding gold' },
  NOMINAL_YIELD: { up: 'lower Treasury yields ease pressure on non-yielding gold', down: 'higher Treasury yields pressure non-yielding gold' },
  USD: { up: 'a weaker dollar makes dollar-priced gold cheaper abroad', down: 'a stronger dollar weighs on dollar-priced gold' },
  INFLATION: { up: 'softer inflation supports an easier policy path', down: 'hotter inflation pushes the policy path higher short term (hedge demand is a longer-term offset)' },
  MONETARY_POLICY: { up: 'an easier policy path lowers yields and the dollar', down: 'a tighter policy path lifts yields and the dollar' },
  FISCAL_POLICY: { up: 'fiscal/debt risk supports gold as a hedge against sovereign and debasement risk', down: 'fiscal consolidation reduces that hedge demand' },
  LIQUIDITY: { up: 'liquidity support and easier funding conditions', down: 'forced selling / margin calls can hit gold short term' },
  RISK_SENTIMENT: { up: 'risk-off flows support gold', down: 'risk-on flows reduce defensive demand' },
  CENTRAL_BANK_DEMAND: { up: 'official-sector buying is a structural source of demand', down: 'official-sector selling adds supply' },
  PHYSICAL_DEMAND: { up: 'stronger physical/ETF demand', down: 'weaker physical/ETF demand' },
  ENERGY: { up: 'higher energy prices lift inflation expectations and risk premia', down: 'lower energy prices ease inflation expectations' },
  TRADE_SUPPLY_SHOCK: { up: 'trade conflict and supply shocks raise uncertainty', down: 'trade de-escalation lowers uncertainty' },
  POSITIONING: { up: 'positioning leaves room for buying', down: 'crowded positioning raises liquidation risk' },
  VOLATILITY: { up: 'volatility', down: 'volatility' },
};

function channelLine(c) {
  const name = CHANNEL_NAMES[c.channel] || c.channel;
  const mech = CHANNEL_MECHANISM[c.channel];
  const dirText = c.direction === 'BULLISH' ? (mech && mech.up) : c.direction === 'BEARISH' ? (mech && mech.down) : 'mixed signals';
  const ev = c.evidence && c.evidence.length ? ` [evidence: ${c.evidence.slice(0, 2).join('; ')}]` : '';
  return `${name}: ${c.direction.toLowerCase()} (strength ${c.strength}, confidence ${c.confidence}, ${c.time_horizon}) — ${dirText}${ev}`;
}

function marketLine(state) {
  const parts = [];
  if (state.gold) parts.push(`Gold ${state.gold.value} (24h ${fmtPct(state.gold.change_24h_pct)}, 5d ${fmtPct(state.gold.change_5d_pct)})`);
  if (state.usd) parts.push(`USD proxy ${state.usd.value} (24h ${fmtPct(state.usd.change_24h_pct)})`);
  if (state.us10y) parts.push(`10Y ${state.us10y.value}% (5d ${fmtBp(state.us10y.change_5d_bp)})`);
  if (state.us2y) parts.push(`2Y ${state.us2y.value}% (5d ${fmtBp(state.us2y.change_5d_bp)})`);
  if (state.real10y) parts.push(`10Y real ${state.real10y.value}% (5d ${fmtBp(state.real10y.change_5d_bp)})`);
  return parts.join('; ') || 'market data unavailable';
}

function confirmationLine(mc) {
  if (!mc) return 'not assessed';
  const g = mc.gold_move_pct === null || mc.gold_move_pct === undefined ? '' : ` gold ${fmtPct(mc.gold_move_pct)} since first report`;
  const u = mc.usd_move_pct === null || mc.usd_move_pct === undefined ? '' : `, USD proxy ${fmtPct(mc.usd_move_pct)}`;
  const hyp = mc.divergence_hypotheses ? ` Possible reasons (hypotheses): ${mc.divergence_hypotheses.join('; ')}.` : '';
  return `${mc.status}.${g}${u}.${hyp}`.replace('..', '.');
}

// ---------------------------------------------------------------------------
// EVENT
// ---------------------------------------------------------------------------
function eventConfidence(ev) {
  const active = (ev.transmission || []).filter((c) => c.active);
  if (!active.length) return 20;
  const mean = active.reduce((s, c) => s + c.confidence, 0) / active.length;
  const conf = { CONFIRMED_OFFICIAL: 1, CORROBORATED: 0.95, SINGLE_SOURCE: 0.8, UNCONFIRMED: 0.55 }[ev.confirmation_status] || 0.7;
  const conflictPenalty = ev.net_pressure === 'MIXED' ? 0.8 : 1;
  return Math.round(Math.min(85, 100 * mean * conf * conflictPenalty));
}

function eventFacts(ev, desk, snap) {
  const state = currentState(snap);
  const active = (ev.transmission || []).filter((c) => c.active);
  return {
    purpose: ev.is_test ? 'TEST' : 'EVENT',
    simulated: Boolean(ev.is_test),
    event: {
      title: ev.title, category: ev.category, subcategory: ev.subcategory, region: ev.region,
      first_seen_at: ev.first_seen_at, last_seen_at: ev.last_seen_at,
      confirmation_status: ev.confirmation_status, best_source_tier: ev.best_tier, publisher_count: ev.publisher_count,
      gold_relevance_score: ev.gold_relevance_score, importance_score: ev.importance_score, importance_class: ev.importance_class,
      reports: (ev.reports || []).slice(0, 6).map((r) => ({ publisher: r.publisher, tier: r.tier, title: r.title, published_at: r.published_at })),
      linked_release: ev.linked_release || null,
    },
    transmission: {
      net_pressure: ev.net_pressure, dominant_driver: ev.dominant_driver, counter_driver: ev.counter_driver,
      channels: active.map((c) => ({ channel: c.channel, direction: c.direction, strength: c.strength, confidence: c.confidence, time_horizon: c.time_horizon, evidence: c.evidence })),
      horizons: ev.horizon_biases,
    },
    market_confirmation: ev.market_confirmation || null,
    market_state: state,
    desk_context: desk ? { regime: desk.regime, horizons: Object.fromEntries(Object.entries(desk.horizons || {}).map(([h, v]) => [h, v.bias])) } : null,
    deterministic: { confidence: eventConfidence(ev) },
  };
}

function deterministicEvent(facts) {
  const e = facts.event;
  const t = facts.transmission;
  const channels = t.channels || [];
  const bulls = channels.filter((c) => c.direction === 'BULLISH');
  const bears = channels.filter((c) => c.direction === 'BEARISH' || (c.channel === 'INFLATION' && c.direction === 'MIXED'));
  const sorted = channels.slice().sort((a, b) => b.strength * b.confidence - a.strength * a.confidence);
  const secondary = sorted.find((c) => c.channel !== t.dominant_driver && c.channel !== t.counter_driver);
  const h = t.horizons || {};
  const sources = (e.reports || []).map((r) => `${r.publisher} (tier ${r.tier})`).join(', ');
  const drv = CHANNEL_NAMES[t.dominant_driver] || 'no dominant channel';
  const ctr = t.counter_driver ? CHANNEL_NAMES[t.counter_driver] : 'none identified';
  const region = e.region && e.region !== 'GLOBAL' ? ` (${e.region.replace(/_/g, ' ').toLowerCase()})` : '';
  const reporters = `${e.publisher_count} publisher${e.publisher_count === 1 ? '' : 's'}, best source tier ${e.best_source_tier}`;
  const summary = `${facts.simulated ? '[SIMULATED] ' : ''}${e.category.charAt(0) + e.category.slice(1).toLowerCase()} / ${e.subcategory.toLowerCase().replace(/_/g, ' ')}${region} reported by ${reporters} (${e.confirmation_status.toLowerCase().replace(/_/g, ' ')}). Net gold pressure ${t.net_pressure} via ${drv}.`;
  const out = {
    summary,
    facts: [
      `Reported by: ${sources || 'n/a'}; confirmation ${e.confirmation_status}.`,
      `Gold relevance ${e.gold_relevance_score}/100, importance ${e.importance_score}/100 (${e.importance_class}).`,
      `Market: ${marketLine(facts.market_state || {})}.`,
    ],
    historical_context: facts.historical_context || [],
    interpretation: channels.length
      ? `Transmission to gold: ${channels.map(channelLine).join(' | ')}. Net: ${t.net_pressure}; dominant driver ${drv}; counter-driver ${ctr}.`
      : 'No directional transmission channel identified; informational only.',
    dominant_driver: t.dominant_driver || 'NONE',
    secondary_driver: secondary ? secondary.channel : 'NONE',
    counter_driver: t.counter_driver || 'NONE',
    bullish_forces: bulls.map(channelLine),
    bearish_forces: bears.map(channelLine),
    market_confirmation: confirmationLine(facts.market_confirmation),
    regime: facts.desk_context ? facts.desk_context.regime : 'UNDETERMINED',
    short_bias: (h.SHORT && h.SHORT.bias) || 'UNDETERMINED',
    tactical_bias: (h.TACTICAL && h.TACTICAL.bias) || 'UNDETERMINED',
    swing_bias: (h.SWING && h.SWING.bias) || 'UNDETERMINED',
    structural_bias: (h.STRUCTURAL && h.STRUCTURAL.bias) || 'UNDETERMINED',
    bullish_scenario: bulls.length ? `Follow-through on ${bulls.map((c) => CHANNEL_NAMES[c.channel]).join(', ')} (further confirmation from official sources and cross-asset moves) keeps upward pressure on gold.` : 'No bullish channel currently active from this event.',
    base_scenario: 'The event is absorbed without further escalation or policy repricing; gold reverts to the prevailing regime drivers.',
    bearish_scenario: bears.length ? `Strengthening of ${bears.map((c) => CHANNEL_NAMES[c.channel]).join(', ')} would add downward pressure.` : 'Reversal or denial of the event (e.g. de-escalation, retraction) would remove its support for gold.',
    invalidation_conditions: [
      'official denial, retraction or reversal of the reported development',
      'cross-asset reaction contradicts the channel (e.g. yields/USD move against the thesis while gold fails to respond)',
    ],
    confidence: facts.deterministic.confidence,
    uncertainty: [
      e.confirmation_status === 'UNCONFIRMED' ? 'only tier-4 reporting: unconfirmed' : null,
      e.confirmation_status === 'SINGLE_SOURCE' ? 'single-source report pending corroboration' : null,
      t.net_pressure === 'MIXED' ? 'conflicting channels: net effect depends on which force dominates' : null,
      'keyword-based transmission detection (deterministic mode)',
    ].filter(Boolean),
    telegram_summary: `${e.title} — net gold pressure ${t.net_pressure} via ${drv}; counter-driver: ${ctr}.`,
  };
  return out;
}

// ---------------------------------------------------------------------------
// PRE-EVENT FORECAST (Forecast & Conditional Scenario Engine)
// ---------------------------------------------------------------------------
function forecastFacts(fc, desk) {
  const a = fc.analogues;
  const L = fc.layers;
  return {
    purpose: 'PRE_EVENT',
    rule: 'The outcome of the event is unknown. Provide conditional analysis only. The deterministic score, state and confidence are authoritative; if you disagree, set ai_disagreement=true and explain in disagreement_reason — never change them.',
    event: fc.event,
    deterministic: { forecast_state: fc.forecast_state, pre_event_score: fc.pre_event_score, confidence: fc.pre_event_confidence, undetermined_reasons: fc.undetermined_reasons, data_quality: fc.data_quality, history_vs_current_conflict: fc.history_vs_current_conflict },
    current_state: {
      gold: { value: L.gold.value, state: L.gold.state, ret_1d_pct: L.gold.ret_1d, ret_5d_pct: L.gold.ret_5d, ret_20d_pct: L.gold.ret_20d, vol_20d_annualised_pct: L.gold.vol_20d_annualised_pct },
      usd: { value: L.usd.value, class: L.usd.class, chg_5d_pct: L.usd.chg_5d_pct, chg_20d_pct: L.usd.chg_20d_pct },
      yields: { us2y: L.yields.us2y, us10y: L.yields.us10y, real10y: L.yields.real10y, class: L.yields.class, chg_5d_bp: L.yields.chg_5d_bp, curve_2s10s_bp: L.yields.curve_2s10s_bp },
      macro_regime: { primary: L.macro.primary, tags: L.macro.tags, evidence: L.macro.evidence },
      geopolitics: { risk_score: L.geopolitics.geopolitical_risk_score, class: L.geopolitics.class, trend: L.geopolitics.trend, top: (L.geopolitics.top_events || []).slice(0, 3).map((e) => e.title) },
      politics: { risk_score: L.politics.political_risk_score, class: L.politics.class, themes: L.politics.themes },
      desk_regime: desk ? desk.regime : 'UNDETERMINED',
    },
    historical_evidence: {
      sample_size: a.historical_sample_size, effective_sample: a.effective_sample, evidence_quality: a.historical_evidence_quality,
      regime_match: a.regime_match, similarity_score: a.historical_similarity_score, historical_bias: a.historical_bias,
      unconditional: a.unconditional, conditional_similar_context: a.conditional, best_analogues: a.best_analogues,
      largest_upside_reaction: a.largest_upside_reaction, largest_downside_reaction: a.largest_downside_reaction,
    },
    components: fc.components,
    scenarios: fc.scenarios,
    what_matters_most: fc.what_matters_most,
    invalidation_conditions: fc.invalidation_conditions,
  };
}

function scenarioText(s) {
  return `TRIGGER: ${s.trigger}. MECHANISM: ${s.mechanism}. CONFIRMATION: ${s.expected_market_confirmation || s.market_confirmation}. GOLD: ${s.gold_response}. SUPPORT: ${s.support} — ${s.historical_support}. INVALIDATION: ${s.invalidation}.`;
}

function deterministicForecast(fc) {
  const a = fc.analogues;
  const L = fc.layers;
  const pct = (x) => (x === null || x === undefined ? 'n/a' : `${x > 0 ? '+' : ''}${x}%`);
  const bp = (x) => (x === null || x === undefined ? 'n/a' : `${x > 0 ? '+' : ''}${x}bp`);
  const histLines = a.historical_sample_size ? [
    `Unconditional: ${a.historical_sample_size} past ${fc.event.event_type} releases — gold up ${a.unconditional.bullish_cases}, down ${a.unconditional.bearish_cases}, mixed ${a.unconditional.mixed_cases} at 4h; median ${pct(a.unconditional.median_gold_reaction_4h)}.`,
    `Conditional (top ${a.conditional.top_k} most similar, similarity ${a.historical_similarity_score}/100): up ${a.conditional.bullish_cases}, down ${a.conditional.bearish_cases}, mixed ${a.conditional.mixed_cases}; median ${pct(a.conditional.median_gold_reaction_4h)}.`,
    `Evidence quality ${a.historical_evidence_quality}/100; regime match ${a.regime_match}; historical bias ${a.historical_bias}.`,
  ] : ['No historical sample for this event type (NOT AVAILABLE).'];
  const ranked = fc.components.slice().sort((x, y) => Math.abs(y.weight * y.score) - Math.abs(x.weight * x.score));
  const conflictText = fc.history_vs_current_conflict ? ' Historical analogues and current drivers point in opposite directions — the lean is conflicted.' : '';
  const counter = fc.components.find((c) => fc.pre_event_score !== 0 && Math.sign(c.score) === -Math.sign(fc.pre_event_score));
  return {
    summary: `${fc.event.event_name}: pre-event state ${fc.forecast_state} (score ${fc.pre_event_score}, confidence ${fc.pre_event_confidence}).${conflictText}`,
    facts: [
      `Gold ${L.gold.value ?? 'n/a'} (5d ${pct(L.gold.ret_5d)}, 20d ${pct(L.gold.ret_20d)}, ${L.gold.state}); USD proxy ${L.usd.value ?? 'n/a'} (${L.usd.class}).`,
      `2Y ${L.yields.us2y ?? 'n/a'}%, 10Y ${L.yields.us10y ?? 'n/a'}%, 10Y real ${L.yields.real10y ?? 'n/a'}% (5d ${bp(L.yields.chg_5d_bp && L.yields.chg_5d_bp.real10y)}); ${L.yields.class}.`,
      `Macro: ${L.macro.primary}; geopolitical risk ${L.geopolitics.class} (${L.geopolitics.geopolitical_risk_score}/100, ${L.geopolitics.trend}).`,
    ],
    historical_context: histLines,
    interpretation: `Components: ${fc.components.map((c) => `${c.name} ${c.score > 0 ? '+' : ''}${c.score} (w ${c.weight})`).join(', ') || 'none'}. The score is a weighted evidence score, not a probability.${conflictText}`,
    dominant_driver: ranked[0] ? ranked[0].name : 'NONE',
    secondary_driver: ranked[1] ? ranked[1].name : 'NONE',
    counter_driver: counter ? counter.name : 'NONE',
    bullish_forces: fc.components.filter((c) => c.score > 0).map((c) => `${c.name}: ${c.note}`),
    bearish_forces: fc.components.filter((c) => c.score < 0).map((c) => `${c.name}: ${c.note}`),
    market_confirmation: 'Assessed after the release: USD proxy and 2Y in the first 30-60 minutes.',
    regime: L.macro.primary,
    short_bias: fc.forecast_state,
    tactical_bias: fc.forecast_state,
    swing_bias: 'UNDETERMINED',
    structural_bias: 'UNDETERMINED',
    bullish_scenario: scenarioText(fc.scenarios.bullish),
    base_scenario: scenarioText(fc.scenarios.base),
    bearish_scenario: scenarioText(fc.scenarios.bearish),
    invalidation_conditions: fc.invalidation_conditions,
    confidence: fc.pre_event_confidence,
    uncertainty: [
      'the release outcome is unknown until publication',
      ...fc.undetermined_reasons,
      ...fc.data_quality.reasons,
      'historical surprise conditioning uses the USD reaction as a market-implied proxy where consensus history is not available',
    ],
    telegram_summary: `${fc.event.event_name}: ${fc.forecast_state} (score ${fc.pre_event_score}, confidence ${fc.pre_event_confidence}). Conditional scenarios only.`,
  };
}

// ---------------------------------------------------------------------------
// DAILY
// ---------------------------------------------------------------------------
function dailyFacts(d) {
  return {
    purpose: 'DAILY',
    as_of: d.as_of,
    regime: d.desk.regime,
    horizons: Object.fromEntries(Object.entries(d.desk.horizons).map(([h, v]) => [h, { bias: v.bias, gold_trend: v.gold_trend, market_confirmation: v.market_confirmation }])),
    dominant_driver: d.desk.dominant_driver,
    counter_driver: d.desk.counter_driver,
    market_state: d.state,
    top_events: d.topEvents,
    upcoming_events: d.upcoming,
    deterministic: { confidence: d.desk.confidence },
  };
}

function deterministicDaily(d) {
  const hz = d.desk.horizons;
  const top = (cat) => d.topEvents.filter((e) => e.category === cat).slice(0, 3).map((e) => `${e.title} (${e.importance_class}, ${e.net_pressure})`);
  return {
    summary: `Regime ${d.desk.regime}; tactical ${hz.TACTICAL.bias}, structural ${hz.STRUCTURAL.bias}. Dominant driver ${d.desk.dominant_driver || 'none'}, counter ${d.desk.counter_driver || 'none'}.`,
    facts: [`Market: ${marketLine(d.state)}.`, `Data quality ${d.desk.data_quality}; missing: ${(d.desk.data_missing || []).join(', ') || 'none'}.`],
    historical_context: [],
    interpretation: `Horizon view: SHORT ${hz.SHORT.bias}, TACTICAL ${hz.TACTICAL.bias}, SWING ${hz.SWING.bias}, STRUCTURAL ${hz.STRUCTURAL.bias}. News vs market components: ${['SHORT', 'TACTICAL', 'SWING', 'STRUCTURAL'].map((h) => `${h} news ${hz[h].news_score ?? 'n/a'} / market ${hz[h].market_score ?? 'n/a'}${hz[h].conflict ? ' (conflict)' : ''}`).join('; ')}.`,
    dominant_driver: d.desk.dominant_driver || 'NONE',
    secondary_driver: (d.desk.regime_scores && d.desk.regime_scores[1] && d.desk.regime_scores[1].id) || 'NONE',
    counter_driver: d.desk.counter_driver || 'NONE',
    bullish_forces: [...top('GEOPOLITICS'), ...top('MACRO'), ...top('POLITICS')].filter((x) => /BULLISH/.test(x)),
    bearish_forces: [...top('GEOPOLITICS'), ...top('MACRO'), ...top('POLITICS')].filter((x) => /BEARISH/.test(x)),
    market_confirmation: `Tactical bias ${hz.TACTICAL.bias} vs gold 5d trend ${hz.TACTICAL.gold_trend}: ${hz.TACTICAL.market_confirmation}.`,
    regime: d.desk.regime,
    short_bias: hz.SHORT.bias, tactical_bias: hz.TACTICAL.bias, swing_bias: hz.SWING.bias, structural_bias: hz.STRUCTURAL.bias,
    bullish_scenario: 'Softer US data / dovish repricing, weaker USD, or geopolitical escalation would support gold.',
    base_scenario: 'Current drivers persist; gold follows the dominant regime driver with event-driven volatility.',
    bearish_scenario: 'Hotter data / hawkish repricing, higher real yields, stronger USD or de-escalation would pressure gold.',
    invalidation_conditions: ['a regime-changing release (see upcoming events)', 'a sharp reversal in real yields or the USD against the prevailing trend'],
    confidence: d.desk.confidence,
    uncertainty: [`desk confidence ${d.desk.confidence}/100`, d.desk.data_quality !== 'GOOD' ? `market data ${d.desk.data_quality}` : null].filter(Boolean),
    telegram_summary: `Regime ${d.desk.regime}; tactical ${hz.TACTICAL.bias}; structural ${hz.STRUCTURAL.bias}.`,
  };
}

module.exports = {
  CHANNEL_NAMES, channelLine, marketLine, confirmationLine, eventConfidence, eventFacts, deterministicEvent,
  forecastFacts, deterministicForecast, scenarioText, dailyFacts, deterministicDaily, round,
};
