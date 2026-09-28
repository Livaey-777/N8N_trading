'use strict';
/**
 * Data-store helper for the local pilot and the VPS bootstrap.
 *
 *   node tools/db.js migrate            # apply sql/*.sql in order (idempotent)
 *   node tools/db.js seed-history       # load seed/historical_event_reactions.sql + seed/market_history.sql
 *   node tools/db.js query "<sql>"      # ad-hoc read query, prints JSON rows
 *   node tools/db.js counts             # row counts per table
 *   node tools/db.js cleanup-tests      # delete every is_test row (synthetic events, test messages/forecasts)
 */
const fs = require('fs');
const path = require('path');
const { ROOT, loadEnv } = require('./env');

function client(database) {
  const env = loadEnv();
  const { Client } = require('pg');
  // The process environment wins for the target (e.g. GI_PG_HOST=postgres inside the Compose network).
  return new Client({
    host: process.env.GI_PG_HOST || env.GI_PG_HOST, port: Number(process.env.GI_PG_PORT || env.GI_PG_PORT), user: env.GI_PG_USER,
    password: env.GI_PG_PASSWORD, database: database || env.GI_PG_DATABASE,
  });
}

async function withClient(fn, database) {
  const c = client(database);
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function migrate() {
  const dir = path.join(ROOT, 'sql');
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  await withClient(async (c) => {
    for (const f of files) {
      await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      console.log(`applied ${f}`);
    }
  });
}

async function seedHistory() {
  const files = ['historical_event_reactions.sql', 'market_history.sql'].map((f) => path.join(ROOT, 'seed', f)).filter((f) => fs.existsSync(f));
  await withClient(async (c) => {
    for (const file of files) await c.query(fs.readFileSync(file, 'utf8'));
    const r = await c.query('SELECT event_type, count(*)::int AS n FROM historical_event_reactions GROUP BY 1 ORDER BY 1');
    console.log(JSON.stringify(r.rows));
  });
}

async function query(sql) {
  await withClient(async (c) => {
    const r = await c.query(sql);
    console.log(JSON.stringify(r.rows, null, 1));
  });
}

async function counts() {
  await withClient(async (c) => {
    const t = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1");
    const out = {};
    for (const { table_name: name } of t.rows) {
      const r = await c.query(`SELECT count(*)::int AS n FROM "${name}"`);
      out[name] = r.rows[0].n;
    }
    console.log(JSON.stringify(out, null, 1));
  });
}

// Removes every row flagged is_test (synthetic events, test alerts, test forecasts/reviews).
// Child tables first so foreign keys never block the delete; production rows are untouched.
async function cleanupTests() {
  await withClient(async (c) => {
    const t = await c.query("SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='is_test' AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE')");
    const first = ['scenarios', 'evaluation_results', 'analysis_results', 'pre_event_forecasts', 'news_items'];
    const names = t.rows.map((r) => r.table_name).sort((a, b) => {
      const ia = first.indexOf(a) === -1 ? first.length : first.indexOf(a);
      const ib = first.indexOf(b) === -1 ? first.length : first.indexOf(b);
      return ia - ib || a.localeCompare(b);
    });
    const out = {};
    await c.query('BEGIN');
    try {
      for (const name of names) out[name] = (await c.query(`DELETE FROM "${name}" WHERE is_test`)).rowCount;
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
    console.log(JSON.stringify({ deleted_test_rows: out }, null, 1));
  });
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'migrate') await migrate();
  else if (cmd === 'seed-history') await seedHistory();
  else if (cmd === 'query') await query(arg);
  else if (cmd === 'counts') await counts();
  else if (cmd === 'cleanup-tests') await cleanupTests();
  else throw new Error('usage: node tools/db.js migrate|seed-history|query "<sql>"|counts|cleanup-tests');
}

if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { withClient, client };
