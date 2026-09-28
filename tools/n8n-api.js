'use strict';
/**
 * Developer tooling against the local n8n editor REST API (session login with the
 * local test owner). Used for push-updates, manual runs and execution inspection
 * during the pilot; the browser UI is used for visual verification.
 *
 *   node tools/n8n-api.js list
 *   node tools/n8n-api.js push <workflow.json>...        # PATCH existing workflow(s) by id
 *   node tools/n8n-api.js activate <id> | deactivate <id>
 *   node tools/n8n-api.js delete-scratch <id>              # only workflows named "... (scratch)"
 *   node tools/n8n-api.js run <id> [triggerName] [--dump=NodeA,NodeB] [--full]
 *   node tools/n8n-api.js execution <execId> [--dump=...] [--full]
 *   node tools/n8n-api.js executions [workflowId] [limit]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { ROOT, parseEnv } = require('./env');

const HOST = '127.0.0.1';
const PORT = 5678;
const BROWSER_ID = 'gi-dev-tools';
let cookie = null;

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { 'browser-id': BROWSER_ID, accept: 'application/json' };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = data.length; }
    if (cookie) headers.cookie = cookie;
    const req = http.request({ host: HOST, port: PORT, path: pathname, method, headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        const setCookie = res.headers['set-cookie'];
        if (setCookie) {
          const auth = setCookie.find((c) => c.startsWith('n8n-auth='));
          if (auth) cookie = auth.split(';')[0];
        }
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch (_) { json = null; }
        if (res.statusCode >= 400) {
          reject(new Error(`${method} ${pathname} -> HTTP ${res.statusCode}: ${(json && json.message) || buf.slice(0, 300)}`));
        } else resolve(json && Object.prototype.hasOwnProperty.call(json, 'data') ? json.data : json);
      });
    });
    req.on('error', reject);
    req.setTimeout(600000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

async function login() {
  const owner = parseEnv(fs.readFileSync(path.join(ROOT, 'runtime', 'n8n-owner.local.env'), 'utf8'));
  await request('POST', '/rest/login', {
    emailOrLdapLoginId: owner.N8N_LOCAL_OWNER_EMAIL, password: owner.N8N_LOCAL_OWNER_PASSWORD,
  });
  if (!cookie) throw new Error('login did not return a session cookie');
}

async function getWorkflow(id) { return request('GET', `/rest/workflows/${id}`); }

async function push(file) {
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const current = await getWorkflow(wf.id);
  const body = {
    name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings,
    pinData: wf.pinData || {}, versionId: current.versionId,
  };
  const updated = await request('PATCH', `/rest/workflows/${wf.id}?forceSave=true`, body);
  console.log(`pushed ${wf.id} "${wf.name}" (${wf.nodes.length} nodes) active=${updated.active}`);
}

async function setActive(id, active) {
  const current = await getWorkflow(id);
  const updated = await request('PATCH', `/rest/workflows/${id}?forceSave=true`, { active, versionId: current.versionId });
  console.log(`${id} active=${updated.active}`);
}

function summariseExecution(exec, dumpNodes, full) {
  const data = typeof exec.data === 'string' ? JSON.parse(exec.data) : exec.data;
  const out = { id: exec.id, status: exec.status, mode: exec.mode, startedAt: exec.startedAt, stoppedAt: exec.stoppedAt };
  console.log(JSON.stringify(out));
  const runData = unflatten(data).resultData.runData || {};
  const lastErr = unflatten(data).resultData.error;
  if (lastErr) console.log(`EXECUTION ERROR: ${lastErr.message}${lastErr.node ? ` @ ${lastErr.node.name || lastErr.node}` : ''}`);
  for (const [node, runs] of Object.entries(runData)) {
    for (const run of runs) {
      const outputs = (run.data && run.data.main) || [];
      const counts = outputs.map((o) => (o ? o.length : 0));
      const err = run.error ? ` ERROR: ${run.error.message}${run.error.description ? ` — ${String(run.error.description).slice(0, 300)}` : ''}` : '';
      console.log(`  ${node}: items=${JSON.stringify(counts)} ${run.executionTime}ms${err}`);
      if (dumpNodes.includes(node) || dumpNodes.includes('*')) {
        const items = outputs.flat().filter(Boolean).map((i) => i.json);
        const text = JSON.stringify(items, null, 1);
        console.log(full ? text : text.slice(0, 6000));
      }
    }
  }
}

/** n8n stores execution data in "flatted" form (array + string refs). */
function unflatten(data) {
  if (!Array.isArray(data)) return data;
  const table = data;
  const seen = new Map();
  const revive = (value) => {
    if (typeof value === 'string' && /^\d+$/.test(value)) return resolveIndex(Number(value));
    return value;
  };
  function resolveIndex(i) {
    if (seen.has(i)) return seen.get(i);
    const raw = table[i];
    if (raw === null || typeof raw !== 'object') { seen.set(i, raw); return raw; }
    const target = Array.isArray(raw) ? [] : {};
    seen.set(i, target);
    for (const [k, v] of Object.entries(raw)) target[k] = revive(v);
    return target;
  }
  return resolveIndex(0);
}

async function waitExecution(id, timeoutMs = 900000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const exec = await request('GET', `/rest/executions/${id}`);
    if (exec && exec.finished !== undefined && exec.status && !['new', 'running', 'waiting'].includes(exec.status)) return exec;
    if (Date.now() > until) throw new Error(`execution ${id} still ${exec && exec.status}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function run(id, triggerName, dumpNodes, full) {
  const wf = await getWorkflow(id);
  const body = { workflowData: wf };
  if (triggerName) body.triggerToStartFrom = { name: triggerName };
  const res = await request('POST', `/rest/workflows/${id}/run`, body);
  if (!res || !res.executionId) throw new Error(`run did not start: ${JSON.stringify(res).slice(0, 300)}`);
  console.log(`execution ${res.executionId} started`);
  const exec = await waitExecution(res.executionId);
  summariseExecution(exec, dumpNodes, full);
}

async function main() {
  const args = process.argv.slice(2);
  const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.slice(2).split('=');
    return [k, v === undefined ? true : v];
  }));
  const [cmd, ...rest] = args.filter((a) => !a.startsWith('--'));
  const dump = flags.dump ? String(flags.dump).split(',') : [];
  await login();
  if (cmd === 'list') {
    const list = await request('GET', '/rest/workflows');
    for (const w of list) console.log(`${w.id}  active=${w.active}  ${w.name}`);
  } else if (cmd === 'push') {
    for (const f of rest) await push(f);
  } else if (cmd === 'create') {
    // Scratch/probe workflows only: n8n assigns a new id (fixed ids need CLI import).
    const wf = JSON.parse(fs.readFileSync(rest[0], 'utf8'));
    const created = await request('POST', '/rest/workflows', {
      name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings || {}, active: false,
    });
    console.log(`created ${created.id} "${created.name}"`);
  } else if (cmd === 'delete-scratch') {
    // Removes a scratch/probe workflow created with `create`; refuses anything else.
    const wf = await getWorkflow(rest[0]);
    if (!/\(scratch\)/.test(wf.name || '')) throw new Error(`refusing to delete "${wf.name}": not a scratch workflow`);
    if (!wf.isArchived) await request('POST', `/rest/workflows/${rest[0]}/archive`, {});
    await request('DELETE', `/rest/workflows/${rest[0]}`);
    console.log(`deleted scratch workflow ${rest[0]} "${wf.name}"`);
  } else if (cmd === 'activate') await setActive(rest[0], true);
  else if (cmd === 'deactivate') await setActive(rest[0], false);
  else if (cmd === 'run') await run(rest[0], rest[1], dump, flags.full);
  else if (cmd === 'execution') summariseExecution(await request('GET', `/rest/executions/${rest[0]}`), dump, flags.full);
  else if (cmd === 'executions') {
    const filter = rest[0] ? `&filter=${encodeURIComponent(JSON.stringify({ workflowId: rest[0] }))}` : '';
    const list = await request('GET', `/rest/executions?limit=${rest[1] || 10}${filter}`);
    for (const e of (list.results || list)) console.log(`${e.id} ${e.status} ${e.mode} ${e.workflowId} ${e.startedAt} ${e.stoppedAt || ''}`);
  } else throw new Error('unknown command');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
