'use strict';
/**
 * Checks an n8n instance against this package, from n8n's own exports (no database access, no network):
 *   n8n export:workflow --all --output=<workflows.json>
 *   n8n export:credentials --all --output=<credentials.json>      (encrypted; only id / name / type are read)
 *
 *   node check-import.js --phase=pre  --credentials=<file>
 *   node check-import.js --phase=post --workflows=<file> --credentials=<file> [--package=<dir>]
 *
 * pre  : the shared PostgreSQL credential exists (id GIpostgresCred01, or exactly one "GI Postgres" of type
 *        postgres, which n8n's import re-links by name).
 * post : the 9 fixed workflow ids; nodes, Code, SQL and connections identical to the package; every sub-workflow
 *        call and error-workflow link resolves; every Postgres node uses one existing credential; exactly the 6
 *        scheduled workflows active; schedules and timezone kept; no other active "GI ·" copy (duplicate output).
 * Exit code 0 when every check passes. Prints no secret (credential data is never read).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const PKG = args.package || __dirname;
const FILES = {
  giMasterPipeline: '01-master-pipeline.json', giAiAnalystSub01: '02-ai-analyst.json', giTelegramSend01: '03-telegram-sender.json',
  giPreEventEngine: '04-pre-event.json', giPostEventRevw1: '05-post-event.json', giDailyReport001: '06-daily-report.json',
  giTelegramBot001: '07-telegram-bot.json', giHealthMonitor1: '08-health-monitor.json', giErrorHandler01: '09-error-handler.json',
};
const ACTIVE = ['giHealthMonitor1', 'giMasterPipeline', 'giPreEventEngine', 'giPostEventRevw1', 'giDailyReport001', 'giTelegramBot001'];
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`); if (!ok) failed++; };
const load = (f) => {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  return Array.isArray(j) ? j : [j];
};

function credentialCheck(creds) {
  const pg = creds.filter((c) => c.type === 'postgres');
  const fixed = pg.find((c) => c.id === 'GIpostgresCred01');
  const named = pg.filter((c) => c.name === 'GI Postgres');
  const ok = Boolean(fixed) || named.length === 1;
  const why = named.length > 1 ? `${named.length} credentials are named "GI Postgres" — keep exactly one`
    : 'no PostgreSQL credential named "GI Postgres" — create it first (CREDENTIAL_SETUP.md step 1)';
  check('shared PostgreSQL credential "GI Postgres" exists (created once, used by all 9 workflows)', ok, why);
  return fixed || named[0] || null;
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
const shape = (w) => JSON.stringify({
  nodes: w.nodes.map((n) => ({ name: n.name, type: n.type, typeVersion: n.typeVersion, code: n.parameters && n.parameters.jsCode ? sha(n.parameters.jsCode) : null,
    query: n.parameters && n.parameters.query ? sha(n.parameters.query) : null, rule: n.parameters && n.parameters.rule ? n.parameters.rule : null,
    workflowId: n.parameters && n.parameters.workflowId ? n.parameters.workflowId.value : null })).sort((a, b) => a.name.localeCompare(b.name)),
  connections: w.connections,
});

function postCheck(wfs, creds) {
  const byId = Object.fromEntries(wfs.map((w) => [w.id, w]));
  const missing = Object.keys(FILES).filter((id) => !byId[id]);
  check('all 9 workflows present with their fixed ids', !missing.length, `missing: ${missing.join(', ')}`);
  const diff = [];
  for (const [id, file] of Object.entries(FILES)) {
    const f = path.join(PKG, 'workflows', file);
    if (!byId[id] || !fs.existsSync(f)) continue;
    if (shape(byId[id]) !== shape(JSON.parse(fs.readFileSync(f, 'utf8')))) diff.push(file);
  }
  check('nodes, Code, SQL, schedules and connections identical to the package', !diff.length, `differs: ${diff.join(', ')}`);
  const refs = [];
  for (const id of Object.keys(FILES)) {
    const w = byId[id];
    if (!w) continue;
    for (const n of w.nodes) if (n.type.endsWith('.executeWorkflow') && !byId[n.parameters.workflowId.value]) refs.push(`${id}: ${n.name} → ${n.parameters.workflowId.value}`);
    const ew = (w.settings || {}).errorWorkflow;
    if (id !== 'giErrorHandler01' && ew !== 'giErrorHandler01') refs.push(`${id}: error workflow ${ew || 'missing'}`);
  }
  check('every sub-workflow call (12) and error-workflow link (8) resolves', !refs.length, refs.join('; '));
  const credIds = new Set(creds.filter((c) => c.type === 'postgres').map((c) => c.id));
  const used = new Set();
  const bad = [];
  for (const id of Object.keys(FILES)) {
    for (const n of (byId[id] ? byId[id].nodes : [])) {
      if (!n.type.endsWith('.postgres')) continue;
      const c = n.credentials && n.credentials.postgres;
      if (!c || !credIds.has(c.id)) bad.push(`${id}: ${n.name}`);
      else used.add(c.id);
    }
  }
  check('every PostgreSQL node (27) linked to an existing credential', !bad.length, bad.slice(0, 5).join('; '));
  check('all PostgreSQL nodes share ONE credential (configured once)', used.size === 1, `${used.size} different credentials in use`);
  const active = Object.keys(FILES).filter((id) => byId[id] && byId[id].active);
  const wrong = [...ACTIVE.filter((id) => !active.includes(id)).map((id) => `${id} inactive`), ...active.filter((id) => !ACTIVE.includes(id)).map((id) => `${id} active`)];
  check('exactly the 6 scheduled workflows are active (AI Analyst, Telegram Sender, Error Handler stay inactive)', !wrong.length, wrong.join('; '));
  const sched = ACTIVE.filter((id) => byId[id] && !byId[id].nodes.some((n) => n.type.endsWith('.scheduleTrigger')));
  const tz = Object.keys(FILES).filter((id) => byId[id] && (byId[id].settings || {}).timezone !== 'Africa/Casablanca');
  check('schedule triggers kept, timezone Africa/Casablanca', !sched.length && !tz.length, [...sched, ...tz].join(', '));
  const dup = wfs.filter((w) => !FILES[w.id] && w.active && /^GI · /.test(w.name || ''));
  check('no other active "GI ·" workflow (would duplicate alerts / reports)', !dup.length, dup.map((w) => `${w.id} "${w.name}"`).join('; '));
}

const creds = args.credentials && fs.existsSync(args.credentials) ? load(args.credentials) : [];
if (args.phase === 'pre') credentialCheck(creds);
else if (args.phase === 'post') { credentialCheck(creds); postCheck(load(args.workflows), creds); }
else { console.error('usage: node check-import.js --phase=pre|post --credentials=<file> [--workflows=<file>] [--package=<dir>]'); process.exit(2); }
console.log(failed ? `IMPORT CHECK (${args.phase}): FAILED (${failed})` : `IMPORT CHECK (${args.phase}): PASSED`);
process.exit(failed ? 1 : 0);
