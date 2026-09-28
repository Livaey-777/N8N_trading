#!/usr/bin/env node
'use strict';
/**
 * Executes the SQL of selected Postgres nodes from the built workflow files against the local
 * database inside a transaction that is always rolled back (catches SQL errors the structural
 * validator cannot see). Prints the top-level keys / row counts of each result.
 *
 *   node tools/check-sql.js
 */
const fs = require('fs');
const path = require('path');
const { withClient } = require('./db');
const { ROOT } = require('./env');

const CHECKS = [
  ['gold-intelligence-telegram-bot.json', 'Load Command Data', { event_ids: [], want_latest: true }],
  ['gold-intelligence-ai-analyst.json', 'Load AI State', { payload: { requests: [] }, fingerprints: ['none'] }],
  ['gold-intelligence-ai-analyst.json', 'Record AI Usage', {}],
  ['gold-intelligence-health.json', 'Collect Health', { mode: 'MANUAL' }],
  ['gold-intelligence-health.json', 'Record AI Health', {}],
  ['gold-intelligence-daily.json', 'Load Report Data', { mode: 'MANUAL' }],
  ['gold-intelligence-daily.json', 'Load Calibration Inputs', {}],
  ['gold-intelligence-daily.json', 'Store Calibration', { cells: [] }],
  // Error Handler: a replayed crash report of an already-recorded execution must not be recorded or alerted again.
  ['gold-intelligence-error-handler.json', 'Record Error', { error: { workflow_id: 'giTelegramBot001', workflow_name: 'GI · Telegram Bot (commands)', node_name: 'Get Updates', error_message: 'check-sql replay', execution_id: '496', severity: 'MEDIUM', mode: 'trigger' }, alertable: true, cooldown_min: 60 }],
  ['gold-intelligence-error-handler.json', 'Record Error', { error: { workflow_id: 'giTelegramBot001', workflow_name: 'GI · Telegram Bot (commands)', node_name: 'Get Updates', error_message: 'check-sql new', execution_id: 'check-sql-new', severity: 'MEDIUM', mode: 'trigger' }, alertable: true, cooldown_min: 60 }],
  ['gold-intelligence-pre-event.json', 'Persist Forecasts', { job: 'PRE_EVENT_CHECK', started_at: new Date().toISOString(), status: 'OK', forecasts: [{ macro_release_id: 6, kind: 'MANUAL', event_type: 'PCE', scheduled_at: new Date().toISOString(), historical: {}, market_context: {}, historical_bias: 'MIXED', pre_event_bias: 'NEUTRAL', confidence: 10, mode: 'DETERMINISTIC', final: {}, deterministic: {}, forecast_state: 'NEUTRAL', pre_event_score: 0, scenarios: [], ai_provider: 'openrouter', ai_fallback_level: 1, ai_tokens: 10, ai_latency_ms: 5, ai_status: 'AI' }], messages: [] }],
];

async function main() {
  let failed = 0;
  await withClient(async (c) => {
    for (const [file, nodeName, param] of CHECKS) {
      const wf = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', file), 'utf8'));
      const node = wf.nodes.find((n) => n.name === nodeName);
      if (!node) { console.log(`SKIP  ${file} :: ${nodeName} (node not found)`); continue; }
      const sql = node.parameters.query.replace(/^=/, '');
      await c.query('BEGIN');
      try {
        const r = await c.query(sql, sql.includes('$1') ? [JSON.stringify(param)] : []);
        const row = r.rows[0] || {};
        const keys = Object.keys(row).map((k) => {
          const v = row[k];
          return Array.isArray(v) ? `${k}[${v.length}]` : v && typeof v === 'object' ? `${k}{${Object.keys(v).length}}` : `${k}=${v === null ? 'null' : String(v).slice(0, 24)}`;
        });
        console.log(`OK    ${file} :: ${nodeName} -> ${r.rows.length} row(s): ${keys.join(', ').slice(0, 600)}`);
      } catch (e) {
        failed++;
        console.log(`FAIL  ${file} :: ${nodeName}: ${e.message}`);
      } finally {
        await c.query('ROLLBACK');
      }
    }
  });
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
