'use strict';
/**
 * Local-pilot PostgreSQL lifecycle using the embedded-postgres binaries
 * (npm @embedded-postgres/windows-x64 | linux-x64 | darwin-*).
 * Production uses the postgres service in docker-compose.yml instead.
 *
 *   node tools/local-pg.js init|start|stop|status
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, loadEnv } = require('./env');

const DATA_DIR = path.join(ROOT, 'runtime', 'pgdata');
const LOG_FILE = path.join(ROOT, 'runtime', 'logs', 'postgres.log');

function binDir() {
  const platformPkg = {
    win32: '@embedded-postgres/windows-x64',
    linux: '@embedded-postgres/linux-x64',
    darwin: os.arch() === 'arm64' ? '@embedded-postgres/darwin-arm64' : '@embedded-postgres/darwin-x64',
  }[process.platform];
  if (!platformPkg) throw new Error(`Unsupported platform ${process.platform}`);
  const dir = path.join(ROOT, 'node_modules', ...platformPkg.split('/'), 'native', 'bin');
  if (!fs.existsSync(dir)) throw new Error(`Postgres binaries not found at ${dir}. Run npm install.`);
  return dir;
}

function exe(name) {
  return path.join(binDir(), process.platform === 'win32' ? `${name}.exe` : name);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  if (res.error) throw res.error;
  return res;
}

function init(env) {
  if (fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'))) {
    console.log('pgdata already initialised');
    return;
  }
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const pwFile = path.join(os.tmpdir(), `gi-pw-${process.pid}.txt`);
  fs.writeFileSync(pwFile, env.GI_PG_PASSWORD, { mode: 0o600 });
  try {
    const res = run(exe('initdb'), [
      '-D', DATA_DIR, '-U', env.GI_PG_USER, `--pwfile=${pwFile}`,
      '-A', 'scram-sha-256', '-E', 'UTF8', '--no-locale',
    ]);
    if (res.status !== 0) throw new Error(`initdb failed: ${res.stderr || res.stdout}`);
  } finally {
    fs.rmSync(pwFile, { force: true });
  }
  console.log('pgdata initialised');
}

function status() {
  const res = run(exe('pg_ctl'), ['-D', DATA_DIR, 'status']);
  return res.status === 0;
}

function start(env) {
  init(env);
  if (status()) {
    console.log('postgres already running');
    return;
  }
  // stdio must be ignored: the postmaster inherits pipe handles and would keep
  // spawnSync waiting forever. Diagnostics go to LOG_FILE.
  const res = run(exe('pg_ctl'), [
    '-D', DATA_DIR, '-l', LOG_FILE, '-w', '-t', '60',
    '-o', `-p ${env.GI_PG_PORT} -c listen_addresses=${env.GI_PG_HOST}`,
    'start',
  ], { stdio: 'ignore' });
  if (res.status !== 0) throw new Error(`pg_ctl start failed (exit ${res.status}); see ${LOG_FILE}`);
  console.log(`postgres started on ${env.GI_PG_HOST}:${env.GI_PG_PORT}`);
}

function stop() {
  if (!status()) {
    console.log('postgres not running');
    return;
  }
  const res = run(exe('pg_ctl'), ['-D', DATA_DIR, '-m', 'fast', '-w', 'stop']);
  if (res.status !== 0) throw new Error(`pg_ctl stop failed: ${res.stderr || res.stdout}`);
  console.log('postgres stopped');
}

async function ensureDatabases(env) {
  const { Client } = require('pg');
  const client = new Client({
    host: env.GI_PG_HOST, port: Number(env.GI_PG_PORT), user: env.GI_PG_USER,
    password: env.GI_PG_PASSWORD, database: 'postgres',
  });
  await client.connect();
  try {
    for (const db of [env.GI_PG_DATABASE, env.N8N_DB_DATABASE]) {
      const r = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
      if (r.rowCount === 0) {
        await client.query(`CREATE DATABASE "${db.replace(/"/g, '')}"`);
        console.log(`created database ${db}`);
      }
    }
  } finally {
    await client.end();
  }
}

async function main() {
  const env = loadEnv();
  const cmd = process.argv[2] || 'status';
  if (cmd === 'init') init(env);
  else if (cmd === 'start') { start(env); await ensureDatabases(env); }
  else if (cmd === 'stop') stop();
  else if (cmd === 'status') console.log(status() ? 'running' : 'stopped');
  else throw new Error(`unknown command ${cmd}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
