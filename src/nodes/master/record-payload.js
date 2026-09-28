'use strict';
// STORAGE: prepares the final write (analysis results, alert bookkeeping, job run stats).
const cc = $('Classify, Score & Cluster').first().json;
const comp = $('Compose Alerts').first().json;
const tg = $input.first().json;
const gw = $('AI Gateway').first().json;
const ai = $('AI Analyst').first().json;
const idByKey = Object.fromEntries((gw.candidates || []).map((c) => [c.event_key, c.id]));
// SENT, already-delivered duplicates and NOT_CONFIGURED count as handled (no re-alert on every new report);
// FAILED deliveries are retried on the next run.
const sentRefs = new Set((tg.results || []).filter((r) => ['SENT', 'SKIPPED_DUPLICATE', 'NOT_CONFIGURED'].includes(r.status)).map((r) => r.related_ref));
const eventUpdates = (cc.events || [])
  .filter((e) => idByKey[e.event_key])
  .map((e) => ({ event_id: idByKey[e.event_key], alerted: sentRefs.has(`event:${idByKey[e.event_key]}`), signature: e.signature }));
const aiModes = (ai.results || []).reduce((acc, r) => { acc[r.mode] = (acc[r.mode] || 0) + 1; return acc; }, {});
return [{
  json: {
    record: {
      job: cc.run.job || 'NEWS', started_at: cc.run.started_at, status: 'OK', execution_id: $execution.id, is_test: Boolean(cc.run.is_test),
      stats: { ...cc.stats, ai_modes: aiModes, ai_gateway: gw.gateway, telegram: { sent: tg.sent, failed: tg.failed, skipped_duplicates: tg.skipped_duplicates, not_configured: tg.not_configured, status: tg.telegram } },
      analyses: comp.analyses,
      event_updates: eventUpdates,
    },
  },
}];
