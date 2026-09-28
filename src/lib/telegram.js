'use strict';
/**
 * Telegram delivery: message formats, chunking, resilient sender, update polling and
 * command parsing. HTML parse mode with strict escaping. Every report states its data
 * quality and whether gold / USD data are DIRECT or PROXY.
 */
const { redact, hashOf } = require('./util');
const { CHANNEL_NAMES, marketLine } = require('./analyst');
const { fmtPct, fmtBp } = require('./preevent');

const MAX_LEN = 4000;
const RULE = '━━━━━━━━━━━━━━━━━━━━';
const COMMANDS = ['/start', '/menu', '/now', '/biggest', '/news', '/geopolitics', '/politics', '/macro', '/market', '/events', '/bias', '/history', '/alerts', '/review', '/analysis', '/status', '/daily', '/gold', '/scenarios', '/event', '/ai', '/usage', '/ai_usage'];
const CLASS_ICON = { CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '⚪', INFORMATIONAL: '⚪' };
const STATE_ICON = { BULLISH: '🟢', BEARISH: '🔴', MIXED: '🟠', NEUTRAL: '⚪', UNDETERMINED: '❔' };

function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function b(s) { return `<b>${esc(s)}</b>`; }
function i(s) { return `<i>${esc(s)}</i>`; }
function stripTags(html) {
  return String(html).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function list(items, max = 4) {
  const arr = (items || []).filter(Boolean).slice(0, max);
  return arr.length ? arr.map((x) => `• ${esc(x)}`).join('\n') : '• none identified';
}
function numbered(items, max = 4) {
  const arr = (items || []).filter(Boolean).slice(0, max);
  return arr.map((x, n) => `${n + 1}. ${esc(x)}`).join('\n');
}
function localTime(iso, tz) {
  try {
    return new Date(iso).toLocaleString('en-GB', { timeZone: tz || 'Africa/Casablanca', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch (_) {
    return iso;
  }
}
function untilText(iso) {
  const h = (Date.parse(iso) - Date.now()) / 3600000;
  if (!Number.isFinite(h)) return '';
  if (h < 0) return 'released';
  const d = Math.floor(h / 24);
  return d ? `in ${d}d ${Math.round(h - d * 24)}h` : `in ${Math.max(0, Math.round(h * 10) / 10)}h`;
}

/**
 * Data-quality footer. `dq` = { level, gold_source, usd_source, history_source, reasons }.
 * Proxies are always named as proxies (never "true XAUUSD" / "true DXY").
 */
function dataQualityLines(dq) {
  if (!dq) return [];
  const lines = [`${b('DATA QUALITY:')} ${esc(dq.level || 'UNKNOWN')}${dq.reasons && dq.reasons.length ? ` — ${esc(dq.reasons.slice(0, 3).join('; '))}` : ''}`];
  if (dq.gold_source) lines.push(`${b('GOLD DATA:')} ${esc(dq.gold_source)}`);
  if (dq.usd_source) lines.push(`${b('USD DATA:')} ${esc(dq.usd_source)}`);
  if (dq.history_source) lines.push(`${b('HISTORICAL REACTIONS:')} ${esc(dq.history_source)}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Real-time event alert
// ---------------------------------------------------------------------------
function formatAlert(ev, out, meta) {
  const test = ev.is_test ? '🧪 <b>SIMULATED GOLD RELEVANT EVENT (pipeline test — not real news)</b>\n' : '';
  const update = meta && meta.isUpdate ? ' — UPDATE' : '';
  const hz = ev.horizon_biases || {};
  const sources = (ev.reports || []).slice(0, 4).map((r) => `${r.publisher} (tier ${r.tier})`).join(', ');
  const channels = (ev.transmission || []).filter((c) => c.active && c.direction !== 'NEUTRAL')
    .slice().sort((a, x) => x.strength * x.confidence - a.strength * a.confidence).slice(0, 3)
    .map((c) => `${CHANNEL_NAMES[c.channel] || c.channel} (${c.direction.toLowerCase()})`);
  const mode = meta && meta.mode === 'AI' ? `AI: ${meta.model}` : `deterministic${meta && meta.fallbackReason ? ` (${meta.fallbackReason})` : ''}`;
  const hzv = (h) => esc(hz[h] ? hz[h].bias : 'UNDETERMINED');
  return [
    `${test}🔴 ${b(`XAUUSD GOLD INTELLIGENCE${update}`)}`,
    `${CLASS_ICON[ev.importance_class] || ''} ${esc(ev.importance_class)} · ${esc(ev.confirmation_status)}`,
    '', `${b('EVENT:')} ${esc(ev.title)}`,
    '', b('WHAT HAPPENED:'), esc(out.summary),
    '', b('WHY IT MATTERS:'), esc(out.interpretation).slice(0, 900),
    '', `${b('GOLD RELEVANCE:')} ${esc(ev.gold_relevance_score)}/100 · ${b('IMPORTANCE:')} ${esc(ev.importance_score)}/100 (${esc(ev.importance_class)})`,
    `${b('GOLD CHANNEL:')} ${esc(channels.join(' · ') || 'no directional channel')}`,
    '', b('BULLISH FORCES:'), list(out.bullish_forces, 3),
    '', b('BEARISH FORCES:'), list(out.bearish_forces, 3),
    '', `${b('DOMINANT DRIVER:')} ${esc(CHANNEL_NAMES[out.dominant_driver] || out.dominant_driver)}`,
    `${b('COUNTER-DRIVER:')} ${esc(CHANNEL_NAMES[out.counter_driver] || out.counter_driver)}`,
    '', b('MARKET CONFIRMATION:'), esc(out.market_confirmation),
    '', `${b('NET GOLD PRESSURE:')} ${esc(ev.net_pressure)}`,
    `${b('SHORT BIAS:')} ${hzv('SHORT')} · ${b('TACTICAL:')} ${hzv('TACTICAL')}`,
    `${b('SWING BIAS:')} ${hzv('SWING')} · ${b('STRUCTURAL:')} ${hzv('STRUCTURAL')}`,
    `${b('CONFIDENCE:')} ${esc(out.confidence)}/100 (deterministic)`,
    '', b('INVALIDATION:'), list(out.invalidation_conditions, 3),
    '', ...dataQualityLines(meta && meta.dataQuality),
    `${b('SOURCES:')} ${esc(sources || 'n/a')}`,
    '', `${b('AI SUMMARY:')} ${esc(out.telegram_summary || out.summary)}`,
    i(`Event #${ev.id} · ${mode} · intelligence only, not a trade order`),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Pre-event forecast (Forecast & Conditional Scenario Engine)
// ---------------------------------------------------------------------------
function scenarioBlock(s, withSupport = true) {
  return [
    `${b('Trigger:')} ${esc(s.trigger)}`,
    `${b('Mechanism:')} ${esc(s.mechanism)}`,
    `${b('Confirmation:')} ${esc(s.expected_market_confirmation || s.market_confirmation)}`,
    `${b('Gold:')} ${esc(s.gold_response)}`,
    `${b('Invalidation:')} ${esc(s.invalidation)}`,
    withSupport ? `${b('Support:')} ${esc(s.support)} — ${esc(s.historical_support)}` : null,
  ].filter(Boolean).join('\n');
}

function formatForecast(fc, out, meta, tz) {
  const L = fc.layers;
  const a = fc.analogues;
  const e = fc.event;
  const head = meta && meta.kind === 'MANUAL' ? '🧪 <i>manual run (real data)</i>\n' : '';
  const best = (a.best_analogues || []).slice(0, 3).map((x) => `${String(x.date).slice(0, 10)} (sim ${x.similarity}, 4h ${fmtPct(x.ret_4h)})`).join(', ');
  const ai = meta && meta.mode === 'AI';
  const aiLines = ai
    ? [`${b(`🤖 AI ANALYST (${meta.model}):`)}`, esc(out.interpretation).slice(0, 700), out.ai_disagreement ? `⚠️ ${b('AI DISAGREES with the deterministic state:')} ${esc(out.disagreement_reason || 'see analysis')}` : `${i('AI agrees with / does not override the deterministic state.')}`]
    : [`${b('🤖 AI ANALYST:')} not used (${esc((meta && meta.fallbackReason) || 'deterministic mode')}) — deterministic analysis below.`, esc(out.interpretation).slice(0, 500)];
  return [
    `${head}🧭 ${b('XAUUSD PRE-EVENT INTELLIGENCE')}`,
    RULE,
    `📅 ${b('EVENT:')} ${esc(e.event_name)}${e.title && !String(e.title).startsWith(`${e.event_name} — `) ? ` — ${esc(e.title)}` : e.title ? ` — ${esc(String(e.title).slice(e.event_name.length + 3))}` : ''}`,
    `🔗 ${b('CAUSAL CHAIN:')} ${esc(e.causal_chain)}`,
    `⏰ ${b('TIME:')} ${esc(localTime(e.event_datetime, tz))} (${esc(tz)}) · ${esc(untilText(e.event_datetime))}`,
    `🔥 ${b('IMPORTANCE:')} ${esc(e.importance)} · consensus ${esc(e.available_consensus)} · previous ${esc(e.previous)}`,
    RULE,
    `📊 ${b('CURRENT STATE')}`,
    `${b('Gold:')} ${esc(L.gold.value ?? 'n/a')} · ${esc(L.gold.state)} (5d ${esc(fmtPct(L.gold.ret_5d))}, 20d ${esc(fmtPct(L.gold.ret_20d))}${L.gold.vol_20d_annualised_pct !== null && L.gold.vol_20d_annualised_pct !== undefined ? `, vol ${esc(L.gold.vol_20d_annualised_pct)}%` : ''})`,
    `${b('USD:')} ${esc(L.usd.value ?? 'n/a')} · ${esc(L.usd.class)} (5d ${esc(fmtPct(L.usd.chg_5d_pct))}, 20d ${esc(fmtPct(L.usd.chg_20d_pct))})`,
    `${b('2Y:')} ${esc(L.yields.us2y ?? 'n/a')}% (5d ${esc(fmtBp(L.yields.chg_5d_bp && L.yields.chg_5d_bp.us2y))}) · ${b('10Y:')} ${esc(L.yields.us10y ?? 'n/a')}% (5d ${esc(fmtBp(L.yields.chg_5d_bp && L.yields.chg_5d_bp.us10y))})`,
    `${b('Real Yield:')} ${esc(L.yields.real10y ?? 'n/a')}% 10Y TIPS (5d ${esc(fmtBp(L.yields.chg_5d_bp && L.yields.chg_5d_bp.real10y))}) · ${esc(L.yields.class)}`,
    `${b('Geopolitical Risk:')} ${esc(L.geopolitics.class)} ${esc(L.geopolitics.geopolitical_risk_score)}/100 (${esc(L.geopolitics.trend)})`,
    `${b('Macro Regime:')} ${esc(L.macro.primary)}${L.macro.tags.length ? ` (${esc(L.macro.tags.join(', '))})` : ''}`,
    `${b('Current Regime:')} ${esc(fc.context.regime || 'UNDETERMINED')}`,
    RULE,
    `📚 ${b('HISTORICAL EVIDENCE')}`,
    `${b('Historical Sample:')} ${esc(a.historical_sample_size)} releases${a.period ? ` (${esc(String(a.period.from).slice(0, 7))} → ${esc(String(a.period.to).slice(0, 7))})` : ''}`,
    a.historical_sample_size ? `${b('All cases:')} up ${esc(a.unconditional.bullish_cases)} · down ${esc(a.unconditional.bearish_cases)} · mixed ${esc(a.unconditional.mixed_cases)} (median 4h ${esc(fmtPct(a.unconditional.median_gold_reaction_4h))})` : 'No historical sample for this event type (NOT AVAILABLE).',
    a.historical_sample_size ? `${b('Similar Events:')} top ${esc(a.conditional.top_k)} (similarity ${esc(a.historical_similarity_score)}/100): up ${esc(a.conditional.bullish_cases)} · down ${esc(a.conditional.bearish_cases)} · mixed ${esc(a.conditional.mixed_cases)}` : null,
    best ? `${b('Closest analogues:')} ${esc(best)}` : null,
    `${b('Historical Bias:')} ${esc(a.historical_bias)} · ${b('Evidence Quality:')} ${esc(a.historical_evidence_quality)}/100 · ${b('Regime Match:')} ${esc(a.regime_match)}`,
    RULE,
    `🧠 ${b('PRE-EVENT BIAS')}`,
    `${b('State:')} ${STATE_ICON[fc.forecast_state] || ''} ${esc(fc.forecast_state)}`,
    `${b('Score:')} ${esc(fc.pre_event_score > 0 ? `+${fc.pre_event_score}` : fc.pre_event_score)} ${i('(weighted evidence score −100…+100 — not a probability)')}`,
    `${b('Confidence:')} ${esc(fc.pre_event_confidence)}/100 ${i('(deterministic)')}`,
    fc.undetermined_reasons.length ? `${b('Undetermined because:')} ${esc(fc.undetermined_reasons.join('; '))}` : null,
    fc.history_vs_current_conflict ? `⚖️ ${esc('Historical analogues and current drivers point in opposite directions — the lean is conflicted.')}` : null,
    RULE,
    `🟢 ${b('BULLISH SCENARIO')}`, scenarioBlock(fc.scenarios.bullish),
    RULE,
    `🔴 ${b('BEARISH SCENARIO')}`, scenarioBlock(fc.scenarios.bearish),
    RULE,
    `⚪ ${b('BASE / MIXED')}`, scenarioBlock(fc.scenarios.base),
    RULE,
    `🎯 ${b('WHAT MATTERS MOST')}`, numbered(fc.what_matters_most, 4),
    '', b('INVALIDATION:'), list(fc.invalidation_conditions, 3),
    RULE,
    ...aiLines,
    RULE,
    ...dataQualityLines(meta && meta.dataQuality),
    RULE,
    `⚠️ ${b('IMPORTANT')}`,
    ...fc.disclaimer.map(esc),
    i('Not a trade order.'),
  ].filter((x) => x !== null && x !== undefined).join('\n');
}

function formatForecastUpdate(prev, fc, cmp, tz, invalidated) {
  const e = fc.event;
  return [
    invalidated ? `⚠️ ${b('XAUUSD FORECAST INVALIDATED')}` : `🔄 ${b('XAUUSD FORECAST UPDATE')}`,
    `${b('EVENT:')} ${esc(e.event_name)} — ${esc(localTime(e.event_datetime, tz))} (${esc(untilText(e.event_datetime))})`,
    `${b('PREVIOUS BIAS:')} ${esc(prev.forecast_state)} (score ${esc(prev.pre_event_score)}, confidence ${esc(prev.confidence)})`,
    `${b(invalidated ? 'NEW STATE:' : 'NEW BIAS:')} ${esc(fc.forecast_state)} (score ${esc(fc.pre_event_score)}, confidence ${esc(fc.pre_event_confidence)})`,
    '', b('WHAT CHANGED:'), list(cmp.changes, 6),
    '', `${b(invalidated ? 'REASON:' : 'WHY:')} ${esc(invalidated ? 'the original pre-event thesis is no longer supported by the current evidence' : 'material change in the evidence behind the forecast')}${fc.undetermined_reasons.length ? ` (${esc(fc.undetermined_reasons.join('; '))})` : ''}`,
    '', b('WHAT TO WATCH NOW:'), numbered(fc.what_matters_most, 3),
    i('Conditional scenario analysis — not knowledge of undisclosed future news.'),
  ].join('\n');
}

function formatCalendarNotice(n, tz) {
  return [
    n.kind === 'CANCELLED' ? `🗓 ${b('EVENT REMOVED FROM OFFICIAL CALENDAR')}` : `🗓 ${b('EVENT RESCHEDULED')}`,
    `${b('EVENT:')} ${esc(n.label)}`,
    `${b('WAS:')} ${esc(localTime(n.old_time, tz))}`,
    n.new_time ? `${b('NOW:')} ${esc(localTime(n.new_time, tz))}` : `${b('STATUS:')} no longer on the official schedule (cancelled or postponed)`,
    'The previous pre-event forecast is superseded; a new forecast will be produced on schedule.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Post-event review (spec: EVENT RESULT ALERT)
// ---------------------------------------------------------------------------
function formatEventReview(r, tz) {
  const m = r.metrics;
  const s = r.score;
  const bp = (x) => (x === null || x === undefined ? 'n/a' : `${x > 0 ? '+' : ''}${x}bp`);
  return [
    `🧾 ${b('XAUUSD EVENT REVIEW')}${r.manual ? ` ${i('(manual review run)')}` : ''}`,
    `${b('EVENT:')} ${esc(r.label)} — ${esc(localTime(r.scheduled_at, tz))}`,
    `${b('FORECAST:')} ${r.forecast ? `${esc(r.forecast.forecast_state)} (score ${esc(r.forecast.pre_event_score)}, confidence ${esc(r.forecast.confidence)})` : 'no pre-event forecast was stored for this event'}`,
    `${b('ACTUAL:')} ${esc(r.actual ?? 'NOT AVAILABLE')}`,
    `${b('CONSENSUS:')} ${esc(r.consensus ?? 'NOT AVAILABLE')} · ${b('SURPRISE:')} ${esc(r.surprise ?? 'NOT AVAILABLE')}`,
    `${b('GOLD REACTION:')} 5m ${esc(fmtPct(m.ret_5m))} · 30m ${esc(fmtPct(m.ret_30m))} · 1h ${esc(fmtPct(m.ret_1h))} · 4h ${esc(fmtPct(m.ret_4h))} → ${esc(m.direction || 'n/a')} (${esc(m.strength || 'n/a')})`,
    `${b('USD REACTION:')} ${esc(m.usd_move_pct === null || m.usd_move_pct === undefined ? 'n/a' : fmtPct(m.usd_move_pct))} (${esc(m.usd_dir || 'n/a')}, 1h)`,
    `${b('2Y:')} ${esc(bp(r.y2_bp))} · ${b('10Y:')} ${esc(bp(r.y10_bp))} · ${b('Real 10Y:')} ${esc(bp(r.real_bp))} ${i('(official daily close vs prior day)')}`,
    `${b('OIL:')} ${esc(r.oil_text || 'NOT AVAILABLE')}`,
    s ? `${b('FORECAST RESULT:')} ${esc(s.forecast_result)} · scenario played: ${esc(s.realized_scenario || 'n/a')} (${esc(s.scenario_correct === null ? 'n/a' : s.scenario_correct ? 'matched' : 'not matched')}) · timing ${esc(s.timing_quality)}` : `${b('FORECAST RESULT:')} UNDETERMINED (no forecast)`,
    s ? `${b('WHY:')} ${esc(s.why)}` : null,
    s ? `${b('LESSON:')} ${esc(s.lesson)}` : null,
    ...dataQualityLines(r.dataQuality),
    i(`Stored in historical_event_reactions${s ? ' and evaluation_results' : ''}. Weights are never changed automatically.`),
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Daily report
// ---------------------------------------------------------------------------
function instrumentLines(state) {
  return [
    `${b('USD:')} ${state.usd ? `${esc(state.usd.value)} (24h ${esc(fmtPct(state.usd.change_24h_pct))}, 5d ${esc(fmtPct(state.usd.change_5d_pct))})` : 'unavailable'}`,
    `${b('2Y:')} ${state.us2y ? `${esc(state.us2y.value)}% (5d ${esc(fmtBp(state.us2y.change_5d_bp))}, as of ${esc(String(state.us2y.as_of).slice(0, 10))})` : 'unavailable'}`,
    `${b('10Y:')} ${state.us10y ? `${esc(state.us10y.value)}% (5d ${esc(fmtBp(state.us10y.change_5d_bp))})` : 'unavailable'}`,
    `${b('REAL YIELD:')} ${state.real10y ? `${esc(state.real10y.value)}% (5d ${esc(fmtBp(state.real10y.change_5d_bp))})` : 'unavailable'}`,
    `${b('OIL:')} ${state.oil ? `${esc(state.oil.value)} (5d ${esc(fmtPct(state.oil.change_5d_pct))})` : 'NOT AVAILABLE (optional FRED key not configured)'}`,
    `${b('GOLD:')} ${state.gold ? `${esc(state.gold.value)} (24h ${esc(fmtPct(state.gold.change_24h_pct))}, 5d ${esc(fmtPct(state.gold.change_5d_pct))})` : 'unavailable'}`,
  ];
}

function forecastLine(f, tz) {
  return `${localTime(f.scheduled_at, tz)} · ${f.label} (${f.impact}) — ${f.forecast_state || 'not yet forecast'}${f.pre_event_score !== null && f.pre_event_score !== undefined ? ` · score ${f.pre_event_score > 0 ? '+' : ''}${f.pre_event_score} · conf ${f.confidence} · evidence ${f.historical_evidence_quality ?? 'n/a'}` : ''}`;
}

function formatDaily(d, out, meta, tz) {
  const top = (cat) => d.topEvents.filter((e) => e.category === cat).slice(0, 3).map((e) => `${e.title} — ${e.importance_class}, ${e.net_pressure}`);
  const hz = d.desk.horizons;
  const fcs = (d.forecasts || []).slice(0, 4);
  const fcBlock = fcs.length ? fcs.map((f) => [
    `• ${esc(forecastLine(f, tz))}`,
    f.bullish_trigger ? `   🟢 ${esc(f.bullish_trigger)}` : null,
    f.bearish_trigger ? `   🔴 ${esc(f.bearish_trigger)}` : null,
    f.watch ? `   👀 ${esc(f.watch)}` : null,
  ].filter(Boolean).join('\n')).join('\n') : '• no stored pre-event forecasts for the next 48h';
  const up = (d.upcoming || []).slice(0, 6).map((u) => `${localTime(u.scheduled_at, tz)} · ${u.label} (${u.impact})${u.consensus ? ` · cons ${u.consensus}` : ''}`);
  const L = d.layers || {};
  return [
    `🥇 ${b('XAUUSD DAILY INTELLIGENCE')} — ${esc(localTime(d.as_of, tz))}`,
    RULE,
    `${b('CURRENT REGIME:')} ${esc(d.desk.regime)}${d.desk.regime_conflict ? ` — ${esc(d.desk.regime_conflict)}` : ''}`,
    `${b('TACTICAL BIAS:')} ${esc(hz.TACTICAL.bias)} · ${b('STRUCTURAL BIAS:')} ${esc(hz.STRUCTURAL.bias)}`,
    `${b('SHORT:')} ${esc(hz.SHORT.bias)} · ${b('SWING:')} ${esc(hz.SWING.bias)}`,
    L.macro ? `${b('MACRO REGIME:')} ${esc(L.macro.primary)}` : null,
    L.geopolitics ? `${b('GEOPOLITICAL RISK:')} ${esc(L.geopolitics.class)} ${esc(L.geopolitics.geopolitical_risk_score)}/100 (${esc(L.geopolitics.trend)})` : null,
    RULE,
    `🌍 ${b('TOP GEOPOLITICAL DEVELOPMENTS')}`, list(top('GEOPOLITICS'), 3),
    `🏛 ${b('TOP POLITICAL DEVELOPMENTS')}`, list(top('POLITICS'), 3),
    `📈 ${b('TOP MACRO DEVELOPMENTS')}`, list(top('MACRO'), 3),
    RULE,
    ...instrumentLines(d.state),
    RULE,
    `${b('MARKET CONFIRMATION:')} ${esc(out.market_confirmation)}`,
    `${b('DOMINANT DRIVER:')} ${esc(out.dominant_driver)}`,
    `${b('COUNTER-DRIVER:')} ${esc(out.counter_driver)}`,
    RULE,
    `🗓 ${b('UPCOMING EVENTS')}`, list(up, 6),
    `🧭 ${b('PRE-EVENT FORECASTS')}`, fcBlock,
    RULE,
    `🟢 ${b('BULLISH SCENARIO:')} ${esc(out.bullish_scenario)}`,
    `🔴 ${b('BEARISH SCENARIO:')} ${esc(out.bearish_scenario)}`,
    `⚪ ${b('BASE / MIXED:')} ${esc(out.base_scenario)}`,
    '', b('WHAT COULD CHANGE THE VIEW:'), list(out.invalidation_conditions, 3),
    RULE,
    `${b('AI SUMMARY:')} ${esc(out.telegram_summary || out.summary)}`,
    ...dataQualityLines(meta && meta.dataQuality),
    i(`${meta && meta.mode === 'AI' ? `AI: ${meta.model}` : `deterministic synthesis${meta && meta.fallbackReason ? ` (${meta.fallbackReason})` : ''}`} · desk confidence ${d.desk.confidence}/100 · intelligence only`),
  ].filter((x) => x !== null && x !== undefined).join('\n');
}

// ---------------------------------------------------------------------------
// /now
// ---------------------------------------------------------------------------
function formatNow(desk, state, catSummary, next, tz, extra) {
  const hz = desk.horizons;
  const L = (extra && extra.layers) || {};
  const f = next && next.forecast;
  return [
    `🟡 ${b('XAUUSD — NOW')} (${esc(localTime(desk.as_of, tz))})`,
    RULE,
    `${b('REGIME:')} ${esc(desk.regime)}${desk.regime_conflict ? ` — ${esc(desk.regime_conflict)}` : ''}`,
    `${b('SHORT BIAS:')} ${esc(hz.SHORT.bias)} · ${b('TACTICAL:')} ${esc(hz.TACTICAL.bias)}`,
    `${b('SWING BIAS:')} ${esc(hz.SWING.bias)} · ${b('STRUCTURAL:')} ${esc(hz.STRUCTURAL.bias)}`,
    RULE,
    `${b('GOLD STATE:')} ${state.gold ? `${esc(state.gold.value)} (24h ${esc(fmtPct(state.gold.change_24h_pct))}, 5d ${esc(fmtPct(state.gold.change_5d_pct))})${L.gold ? ` · ${esc(L.gold.state)}` : ''}` : 'unavailable'}`,
    `${b('USD STATE:')} ${state.usd ? `${esc(state.usd.value)} (5d ${esc(fmtPct(state.usd.change_5d_pct))})${L.usd ? ` · ${esc(L.usd.class)}` : ''}` : 'unavailable'}`,
    `${b('YIELD STATE:')} 2Y ${esc(state.us2y ? `${state.us2y.value}%` : 'n/a')} · 10Y ${esc(state.us10y ? `${state.us10y.value}%` : 'n/a')}${L.yields ? ` · ${esc(L.yields.class)}` : ''}`,
    `${b('REAL-YIELD STATE:')} ${state.real10y ? `${esc(state.real10y.value)}% (5d ${esc(fmtBp(state.real10y.change_5d_bp))})` : 'unavailable'}`,
    `${b('OIL:')} ${state.oil ? `${esc(state.oil.value)}` : 'NOT AVAILABLE (optional FRED key)'}`,
    `${b('GEOPOLITICAL STATE:')} ${L.geopolitics ? `${esc(L.geopolitics.class)} ${esc(L.geopolitics.geopolitical_risk_score)}/100 (${esc(L.geopolitics.trend)})` : 'n/a'} — ${esc(catSummary.GEOPOLITICS || 'no high-relevance events (24h)')}`,
    `${b('POLITICS:')} ${esc(catSummary.POLITICS || 'no high-relevance events (24h)')}`,
    `${b('MACRO STATE:')} ${L.macro ? esc(L.macro.primary) : 'n/a'} — ${esc(catSummary.MACRO || 'no high-relevance events (24h)')}`,
    `${b('MARKET CONFIRMATION:')} tactical ${esc(hz.TACTICAL.market_confirmation)}`,
    `${b('DOMINANT DRIVER:')} ${esc(desk.dominant_driver || 'none')} · ${b('COUNTER-DRIVER:')} ${esc(desk.counter_driver || 'none')}`,
    RULE,
    `🧭 ${b('CURRENT FORECAST STATE')}`,
    `${b('NEXT MAJOR EVENT:')} ${esc(next ? `${next.label} — ${localTime(next.scheduled_at, tz)} (${untilText(next.scheduled_at)})` : 'none scheduled in the next 7 days')}`,
    f ? `${b('PRE-EVENT BIAS:')} ${STATE_ICON[f.forecast_state] || ''} ${esc(f.forecast_state)} · ${b('SCORE:')} ${esc(f.pre_event_score > 0 ? `+${f.pre_event_score}` : f.pre_event_score)} · ${b('CONFIDENCE:')} ${esc(f.confidence)}` : `${b('PRE-EVENT BIAS:')} not yet computed (daily pre-event run)`,
    f ? `${b('HISTORICAL SAMPLE:')} ${esc(f.historical_sample_size)} · ${b('HISTORICAL BIAS:')} ${esc(f.historical_bias)} · evidence ${esc(f.historical_evidence_quality)}/100` : null,
    f && f.bullish_trigger ? `🟢 ${esc(f.bullish_trigger)}` : null,
    f && f.bearish_trigger ? `🔴 ${esc(f.bearish_trigger)}` : null,
    f && f.main_invalidation ? `${b('MAIN INVALIDATION:')} ${esc(f.main_invalidation)}` : null,
    RULE,
    `${b('CONFIDENCE:')} ${esc(desk.confidence)}/100 (desk)`,
    ...dataQualityLines(extra && extra.dataQuality),
  ].filter((x) => x !== null && x !== undefined).join('\n');
}

function formatEventList(title, events, tz) {
  if (!events.length) return `${b(title)}\nNo retained events in the last 48h.`;
  return [b(title), ...events.slice(0, 8).map((e) => `${CLASS_ICON[e.importance_class] || '•'} #${esc(e.id)} ${esc(e.title)}\n   ${esc(e.subcategory)} · rel ${esc(e.gold_relevance_score)} · imp ${esc(e.importance_score)} · ${esc(e.net_pressure)} · ${esc(localTime(e.last_seen_at, tz))}`), '', '<i>/event &lt;id&gt; for details</i>'].join('\n');
}

function formatEventDetail(ev, tz) {
  if (!ev) return 'Event not found.';
  const ch = (ev.transmission || []).filter((c) => c.active).map((c) => `${CHANNEL_NAMES[c.channel] || c.channel}: ${c.direction} s${c.strength}/c${c.confidence} ${c.time_horizon}`);
  const mc = ev.market_confirmation || {};
  return [
    `${CLASS_ICON[ev.importance_class] || ''} ${b(`EVENT #${ev.id}`)}${ev.is_test ? ' 🧪 SIMULATED' : ''}`,
    esc(ev.title),
    `${esc(ev.category)} / ${esc(ev.subcategory)} · ${esc(ev.region)}`,
    `first seen ${esc(localTime(ev.first_seen_at, tz))} · sources ${esc(ev.source_count)} (${esc(ev.publisher_count)} publishers) · ${esc(ev.confirmation_status)}`,
    `relevance ${esc(ev.gold_relevance_score)} · importance ${esc(ev.importance_score)} (${esc(ev.importance_class)})`,
    `net pressure ${esc(ev.net_pressure)} · dominant ${esc(ev.dominant_driver || 'none')} · counter ${esc(ev.counter_driver || 'none')}`,
    '', b('CHANNELS:'), list(ch, 8),
    '', `${b('MARKET CONFIRMATION:')} ${esc(mc.status || 'n/a')}${mc.gold_move_pct !== undefined && mc.gold_move_pct !== null ? ` (gold ${esc(fmtPct(mc.gold_move_pct))})` : ''}`,
    '', b('SOURCES:'), list((ev.reports || []).map((r) => `${r.publisher} (T${r.tier}): ${r.title}`), 5),
  ].join('\n');
}

function formatStatus(h, cfgView, tz) {
  const icon = { OK: '✅', DEGRADED: '⚠️', DOWN: '❌', NOT_CONFIGURED: '⚙️', UNKNOWN: '❔' };
  const x = h.extra || {};
  const ago = (iso) => (iso ? `${localTime(iso, tz)}` : 'never');
  // Scheduler health = the Health Monitor's job-freshness checks (last run vs configured interval).
  const jobs = h.components.filter((c) => c.component === 'NEWS_PIPELINE' || c.component === 'MARKET_PIPELINE');
  const scheduler = !jobs.length ? '❔ not yet checked (health check pending)'
    : jobs.every((c) => c.status === 'OK') ? '✅ news & market jobs on schedule'
      : `⚠️ ${jobs.filter((c) => c.status !== 'OK').map((c) => `${c.component} ${c.status}`).join(', ')}`;
  return [
    `🩺 ${b('SYSTEM STATUS')} — ${esc(localTime(new Date().toISOString(), tz))}`,
    `${b('Overall:')} ${icon[h.overall] || ''} ${esc(h.overall)} · ${b('health check:')} ${esc(h.components.length ? localTime(h.checked_at, tz) : 'none in the last 2h')}`,
    `${b('n8n:')} ✅ running (this reply was produced by it) · ${b('Scheduler:')} ${esc(scheduler)}`,
    ...h.components.map((c) => `${icon[c.status] || ''} ${esc(c.component)}: ${esc(c.status)}${c.detail ? ` — ${esc(c.detail)}` : ''}`),
    RULE,
    `${b('Last ingestion:')} ${esc(ago(x.last_news))} · ${b('Last market tick:')} ${esc(ago(x.last_market))}`,
    `${b('Last AI run:')} ${esc(x.last_ai ? `${ago(x.last_ai.at)} (${x.last_ai.model}, ${x.last_ai.success ? 'OK' : x.last_ai.failure_reason})` : 'never')}`,
    `${b('Last Telegram delivery:')} ${esc(ago(x.last_telegram))}`,
    `${b('Errors (24h):')} ${esc(x.errors_24h ?? 'n/a')} · ${b('Data quality:')} ${esc(x.data_quality || 'n/a')}`,
    RULE,
    `Telegram: ${esc(cfgView.telegram)} · OpenRouter: ${esc(cfgView.openrouter)} · FRED: ${esc(cfgView.fred)}`,
    `AI models: ${esc(cfgView.models.join(' → '))} → deterministic`,
    `${b('AI usage:')} ${esc(h.ai_used_today)}/${esc(cfgView.ai_daily_budget)} requests today`,
  ].join('\n');
}

function formatStart(chatId, authorised) {
  if (!authorised) {
    return [
      b('Gold Intelligence bot'),
      'This is a private intelligence bot.',
      `Your chat id is <code>${esc(chatId)}</code>. The owner can authorise it by adding it to TELEGRAM_CHAT_ID.`,
    ].join('\n');
  }
  return [
    `🟡 ${b('XAUUSD Gold Intelligence Desk')}`,
    'Geopolitics · politics · macro · monetary & fiscal policy · gold fundamentals · market confirmation · pre-event conditional forecasts.',
    'Intelligence only — no trade execution, no orders.',
    '',
    '/now — regime, horizon biases, drivers, markets, next-event forecast',
    '/daily — latest daily report',
    '/geopolitics · /politics · /macro · /gold — top events (48h)',
    '/events — upcoming scheduled events + pre-event forecasts',
    '/scenarios — latest pre-event scenarios',
    '/biggest — 🔮 biggest scenarios of the week (deterministic ranking + AI explanation)',
    '/event &lt;id&gt; — event detail',
    '/status — system health',
    '/ai — 🤖 AI control center · /usage — AI requests, tokens, quota, fallbacks',
  ].join('\n');
}

function formatTechAlert(err, tz) {
  return [
    `⚠️ ${b('GOLD INTEL — TECHNICAL ALERT')} (${esc(err.severity)})`,
    `Workflow: ${esc(err.workflow_name)}`,
    `Node: ${esc(err.node_name || 'n/a')}`,
    `Error: ${esc(String(err.error_message || '').slice(0, 400))}`,
    `Execution: ${esc(err.execution_id || 'n/a')} · ${esc(localTime(err.occurred_at, tz))}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Chunking + sending
// ---------------------------------------------------------------------------
function chunk(text, max = MAX_LEN) {
  if (text.length <= max) return [text];
  const parts = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if ((cur + line).length + 1 > max) {
      if (cur) parts.push(cur);
      cur = line.length > max ? line.slice(0, max) : line;
    } else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) parts.push(cur);
  // Never leave an unbalanced tag at a chunk boundary.
  return parts.map((p) => {
    const open = (p.match(/<(b|i|code)>/g) || []).length;
    const close = (p.match(/<\/(b|i|code)>/g) || []).length;
    return open === close ? p : stripTags(p);
  });
}

/**
 * @param {{messages:Array<{chat_id,text,message_type,dedup_key,related_ref,is_test,reply_markup?}>, token:string,
 *          http:Function, sleep:Function, secrets:string[]}} opts
 */
async function sendMessages(opts) {
  const results = [];
  for (const msg of opts.messages) {
    const res = { ...msg, status: 'FAILED', telegram_message_ids: [], attempts: 0, parts: 0, error: null, text_hash: hashOf(msg.text) };
    if (!opts.token || !msg.chat_id) {
      res.status = 'NOT_CONFIGURED';
      results.push(res);
      continue;
    }
    const parts = chunk(msg.text);
    res.parts = parts.length;
    let allOk = true;
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi];
      // Inline keyboard (menus) goes on the last part only.
      const markup = msg.reply_markup && pi === parts.length - 1 ? { reply_markup: msg.reply_markup } : {};
      let ok = false;
      let plain = false;
      for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
        res.attempts++;
        let status = 0;
        let body = null;
        try {
          const r = await opts.http({
            url: `https://api.telegram.org/bot${opts.token}/sendMessage`,
            method: 'POST',
            body: plain ? { chat_id: msg.chat_id, text: stripTags(part), disable_web_page_preview: true, ...markup }
              : { chat_id: msg.chat_id, text: part, parse_mode: 'HTML', disable_web_page_preview: true, ...markup },
            timeout: 20000,
          });
          status = r.statusCode;
          body = r.body;
        } catch (e) {
          res.error = redact(e.message || String(e), opts.secrets).slice(0, 300);
          await opts.sleep(1000 * 3 ** (attempt - 1));
          continue;
        }
        if (status === 200 && body && body.ok) {
          ok = true;
          res.telegram_message_ids.push(body.result && body.result.message_id);
        } else if (status === 429) {
          const wait = Math.min(((body && body.parameters && body.parameters.retry_after) || 3) * 1000, 30000);
          res.error = `rate limited (retry_after ${wait / 1000}s)`;
          await opts.sleep(wait);
        } else if (status === 400 && !plain && body && /parse entities|can't parse/i.test(body.description || '')) {
          plain = true;
          res.error = 'HTML parse error; resent as plain text';
        } else if (status >= 500 || status === 0) {
          res.error = `telegram HTTP ${status}`;
          await opts.sleep(1000 * 3 ** (attempt - 1));
        } else {
          res.error = redact(`telegram HTTP ${status}: ${(body && body.description) || ''}`, opts.secrets).slice(0, 300);
          break;
        }
      }
      if (!ok) { allOk = false; break; }
      await opts.sleep(1100);
    }
    res.status = allOk ? 'SENT' : 'FAILED';
    if (allOk && res.error && !/plain text/.test(res.error)) res.error = null;
    results.push(res);
  }
  return results;
}

/**
 * Normalises a getUpdates batch: inline-button presses (callback_query) become command messages
 * (their callback_data is the command text) for AUTHORISED chats only.
 * @returns {{updates:Array, callbacks:Array<string>, new_offset:number|null}} callbacks = ids to answer
 */
function normaliseUpdates(raw, allowedChatIds, nowSec) {
  const allowed = new Set([...(allowedChatIds || [])].map(String));
  const list = raw || [];
  const updates = [];
  const callbacks = [];
  for (const u of list) {
    const cq = u.callback_query;
    if (!cq) { if (u.message) updates.push(u); continue; }
    callbacks.push(cq.id);
    const chat = cq.message && cq.message.chat;
    if (!chat || !allowed.has(String(chat.id))) continue;
    updates.push({
      update_id: u.update_id, via_button: true,
      message: { message_id: cq.message.message_id, date: nowSec || Math.floor(Date.now() / 1000), chat, from: cq.from, text: String(cq.data || '').slice(0, 64) },
    });
  }
  return { updates, callbacks, new_offset: list.length ? Math.max(...list.map((u) => u.update_id)) + 1 : null };
}

function parseCommand(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('/')) return null;
  const [head, ...rest] = t.split(/\s+/);
  const cmd = head.split('@')[0].toLowerCase();
  return { command: cmd, args: rest, known: COMMANDS.includes(cmd) };
}

module.exports = {
  esc, stripTags, chunk, sendMessages, parseCommand, normaliseUpdates, localTime, untilText, COMMANDS, RULE, dataQualityLines,
  formatAlert, formatForecast, formatForecastUpdate, formatCalendarNotice, formatEventReview, formatDaily, formatNow,
  formatEventList, formatEventDetail, formatStatus, formatStart, formatTechAlert, marketLine,
};
