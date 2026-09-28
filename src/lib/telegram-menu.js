'use strict';
/**
 * Telegram main menu and the read-only views behind it. Everything is built from stored state —
 * no AI request is spent on menus, market values, counts or status (spec §26).
 */
const { esc, localTime, untilText, RULE } = require('./telegram');

const b = (s) => `<b>${esc(s)}</b>`;
const i = (s) => `<i>${esc(s)}</i>`;
const CLASS_ICON = { CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '⚪', INFORMATIONAL: '⚪' };
const STATE_ICON = { BULLISH: '🟢', BEARISH: '🔴', MIXED: '🟠', NEUTRAL: '⚪', UNDETERMINED: '❔' };
const pct = (x, d = 3) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? 'n/a' : `${Number(x) > 0 ? '+' : ''}${Number(Number(x).toFixed(d))}%`);
const bp = (x) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? 'n/a' : `${Number(x) > 0 ? '+' : ''}${Math.round(Number(x))}bp`);

const MENU = [
  ['📍 GOLD NOW', '/now'], ['🔮 BIGGEST SCENARIOS', '/biggest'],
  ['📰 TOP NEWS', '/news'], ['🌍 GEOPOLITICS', '/geopolitics'],
  ['🏛 POLITICS', '/politics'], ['📈 MACRO', '/macro'],
  ['💹 MARKET STATE', '/market'], ['🗓 UPCOMING EVENTS', '/events'],
  ['🧭 PRE-EVENT BIAS', '/bias'], ['📚 HISTORICAL PATTERNS', '/history'],
  ['🚨 ACTIVE ALERTS', '/alerts'], ['🧾 FORECAST REVIEW', '/review'],
  ['🤖 AI ANALYSIS', '/analysis'], ['🩺 SYSTEM STATUS', '/status'],
  ['🎛 AI CONTROL CENTER', '/ai'], ['📊 AI USAGE', '/usage'],
];
const MAIN_MENU_KEYBOARD = { inline_keyboard: MENU.reduce((rows, [text, data], k) => {
  if (k % 2 === 0) rows.push([]);
  rows[rows.length - 1].push({ text, callback_data: data });
  return rows;
}, []) };
const BACK_TO_MENU = { inline_keyboard: [[{ text: '⬅️ MENU', callback_data: '/start' }]] };

function formatMenu(tz) {
  return [
    `🟡 ${b('XAUUSD Gold Intelligence Desk')}`,
    'Geopolitics · politics · macro · policy · gold fundamentals · market confirmation · pre-event conditional forecasts.',
    'Intelligence only — no trade execution, no orders.',
    '',
    ...MENU.map(([t, c]) => `${esc(t)} — ${esc(c)}`),
    '',
    i(`Also: /daily · /gold · /scenarios · /event <id> · /ai health · /ai model · /ai failures · ${localTime(new Date().toISOString(), tz)}`),
  ].join('\n');
}

/** 📰 TOP NEWS: most important gold-relevant events of the last 24h, all categories. */
function formatNews(events, tz) {
  const nowMs = Date.now();
  const list = (events || []).filter((e) => nowMs - Date.parse(e.last_seen_at) <= 24 * 3600000)
    .sort((a, c) => c.importance_score - a.importance_score).slice(0, 10);
  if (!list.length) return `📰 ${b('TOP NEWS (24h)')}\nNo gold-relevant events in the last 24 hours.`;
  return [`📰 ${b('TOP NEWS (24h)')}`, ...list.map((e) => [
    `${CLASS_ICON[e.importance_class] || '•'} #${e.id} ${esc(e.title)}`,
    `   ${esc(e.category)} / ${esc(e.subcategory || 'n/a')} · rel ${esc(e.gold_relevance_score)} · imp ${esc(e.importance_score)} · ${esc(e.net_pressure)} · ${esc(localTime(e.last_seen_at, tz))}`,
  ].join('\n')), '', i('/event <id> for details')].join('\n');
}

/** 💹 MARKET STATE: instruments, desk regime and horizon confirmation, with honest data labels. */
function formatMarketState(state, desk, dq, tz) {
  const s = state || {};
  const g = s.gold;
  const u = s.usd;
  const lines = [`💹 ${b('MARKET STATE')} — ${esc(localTime(new Date().toISOString(), tz))}`,
    `${b('GOLD:')} ${g ? `${esc(g.value)} · 24h ${esc(pct(g.change_24h_pct))} · 5d ${esc(pct(g.change_5d_pct))} · trend ${esc(g.trend_5d)}` : 'NOT AVAILABLE'}`,
    `${b('USD (DXY-formula proxy):')} ${u ? `${esc(u.value)} · 24h ${esc(pct(u.change_24h_pct))} · 5d ${esc(pct(u.change_5d_pct))} · ${esc(u.trend_5d)}` : 'NOT AVAILABLE'}`,
    `${b('2Y:')} ${s.us2y ? `${esc(s.us2y.value)}% (5d ${esc(bp(s.us2y.change_5d_bp))})` : 'n/a'} · ${b('10Y:')} ${s.us10y ? `${esc(s.us10y.value)}% (5d ${esc(bp(s.us10y.change_5d_bp))})` : 'n/a'}`,
    `${b('REAL 10Y:')} ${s.real10y ? `${esc(s.real10y.value)}% (5d ${esc(bp(s.real10y.change_5d_bp))})` : 'n/a'}${s.us10y && s.us10y.as_of ? ` · ${i(`yields as of ${String(s.us10y.as_of).slice(0, 10)}`)}` : ''}`,
    `${b('OIL:')} ${s.oil ? `${esc(s.oil.value)} (5d ${esc(pct(s.oil.change_5d_pct, 2))})` : 'NOT AVAILABLE (optional FRED key)'}`,
    `${b('POSITIONING (COT):')} ${s.positioning ? `${esc(s.positioning.state)} · net ${esc(s.positioning.net_noncommercial)} · ${esc(s.positioning.percentile_3y)}th pct (3y)` : 'n/a'}`];
  if (desk) {
    lines.push(RULE, `${b('REGIME:')} ${esc(desk.regime)}${desk.regime_conflict ? ` — ${esc(desk.regime_conflict)}` : ''}`);
    for (const h of ['SHORT', 'TACTICAL', 'SWING', 'STRUCTURAL']) {
      const x = (desk.horizons || {})[h];
      if (x) lines.push(`${STATE_ICON[x.bias] || '•'} ${b(h)}: ${esc(x.bias)} · gold ${esc(x.gold_trend)} ${esc(pct(x.gold_change_pct, 2))} · ${esc(x.market_confirmation)}`);
    }
    lines.push(`${b('DOMINANT:')} ${esc(desk.dominant_driver || 'none')} · ${b('COUNTER:')} ${esc(desk.counter_driver || 'none')} · ${b('confidence')} ${esc(desk.confidence)}/100`);
  }
  if (dq) {
    lines.push(RULE, `${b('DATA QUALITY:')} ${esc(dq.level)}${dq.reasons && dq.reasons.length ? ` — ${esc(dq.reasons.join('; '))}` : ''}`,
      `${b('GOLD DATA:')} ${esc(dq.gold_source)}`, `${b('USD DATA:')} ${esc(dq.usd_source)}`);
  }
  lines.push(i('Market context only — not a technical trading signal.'));
  return lines.join('\n');
}

/** 🧭 PRE-EVENT BIAS: the stored deterministic forecast for each upcoming release. */
function formatBias(forecasts, tz) {
  const f = forecasts || [];
  if (!f.length) return `🧭 ${b('PRE-EVENT BIAS')}\nNo active pre-event forecasts for the next 7 days (the daily pre-event run creates them up to 36h ahead).`;
  return [`🧭 ${b('PRE-EVENT BIAS')} — active forecasts`, ...f.map((x) => [
    RULE,
    `${STATE_ICON[x.forecast_state] || '•'} ${b(x.label || x.event_type)} · ${esc(localTime(x.scheduled_at, tz))} (${esc(untilText(x.scheduled_at))}) · ${esc(x.impact || '')}`,
    `${b('State:')} ${esc(x.forecast_state)} · ${b('score')} ${esc(x.pre_event_score)} ${i('(−100…+100, not a probability)')} · ${b('confidence')} ${esc(x.confidence)}`,
    `${b('History:')} ${esc(x.historical_sample_size ?? 'n/a')} releases · bias ${esc(x.historical_bias || 'n/a')} · evidence ${esc(x.historical_evidence_quality ?? 'n/a')}/100 · regime match ${esc(x.regime_match || 'n/a')}`,
    `${b('Data quality:')} ${esc(x.data_quality || 'n/a')}${x.ai_model ? ` · ${b('AI:')} ${esc(x.ai_model)}` : ''}`,
    x.bullish_trigger ? `🟢 ${esc(x.bullish_trigger)}` : null,
    x.bearish_trigger ? `🔴 ${esc(x.bearish_trigger)}` : null,
    x.main_invalidation ? `${b('Main invalidation:')} ${esc(x.main_invalidation)}` : null,
  ].filter(Boolean).join('\n')), '', i('Conditional analysis — the outcome is unknown. /biggest ranks the scenarios.')].join('\n');
}

/** 📚 HISTORICAL PATTERNS: reaction statistics per event type from the reaction database. */
function formatHistory(rows, filter) {
  const want = filter ? String(filter).toUpperCase() : null;
  const r = (rows || []).filter((x) => !want || x.event_type === want);
  if (!r.length) return `📚 ${b('HISTORICAL PATTERNS')}\n${want ? `No history for ${esc(want)}.` : 'Historical reaction database is empty.'}`;
  const lines = [`📚 ${b('HISTORICAL PATTERNS')} — gold reaction at 4h`, i('Descriptive statistics of past releases; small samples (< 20) are indicative only. Not a probability.')];
  for (const x of r.sort((a, c) => Number(c.n) - Number(a.n))) {
    const usdUp = Number(x.usd_up || 0);
    const usdDown = Number(x.usd_down || 0);
    lines.push(RULE,
      `${b(x.event_type)} · n=${esc(x.n)} (${esc(String(x.first).slice(0, 7))} → ${esc(String(x.last).slice(0, 7))})${Number(x.n) < 20 ? ' ⚠️ small sample' : ''}`,
      `up ${esc(x.up)} · down ${esc(x.down)} · mixed ${esc(x.mixed)} · median 4h ${esc(pct(x.med_4h, 3))} · median |4h| ${esc(pct(x.med_abs_4h, 3).replace('+', ''))}`,
      `USD up → gold down in ${esc(x.usd_up_gold_down)}/${esc(usdUp)} · USD down → gold up in ${esc(x.usd_down_gold_up)}/${esc(usdDown)}`,
      `${b('Source:')} ${x.any_direct ? 'DIRECT (Dukascopy spot) for part of the sample' : 'PROXY (PAXG/USDT gold, inverted EUR/USDT USD, 1-minute)'}`);
  }
  if (!want) lines.push('', i('/history CPI (or NFP, FOMC, PCE, PPI, GDP, JOLTS) for one event type'));
  return lines.join('\n');
}

/** 🚨 ACTIVE ALERTS: alerts of the last 24h and events that are alert-grade right now. */
function formatAlerts(alerts, live, tz) {
  // One line per event: latest alert time, how many alerts/updates, latest delivery status.
  const groups = new Map();
  for (const x of alerts || []) {
    const k = x.event_id ? `event:${x.event_id}` : x.related_ref || String(groups.size);
    const g = groups.get(k);
    if (!g) groups.set(k, { ...x, count: 1 });
    else {
      g.count += 1;
      if (Date.parse(x.created_at) > Date.parse(g.created_at)) Object.assign(g, { ...x, count: g.count });
    }
  }
  const a = [...groups.values()].sort((p, q) => Date.parse(q.created_at) - Date.parse(p.created_at));
  const l = (live || []).slice(0, 6);
  const lines = [`🚨 ${b('ACTIVE ALERTS')}`];
  lines.push(b('Alerts in the last 24h:'));
  if (!a.length) lines.push('• none');
  for (const x of a) {
    lines.push(`${CLASS_ICON[x.importance_class] || '•'} ${esc(localTime(x.created_at, tz))} · ${x.event_id ? `#${esc(x.event_id)} ` : ''}${esc(x.title || x.related_ref || 'alert')} · ${esc(x.net_pressure || '')} · delivery ${esc(x.status)}${x.count > 1 ? ` · ${x.count} alerts/updates` : ''}`);
  }
  lines.push('', b('Alert-grade events now (HIGH/CRITICAL, seen in the last 6h):'));
  if (!l.length) lines.push('• none');
  for (const e of l) lines.push(`${CLASS_ICON[e.importance_class] || '•'} #${esc(e.id)} ${esc(e.title)} · ${esc(e.importance_class)} · ${esc(e.net_pressure)} · ${esc(e.confirmation_status)}`);
  lines.push('', i('Delivery NOT_CONFIGURED means the alert was produced but Telegram was not configured at the time.'));
  return lines.join('\n');
}

/** 🧾 FORECAST REVIEW: latest post-event reviews and descriptive performance statistics. */
function formatReview(reviews, reactions, perf, tz) {
  const lines = [`🧾 ${b('FORECAST REVIEW')}`];
  const r = reviews || [];
  if (r.length) {
    lines.push(b('Latest evaluated forecasts:'));
    for (const x of r) {
      lines.push(`${STATE_ICON[x.forecast_state] || '•'} ${esc(x.event_type)} ${esc(localTime(x.scheduled_at, tz))} · forecast ${esc(x.forecast_state)} (score ${esc(x.pre_event_score ?? 'n/a')}) → realized ${esc(x.realized_direction || 'n/a')} ${esc(pct(x.realized_move_pct, 3))} · ${b(x.forecast_result || 'n/a')}${x.timing_quality ? ` · timing ${esc(x.timing_quality)}` : ''}`);
      if (x.lesson) lines.push(`   ${i(x.lesson)}`);
    }
  } else lines.push('No forecast has been evaluated yet (first scoring after the next reviewed release).');
  const rx = reactions || [];
  if (rx.length) {
    lines.push('', b('Latest measured releases:'));
    for (const x of rx) lines.push(`• ${esc(x.event_type)} ${esc(localTime(x.event_date, tz))} · gold 1h ${esc(pct(x.ret_1h, 3))} · 4h ${esc(pct(x.ret_4h, 3))} · ${esc(x.gold_direction || 'n/a')} · USD ${esc(x.usd_reaction_direction || 'n/a')}${x.forecast_state ? ` · forecast was ${esc(x.forecast_state)}` : ' · no forecast stored'}`);
  }
  const p = perf || {};
  if (Number(p.evaluated || 0) > 0) {
    lines.push('', b('Performance (descriptive):'),
      `evaluated ${esc(p.evaluated)} · direction correct ${esc(p.directionally_correct)} / incorrect ${esc(p.directionally_incorrect)} · scenario correct ${esc(p.scenario_correct)} / incorrect ${esc(p.scenario_incorrect)}`,
      `avg |error| ${esc(p.average_forecast_error ?? 'n/a')} · avg confidence ${esc(p.average_confidence ?? 'n/a')} · calibration error ${esc(p.confidence_calibration_error ?? 'n/a')}`);
  }
  lines.push('', i('Weights are never changed automatically.'));
  return lines.join('\n');
}

/** 🤖 AI ANALYSIS: the latest stored analyses (AI or deterministic) — no new AI request. */
function formatAnalysis(rows, tz) {
  const r = rows || [];
  if (!r.length) return `🤖 ${b('AI ANALYSIS')}\nNo analyses stored yet.`;
  return [`🤖 ${b('AI ANALYSIS')} — latest stored analyses`, ...r.map((x) => [
    RULE,
    `${b(x.analysis_type)} · ${esc(localTime(x.created_at, tz))} · ${x.mode === 'AI' ? `AI ${esc(x.model || '')}` : `deterministic${x.fallback_reason ? ` (${esc(x.fallback_reason)})` : ''}`}`,
    x.subject ? b(x.subject) : null,
    esc(String(x.summary || 'n/a').slice(0, 700)),
    x.ai_disagreement ? `⚠️ ${b('AI VIEW DIFFERS:')} ${esc(String(x.disagreement_reason || '').slice(0, 300))}` : null,
  ].filter(Boolean).join('\n')), '', i('Shows stored results only; opening this view spends no AI request.')].join('\n');
}

module.exports = {
  MENU, MAIN_MENU_KEYBOARD, BACK_TO_MENU, formatMenu, formatNews, formatMarketState, formatBias, formatHistory,
  formatAlerts, formatReview, formatAnalysis,
};
