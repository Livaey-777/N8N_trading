'use strict';
// Alert decision with cooldown. Uses the DB decision when the DB is reachable; falls back
// to workflow static data when the database itself is the failure.
const { loadConfig } = require('../../lib/config');

const cfg = loadConfig($env);
const cls = $('Classify Error').first().json;
const r = $input.first().json || {};
const sd = $getWorkflowStaticData('global');
const dbOk = typeof r.send === 'boolean' && !r.error;
let send;
if (dbOk) send = r.send;
else {
  const last = sd.lastTechAlert ? Date.parse(sd.lastTechAlert) : 0;
  send = (Date.now() - last) / 60000 >= cfg.schedule.techAlertCooldownMin;
}
if (cls.error.severity === 'LOW') send = false; // transient bot polling glitches: logged only
if (!cfg.secrets.telegramConfigured) send = false;
if (send) sd.lastTechAlert = new Date().toISOString();
return [{ json: { send, error: cls.error, db_recorded: dbOk, telegram: cfg.secrets.telegramConfigured ? 'CONFIGURED' : 'NOT CONFIGURED' } }];
