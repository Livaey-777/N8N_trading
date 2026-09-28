'use strict';
// ERROR WORKFLOW: normalise the failed execution (workflow, node, error, execution id,
// severity) and strip any secret from the message before it is stored or sent.
const { loadConfig, secretsFrom } = require('../../lib/config');
const { redact } = require('../../lib/util');

const cfg = loadConfig($env);
const secrets = secretsFrom($env);
const e = $input.first().json;
const wf = e.workflow || {};
const ex = e.execution || {};
const err = ex.error || {};
const message = redact(String(err.message || err.description || 'unknown error'), secrets.list()).slice(0, 800);
const node = ex.lastNodeExecuted || (err.node && err.node.name) || null;
let severity = 'MEDIUM';
if (/ECONNREFUSED|database|postgres|connection terminated|password authentication|too many clients/i.test(message)) severity = 'CRITICAL';
else if (/Master Pipeline|Pre-Event/i.test(wf.name || '')) severity = 'HIGH';
else if (/Telegram Bot/i.test(wf.name || '') && /network error|ETIMEDOUT|ECONNRESET|socket hang up|HTTP 5\d\d/i.test(message)) severity = 'LOW';
return [{
  json: {
    error: {
      workflow_id: wf.id || null, workflow_name: wf.name || 'unknown', node_name: node, error_message: message,
      error_type: err.name || (err.node ? 'NodeError' : 'Error'), execution_id: ex.id ? String(ex.id) : null,
      execution_url: ex.url || null, severity, mode: ex.mode || null, occurred_at: new Date().toISOString(),
    },
    cooldown_min: cfg.schedule.techAlertCooldownMin,
    // Only errors that would actually be sent may start the alert cooldown.
    alertable: severity !== 'LOW' && cfg.secrets.telegramConfigured,
  },
}];
