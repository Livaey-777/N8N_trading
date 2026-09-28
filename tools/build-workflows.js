'use strict';
/**
 * Builds the n8n workflow JSON exports from source:
 *   src/workflows/*.js  — workflow definitions (nodes, connections, settings)
 *   src/nodes/**.js     — Code-node entry scripts (use n8n globals: $input, $env, this.helpers, ...)
 *   src/lib/*.js        — shared, unit-tested engine modules bundled into each Code node
 *
 *   node tools/build-workflows.js            -> workflows/*.json
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT } = require('./env');

const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'workflows');
const PG_CREDENTIAL = { postgres: { id: 'GIpostgresCred01', name: 'GI Postgres' } };
const ERROR_WORKFLOW_ID = 'giErrorHandler01';
const TZ = 'Africa/Casablanca';

// ---------------------------------------------------------------------------
// Bundler: resolves relative require() calls into IIFE-wrapped modules.
// ---------------------------------------------------------------------------
const REQ_RE = /require\((['"])(\.{1,2}\/[^'"]+)\1\)/g;

function resolveModule(fromFile, spec) {
  let p = path.resolve(path.dirname(fromFile), spec);
  if (!p.endsWith('.js')) p += '.js';
  if (!fs.existsSync(p)) throw new Error(`cannot resolve ${spec} from ${fromFile}`);
  return p;
}

function moduleVar(file) {
  return `__gi_${path.relative(SRC, file).replace(/\\/g, '/').replace(/\.js$/, '').replace(/[^a-zA-Z0-9]/g, '_')}`;
}

function bundle(entryFile) {
  const order = [];
  const seen = new Set();
  const visit = (file, stack) => {
    if (seen.has(file)) return;
    if (stack.includes(file)) throw new Error(`circular require: ${[...stack, file].join(' -> ')}`);
    const code = fs.readFileSync(file, 'utf8');
    for (const m of code.matchAll(REQ_RE)) visit(resolveModule(file, m[2]), [...stack, file]);
    seen.add(file);
    order.push(file);
  };
  const entryCode = fs.readFileSync(entryFile, 'utf8');
  for (const m of entryCode.matchAll(REQ_RE)) visit(resolveModule(entryFile, m[2]), [entryFile]);
  const rewrite = (file, code) => code.replace(REQ_RE, (_, q, spec) => moduleVar(resolveModule(file, spec)));
  const parts = [
    `// Gold Intelligence n8n — generated from ${path.relative(ROOT, entryFile).replace(/\\/g, '/')} by tools/build-workflows.js.`,
    '// Edit the source files, not this node. Shared modules are bundled below.',
  ];
  for (const file of order) {
    const body = rewrite(file, fs.readFileSync(file, 'utf8')).replace(/^'use strict';\s*/m, '');
    parts.push(`// ---- module: ${path.relative(SRC, file).replace(/\\/g, '/')}`);
    parts.push(`const ${moduleVar(file)} = (() => { const module = { exports: {} }; const exports = module.exports;\n${body}\nreturn module.exports; })();`);
  }
  parts.push('// ---- node entry');
  parts.push(rewrite(entryFile, entryCode).replace(/^'use strict';\s*/m, ''));
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Workflow builder helpers
// ---------------------------------------------------------------------------
function stableId(workflowId, nodeName) {
  const h = crypto.createHash('sha1').update(`${workflowId}::${nodeName}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function createBuilder(workflowId) {
  const nodes = [];
  const connections = {};
  let col = 0;
  let row = 0;
  const add = (node, pos) => {
    if (nodes.some((n) => n.name === node.name)) throw new Error(`duplicate node name ${node.name} in ${workflowId}`);
    node.id = stableId(workflowId, node.name);
    node.position = pos || [col * 260, row * 200];
    if (!pos) col++;
    nodes.push(node);
    return node.name;
  };
  const h = {
    lane(r) { row = r; col = 0; },
    at(c, r) { col = c; row = r; },
    code(name, entry, opts = {}) {
      return add({
        name, type: 'n8n-nodes-base.code', typeVersion: 2,
        parameters: { mode: 'runOnceForAllItems', jsCode: bundle(path.join(SRC, 'nodes', entry)) },
        ...(opts.onError ? { onError: opts.onError } : {}),
        ...(opts.notes ? { notes: opts.notes, notesInFlow: true } : {}),
      }, opts.pos);
    },
    pg(name, sql, param, opts = {}) {
      return add({
        name, type: 'n8n-nodes-base.postgres', typeVersion: 2.6,
        parameters: {
          operation: 'executeQuery',
          query: sql.trim(),
          options: param ? { queryReplacement: `={{ JSON.stringify(${param}) }}` } : {},
        },
        credentials: PG_CREDENTIAL,
        retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
        ...(opts.onError ? { onError: opts.onError } : {}),
        ...(opts.alwaysOutputData ? { alwaysOutputData: true } : {}),
        ...(opts.notes ? { notes: opts.notes, notesInFlow: true } : {}),
      }, opts.pos);
    },
    http(name, opts = {}) {
      return add({
        name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
        parameters: {
          url: '={{ $json.url }}',
          sendHeaders: true,
          headerParameters: { parameters: [
            { name: 'User-Agent', value: '={{ $json.user_agent }}' },
            { name: 'Accept', value: '={{ $json.accept }}' },
          ] },
          options: {
            timeout: opts.timeout || 25000,
            response: { response: { fullResponse: true, neverError: true, responseFormat: 'text', outputPropertyName: 'body' } },
            batching: { batch: { batchSize: opts.batchSize || 4, batchInterval: opts.batchInterval || 250 } },
          },
        },
        onError: 'continueRegularOutput',
        ...(opts.notes ? { notes: opts.notes, notesInFlow: true } : {}),
      }, opts.pos);
    },
    schedule(name, interval, opts = {}) {
      return add({ name, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, parameters: { rule: { interval: [interval] } }, ...(opts.notes ? { notes: opts.notes, notesInFlow: true } : {}) }, opts.pos);
    },
    manual(name, opts = {}) {
      return add({ name, type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }, opts.pos);
    },
    subTrigger(name, opts = {}) {
      return add({ name, type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, parameters: { inputSource: 'passthrough' } }, opts.pos);
    },
    errorTrigger(name, opts = {}) {
      return add({ name, type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, parameters: {} }, opts.pos);
    },
    callWorkflow(name, targetId, opts = {}) {
      return add({
        name, type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2,
        parameters: {
          workflowId: { __rl: true, value: targetId, mode: 'id' },
          workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true },
          mode: 'once',
          options: { waitForSubWorkflow: true },
        },
        ...(opts.onError ? { onError: opts.onError } : {}),
      }, opts.pos);
    },
    ifTrue(name, expr, opts = {}) {
      return add({
        name, type: 'n8n-nodes-base.if', typeVersion: 2.2,
        parameters: {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
            conditions: [{ id: stableId(workflowId, `${name}-cond`), leftValue: `={{ ${expr} }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
            combinator: 'and',
          },
          options: {},
        },
      }, opts.pos);
    },
    note(name, content, pos, size = [420, 240], color = 7) {
      return add({ name, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, parameters: { content, width: size[0], height: size[1], color } }, pos);
    },
    connect(from, to, fromOutput = 0, toInput = 0) {
      connections[from] = connections[from] || { main: [] };
      while (connections[from].main.length <= fromOutput) connections[from].main.push([]);
      connections[from].main[fromOutput].push({ node: to, type: 'main', index: toInput });
    },
    chain(...names) { for (let i = 0; i < names.length - 1; i++) h.connect(names[i], names[i + 1]); },
    result(meta) {
      return {
        id: workflowId,
        name: meta.name,
        nodes,
        connections,
        active: false,
        settings: {
          executionOrder: 'v1',
          timezone: TZ,
          saveManualExecutions: true,
          saveDataErrorExecution: 'all',
          saveDataSuccessExecution: meta.saveSuccess || 'all',
          saveExecutionProgress: false,
          callerPolicy: 'workflowsFromSameOwner',
          ...(meta.noErrorWorkflow ? {} : { errorWorkflow: ERROR_WORKFLOW_ID }),
          executionTimeout: meta.timeoutSeconds || 900,
        },
        pinData: {},
        meta: { templateCredsSetupCompleted: true },
        tags: [],
      };
    },
  };
  return h;
}

// ---------------------------------------------------------------------------
function buildAll() {
  const defsDir = path.join(SRC, 'workflows');
  const defs = fs.readdirSync(defsDir).filter((f) => f.endsWith('.js')).sort();
  fs.mkdirSync(OUT, { recursive: true });
  const written = [];
  for (const f of defs) {
    const def = require(path.join(defsDir, f));
    const h = createBuilder(def.id);
    const wf = def.build(h);
    const file = path.join(OUT, def.file);
    fs.writeFileSync(file, `${JSON.stringify(wf, null, 2)}\n`);
    written.push({ file: path.relative(ROOT, file), id: wf.id, name: wf.name, nodes: wf.nodes.length });
  }
  return written;
}

if (require.main === module) {
  for (const w of buildAll()) console.log(`built ${w.file}  (${w.id}, ${w.nodes} nodes)  ${w.name}`);
}

module.exports = { bundle, buildAll, createBuilder, stableId };
