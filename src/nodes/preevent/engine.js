'use strict';
// FORECAST & CONDITIONAL SCENARIO ENGINE: current state + historical analogues + regime
// -> pre_event_score / confidence / state + conditional scenarios. Never the outcome.
// REFRESH mode re-computes stored forecasts and flags material updates / invalidations.
const { loadConfig } = require('../../lib/config');
const { marketSnapshot, sourceQuality } = require('../../lib/market');
const { trendState } = require('../../lib/history');
const { marketRegime } = require('../../lib/reactions');
const { buildForecast, compareForecasts, snapshotOf } = require('../../lib/forecast');
const { forecastFacts, deterministicForecast } = require('../../lib/analyst');

const cfg = loadConfig($env);
const ctx = $input.first().json;
const cal = $('Parse Calendars').first().json;
const nowIso = new Date().toISOString();
const ser = (a) => (a || []).map((p) => ({ t: p.t, v: Number(p.v), src: p.src })).filter((p) => Number.isFinite(p.v));
const snap = marketSnapshot({
  GOLD: ser(ctx.gold), USD_PROXY: ser(ctx.usd), US2Y: ser(ctx.us2y), US10Y: ser(ctx.us10y), US30Y: ser(ctx.us30y),
  US10Y_REAL: ser(ctx.us10y_real), WTI: ser(ctx.wti), GOLD_COT_NONCOMM_NET: ser(ctx.cot),
}, nowIso);
const desk = ctx.desk && ctx.desk.desk ? ctx.desk.desk : null;
const inst = snap.instruments;
const ch = (k, h) => (inst[k] && inst[k].available && inst[k].changes ? inst[k].changes[h] : null);
// Same definitions as the historical backfill, so current context is comparable with history.
const context = {
  pre_gold_trend: trendState(ch('GOLD', '5d'), 1.0),
  pre_usd_trend: trendState(ch('USD_PROXY', '5d'), 0.5),
  pre_10y_trend: trendState(ch('US10Y', '5d'), 8),
  regime: marketRegime(ch('US10Y_REAL', '20d'), ch('USD_PROXY', '20d')),
};
const dailyGold = ser(ctx.gold).filter((p, i, a) => i === a.length - 1 || String(p.t).slice(0, 10) !== String(a[i + 1].t).slice(0, 10));
const events = (ctx.events || []).map((e) => ({ ...e, transmission: e.transmission || [] }));
const history = ctx.history || [];
const cpiRows = ctx.cpi_rows || [];
const nfpRows = ctx.nfp_rows || [];
const us2yLong = ser(ctx.us2y_long);
const active = Object.fromEntries((ctx.active_forecasts || []).map((f) => [String(f.macro_release_id), f]));
// A failed re-sync this run is tolerated when the calendar was verified (>=2 official sources OK)
// within the last 24h: data quality drops to PARTIAL with the reason, instead of UNDETERMINED.
const syncedNow = !cal.synced || (cal.calendar_ok || 0) >= 2;
const cal24 = ctx.calendar_24h || {};
const verifiedRecently = (cal24.sources_ok || 0) >= 2;
const calendarOk = syncedNow || verifiedRecently;
const calendarNote = !syncedNow && verifiedRecently
  ? `calendar re-sync failed this run (last verified ${Math.max(1, Math.round((Date.now() - Date.parse(cal24.last_ok)) / 3600000))}h ago)` : null;
const histSource = history.some((r) => /dukascopy/i.test(JSON.stringify(r.data_source || ''))) ? 'DIRECT (Dukascopy spot) where available'
  : 'PROXY (PAXG/USDT gold + inverted EUR/USDT USD, 1-minute; Dukascopy spot unavailable from this host)';

const items = [];
let aiSlots = ctx.mode === 'REFRESH' ? 1 : 2;
for (const r of ctx.due || []) {
  const rows = history.filter((h) => h.event_type === r.event_type);
  const recentUsd = rows.slice().sort((a, b) => String(b.event_date).localeCompare(String(a.event_date))).slice(0, 3)
    .map((h) => ({ date: h.event_date, usd_dir: h.usd_reaction_direction, gold_direction: h.gold_direction }));
  const fc = buildForecast({
    release: r, snap, desk, events, historyRows: rows, cpiRows, nfpRows, us2ySeries: us2yLong, dailyGold,
    recentUsdReactions: recentUsd, calendarOk, calendarNote, cfg: { minSample: cfg.thresholds.histMinSample }, nowIso, context,
  });
  const prev = active[String(r.id)] || null;
  let kind = ctx.mode === 'MANUAL' ? 'MANUAL' : ctx.mode === 'REFRESH' ? 'REFRESH' : 'DAILY';
  let cmp = null;
  let send = true;
  if (ctx.mode === 'REFRESH') {
    const leadDue = (Date.parse(r.scheduled_at) - Date.now()) / 60000 <= (Number($env.GI_PREEVENT_REFRESH_LEAD_MIN) || 90) && !r.refresh_sent_at;
    if (prev) {
      cmp = compareForecasts({ ...prev, consensus: prev.snapshot && prev.snapshot.consensus !== 'NOT AVAILABLE' ? prev.snapshot.consensus : null }, fc);
      if (cmp.material) kind = 'UPDATE';
      send = cmp.material || leadDue;
    } else {
      send = leadDue;
    }
    if (!send) continue;
  }
  const facts = forecastFacts(fc, desk);
  const det = deterministicForecast(fc);
  const useAi = aiSlots > 0 && r.impact === 'HIGH' && (kind !== 'REFRESH');
  if (useAi) aiSlots--;
  items.push({
    release: r, fc, kind, cmp, prev,
    snapshot: snapshotOf(fc),
    dataQuality: (() => {
      const base = sourceQuality(snap, { reasons: fc.data_quality.reasons, historySource: histSource });
      const rank = { GOOD: 0, PARTIAL: 1, DEGRADED: 2, CRITICAL: 3 };
      const worst = [base.level, fc.data_quality.level, base.reasons.some((r) => !/oil NOT AVAILABLE/.test(r)) ? 'PARTIAL' : 'GOOD'].sort((a, x) => rank[x] - rank[a])[0];
      return { ...base, level: worst };
    })(),
    request: { ref: r.release_key, purpose: 'PRE_EVENT', use_ai: useAi, is_test: false, facts, deterministic: det },
  });
}
return [{
  json: {
    payload: { requests: items.map((x) => x.request) },
    items: items.map(({ request, ...rest }) => rest),
    mode: ctx.mode, context, data_quality: snap.data_quality, due_count: (ctx.due || []).length, selected: items.length,
    notices: cal.notices || [],
  },
}];
