'use strict';
/**
 * Static audit of the n8n import package (no network, no database, writes nothing).
 *   node verify-package.js      (or: sh verify-package.sh)   → exit 0 when every check passes
 * Checks:
 *   files + checksums against PACKAGE_MANIFEST.txt;
 *   workflow ids, connections, sub-workflow and error-workflow references, credentials, Code nodes, schedules;
 *   no local-machine dependency; no secrets;
 *   inside the repository, byte-identical to workflows/*.json.
 */
process.chdir(__dirname);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failed++; };

const EXPECT = {
  '01-master-pipeline.json': ['giMasterPipeline', 'gold-intelligence-master.json', true],
  '02-ai-analyst.json': ['giAiAnalystSub01', 'gold-intelligence-ai-analyst.json', false],
  '03-telegram-sender.json': ['giTelegramSend01', 'gold-intelligence-telegram-sender.json', false],
  '04-pre-event.json': ['giPreEventEngine', 'gold-intelligence-pre-event.json', true],
  '05-post-event.json': ['giPostEventRevw1', 'gold-intelligence-post-event.json', true],
  '06-daily-report.json': ['giDailyReport001', 'gold-intelligence-daily.json', true],
  '07-telegram-bot.json': ['giTelegramBot001', 'gold-intelligence-telegram-bot.json', true],
  '08-health-monitor.json': ['giHealthMonitor1', 'gold-intelligence-health.json', true],
  '09-error-handler.json': ['giErrorHandler01', 'gold-intelligence-error-handler.json', false],
};
const DOCS = ['CREDENTIAL_SETUP.md', 'CREDENTIALS.md', '.env.example', 'DATABASE.md', 'IMPORT_ORDER.md', 'VERIFICATION.md', 'ROLLBACK.md',
  'PACKAGE_MANIFEST.txt', 'verify-package.sh', 'verify-package.js', 'import-all.sh', 'import-all.ps1', 'check-import.js'];

// 1. Files and checksums
const missing = [...DOCS, ...Object.keys(EXPECT).map((f) => `workflows/${f}`)].filter((f) => !fs.existsSync(f));
check(`all package files present (9 workflows + ${DOCS.length} package files)`, !missing.length, missing.join(', '));
check('no .env / dumps / runtime artifacts in the package', !fs.readdirSync('.').some((f) => f === '.env' || /\.(dump|sql|log|pid)$/.test(f) || f === 'runtime'));
const manifest = fs.existsSync('PACKAGE_MANIFEST.txt') ? fs.readFileSync('PACKAGE_MANIFEST.txt', 'utf8') : '';
const listed = [...manifest.matchAll(/^([0-9a-f]{64})\s+(\d+)\s+(\S+)$/gm)].map((m) => ({ sha: m[1], bytes: Number(m[2]), file: m[3] }));
const bad = listed.filter((x) => !fs.existsSync(x.file) || crypto.createHash('sha256').update(fs.readFileSync(x.file)).digest('hex') !== x.sha);
check(`checksums match PACKAGE_MANIFEST.txt (${listed.length} files)`, listed.length >= 9 + DOCS.length - 1 && !bad.length, bad.map((x) => x.file).join(', '));

// 2. Workflows
const wfs = {};
for (const f of Object.keys(EXPECT)) {
  try { wfs[f] = JSON.parse(fs.readFileSync(`workflows/${f}`, 'utf8')); } catch (e) { check(`${f} is valid JSON`, false, e.message); }
}
const ids = Object.values(wfs).map((w) => w.id);
check('workflow ids are the fixed ids, one per file', Object.entries(EXPECT).every(([f, [id]]) => wfs[f] && wfs[f].id === id) && new Set(ids).size === 9);
const idSet = new Set(ids);
const problems = { conn: [], refs: [], creds: [], code: [], sched: [], local: [], orphan: [] };
for (const [f, w] of Object.entries(wfs)) {
  const names = new Set(w.nodes.map((n) => n.name));
  for (const [src, out] of Object.entries(w.connections || {})) {
    if (!names.has(src)) problems.conn.push(`${f}: ${src}`);
    for (const branch of (out.main || [])) for (const c of (branch || [])) if (!names.has(c.node)) problems.conn.push(`${f}: → ${c.node}`);
  }
  const targets = new Set(Object.values(w.connections || {}).flatMap((o) => (o.main || []).flat().filter(Boolean).map((c) => c.node)));
  for (const n of w.nodes) {
    const t = n.type.split('.').pop();
    if (!/Trigger$|stickyNote/.test(t) && !targets.has(n.name)) problems.orphan.push(`${f}: ${n.name}`);
    if (t === 'executeWorkflow' && !idSet.has(n.parameters.workflowId && n.parameters.workflowId.value)) problems.refs.push(`${f}: ${n.name}`);
    if (t === 'postgres' && !(n.credentials && n.credentials.postgres && n.credentials.postgres.id === 'GIpostgresCred01')) problems.creds.push(`${f}: ${n.name}`);
    for (const c of Object.values(n.credentials || {})) if (c.id !== 'GIpostgresCred01') problems.creds.push(`${f}: ${n.name} uses ${c.id}`);
    if (t === 'code') {
      const js = String(n.parameters.jsCode || '');
      if (js.length < 50) problems.code.push(`${f}: ${n.name} empty`);
      if (/\brequire\s*\(|readFileSync|writeFileSync|child_process/.test(js)) problems.code.push(`${f}: ${n.name} uses modules / files`);
    }
  }
  if (w.settings.errorWorkflow && !idSet.has(w.settings.errorWorkflow)) problems.refs.push(`${f}: errorWorkflow ${w.settings.errorWorkflow}`);
  if (f !== '09-error-handler.json' && w.settings.errorWorkflow !== 'giErrorHandler01') problems.refs.push(`${f}: no error workflow`);
  const scheduled = w.nodes.some((n) => n.type.endsWith('scheduleTrigger'));
  if (scheduled !== EXPECT[f][2]) problems.sched.push(`${f}: scheduled=${scheduled}`);
  if (w.settings.timezone !== 'Africa/Casablanca') problems.sched.push(`${f}: timezone ${w.settings.timezone}`);
  const text = JSON.stringify(w);
  // Drive paths are matched by their usual roots: a bare "X:\\" also occurs in escaped prompt text ("JSON:\\n").
  const m = /(localhost|127\.0\.0\.1|file:\/\/|\b[A-Z]:\\\\(Users|Windows|Program Files|ProgramData)|\/home\/|\/Users\/|AppData)/.exec(text);
  if (m) problems.local.push(`${f}: ${m[0]}`);
}
check('connections reference existing nodes', !problems.conn.length, problems.conn.slice(0, 5).join('; '));
check('no orphan nodes (every non-trigger node is connected)', !problems.orphan.length, problems.orphan.slice(0, 5).join('; '));
check('sub-workflow calls and error workflow resolve inside the package', !problems.refs.length, problems.refs.join('; '));
check('only credential GIpostgresCred01, on every Postgres node', !problems.creds.length, problems.creds.slice(0, 5).join('; '));
check('Code nodes self-contained (logic bundled, no modules / files)', !problems.code.length, problems.code.slice(0, 5).join('; '));
check('schedules preserved (6 scheduled workflows, timezone Africa/Casablanca)', !problems.sched.length && Object.values(EXPECT).filter((e) => e[2]).length === 6, problems.sched.join('; '));
check('no local-machine dependency (paths, localhost)', !problems.local.length, problems.local.join('; '));

// 3. Secrets
const SECRET = [/sk-or-v1-[0-9a-f]{16,}/, /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/, /api\.telegram\.org\/bot\d{6,}/, /postgres(ql)?:\/\/[^:@/\s]+:[^@/\s]{6,}@/, /BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY/];
const hits = [];
for (const f of [...DOCS, ...Object.keys(EXPECT).map((x) => `workflows/${x}`)].filter((x) => fs.existsSync(x))) {
  const t = fs.readFileSync(f, 'utf8');
  for (const re of SECRET) if (re.test(t)) hits.push(`${f} ~ ${re.source.slice(0, 20)}`);
}
const env = fs.existsSync('.env.example') ? fs.readFileSync('.env.example', 'utf8') : '';
for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'OPENROUTER_API_KEY', 'FRED_API_KEY', 'GI_PG_PASSWORD', 'N8N_ENCRYPTION_KEY']) {
  if (new RegExp(`^${k}=\\S`, 'm').test(env)) hits.push(`.env.example has a value for ${k}`);
}
check('no secrets (key / token / password patterns; secret variables empty in .env.example)', !hits.length, hits.join('; '));

// 4. Inside the repository: identical to the generated workflows
if (fs.existsSync(path.join('..', '..', 'workflows'))) {
  const diff = Object.entries(EXPECT).filter(([f, [, src]]) => !fs.existsSync(path.join('..', '..', 'workflows', src))
    || !fs.readFileSync(`workflows/${f}`).equals(fs.readFileSync(path.join('..', '..', 'workflows', src))));
  check('byte-identical to the repository workflows/ (live-verified build)', !diff.length, diff.map(([f]) => f).join(', '));
}
console.log(failed ? `\nPACKAGE CHECK: FAILED (${failed})` : '\nPACKAGE CHECK: PASSED');
process.exit(failed ? 1 : 0);
