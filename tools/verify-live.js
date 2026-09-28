'use strict';
/**
 * Read-only verification of the live instance: the scheduled PRE_EVENT and DAILY_REPORT runs and the
 * health of the AI fallback chain, from what n8n and the data store actually recorded.
 *
 *   node tools/verify-live.js [--days=3]
 *
 * - A run counts as SCHEDULED only when n8n recorded it with mode = 'trigger' at the configured slot.
 *   A run started from the editor (mode 'manual') is listed but never counted, even when it went through
 *   the "⏱ Daily …" trigger and wrote a PRE_EVENT_DAILY / DAILY_SCHEDULED job row.
 * - Makes no OpenRouter or Telegram request and writes nothing (every query is a SELECT).
 * - Prints no secret, chat id or message text; any .env secret value that would appear is redacted.
 * - Connection: .env (GI_PG_*, N8N_DB_DATABASE), overridable by the process environment
 *   (e.g. GI_PG_HOST=postgres GI_PG_PORT=5432 inside the Docker network).
 */
const { loadEnv } = require('./env');
const { loadConfig } = require('../src/lib/config');
const { modelHealth } = require('../src/lib/aiusage');

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const DAYS = Math.min(14, Math.max(1, Number(args.days) || 3));
const env = { ...loadEnv({ required: false }) };
// Process environment wins (Docker --env-file / -e). Secret names are taken only so they can be redacted.
for (const [k, v] of Object.entries(process.env)) if (/^(GI_|N8N_DB_|OPENROUTER_|AI_|TELEGRAM_|FRED_API_KEY$|N8N_ENCRYPTION_KEY$|GENERIC_TIMEZONE$|DB_TABLE_PREFIX$)/.test(k)) env[k] = v;
const cfg = loadConfig(env);
const TZ = cfg.timezone || 'Africa/Casablanca';
const PREFIX = env.DB_TABLE_PREFIX || '';
const PRE_HOUR = Number(env.GI_PREEVENT_DAILY_HOUR) || 6;
const DAILY_HOUR = Number(env.GI_DAILY_REPORT_HOUR) || 7;
const SLOT_BEFORE_MS = 5 * 60000;
const SLOT_AFTER_MS = 20 * 60000;
const NOW = Date.now();

// ---- output with redaction ---------------------------------------------------------------------
// Secret-valued names only (AI_KEY_ALIAS / AI_MAX_TOKENS_* are labels and numbers, not secrets).
const secrets = Object.entries(env).filter(([k, v]) => /(^|_)(PASSWORD|SECRET|API_KEY|BOT_TOKEN|ENCRYPTION_KEY|CHAT_ID)$/.test(k) && v && String(v).length >= 6)
  .flatMap(([, v]) => String(v).split(',').map((s) => s.trim()).filter((s) => s.length >= 6));
const PATTERNS = [/sk-or-v1-[0-9a-f]{16,}/gi, /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g];
let redactions = 0;
function redact(s) {
  let out = String(s);
  for (const v of secrets) if (out.includes(v)) { out = out.split(v).join('[REDACTED]'); redactions++; }
  for (const re of PATTERNS) out = out.replace(re, () => { redactions++; return '[REDACTED]'; });
  return out;
}
const lines = [];
const say = (s = '') => lines.push(redact(s));

// ---- time helpers ------------------------------------------------------------------------------
function tzOffsetMs(utcMs, tz = TZ) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}
function localSlotUtc(day, hour, tz = TZ) {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  return guess - tzOffsetMs(guess - tzOffsetMs(guess, tz), tz);
}
const localDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
const localTime = (ms) => new Date(ms).toLocaleString('en-GB', { timeZone: TZ, hour12: false }).replace(',', '');
const ms = (t) => new Date(t).getTime();
const iso = (t) => (t ? new Date(t).toISOString().replace('.000Z', 'Z') : '—');
const both = (t) => (t ? `${iso(t)} (${localTime(ms(t))} ${TZ})` : '—');
const age = (t) => {
  if (!t) return '';
  const m = Math.round((NOW - ms(t)) / 60000);
  return m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
function slots(hour) {
  const out = [];
  for (let k = DAYS - 1; k >= 0; k--) {
    const day = localDay(NOW - k * 86400000);
    const at = localSlotUtc(day, hour);
    if (!out.some((s) => s.day === day)) out.push({ day, at, passed: at + SLOT_AFTER_MS <= NOW, due: at <= NOW });
  }
  return out;
}

// ---- database ----------------------------------------------------------------------------------
function client(database) {
  const { Client } = require('pg');
  return new Client({ host: env.GI_PG_HOST, port: Number(env.GI_PG_PORT), user: env.GI_PG_USER, password: env.GI_PG_PASSWORD, database });
}
async function tryQuery(c, sql, params) {
  try { return (await c.query(sql, params)).rows; } catch (err) { say(`  ! query failed: ${err.message}`); return null; }
}

async function executionsAround(n8n, workflowId, from, to) {
  return (await tryQuery(n8n, `SELECT id::text AS id, mode, status, finished, coalesce("startedAt", "createdAt") AS started_at, "stoppedAt" AS stopped_at
    FROM ${PREFIX}execution_entity WHERE "workflowId" = $1 AND "deletedAt" IS NULL
      AND coalesce("startedAt", "createdAt") BETWEEN $2 AND $3 ORDER BY 1::int`, [workflowId, new Date(from), new Date(to)])) || [];
}
async function executionsById(n8n, ids) {
  if (!ids.length) return {};
  const rows = (await tryQuery(n8n, `SELECT id::text AS id, "workflowId" AS workflow_id, mode, status, finished, coalesce("startedAt", "createdAt") AS started_at, "stoppedAt" AS stopped_at
    FROM ${PREFIX}execution_entity WHERE id::text = ANY($1)`, [ids])) || [];
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}
async function schedulerActivity(n8n, at) {
  const r = await tryQuery(n8n, `SELECT count(*)::int AS n, min(coalesce("startedAt", "createdAt")) AS first, max(coalesce("startedAt", "createdAt")) AS last
    FROM ${PREFIX}execution_entity WHERE mode = 'trigger' AND coalesce("startedAt", "createdAt") BETWEEN $1 AND $2`, [new Date(at - 30 * 60000), new Date(at + 30 * 60000)]);
  return r ? r[0] : null;
}

/**
 * One scheduled job: finds the trigger-mode execution at each slot, its job row, what it stored and what
 * it delivered. `spec` supplies the job names, message types and the product check (forecast / report).
 */
async function verifyJob(gi, n8n, spec) {
  say(`\n=== ${spec.label} — workflow ${spec.workflowId}, daily ${String(spec.hour).padStart(2, '0')}:00 ${TZ} ===`);
  const wf = await tryQuery(n8n, `SELECT active, settings->>'timezone' AS tz FROM ${PREFIX}workflow_entity WHERE id = $1`, [spec.workflowId]);
  if (wf && wf[0]) say(`workflow active: ${wf[0].active} · workflow timezone: ${wf[0].tz || '(instance default)'}`);
  else say('workflow NOT FOUND in n8n');
  const since = new Date(NOW - DAYS * 86400000);
  // Every job row of this kind in the window, with its execution's n8n mode (manual runs are shown, never counted).
  const jobs = (await tryQuery(gi, `SELECT id, job, started_at, finished_at, status, stats, execution_id FROM job_runs
    WHERE job = ANY($1) AND started_at > $2 AND NOT is_test ORDER BY started_at`, [spec.jobs, since])) || [];
  const ex = await executionsById(n8n, jobs.map((j) => j.execution_id).filter(Boolean));
  const results = [];
  for (const s of slots(spec.hour)) {
    if (!s.due) { say(`\n[${s.day}] slot ${both(s.at)}: not reached yet`); continue; }
    say(`\n[${s.day}] slot ${both(s.at)}`);
    const around = await executionsAround(n8n, spec.workflowId, s.at - SLOT_BEFORE_MS, s.at + SLOT_AFTER_MS);
    const scheduled = around.filter((e) => e.mode === 'trigger');
    const mine = scheduled.map((e) => ({ e, job: jobs.find((j) => j.execution_id === e.id) }));
    for (const { e, job } of mine) say(`  execution #${e.id} mode=${e.mode} status=${e.status} started ${iso(e.started_at)} stopped ${iso(e.stopped_at)} → job ${job ? `${job.job} (${job.status})` : 'none (another trigger of this workflow, or the run stopped before persisting)'}`);
    for (const e of around.filter((x) => x.mode !== 'trigger')) say(`  execution #${e.id} mode=${e.mode} (NOT a scheduled execution — not counted)`);
    const runs = mine.filter((m) => m.job && spec.scheduledJobs.includes(m.job.job));
    if (!runs.length) {
      const act = await schedulerActivity(n8n, s.at);
      const why = !s.passed ? 'slot still in progress' : act && act.n > 0
        ? `n8n was scheduling (${act.n} trigger executions within ±30 min) — the ${spec.label} trigger did not produce a run`
        : 'no trigger executions at all within ±30 min — n8n (or the PC) was not running at the slot';
      say(`  → NO SCHEDULED ${spec.label} RUN: ${why}`);
      results.push({ day: s.day, verdict: s.passed ? 'NOT RUN' : 'PENDING', reason: why });
      continue;
    }
    if (runs.length > 1) say(`  ✗ ${runs.length} scheduled ${spec.label} runs in one slot (duplicate trigger)`);
    const { e, job } = runs[0];
    const st = job.stats || {};
    const tg = st.telegram || {};
    say(`  SCHEDULED RUN: execution #${e.id} · n8n status ${e.status} · job_runs #${job.id} ${job.job} ${job.status} · ${Math.round((ms(e.stopped_at || job.finished_at) - ms(e.started_at)) / 1000)} s`);
    say(`  telegram (job stats): sent ${tg.sent ?? '?'} · failed ${tg.failed ?? '?'} · skipped duplicates ${tg.skipped ?? '?'} · not configured ${tg.not_configured ?? '?'} · ${tg.status || ''}`);
    const from = new Date(ms(e.started_at) - 1000);
    const to = new Date(ms(e.stopped_at || job.finished_at || NOW) + 60000);
    const product = await spec.product(gi, from, to, st);
    const msgs = (await tryQuery(gi, `SELECT id, message_type, status, telegram_message_id IS NOT NULL AS has_msg_id, parts, dedup_key, left(coalesce(error, ''), 160) AS error
      FROM telegram_messages WHERE direction = 'OUT' AND NOT is_test AND message_type = ANY($1) AND created_at BETWEEN $2 AND $3 ORDER BY id`, [spec.messageTypes, from, to])) || [];
    for (const m of msgs) say(`  message #${m.id} ${m.message_type} ${m.status}${m.has_msg_id ? ' (Telegram message id returned)' : ''}${m.parts ? ` · ${m.parts} part(s)` : ''} · ${m.dedup_key}${m.error ? ` · ${m.error}` : ''}`);
    const sent = msgs.filter((m) => m.status === 'SENT' && m.has_msg_id);
    // Duplicate output: the same dedup key SENT more than once on this local day, or more than one scheduled run.
    const dups = (await tryQuery(gi, `SELECT dedup_key, count(*)::int AS n FROM telegram_messages WHERE direction = 'OUT' AND status = 'SENT' AND NOT is_test
      AND dedup_key LIKE $1 AND created_at > $2 GROUP BY 1 HAVING count(*) > 1`, [spec.dedupLike(s.day), new Date(s.at - 86400000)])) || [];
    for (const d of dups) say(`  ✗ duplicate delivery: ${d.dedup_key} SENT ${d.n}×`);
    const problems = [];
    if (e.status !== 'success') problems.push(`n8n status ${e.status}`);
    if (runs.length > 1) problems.push('duplicate scheduled run');
    if (dups.length) problems.push('duplicate Telegram output');
    if (product.expected > 0 && product.stored < product.expected) problems.push(`${spec.productName} stored ${product.stored}/${product.expected}`);
    if (product.expected > 0) {
      if (Number(tg.not_configured) > 0) problems.push('Telegram NOT_CONFIGURED');
      if (Number(tg.failed) > 0) problems.push(`${tg.failed} Telegram message(s) FAILED`);
      if (!sent.length && !(Number(tg.skipped) > 0)) problems.push('no Telegram message SENT');
    }
    const nothingDue = product.expected === 0;
    const verdict = problems.length ? 'FAIL' : nothingDue ? 'PASS (nothing due)' : 'PASS';
    say(`  → ${verdict}${problems.length ? `: ${problems.join('; ')}` : nothingDue ? `: ${product.note}` : ''}`);
    results.push({ day: s.day, verdict, execution: e.id, reason: problems.join('; ') || product.note || '' });
  }
  const manual = jobs.filter((j) => spec.scheduledJobs.includes(j.job) && ex[j.execution_id] && ex[j.execution_id].mode !== 'trigger');
  for (const j of manual) say(`\n  (not counted) ${j.job} job #${j.id} from execution #${j.execution_id} mode=${ex[j.execution_id].mode} at ${iso(j.started_at)}`);
  const offSlot = jobs.filter((j) => spec.scheduledJobs.includes(j.job) && ex[j.execution_id] && ex[j.execution_id].mode === 'trigger'
    && !slots(spec.hour).some((s) => Math.abs(ms(j.started_at) - s.at) <= SLOT_AFTER_MS));
  for (const j of offSlot) say(`  ⚠ scheduled ${j.job} run at an unexpected time: ${both(j.started_at)} (execution #${j.execution_id}) — check GENERIC_TIMEZONE / the hour setting`);
  return results;
}

const PRE_EVENT = {
  label: 'PRE_EVENT', workflowId: 'giPreEventEngine', hour: PRE_HOUR,
  jobs: ['PRE_EVENT_DAILY', 'PRE_EVENT_REFRESH', 'PRE_EVENT_MANUAL'], scheduledJobs: ['PRE_EVENT_DAILY'],
  messageTypes: ['PRE_EVENT', 'CALENDAR_NOTICE'], productName: 'forecasts',
  dedupLike: (day) => `forecast:%:PRE_EVENT:${day}`,
  async product(gi, from, to, st) {
    const rows = (await tryQuery(gi, `SELECT id, event_type, scheduled_at, forecast_state, pre_event_score, confidence, sent, ai_status
      FROM pre_event_forecasts WHERE kind = 'DAILY' AND NOT is_test AND created_at BETWEEN $1 AND $2 ORDER BY id`, [from, to])) || [];
    say(`  due releases ${st.due ?? '?'} · forecasts in job ${st.forecasts ?? '?'} · calendar synced ${st.calendar_synced ?? '?'}`);
    for (const f of rows) say(`  forecast #${f.id} ${f.event_type} at ${iso(f.scheduled_at)}: ${f.forecast_state} score ${f.pre_event_score} conf ${f.confidence} · sent ${f.sent} · ${f.ai_status}`);
    const expected = Number(st.forecasts) || 0;
    return { expected, stored: rows.length, note: expected ? '' : `no qualifying release within ${Number(env.GI_PREEVENT_LOOKAHEAD_HOURS) || 36} h (due ${st.due ?? 0}); correct empty run, forecast + delivery path not exercised by this run` };
  },
};

const DAILY_REPORT = {
  label: 'DAILY_REPORT', workflowId: 'giDailyReport001', hour: DAILY_HOUR,
  jobs: ['DAILY_SCHEDULED', 'DAILY_MANUAL'], scheduledJobs: ['DAILY_SCHEDULED'],
  messageTypes: ['DAILY'], productName: 'report',
  dedupLike: (day) => `daily:${day}`,
  async product(gi, from, to) {
    const rows = (await tryQuery(gi, `SELECT id, mode, model, regime, tactical_bias, confidence, data_quality FROM analysis_results
      WHERE analysis_type = 'DAILY' AND NOT is_test AND created_at BETWEEN $1 AND $2 ORDER BY id`, [from, to])) || [];
    for (const a of rows) say(`  report analysis #${a.id}: ${a.mode}${a.model ? ` (${a.model})` : ''} · regime ${a.regime} · tactical ${a.tactical_bias} · conf ${a.confidence} · data ${a.data_quality}`);
    const cal = await tryQuery(gi, `SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'CALIBRATED')::int AS ok FROM calibration_cells WHERE built_at BETWEEN $1 AND $2`, [from, new Date(ms(to) + 300000)]);
    if (cal && cal[0]) say(`  calibration rebuilt after the report: ${cal[0].n} cells (${cal[0].ok} CALIBRATED)`);
    return { expected: 1, stored: rows.length, note: '' };
  },
};

// ---- AI fallback chain -------------------------------------------------------------------------
/** Degradation of one model from its health record and its latest attempts (newest first). */
function classify(h, recent, now = NOW) {
  const last = recent[0];
  const fails24 = recent.filter((r) => r.request_status === 'FAILED' && ms(r.request_timestamp) > now - 86400000);
  const oks24 = recent.filter((r) => r.request_status === 'SUCCESS' && ms(r.request_timestamp) > now - 86400000);
  if (h && h.listed === false) return ['PERSISTENT', 'not in the provider model list'];
  if (h && h.free === false) return ['PERSISTENT', 'no longer free'];
  if (!recent.length) return ['NO DATA', 'no recorded request'];
  if (last && ['MODEL_UNAVAILABLE', 'AUTH_ERROR'].includes(last.error_type)) return ['PERSISTENT', `last error ${last.error_type}`];
  if (last && last.request_status === 'SUCCESS' && fails24.length === 0) return ['NONE', `last request succeeded, no failed attempt (latest ${recent.length}, 24 h)`];
  if (last && last.request_status === 'SUCCESS') return ['TEMPORARY', `recovered: last request succeeded after ${fails24.length} failed attempt(s) (latest ${recent.length}, 24 h)`];
  const rl = fails24.filter((r) => ['RATE_LIMIT', 'QUOTA_EXHAUSTED'].includes(r.error_type) || r.http_status === 429).length;
  const firstFail = fails24.length ? Math.min(...fails24.map((r) => ms(r.request_timestamp))) : now;
  if (oks24.length === 0 && fails24.length >= 3 && now - firstFail > 6 * 3600000) return ['PERSISTENT', `${fails24.length} failed attempts and no success over ${Math.round((now - firstFail) / 3600000)} h`];
  if (rl && rl === fails24.length) return ['TEMPORARY', `${rl} upstream rate-limit failure(s) (429 / quota); clears with the provider window`];
  return ['UNDETERMINED', `${fails24.length} failed / ${oks24.length} successful of the latest ${recent.length} attempts in 24 h (${[...new Set(fails24.map((r) => r.error_type))].join(', ')}); needs more requests to tell`];
}

async function verifyAi(gi) {
  say(`\n=== AI FALLBACK CHAIN (recorded requests only; this script sends none) ===`);
  const chain = cfg.ai.models || [];
  const health = Object.fromEntries(((await tryQuery(gi, "SELECT * FROM ai_model_health WHERE provider = 'openrouter'")) || []).map((r) => [r.model, r]));
  const summary = [];
  for (const [i, model] of chain.entries()) {
    const rank = ['PRIMARY', 'SECONDARY', 'TERTIARY'][i] || `RANK ${i + 1}`;
    const agg = ((await tryQuery(gi, `SELECT
        count(*) FILTER (WHERE request_status = 'SUCCESS')::int AS ok, count(*) FILTER (WHERE request_status = 'FAILED')::int AS fail,
        count(*) FILTER (WHERE request_status = 'CACHED')::int AS cached, count(*) FILTER (WHERE is_test)::int AS test_rows,
        count(*) FILTER (WHERE request_status = 'SUCCESS' AND request_timestamp > now() - interval '24 hours')::int AS ok24,
        count(*) FILTER (WHERE request_status = 'FAILED' AND request_timestamp > now() - interval '24 hours')::int AS fail24,
        max(request_timestamp) FILTER (WHERE request_status = 'SUCCESS') AS last_ok, max(request_timestamp) FILTER (WHERE request_status = 'FAILED') AS last_fail,
        count(*) FILTER (WHERE fallback_level > 0 AND request_status IN ('SUCCESS', 'FAILED'))::int AS as_fallback,
        count(*) FILTER (WHERE fallback_level > 0 AND request_status = 'SUCCESS')::int AS fallback_ok,
        count(*) FILTER (WHERE http_status = 429)::int AS http429,
        count(*) FILTER (WHERE ratelimit_limit IS NOT NULL OR ratelimit_remaining IS NOT NULL OR retry_after_s IS NOT NULL)::int AS rl_headers,
        min(ratelimit_remaining) AS rl_min_remaining, max(retry_after_s) AS max_retry_after, max(ratelimit_reset) AS last_reset,
        round(avg(latency_ms) FILTER (WHERE request_status = 'SUCCESS'))::int AS avg_ms
      FROM ai_usage WHERE provider = 'openrouter' AND model = $1`, [model])) || [{}])[0];
    const types = (await tryQuery(gi, `SELECT coalesce(error_type, '?') AS t, count(*)::int AS n, max(request_timestamp) AS last FROM ai_usage
      WHERE provider = 'openrouter' AND model = $1 AND request_status = 'FAILED' GROUP BY 1 ORDER BY 2 DESC`, [model])) || [];
    const recent = (await tryQuery(gi, `SELECT request_timestamp, request_status, error_type, http_status, fallback_level, workflow, left(coalesce(error_detail, ''), 120) AS detail
      FROM ai_usage WHERE provider = 'openrouter' AND model = $1 AND request_status IN ('SUCCESS', 'FAILED') ORDER BY request_timestamp DESC LIMIT 12`, [model])) || [];
    const h = health[model];
    const now = h ? modelHealth(h, NOW) : { status: 'UNKNOWN', reason: 'no health record' };
    const [degradation, why] = classify(h, recent);
    say(`\n${rank}: ${model}`);
    say(`  successes ${agg.ok ?? 0} · failures ${agg.fail ?? 0} · cached ${agg.cached ?? 0} · (24 h: ${agg.ok24 ?? 0} ok / ${agg.fail24 ?? 0} failed) · test rows ${agg.test_rows ?? 0} · avg latency ${agg.avg_ms ?? '—'} ms`);
    say(`  last success ${both(agg.last_ok)} ${age(agg.last_ok)}`);
    say(`  last failure ${both(agg.last_fail)} ${age(agg.last_fail)}`);
    say(`  failure types: ${types.length ? types.map((t) => `${t.t} ${t.n}× (last ${iso(t.last)})`).join(' · ') : 'none'}`);
    say(`  rate-limit evidence: HTTP 429 ${agg.http429 ?? 0}× · rows with rate-limit headers ${agg.rl_headers ?? 0}${agg.max_retry_after ? ` · max retry-after ${agg.max_retry_after} s` : ''}${agg.rl_min_remaining !== null && agg.rl_min_remaining !== undefined ? ` · min remaining ${agg.rl_min_remaining}` : ''}${agg.last_reset ? ` · last reset ${iso(agg.last_reset)}` : ''}`);
    say(`  fallback: used as fallback ${agg.as_fallback ?? 0}× (${agg.fallback_ok ?? 0} succeeded)${i < chain.length - 1 ? ` · own failures that passed the request down the chain: ${agg.fail ?? 0}` : ` · own failures that ended in DETERMINISTIC: ${agg.fail ?? 0}`}`);
    if (h) say(`  health record: ${h.current_status}${h.status_reason ? ` (${h.status_reason})` : ''} · consecutive failures ${h.consecutive_failures} · listed ${h.listed} · free ${h.free} · skip until ${iso(h.skip_until)} · last check ${iso(h.last_health_check)} · last probe ${iso(h.last_probe_at)}`);
    say(`  current health (now): ${now.status}${now.reason ? ` — ${now.reason}` : ''}`);
    say(`  degradation: ${degradation} — ${why}`);
    say(`  last ${recent.length} attempts (newest first): ${recent.map((r) => (r.request_status === 'SUCCESS' ? 'OK' : `✗${r.error_type || r.http_status || ''}`)).join(' ') || '—'}`);
    const lastFail = recent.find((r) => r.request_status === 'FAILED');
    if (lastFail && lastFail.detail) say(`  last failure detail: HTTP ${lastFail.http_status ?? '—'} · ${lastFail.workflow || ''} · ${lastFail.detail}`);
    summary.push({ rank, model, status: now.status, degradation, why, ok: agg.ok ?? 0, fail: agg.fail ?? 0 });
  }
  const det = (await tryQuery(gi, `SELECT count(*)::int AS n, count(*) FILTER (WHERE request_timestamp > now() - interval '24 hours')::int AS n24, max(request_timestamp) AS last
    FROM ai_usage WHERE provider = 'deterministic'`)) || [{}];
  const reasons = (await tryQuery(gi, `SELECT left(coalesce(error_type, error_detail, '?'), 60) AS r, count(*)::int AS n FROM ai_usage
    WHERE provider = 'deterministic' AND request_timestamp > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC LIMIT 6`)) || [];
  say(`\nDETERMINISTIC fallbacks: ${det[0].n ?? 0} total · ${det[0].n24 ?? 0} in 24 h · last ${both(det[0].last)}${reasons.length ? ` · 24 h reasons: ${reasons.map((r) => `${r.r} ${r.n}×`).join(' · ')}` : ''}`);
  const keys = (await tryQuery(gi, 'SELECT key_alias, status, free_requests_used, free_requests_limit, free_requests_remaining, checked_at FROM ai_api_keys')) || [];
  for (const k of keys) say(`provider counter (${k.key_alias}): ${k.status} · free-model requests ${k.free_requests_used ?? '?'} / ${k.free_requests_limit ?? '?'} (remaining ${k.free_requests_remaining ?? '?'}) · checked ${both(k.checked_at)}`);
  return summary;
}

// ---- stability (context for the blockers) ------------------------------------------------------
async function stability(gi, n8n) {
  say('\n=== EXECUTIONS, LAST 24 H (n8n) ===');
  const rows = (await tryQuery(n8n, `SELECT "workflowId" AS w, mode, status, count(*)::int AS n FROM ${PREFIX}execution_entity
    WHERE coalesce("startedAt", "createdAt") > now() - interval '24 hours' AND "deletedAt" IS NULL GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`)) || [];
  const byWf = {};
  for (const r of rows) (byWf[r.w] = byWf[r.w] || []).push(`${r.mode}/${r.status} ${r.n}`);
  for (const [w, s] of Object.entries(byWf)) say(`  ${w}: ${s.join(' · ')}`);
  const errs = (await tryQuery(gi, `SELECT coalesce(workflow_name, workflow_id) AS w, coalesce(error_type, '?') AS t, count(*)::int AS n, max(occurred_at) AS last
    FROM error_events WHERE occurred_at > now() - interval '24 hours' GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10`)) || [];
  say(`  error_events (24 h): ${errs.length ? '' : 'none'}`);
  for (const e of errs) say(`    ${e.w} · ${e.t} · ${e.n}× · last ${iso(e.last)}`);
  return { crashed: rows.filter((r) => ['crashed', 'error'].includes(r.status)) };
}

async function main() {
  const gi = client(env.GI_PG_DATABASE || 'gold_intel');
  const n8n = client(env.N8N_DB_DATABASE || 'n8n');
  await gi.connect();
  await n8n.connect();
  try {
    await gi.query('SET default_transaction_read_only = on');
    await n8n.query('SET default_transaction_read_only = on');
    say(`GOLD INTELLIGENCE — LIVE VERIFICATION (read-only) · now ${both(NOW)} · window ${DAYS} day(s)`);
    say(`slot rule: scheduled = n8n mode 'trigger', started within −${SLOT_BEFORE_MS / 60000}/+${SLOT_AFTER_MS / 60000} min of the slot; manual runs are never counted`);
    const pre = await verifyJob(gi, n8n, PRE_EVENT);
    const daily = await verifyJob(gi, n8n, DAILY_REPORT);
    const ai = await verifyAi(gi);
    const stab = await stability(gi, n8n);
    const verdictOf = (res) => {
      const done = res.filter((r) => r.verdict !== 'PENDING');
      if (!done.length) return 'NOT VERIFIED — no slot reached yet';
      const firstRun = done.find((r) => r.execution);
      if (!firstRun) return `NOT VERIFIED — no scheduled run found (${done.map((r) => `${r.day}: ${r.reason}`).join(' | ')})`;
      const fails = done.filter((r) => r.verdict === 'FAIL');
      const passes = done.filter((r) => r.verdict.startsWith('PASS'));
      const head = fails.length ? 'FAIL' : passes.every((r) => r.verdict === 'PASS (nothing due)') ? 'PASS (execution only — nothing was due, delivery not exercised)' : 'PASS';
      return `${head} — ${done.map((r) => `${r.day}: ${r.verdict}${r.execution ? ` #${r.execution}` : ''}${r.reason && r.verdict !== 'PASS' ? ` (${r.reason})` : ''}`).join(' | ')}`;
    };
    say('\n=== SUMMARY ===');
    say(`PRE_EVENT = ${verdictOf(pre)}`);
    say(`DAILY_REPORT = ${verdictOf(daily)}`);
    for (const a of ai) say(`AI ${a.rank} = ${a.model}: ${a.status} · degradation ${a.degradation} (${a.why}) · ${a.ok} ok / ${a.fail} failed`);
    if (stab.crashed.length) say(`EXECUTION ERRORS (24 h) = ${stab.crashed.map((r) => `${r.w} ${r.mode}/${r.status} ${r.n}`).join(' · ')}`);
    say(`(secret values redacted from this output: ${redactions})`);
  } finally {
    await gi.end();
    await n8n.end();
  }
  console.log(lines.join('\n'));
}

if (require.main === module) main().catch((err) => { console.error(redact(err.message)); process.exit(1); });

module.exports = { localSlotUtc, classify };
