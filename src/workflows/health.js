'use strict';
// GI · Health Monitor.
const S = require('./shared/ai-sql');

module.exports = {
  id: 'giHealthMonitor1',
  file: 'gold-intelligence-health.json',
  build(h) {
    h.lane(0);
    const sched = h.schedule('⏱ Health Schedule', { field: 'minutes', minutesInterval: '={{ Number($env.GI_HEALTH_INTERVAL_MIN) || 5 }}' }, { notes: 'GI_HEALTH_INTERVAL_MIN' });
    const mA = h.code('Mode: Scheduled', 'health/mode-scheduled.js');
    h.lane(1);
    const manual = h.manual('🧪 Health Check');
    const mM = h.code('Mode: Manual', 'health/mode-manual.js');
    h.at(2, 0);
    const collect = h.pg('Collect Health', `
SELECT ($1::jsonb)->>'mode' AS mode, now() AS checked_at,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'tier', tier, 'last_ok_at', last_ok_at, 'consecutive_failures', consecutive_failures, 'last_error', last_error)), '[]'::jsonb)
    FROM sources WHERE enabled AND poll_group = 'news') AS sources,
 (SELECT coalesce(jsonb_object_agg(job, x), '{}'::jsonb) FROM (
    SELECT DISTINCT ON (job) job, jsonb_build_object('started_at', started_at, 'finished_at', finished_at, 'status', status) AS x
    FROM job_runs WHERE NOT is_test ORDER BY job, started_at DESC) j) AS jobs,
 (SELECT max(fetched_at) FROM gold_observations WHERE source = 'gold-api.com') AS last_gold_fetch,
 (SELECT jsonb_build_object('total', count(*), 'success', count(*) FILTER (WHERE success),
         'rate_limited', count(*) FILTER (WHERE failure_reason LIKE 'RATE_LIMITED%'), 'last_success', max(created_at) FILTER (WHERE success))
    FROM ai_runs WHERE created_at > now() - interval '24 hours' AND NOT is_test) AS ai_24h,
 (SELECT count(*) FROM ai_runs WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Africa/Casablanca') AT TIME ZONE 'Africa/Casablanca'))::int AS ai_used_today,
 (SELECT jsonb_build_object('sent', count(*) FILTER (WHERE status = 'SENT'), 'failed', count(*) FILTER (WHERE status = 'FAILED'),
         'last_sent', max(created_at) FILTER (WHERE status = 'SENT'))
    FROM telegram_messages WHERE direction = 'OUT' AND created_at > now() - interval '24 hours') AS tg_24h,
 (SELECT count(*) FROM error_events WHERE occurred_at > now() - interval '1 hour')::int AS errors_1h,
 pg_database_size(current_database()) AS db_bytes,
 (SELECT value FROM kv_state WHERE key = 'health_state') AS health_state,
 (SELECT value FROM kv_state WHERE key = 'models_check') AS models_check,
 (SELECT count(*) FROM historical_event_reactions)::int AS hist_rows,
 ${S.COUNTERS_SQL} AS ai_counters,
 ${S.HEALTH_ROWS_SQL} AS ai_health,
 ${S.KEY_ROW_SQL} AS ai_key,
 ${S.ALERT_STATE_SQL} AS ai_alert_state,
 ${S.LAST_FAILURES_SQL} AS ai_last_failures,
 (SELECT coalesce(jsonb_object_agg(model, jsonb_build_object('requests_today', n, 'tokens_today', t)), '{}'::jsonb) FROM (
    SELECT model, count(*) AS n, coalesce(sum(total_tokens), 0) AS t FROM ai_usage
    WHERE request_status IN ('SUCCESS', 'FAILED') AND request_timestamp >= ${S.UTC_DAY} GROUP BY model) x) AS ai_per_model_today`, '$json');
    const aiCheck = h.code('AI Health Check', 'health/ai-check.js', { notes: 'model list · GET /api/v1/key counter · idle-model tiny probes · quota & alerts' });
    const aiRecord = h.pg('Record AI Health', S.RECORD_SQL, '$json.record', { notes: 'probe usage, model health, key status, alert state' });
    const evaluate = h.code('Evaluate Health', 'health/evaluate.js', { notes: 'components · free-model availability · overall' });
    const persist = h.pg('Persist Health', `
WITH p AS (SELECT $1::jsonb AS j),
hs AS (
  INSERT INTO system_health (component, status, detail, metrics)
  SELECT c->>'component', c->>'status', c->>'detail', c->'metrics' FROM p, jsonb_array_elements(p.j->'components') c RETURNING 1
),
ov AS (
  INSERT INTO system_health (component, status, detail) SELECT 'OVERALL', p.j->>'overall', NULL FROM p RETURNING 1
),
k1 AS (
  INSERT INTO kv_state (key, value, updated_at) SELECT 'health_state', p.j->'health_state', now() FROM p
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() RETURNING 1
),
k2 AS (
  INSERT INTO kv_state (key, value, updated_at) SELECT 'health_overall', jsonb_build_object('overall', p.j->>'overall', 'at', now()), now() FROM p
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() RETURNING 1
),
k3 AS (
  INSERT INTO kv_state (key, value, updated_at) SELECT 'models_check', p.j->'models_check', now() FROM p WHERE p.j->'models_check' IS NOT NULL
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() RETURNING 1
),
prune AS (
  DELETE FROM system_health WHERE checked_at < now() - interval '30 days' RETURNING 1
)
SELECT (SELECT count(*) FROM hs)::int AS components, (SELECT count(*) FROM prune)::int AS pruned`, '$json.record');
    const alertIf = h.ifTrue('Degradation Alert?', "$('Evaluate Health').first().json.send === true || ($('AI Health Check').first().json.ai_messages || []).length > 0");
    const payload = h.code('Health Alert Payload', 'health/alert-payload.js');
    const tg = h.callWorkflow('Send Health Alert', 'giTelegramSend01');
    h.chain(sched, mA, collect);
    h.chain(manual, mM, collect);
    h.chain(collect, aiCheck, aiRecord, evaluate, persist, alertIf);
    h.connect(alertIf, payload, 0);
    h.chain(payload, tg);
    h.note('About', '## GI · Health Monitor\nPipelines, market-data freshness, source failures, AI (every `AI_HEALTH_CHECK_INTERVAL`: model list — exists / still free; `GET /api/v1/key` free-model counter; tiny probe only for idle models), Telegram, errors, historical DB. Alerts on degradation with cooldown `GI_TECH_ALERT_COOLDOWN_MIN`; AI quota/limit/fallback alerts once per state change.', [0, 420], [560, 180], 5);
    return h.result({ name: 'GI · Health Monitor', saveSuccess: 'all' });
  },
};
