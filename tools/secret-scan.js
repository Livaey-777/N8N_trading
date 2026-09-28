#!/usr/bin/env node
'use strict';
/**
 * Scans for the ACTUAL configured secret values (from .env) — never prints them, only where they
 * occur and how often. Covers project files (except .env itself, node_modules and the Postgres data
 * directory), runtime logs, every text/json column of the gold_intel database, and n8n's database
 * (workflows, execution data; credentials are stored encrypted by n8n).
 *
 *   node tools/secret-scan.js        # exit code 1 when a secret is found
 */
const fs = require('fs');
const path = require('path');
const { ROOT, loadEnv } = require('./env');
const { withClient } = require('./db');

const KEYS = ['OPENROUTER_API_KEY', 'TELEGRAM_BOT_TOKEN', 'FRED_API_KEY', 'GI_PG_PASSWORD', 'N8N_ENCRYPTION_KEY'];
const env = loadEnv();
// Short values (chat ids) are not secrets and would produce noise.
const secrets = KEYS.map((k) => [k, String(env[k] || '').trim()]).filter(([, v]) => v.length >= 12);
// The Telegram bot token's secret half is also searched on its own (URLs may split it).
if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_TOKEN.includes(':')) secrets.push(['TELEGRAM_BOT_TOKEN(secret part)', env.TELEGRAM_BOT_TOKEN.split(':')[1]]);
// backups/: compressed pg_dump files (git-ignored, mode 700) — not searchable as text.
const SKIP_DIRS = new Set(['node_modules', '.git', 'pgdata', 'backups']);
const findings = [];
// Expected locations: n8n keeps its own encryption key in its settings file (git-ignored runtime dir).
const ALLOWED = [[path.join('runtime', 'n8n', '.n8n', 'config'), 'N8N_ENCRYPTION_KEY']];
const check = (where, text) => {
  if (!text) return;
  for (const [name, v] of secrets) {
    if (ALLOWED.some(([f, k]) => f === where && k === name)) continue;
    let n = 0;
    let i = text.indexOf(v);
    while (i !== -1) { n++; i = text.indexOf(v, i + v.length); }
    if (n) findings.push({ where, secret: name, count: n });
  }
};

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); continue; }
    if (path.resolve(p) === path.resolve(ROOT, '.env')) continue;
    const st = fs.statSync(p);
    if (st.size > 50 * 1024 * 1024) continue;
    check(path.relative(ROOT, p), fs.readFileSync(p, 'latin1'));
  }
}

async function scanDb(database, label) {
  await withClient(async (c) => {
    const cols = (await c.query(`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type IN ('text', 'jsonb', 'json', 'character varying')
      AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE')`)).rows;
    for (const { table_name: t, column_name: col } of cols) {
      if (label === 'n8n' && t === 'credentials_entity') continue; // encrypted by n8n
      for (const [name, v] of secrets) {
        const r = await c.query(`SELECT count(*)::int AS n FROM "${t}" WHERE "${col}"::text LIKE '%' || $1 || '%'`, [v]);
        if (r.rows[0].n) findings.push({ where: `${label}.${t}.${col}`, secret: name, count: r.rows[0].n });
      }
    }
  }, database);
}

(async () => {
  walk(ROOT);
  await scanDb(undefined, 'gold_intel');
  await scanDb(env.N8N_DB_DATABASE || 'n8n', 'n8n');
  console.log(`secrets checked: ${secrets.map(([n]) => n).join(', ')}`);
  if (!findings.length) { console.log('secret scan: CLEAN (0 occurrences outside .env)'); return; }
  for (const f of findings) console.log(`FOUND ${f.secret} in ${f.where} (${f.count}x)`);
  process.exitCode = 1;
})().catch((e) => { console.error('scan error:', e.message); process.exit(2); });
