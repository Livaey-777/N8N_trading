'use strict';
/**
 * Import validation for workflows/*.json (spec §47):
 *  valid JSON · n8n workflow structure · known node types & versions · unique workflow/node ids ·
 *  unique node names · valid connections · no orphan nodes · balanced expressions · Code-node syntax ·
 *  credential + sub-workflow + errorWorkflow references resolvable · NO embedded secrets.
 *
 *   node tools/validate-workflows.js            (exit code 1 on any failure)
 */
const fs = require('fs');
const path = require('path');
const { ROOT, ENV_FILE, parseEnv } = require('./env');

const DIR = path.join(ROOT, 'workflows');
const KNOWN_TYPES = {
  'n8n-nodes-base.code': { versions: [2], file: 'Code/Code.node.js' },
  'n8n-nodes-base.postgres': { versions: [2.6], file: 'Postgres/Postgres.node.js' },
  'n8n-nodes-base.httpRequest': { versions: [4.2], file: 'HttpRequest/HttpRequest.node.js' },
  'n8n-nodes-base.scheduleTrigger': { versions: [1.2], file: 'Schedule/ScheduleTrigger.node.js', trigger: true },
  'n8n-nodes-base.manualTrigger': { versions: [1], file: 'ManualTrigger/ManualTrigger.node.js', trigger: true },
  'n8n-nodes-base.executeWorkflowTrigger': { versions: [1.1], file: 'ExecuteWorkflow/ExecuteWorkflowTrigger/ExecuteWorkflowTrigger.node.js', trigger: true },
  'n8n-nodes-base.errorTrigger': { versions: [1], file: 'ErrorTrigger/ErrorTrigger.node.js', trigger: true },
  'n8n-nodes-base.executeWorkflow': { versions: [1.2], file: 'ExecuteWorkflow/ExecuteWorkflow/ExecuteWorkflow.node.js' },
  'n8n-nodes-base.if': { versions: [2.2], file: 'If/If.node.js' },
  'n8n-nodes-base.stickyNote': { versions: [1], file: 'StickyNote/StickyNote.node.js', passive: true },
};
const KNOWN_CREDENTIALS = { GIpostgresCred01: 'postgres' };
const SECRET_PATTERNS = [
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, 'Telegram bot token'],
  [/sk-or-v1-[a-f0-9]{20,}/i, 'OpenRouter key'],
  [/\bsk-[A-Za-z0-9]{20,}/, 'API key (sk-)'],
  [/Bearer\s+[A-Za-z0-9._-]{24,}/, 'hard-coded bearer token'],
  [/api_key=[A-Za-z0-9]{16,}/i, 'API key in URL'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
];

function nodesBaseDir() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'n8n', 'node_modules', 'n8n-nodes-base', 'dist', 'nodes'),
    path.join(ROOT, 'node_modules', 'n8n-nodes-base', 'dist', 'nodes'),
    '/usr/local/lib/node_modules/n8n/node_modules/n8n-nodes-base/dist/nodes',
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function localSecrets() {
  if (!fs.existsSync(ENV_FILE)) return [];
  const env = parseEnv(fs.readFileSync(ENV_FILE, 'utf8'));
  return ['TELEGRAM_BOT_TOKEN', 'OPENROUTER_API_KEY', 'FRED_API_KEY', 'GI_PG_PASSWORD', 'N8N_ENCRYPTION_KEY']
    .map((k) => [k, env[k]]).filter(([, v]) => v && v.length >= 8);
}

function balanced(expr) {
  let depth = 0;
  for (let i = 0; i < expr.length - 1; i++) {
    if (expr[i] === '{' && expr[i + 1] === '{') { depth++; i++; } else if (expr[i] === '}' && expr[i + 1] === '}') { depth--; i++; if (depth < 0) return false; }
  }
  return depth === 0;
}

function walkStrings(obj, fn, p = '') {
  if (typeof obj === 'string') fn(obj, p);
  else if (Array.isArray(obj)) obj.forEach((v, i) => walkStrings(v, fn, `${p}[${i}]`));
  else if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) walkStrings(v, fn, p ? `${p}.${k}` : k);
}

function validate() {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
  const errors = [];
  const warnings = [];
  const workflows = [];
  const base = nodesBaseDir();
  const secrets = localSecrets();
  for (const f of files) {
    const raw = fs.readFileSync(path.join(DIR, f), 'utf8');
    let wf;
    try { wf = JSON.parse(raw); } catch (e) { errors.push(`${f}: invalid JSON (${e.message})`); continue; }
    workflows.push({ f, wf, raw });
  }
  const wfIds = new Set();
  for (const { f, wf } of workflows) {
    if (wfIds.has(wf.id)) errors.push(`${f}: duplicate workflow id ${wf.id}`);
    wfIds.add(wf.id);
  }
  const allNodeIds = new Set();
  for (const { f, wf, raw } of workflows) {
    const E = (m) => errors.push(`${f}: ${m}`);
    for (const k of ['id', 'name', 'nodes', 'connections', 'settings']) if (wf[k] === undefined) E(`missing top-level "${k}"`);
    if (!/^[A-Za-z0-9]{16}$/.test(wf.id || '')) E(`workflow id "${wf.id}" is not a 16-char alphanumeric n8n id`);
    if (!Array.isArray(wf.nodes) || !wf.nodes.length) { E('no nodes'); continue; }
    const names = new Set();
    for (const n of wf.nodes) {
      if (!n.id || !n.name || !n.type || n.typeVersion === undefined || !Array.isArray(n.position)) E(`node "${n.name}" missing id/name/type/typeVersion/position`);
      if (names.has(n.name)) E(`duplicate node name "${n.name}"`);
      names.add(n.name);
      if (allNodeIds.has(n.id)) E(`duplicate node id ${n.id} ("${n.name}")`);
      allNodeIds.add(n.id);
      const known = KNOWN_TYPES[n.type];
      if (!known) E(`unknown node type ${n.type} ("${n.name}")`);
      else {
        if (!known.versions.includes(n.typeVersion)) E(`"${n.name}": typeVersion ${n.typeVersion} not in expected ${known.versions}`);
        if (base) {
          const src = path.join(base, known.file);
          if (!fs.existsSync(src)) E(`node implementation not found for ${n.type}`);
          else {
            const code = fs.readFileSync(src, 'utf8');
            const v = String(n.typeVersion);
            if (!new RegExp(`(version|defaultVersion):\\s*\\[?[^\\]\\n]*\\b${v.replace('.', '\\.')}\\b`).test(code)) {
              // Versioned nodes declare versions in sub-files; accept when the version appears anywhere in the node folder.
              const folder = path.dirname(src);
              const any = fs.readdirSync(folder, { recursive: true }).filter((x) => String(x).endsWith('.js'))
                .some((x) => new RegExp(`\\b${v.replace('.', '\\.')}\\b`).test(fs.readFileSync(path.join(folder, String(x)), 'utf8')));
              if (!any) E(`"${n.name}": installed ${n.type} does not declare version ${v}`);
            }
          }
        }
      }
      if (n.credentials) {
        for (const [ctype, ref] of Object.entries(n.credentials)) {
          if (KNOWN_CREDENTIALS[ref.id] !== ctype) E(`"${n.name}": unknown credential ${ctype}:${ref.id}`);
        }
      }
      if (n.type === 'n8n-nodes-base.executeWorkflow') {
        const target = n.parameters.workflowId && n.parameters.workflowId.value;
        if (!wfIds.has(target)) E(`"${n.name}": sub-workflow ${target} not in export set`);
      }
      if (n.type === 'n8n-nodes-base.code') {
        try {
          // eslint-disable-next-line no-new-func
          new Function('$input', '$env', '$', '$execution', '$workflow', '$getWorkflowStaticData', 'DateTime', `return (async function(){\n${n.parameters.jsCode}\n}).call(this)`);
        } catch (e) { E(`"${n.name}": Code syntax error: ${e.message}`); }
        if (/TODO|FIXME/.test(n.parameters.jsCode)) warnings.push(`${f}: "${n.name}" contains TODO/FIXME`);
      }
      walkStrings(n.parameters || {}, (s, p) => {
        if (s.startsWith('=') && s.includes('{{') && !balanced(s)) E(`"${n.name}": unbalanced expression at ${p}`);
      });
    }
    // Connections
    const incoming = new Map();
    for (const [from, conn] of Object.entries(wf.connections || {})) {
      if (!names.has(from)) E(`connection from unknown node "${from}"`);
      for (const outputs of (conn.main || [])) {
        for (const c of outputs || []) {
          if (!names.has(c.node)) E(`connection "${from}" -> unknown node "${c.node}"`);
          incoming.set(c.node, (incoming.get(c.node) || 0) + 1);
        }
      }
    }
    for (const n of wf.nodes) {
      const known = KNOWN_TYPES[n.type] || {};
      if (known.passive) continue;
      const hasOut = Boolean(wf.connections[n.name] && wf.connections[n.name].main.some((o) => o && o.length));
      if (known.trigger && !hasOut) E(`trigger "${n.name}" is not connected`);
      if (!known.trigger && !incoming.get(n.name)) E(`orphan node "${n.name}" (no incoming connection)`);
    }
    if (wf.settings && wf.settings.errorWorkflow && !wfIds.has(wf.settings.errorWorkflow)) E(`errorWorkflow ${wf.settings.errorWorkflow} not in export set`);
    // Secrets
    for (const [re, label] of SECRET_PATTERNS) if (re.test(raw)) E(`possible embedded secret: ${label}`);
    for (const [k, v] of secrets) if (raw.includes(v)) E(`embedded value of ${k} found`);
  }
  return { files: files.length, errors, warnings, nodeTypesChecked: Boolean(base) };
}

if (require.main === module) {
  const r = validate();
  console.log(`validated ${r.files} workflow files (installed node versions checked: ${r.nodeTypesChecked ? 'yes' : 'no'})`);
  for (const w of r.warnings) console.log(`WARN  ${w}`);
  for (const e of r.errors) console.log(`ERROR ${e}`);
  console.log(r.errors.length ? `FAILED (${r.errors.length} errors)` : 'PASSED: valid JSON, structure, node types/versions, ids, connections, no orphans, expressions, Code syntax, references, no embedded secrets');
  process.exit(r.errors.length ? 1 : 0);
}

module.exports = { validate };
