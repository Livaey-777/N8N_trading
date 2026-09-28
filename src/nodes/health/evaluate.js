'use strict';
// HEALTH: component statuses (the AI component comes from the AI Health Check node), overall
// state, and a technical alert on degradation (with cooldown).
const { loadConfig, describeConfig } = require('../../lib/config');
const { formatStatus } = require('../../lib/telegram');

const cfg = loadConfig($env);
const h = $('Collect Health').first().json;
const now = Date.now();
const minsSince = (iso) => (iso ? (now - Date.parse(iso)) / 60000 : Infinity);
const jobs = h.jobs || {};
const comps = [];
const add = (component, status, detail, metrics) => comps.push({ component, status, detail: detail || null, metrics: metrics || null });

add('DATABASE', 'OK', `${Math.round(Number(h.db_bytes || 0) / 1048576)} MB`);
const jobCheck = (name, job, maxMin, critical, neverText) => {
  const j = jobs[job];
  if (!j) return add(name, 'UNKNOWN', neverText || 'never ran (activate the workflow)');
  const age = minsSince(j.finished_at || j.started_at);
  if (age > maxMin * 4 && critical) return add(name, 'DOWN', `last ${job} run ${Math.round(age)} min ago`);
  if (age > maxMin) return add(name, 'DEGRADED', `last ${job} run ${Math.round(age)} min ago`);
  return add(name, j.status === 'OK' ? 'OK' : 'DEGRADED', `last run ${Math.round(age)} min ago (${j.status})`);
};
jobCheck('NEWS_PIPELINE', 'NEWS', cfg.schedule.newsIntervalMin * 3, true);
jobCheck('MARKET_PIPELINE', 'MARKET', cfg.schedule.marketIntervalMin * 3, true);
// Daily jobs: before their first scheduled hour there is simply no run yet (not a fault).
const daily = (hour) => `no scheduled run yet — runs daily at ${String(hour).padStart(2, '0')}:00 (${cfg.timezone})`;
jobCheck('PRE_EVENT', 'PRE_EVENT_DAILY', 26 * 60, false, daily(cfg.schedule.preEventDailyHour));
jobCheck('DAILY_REPORT', 'DAILY_SCHEDULED', 26 * 60, false, daily(cfg.schedule.dailyReportHour));
jobCheck('POST_EVENT', 'POST_EVENT_AUTO', cfg.schedule.postEventIntervalMin * 4, false);

// Gold spot freshness (gold trades ~23h/day Sun 22:00 - Fri 21:00 UTC).
const d = new Date();
const weekendClosed = (d.getUTCDay() === 6) || (d.getUTCDay() === 5 && d.getUTCHours() >= 21) || (d.getUTCDay() === 0 && d.getUTCHours() < 22);
const goldAge = minsSince(h.last_gold_fetch);
if (goldAge === Infinity) add('MARKET_DATA', 'UNKNOWN', 'no gold observation yet');
else if (goldAge > cfg.schedule.marketIntervalMin * 4) add('MARKET_DATA', 'DEGRADED', `gold last fetched ${Math.round(goldAge)} min ago`);
else add('MARKET_DATA', 'OK', weekendClosed ? 'gold market closed (weekend) — last price is Friday close' : `gold fetched ${Math.round(goldAge)} min ago`);

const src = h.sources || [];
const failing = src.filter((s) => s.consecutive_failures >= 3);
add('NEWS_SOURCES', failing.length > src.length * 0.3 ? 'DEGRADED' : 'OK', `${src.length - failing.length}/${src.length} sources healthy${failing.length ? `; failing: ${failing.map((s) => s.id).slice(0, 5).join(', ')}` : ''}`);

// AI component from the AI Health Check node (model list, key counter, probes, quota).
const aiCheck = $('AI Health Check').first().json;
const modelsCheck = aiCheck.models_check;
if (aiCheck.ai_component) comps.push({ metrics: null, ...aiCheck.ai_component });

const tg = h.tg_24h || {};
if (!cfg.secrets.telegramConfigured) add('TELEGRAM', 'NOT_CONFIGURED', 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set');
else if (tg.failed > 0 && (!tg.last_sent || minsSince(tg.last_sent) > 360)) add('TELEGRAM', 'DEGRADED', `${tg.failed} failed sends (24h)`);
else add('TELEGRAM', 'OK', `${tg.sent || 0} sent (24h)`);

add('ERRORS', Number(h.errors_1h) > 0 ? 'DEGRADED' : 'OK', `${h.errors_1h} workflow errors in the last hour`);
add('HISTORICAL_DB', Number(h.hist_rows) >= 100 ? 'OK' : 'DEGRADED', `${h.hist_rows} reaction rows`);

const critical = ['DATABASE', 'NEWS_PIPELINE', 'MARKET_PIPELINE'];
const overall = comps.some((c) => c.status === 'DOWN' && critical.includes(c.component)) ? 'DOWN'
  : comps.some((c) => c.status === 'DEGRADED' || c.status === 'DOWN') ? 'DEGRADED' : 'OK';
const prev = (h.health_state && h.health_state.overall) || 'UNKNOWN';
const lastAlert = h.health_state && h.health_state.last_alert_at;
const cooled = minsSince(lastAlert) >= cfg.schedule.techAlertCooldownMin;
// Manual checks never alert.
const manualRun = $('Collect Health').first().json.mode === 'MANUAL';
// On a state change (after cooldown); while it persists, only a reminder every 6 cooldown periods.
const reminderDue = minsSince(lastAlert) >= 6 * cfg.schedule.techAlertCooldownMin;
const send = overall !== 'OK' && cfg.secrets.telegramConfigured && !manualRun && (overall !== prev ? cooled : reminderDue);
const statusView = { checked_at: new Date().toISOString(), overall, components: comps, ai_used_today: h.ai_used_today };
const text = `⚠️ <b>HEALTH ${overall}</b> (was ${prev})\n${formatStatus(statusView, describeConfig(cfg), cfg.timezone)}`;
return [{
  json: {
    record: {
      components: comps, overall,
      health_state: { overall, previous: prev, at: new Date().toISOString(), last_alert_at: send ? new Date().toISOString() : (lastAlert || null) },
      models_check: modelsCheck,
    },
    send,
    payload: { messages: send ? [{ text, message_type: 'TECH_ALERT', dedup_key: `health:${overall}`, dedup_window_min: cfg.schedule.techAlertCooldownMin, related_ref: 'health', is_test: false }] : [] },
  },
}];
