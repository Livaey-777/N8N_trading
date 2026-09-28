'use strict';
// Prepares forecast persistence (forecast memory), sent flags and job stats.
const comp = $('Compose Pre-Event Messages').first().json;
const eng = $('Forecast Engine').first().json;
const cal = $('Parse Calendars').first().json;
const tg = $input.first().json;
const sent = new Set((tg.results || []).filter((r) => r.status === 'SENT').map((r) => r.related_ref));
return [{
  json: {
    record: {
      forecasts: comp.forecasts.map((f) => ({ ...f, sent: sent.has(`release:${f.macro_release_id}`) })),
      job: `PRE_EVENT_${eng.mode}`,
      started_at: $('Load Calendar State').first().json.started_at,
      execution_id: $execution.id,
      health: cal.health,
      status: cal.health.some((h) => h.status === 'DEGRADED') ? 'DEGRADED' : 'OK',
      stats: {
        mode: eng.mode, calendar_synced: cal.synced, releases_parsed: (cal.releases || []).length, calendar_updates: (cal.updates || []).length,
        due: eng.due_count, forecasts: comp.forecasts.length, states: comp.forecasts.map((f) => `${f.event_type}:${f.forecast_state}:${f.pre_event_score}`),
        telegram: { sent: tg.sent, failed: tg.failed, skipped: tg.skipped_duplicates, not_configured: tg.not_configured, status: tg.telegram },
        context: eng.context, data_quality: eng.data_quality,
      },
    },
  },
}];
