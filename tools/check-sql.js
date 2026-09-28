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
  // The seed row is written in the same rolled-back transaction, so the check does not depend on this database's history.
  ['gold-intelligence-error-handler.json', 'Record Error', { error: { workflow_id: 'giTelegramBot001', workflow_name: 'GI · Telegram Bot (commands)', node_name: 'Get Updates', error_message: 'check-sql replay', execution_id: 'check-sql-replay', severity: 'MEDIUM', mode: 'trigger' }, alertable: true, cooldown_min: 60 },
    { setup: "INSERT INTO error_events (workflow_id, execution_id, severity, error_message) VALUES ('giTelegramBot001', 'check-sql-replay', 'MEDIUM', 'check-sql seed') RETURNING id", expect: { duplicate: true, send: false, error_id: null } }],
  ['gold-intelligence-error-handler.json', 'Record Error', { error: { workflow_id: 'giTelegramBot001', workflow_name: 'GI · Telegram Bot (commands)', node_name: 'Get Updates', error_message: 'check-sql new', execution_id: 'check-sql-new', severity: 'MEDIUM', mode: 'trigger' }, alertable: true, cooldown_min: 60 },
    { expect: { duplicate: false } }],
  ['gold-intelligence-pre-event.json', 'Persist Forecasts', (release) => ({ job: 'PRE_EVENT_CHECK', started_at: new Date().toISOString(), status: 'OK', forecasts: [{ macro_release_id: release.id, kind: 'MANUAL', event_type: 'PCE', scheduled_at: new Date().toISOString(), historical: {}, market_context: {}, historical_bias: 'MIXED', pre_event_bias: 'NEUTRAL', confidence: 10, mode: 'DETERMINISTIC', final: {}, deterministic: {}, forecast_state: 'NEUTRAL', pre_event_score: 0, scenarios: [], ai_provider: 'openrouter', ai_fallback_level: 1, ai_tokens: 10, ai_latency_ms: 5, ai_status: 'AI' }], messages: [] }),
    { setup: "INSERT INTO macro_releases (release_key, event_type, title, scheduled_at, source, is_test) VALUES ('CHECK-SQL:fixture', 'PCE', 'check-sql fixture', now() + interval '1 day', 'check-sql', true) RETURNING id" }],
];

async function main() {
  let failed = 0;
  await withClient(async (c) => {
    for (const [file, nodeName, paramOrFn, opts = {}] of CHECKS) {
      const wf = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', file), 'utf8'));
      const node = wf.nodes.find((n) => n.name === nodeName);
      if (!node) { console.log(`SKIP  ${file} :: ${nodeName} (node not found)`); continue; }
      const sql = node.parameters.query.replace(/^=/, '');
      await c.query('BEGIN');
      try {
        const seed = opts.setup ? (await c.query(opts.setup)).rows[0] : null;
        const param = typeof paramOrFn === 'function' ? paramOrFn(seed) : paramOrFn;
        const r = await c.query(sql, sql.includes('$1') ? [JSON.stringify(param)] : []);
        const row = r.rows[0] || {};
        const wrong = Object.entries(opts.expect || {}).filter(([k, v]) => row[k] !== v).map(([k, v]) => `${k}=${row[k]} (expected ${v})`);
        if (wrong.length) throw new Error(`unexpected result: ${wrong.join(', ')}`);
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
