'use strict';
/**
 * Builds deploy/n8n-final/: the 9 workflows under their package names (byte-identical copies of
 * workflows/*.json), .env.example, and PACKAGE_MANIFEST.txt (checksums, triggers, references,
 * credentials, dependency order). The Markdown documents and verify-package.sh are maintained by hand.
 *
 *   node tools/build-workflows.js && node tools/package-final.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT } = require('./env');

const PKG = path.join(ROOT, 'deploy', 'n8n-final');
// Package name → source file. Numbers are names, not the import order (see IMPORT_ORDER.md).
const FILES = [
  ['01-master-pipeline.json', 'gold-intelligence-master.json'],
  ['02-ai-analyst.json', 'gold-intelligence-ai-analyst.json'],
  ['03-telegram-sender.json', 'gold-intelligence-telegram-sender.json'],
  ['04-pre-event.json', 'gold-intelligence-pre-event.json'],
  ['05-post-event.json', 'gold-intelligence-post-event.json'],
  ['06-daily-report.json', 'gold-intelligence-daily.json'],
  ['07-telegram-bot.json', 'gold-intelligence-telegram-bot.json'],
  ['08-health-monitor.json', 'gold-intelligence-health.json'],
  ['09-error-handler.json', 'gold-intelligence-error-handler.json'],
];
// Dependencies first: error workflow, called sub-workflows, monitoring, data jobs, then the user-facing bot.
const IMPORT_ORDER = ['09-error-handler.json', '03-telegram-sender.json', '02-ai-analyst.json', '08-health-monitor.json',
  '01-master-pipeline.json', '04-pre-event.json', '05-post-event.json', '06-daily-report.json', '07-telegram-bot.json'];
const DOCS = ['CREDENTIALS.md', '.env.example', 'DATABASE.md', 'IMPORT_ORDER.md', 'VERIFICATION.md', 'ROLLBACK.md', 'verify-package.sh'];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const short = (t) => t.split('.').pop();

function describe(wf) {
  const triggers = wf.nodes.filter((n) => /(Trigger)$/.test(short(n.type))).map((n) => {
    const iv = n.parameters && n.parameters.rule && n.parameters.rule.interval && n.parameters.rule.interval[0];
    if (!iv) return `${short(n.type)} "${n.name}"`;
    const every = iv.field === 'days' ? `daily at ${String(iv.triggerAtHour).replace(/.*\|\| (\d+).*/, '$1').padStart(2, '0')}:00 (${String(iv.triggerAtHour).replace(/.*\$env\.(\w+).*/, '$1')})`
      : `every ${String(iv[`${iv.field}Interval`]).replace(/.*\|\| (\d+).*/, '$1')} ${iv.field} (${String(iv[`${iv.field}Interval`]).replace(/.*\$env\.(\w+).*/, '$1')})`;
    return `schedule "${n.name}": ${every}`;
  });
  const calls = [...new Set(wf.nodes.filter((n) => short(n.type) === 'executeWorkflow').map((n) => n.parameters.workflowId.value))];
  const creds = [...new Set(wf.nodes.flatMap((n) => Object.entries(n.credentials || {}).map(([t, c]) => `${c.id} (${c.name}, ${t})`)))];
  return { triggers, calls, creds, scheduled: wf.nodes.some((n) => short(n.type) === 'scheduleTrigger') };
}

function main() {
  fs.mkdirSync(path.join(PKG, 'workflows'), { recursive: true });
  for (const [name, src] of FILES) fs.copyFileSync(path.join(ROOT, 'workflows', src), path.join(PKG, 'workflows', name));
  fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(PKG, '.env.example'));
  const byName = Object.fromEntries(FILES.map(([name]) => [name, JSON.parse(fs.readFileSync(path.join(PKG, 'workflows', name), 'utf8'))]));
  const idToName = Object.fromEntries(Object.entries(byName).map(([n, w]) => [w.id, n]));

  const L = [];
  L.push('GOLD INTELLIGENCE — n8n FINAL IMPORT PACKAGE');
  L.push('Target: self-hosted n8n 1.117.2 (Docker or npm) + PostgreSQL 16. Not n8n Cloud (see IMPORT_ORDER.md).');
  L.push(`Built: ${new Date().toISOString()} by tools/package-final.js from workflows/*.json (byte-identical copies).`);
  L.push('Secrets: none. Every secret is a placeholder in .env.example / CREDENTIALS.md.');
  L.push('');
  L.push('RELEASE GATE — the package may be imported for production only when all three pass on the RUNNING instance');
  L.push('(node tools/verify-live.js on the local pilot, or sh deploy/n8n-web/verify.sh on the server):');
  L.push('  1. first scheduled PRE_EVENT run    : PENDING');
  L.push('  2. first scheduled DAILY_REPORT run : PENDING');
  L.push('  3. AI fallback health (3 models)    : PENDING');
  L.push('Record the verify-live SUMMARY in VERIFICATION.md when they pass.');
  L.push('');
  L.push('WORKFLOWS (package file · workflow id · name · nodes)');
  for (const [name] of FILES) {
    const w = byName[name];
    const d = describe(w);
    L.push(`  ${name.padEnd(26)} ${w.id.padEnd(17)} ${w.name} · ${w.nodes.length} nodes`);
    L.push(`      triggers: ${d.triggers.join('; ')}`);
    L.push(`      activate after import: ${d.scheduled ? 'YES (scheduled)' : 'NO (called / error workflow)'}`);
    L.push(`      calls: ${d.calls.length ? d.calls.map((id) => `${id} → ${idToName[id] || 'MISSING'}`).join(', ') : 'none'}`);
    L.push(`      error workflow: ${w.settings.errorWorkflow ? `${w.settings.errorWorkflow} → ${idToName[w.settings.errorWorkflow] || 'MISSING'}` : 'none (this is the error workflow)'}`);
    L.push(`      credentials: ${d.creds.join(', ') || 'none'} · timezone ${w.settings.timezone}`);
  }
  L.push('');
  L.push('IMPORT ORDER (dependencies first)');
  IMPORT_ORDER.forEach((n, k) => L.push(`  ${k + 1}. ${n}  (${byName[n].id})`));
  L.push('');
  L.push('FILES (sha256 · bytes · path) — checked by verify-package.sh');
  const listed = [...DOCS.filter((f) => fs.existsSync(path.join(PKG, f))), ...FILES.map(([n]) => `workflows/${n}`)];
  for (const f of listed) {
    const buf = fs.readFileSync(path.join(PKG, f));
    L.push(`${sha(buf)}  ${buf.length}  ${f}`);
  }
  fs.writeFileSync(path.join(PKG, 'PACKAGE_MANIFEST.txt'), `${L.join('\n')}\n`);
  console.log(`package: ${path.relative(ROOT, PKG)} · ${FILES.length} workflows · ${listed.length} files in the manifest`);
}

main();
