'use strict';
/**
 * Local-pilot n8n lifecycle (the VPS uses docker-compose.yml).
 *
 *   node tools/n8n-local.js start|stop|restart|status
 *   node tools/n8n-local.js owner-setup          # create the local test owner (first run only)
 *   node tools/n8n-local.js import-credentials   # Postgres credential from .env (encrypted by n8n)
 *   node tools/n8n-local.js import-workflows     # all workflows/*.json (n8n must be stopped)
 *
 * The n8n process receives .env through its environment; nothing is printed.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { ROOT, loadEnv, parseEnv } = require('./env');

const RUNTIME = path.join(ROOT, 'runtime');
const USER_FOLDER = path.join(RUNTIME, 'n8n');
const LOG_DIR = path.join(RUNTIME, 'logs');
const PID_FILE = path.join(RUNTIME, 'n8n.pid');
const OWNER_FILE = path.join(RUNTIME, 'n8n-owner.local.env');
const PORT = 5678;

function n8nBin() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'n8n', 'bin', 'n8n'),
    path.join(ROOT, 'node_modules', 'n8n', 'bin', 'n8n'),
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('n8n not found (npm i -g n8n@1.117.2)');
  return found;
}

function n8nEnv() {
  const env = loadEnv();
  return {
    ...process.env,
    ...env,
    N8N_USER_FOLDER: USER_FOLDER,
    N8N_PORT: String(PORT),
    N8N_LISTEN_ADDRESS: '127.0.0.1',
    N8N_HOST: 'localhost',
    N8N_PROTOCOL: 'http',
    N8N_EDITOR_BASE_URL: `http://localhost:${PORT}`,
    N8N_SECURE_COOKIE: 'false',
    DB_TYPE: 'postgresdb',
    DB_POSTGRESDB_HOST: env.GI_PG_HOST,
    DB_POSTGRESDB_PORT: env.GI_PG_PORT,
    DB_POSTGRESDB_DATABASE: env.N8N_DB_DATABASE || 'n8n',
    DB_POSTGRESDB_USER: env.GI_PG_USER,
    DB_POSTGRESDB_PASSWORD: env.GI_PG_PASSWORD,
    N8N_BLOCK_ENV_ACCESS_IN_NODE: 'false',
    // Owner decision 2026-09-28: on this memory-constrained PC the external task-runner handshake
    // (short-lived grant token) failed repeatedly under load, stalling every Code node. Code nodes
    // therefore run in-process here. Set back to 'true' on a host with enough memory.
    N8N_RUNNERS_ENABLED: 'false',
    N8N_RUNNERS_TASK_TIMEOUT: '300',
    N8N_DIAGNOSTICS_ENABLED: 'false',
    N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
    N8N_TEMPLATES_ENABLED: 'false',
    N8N_PERSONALIZATION_ENABLED: 'false',
    N8N_HIRING_BANNER_ENABLED: 'false',
    N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: 'false',
    EXECUTIONS_DATA_PRUNE: 'true',
    EXECUTIONS_DATA_MAX_AGE: '336',
    EXECUTIONS_DATA_PRUNE_MAX_COUNT: '20000',
    N8N_LOG_LEVEL: 'info',
    N8N_LOG_OUTPUT: 'console,file',
    N8N_LOG_FILE_LOCATION: path.join(LOG_DIR, 'n8n.log'),
  };
}

function readPid() {
  try { return Number(fs.readFileSync(PID_FILE, 'utf8').trim()) || null; } catch (_) { return null; }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function httpGet(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.setTimeout(3000, () => { req.destroy(); resolve(0); });
  });
}

async function waitReady(timeoutMs = 180000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await httpGet(`http://127.0.0.1:${PORT}/healthz/readiness`)) === 200) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function start() {
  const pid = readPid();
  if (isAlive(pid)) { console.log(`n8n already running (pid ${pid})`); return; }
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(USER_FOLDER, { recursive: true });
  const out = fs.openSync(path.join(LOG_DIR, 'n8n.stdout.log'), 'a');
  const child = spawn(process.execPath, [n8nBin(), 'start'], {
    cwd: ROOT, env: n8nEnv(), detached: true, windowsHide: true, stdio: ['ignore', out, out],
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log(`n8n starting (pid ${child.pid}) ...`);
  if (!(await waitReady())) throw new Error('n8n did not become ready; see runtime/logs/n8n.stdout.log');
  console.log(`n8n ready at http://localhost:${PORT}`);
}

function stop() {
  const pid = readPid();
  if (!isAlive(pid)) { console.log('n8n not running'); fs.rmSync(PID_FILE, { force: true }); return; }
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(-pid, 'SIGTERM');
  fs.rmSync(PID_FILE, { force: true });
  console.log('n8n stopped');
}

function cli(args) {
  const res = spawnSync(process.execPath, [n8nBin(), ...args], {
    cwd: ROOT, env: n8nEnv(), encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  const text = `${res.stdout || ''}${res.stderr || ''}`;
  // Only surface lines that matter; the CLI can be chatty.
  const lines = text.split(/\r?\n/).filter((l) => /(success|error|imported|fail|warn|Successfully)/i.test(l));
  if (lines.length) console.log(lines.join('\n'));
  if (res.status !== 0) throw new Error(`n8n ${args.join(' ')} exited ${res.status}`);
}

function importCredentials() {
  const env = loadEnv();
  const tmp = path.join(RUNTIME, `credentials-import-${process.pid}.json`);
  const creds = [{
    id: 'GIpostgresCred01',
    name: 'GI Postgres',
    type: 'postgres',
    data: {
      host: env.GI_PG_HOST, port: Number(env.GI_PG_PORT), database: env.GI_PG_DATABASE,
      user: env.GI_PG_USER, password: env.GI_PG_PASSWORD, ssl: 'disable', allowUnauthorizedCerts: false,
      maxConnections: 10, sshTunnel: false,
    },
  }];
  fs.writeFileSync(tmp, JSON.stringify(creds), { mode: 0o600 });
  try { cli(['import:credentials', `--input=${tmp}`]); } finally { fs.rmSync(tmp, { force: true }); }
  console.log('credential "GI Postgres" imported');
}

function importWorkflows() {
  const dir = path.join(ROOT, 'workflows');
  cli(['import:workflow', '--separate', `--input=${dir}`]);
  console.log('workflows imported');
}

function postJson(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function ownerSetup() {
  if (!fs.existsSync(OWNER_FILE)) throw new Error('owner file missing; run node tools/setup-local.js');
  const owner = parseEnv(fs.readFileSync(OWNER_FILE, 'utf8'));
  const res = await postJson('/rest/owner/setup', {
    email: owner.N8N_LOCAL_OWNER_EMAIL, firstName: 'Gold', lastName: 'Intel',
    password: owner.N8N_LOCAL_OWNER_PASSWORD,
  });
  if (res.status === 200) console.log('local owner account created');
  else console.log(`owner setup returned HTTP ${res.status} (already set up?)`);
}

async function main() {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'start') await start();
  else if (cmd === 'stop') stop();
  else if (cmd === 'restart') { stop(); await new Promise((r) => setTimeout(r, 1500)); await start(); }
  else if (cmd === 'foreground') {
    const child = spawn(process.execPath, [n8nBin(), 'start'], { cwd: ROOT, env: n8nEnv(), stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code || 0));
  }
  else if (cmd === 'status') {
    const pid = readPid();
    const code = await httpGet(`http://127.0.0.1:${PORT}/healthz/readiness`);
    console.log(`process: ${isAlive(pid) ? `running (pid ${pid})` : 'not running'}; readiness HTTP ${code || 'unreachable'}`);
  } else if (cmd === 'owner-setup') await ownerSetup();
  else if (cmd === 'import-credentials') importCredentials();
  else if (cmd === 'import-workflows') importWorkflows();
  else throw new Error(`unknown command ${cmd}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
