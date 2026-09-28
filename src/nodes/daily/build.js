'use strict';
// DAILY REPORT: deterministic synthesis + stored pre-event forecasts + AI request (one per day).
const { loadConfig, describeConfig } = require('../../lib/config');
const { buildUsageView } = require('../../lib/telegram-ai');
const { marketSnapshot, sourceQuality, agedSourceQuality } = require('../../lib/market');
const { computeDeskState } = require('../../lib/desk');
const { currentState } = require('../../lib/preevent');
const { dailyFacts, deterministicDaily } = require('../../lib/analyst');
const { EVENT_TYPES } = require('../../lib/calendar');

const cfg = loadConfig($env);
const ctx = $input.first().json;
const nowIso = new Date().toISOString();
const ser = (a) => (a || []).map((p) => ({ t: p.t, v: Number(p.v), src: p.src })).filter((p) => Number.isFinite(p.v));
const snap = marketSnapshot({
  GOLD: ser(ctx.gold), USD_PROXY: ser(ctx.usd), US2Y: ser(ctx.us2y), US10Y: ser(ctx.us10y), US10Y_REAL: ser(ctx.us10y_real),
  WTI: ser(ctx.wti), GOLD_COT_NONCOMM_NET: ser(ctx.cot),
}, nowIso);
// Latest stored desk state (with forecast layers); if none exists yet, compute it now from stored events.
const desk = ctx.desk && ctx.desk.desk ? ctx.desk.desk : computeDeskState(ctx.desk_events || [], snap, null, nowIso);
const label = (t) => (EVENT_TYPES[t] || {}).label || t;
const d = {
  as_of: nowIso,
  desk,
  layers: desk.layers || null,
  state: currentState(snap),
  topEvents: (ctx.top_events || []).map((e) => ({ id: e.id, title: e.title, category: e.category, subcategory: e.subcategory, importance_class: e.importance_class, importance_score: e.importance_score, net_pressure: e.net_pressure })),
  upcoming: (ctx.upcoming || []).map((u) => ({ ...u, label: label(u.event_type) })),
  forecasts: (ctx.forecasts || []).map((f) => ({ ...f, label: label(f.event_type) })),
};
const facts = dailyFacts(d);
facts.pre_event_forecasts = d.forecasts.map((f) => ({ event: f.label, time: f.scheduled_at, state: f.forecast_state, score: f.pre_event_score, confidence: f.confidence, evidence_quality: f.historical_evidence_quality }));
if (d.layers) facts.layers = { macro: d.layers.macro && d.layers.macro.primary, geopolitics: d.layers.geopolitics && d.layers.geopolitics.class, usd: d.layers.usd && d.layers.usd.class, yields: d.layers.yields && d.layers.yields.class };
const det = deterministicDaily(d);
const manual = ctx.mode === 'MANUAL';
// Optional 🤖 AI HEALTH section (AI_DAILY_REPORT_SECTION: auto | always | never). In auto mode it is
// shown only when the AI is configured and something happened (keeps the report short).
const aiView = buildUsageView(ctx.ai_usage, cfg, describeConfig(cfg), nowIso);
const aiActivity = aiView.system.requests_today > 0 || aiView.system.failures_today > 0 || aiView.system.fallback_events_today > 0
  || !['HEALTHY', 'UNKNOWN'].includes(aiView.quota.daily_state) || aiView.models.some((m) => !['HEALTHY', 'UNKNOWN'].includes(m.status));
const aiSection = cfg.ai.dailyReportSection === 'always' || (cfg.ai.dailyReportSection === 'auto' && cfg.secrets.openrouterConfigured && aiActivity) ? aiView : null;
return [{
  json: {
    payload: { requests: [{ ref: `daily:${nowIso.slice(0, 10)}`, purpose: 'DAILY', use_ai: true, is_test: false, facts, deterministic: det }] },
    report: d, mode: ctx.mode, manual, started_at: ctx.started_at, timezone: cfg.timezone, ai_section: aiSection,
    data_quality: desk.source_quality ? agedSourceQuality(desk.source_quality, desk.as_of, nowIso, cfg.schedule.marketIntervalMin) : sourceQuality(snap),
  },
}];
