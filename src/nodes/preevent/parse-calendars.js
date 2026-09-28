'use strict';
// Parses official calendars + consensus into macro releases (window: -14d .. +21d) and
// reconciles cancelled / rescheduled official releases (only for successfully synced agencies).
const { releasesFromIcs, releasesFromFomcPage, mergeCalendar, reconcileCalendar } = require('../../lib/calendar');

const st = $('Load Calendar State').first().json;
const reqs = $('Plan Calendar Sync').all().map((i) => i.json);
const inputs = $input.all();
const synced = reqs.length > 0 && reqs[0].fetch === true;
const official = [];
let ff = [];
const health = [];
const agencies = new Set();
const AGENCY = { bls_ics: 'BLS', bea_ics: 'BEA', fomc_page: 'FED' };
if (synced) {
  inputs.forEach((resp, idx) => {
    const pair = resp.pairedItem && typeof resp.pairedItem.item === 'number' ? resp.pairedItem.item : idx;
    const req = reqs[pair] || {};
    const status = resp.json.statusCode;
    const body = resp.json.body !== undefined ? resp.json.body : resp.json.data;
    if (resp.json.error || status !== 200 || typeof body !== 'string') {
      health.push({ component: `calendar:${req.kind}`, status: 'DEGRADED', detail: resp.json.error ? String(resp.json.error.message || resp.json.error).slice(0, 200) : `HTTP ${status}`, metrics: null });
      return;
    }
    try {
      let parsed = [];
      if (req.kind === 'bls_ics') parsed = releasesFromIcs(body, 'BLS');
      else if (req.kind === 'bea_ics') parsed = releasesFromIcs(body, 'BEA');
      else if (req.kind === 'fomc_page') parsed = releasesFromFomcPage(body);
      else if (req.kind === 'ff_week') ff = JSON.parse(body);
      if (AGENCY[req.kind]) {
        if (!parsed.length) throw new Error('calendar parsed but empty');
        official.push(...parsed);
        agencies.add(AGENCY[req.kind]);
      }
      health.push({ component: `calendar:${req.kind}`, status: 'OK', detail: null, metrics: null });
    } catch (e) {
      health.push({ component: `calendar:${req.kind}`, status: 'DEGRADED', detail: e.message.slice(0, 200), metrics: null });
    }
  });
}
const nowIso = new Date().toISOString();
const now = Date.parse(nowIso);
const releases = synced ? mergeCalendar(official, ff).filter((r) => {
  const t = Date.parse(r.scheduled_at);
  return t >= now - 14 * 86400000 && t <= now + 21 * 86400000;
}) : [];
const rec = synced ? reconcileCalendar(st.scheduled || [], releases, agencies, nowIso) : { updates: [], notices: [] };
return [{
  json: {
    mode: st.mode, synced, releases, health, calendar_ok: health.filter((x) => x.status === 'OK').length,
    agencies_synced: Array.from(agencies), updates: rec.updates, notices: rec.notices,
  },
}];
