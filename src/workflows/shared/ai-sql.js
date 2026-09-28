'use strict';
// Shared SQL for AI usage monitoring (used by the AI Analyst, Health Monitor, Telegram Bot and
// Daily Report workflows). Days/hours are UTC buckets (OpenRouter resets free counters at 00:00 UTC).

const UTC_DAY = "(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')";
// A "fallback event": answered by a lower-ranked model, or no model answered and the deterministic
// engine was used after real failures. Not-configured / not-eligible / budget skips are not fallbacks.
const FALLBACK_EVENT = "((request_status = 'SUCCESS' AND fallback_level > 0) OR (request_status = 'FALLBACK' AND error_type IN ('ALL_MODELS_FAILED', 'MAX_ATTEMPTS_REACHED')))";

/** Quota counters (jsonb) — the router's and the alert engine's view of current usage. */
const COUNTERS_SQL = `(SELECT jsonb_build_object(
    'requests_today', count(*) FILTER (WHERE real AND ts >= ${UTC_DAY}),
    'requests_hour', count(*) FILTER (WHERE real AND ts > now() - interval '1 hour'),
    'tokens_today', coalesce(sum(total_tokens) FILTER (WHERE real AND ts >= ${UTC_DAY}), 0),
    'tokens_reported_today', count(total_tokens) FILTER (WHERE real AND ts >= ${UTC_DAY}),
    'free_requests_since_key_check', count(*) FILTER (WHERE real AND model LIKE '%:free'
        AND ts > coalesce((SELECT checked_at FROM ai_api_keys WHERE provider = 'openrouter' ORDER BY updated_at DESC LIMIT 1), now() + interval '1 day')),
    'quota_exhausted_today', coalesce(bool_or(error_type = 'QUOTA_EXHAUSTED' AND ts >= ${UTC_DAY}
        AND ts > coalesce((SELECT max(request_timestamp) FROM ai_usage WHERE request_status = 'SUCCESS'), '-infinity'::timestamptz)), false),
    'fallbacks_1h', count(*) FILTER (WHERE ts > now() - interval '1 hour' AND ${FALLBACK_EVENT}),
    'failures_today', count(*) FILTER (WHERE request_status = 'FAILED' AND ts >= ${UTC_DAY}))
  FROM (SELECT request_timestamp AS ts, request_status IN ('SUCCESS', 'FAILED') AS real, model, total_tokens, error_type, request_status, fallback_level
        FROM ai_usage WHERE request_timestamp > now() - interval '25 hours') u)`;

const HEALTH_ROWS_SQL = `(SELECT coalesce(jsonb_agg(to_jsonb(h)), '[]'::jsonb) FROM ai_model_health h WHERE h.provider = 'openrouter')`;
const KEY_ROW_SQL = `(SELECT to_jsonb(k) FROM ai_api_keys k WHERE k.provider = 'openrouter' ORDER BY k.updated_at DESC LIMIT 1)`;
const ALERT_STATE_SQL = `(SELECT value FROM kv_state WHERE key = 'ai_alert_state')`;
const LAST_FAILURES_SQL = `(SELECT coalesce(jsonb_object_agg(model, jsonb_build_object('error_type', error_type, 'detail', error_detail, 'at', request_timestamp)), '{}'::jsonb) FROM (
    SELECT DISTINCT ON (model) model, error_type, error_detail, request_timestamp FROM ai_usage
    WHERE request_status = 'FAILED' AND request_timestamp > now() - interval '24 hours' ORDER BY model, request_timestamp DESC) f)`;

/** Full snapshot for /usage, /ai views and the daily-report section. */
const SNAPSHOT_SQL = `(SELECT jsonb_build_object(
  'counters', ${COUNTERS_SQL},
  'health', ${HEALTH_ROWS_SQL},
  'key', ${KEY_ROW_SQL},
  'alert_state', ${ALERT_STATE_SQL},
  'last_failures', ${LAST_FAILURES_SQL},
  'per_model', (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) FROM (
      SELECT provider, model,
        count(*) FILTER (WHERE real AND ts >= ${UTC_DAY}) AS requests_today,
        count(*) FILTER (WHERE real AND ts > now() - interval '1 hour') AS requests_hour,
        count(*) FILTER (WHERE real AND ts > now() - interval '24 hours') AS requests_24h,
        count(*) FILTER (WHERE request_status = 'SUCCESS' AND ts > now() - interval '24 hours') AS success_24h,
        count(*) FILTER (WHERE request_status = 'FAILED' AND ts >= ${UTC_DAY}) AS failures_today,
        count(*) FILTER (WHERE real AND fallback_level > 0 AND ts >= ${UTC_DAY}) AS fallbacks_today,
        coalesce(sum(total_tokens) FILTER (WHERE real AND ts >= ${UTC_DAY}), 0) AS tokens_today,
        count(total_tokens) FILTER (WHERE real AND ts >= ${UTC_DAY}) AS tokens_reported_today,
        max(ts) FILTER (WHERE real) AS last_request,
        max(ts) FILTER (WHERE request_status = 'SUCCESS') AS last_success_request
      FROM (SELECT *, request_timestamp AS ts, request_status IN ('SUCCESS', 'FAILED') AS real FROM ai_usage
            WHERE request_timestamp > now() - interval '30 days') u
      GROUP BY provider, model) x),
  'totals', (SELECT jsonb_build_object(
      'requests_today', count(*) FILTER (WHERE real AND ts >= ${UTC_DAY}),
      'tokens_today', coalesce(sum(total_tokens) FILTER (WHERE real AND ts >= ${UTC_DAY}), 0),
      'tokens_reported_today', count(total_tokens) FILTER (WHERE real AND ts >= ${UTC_DAY}),
      'failures_today', count(*) FILTER (WHERE request_status = 'FAILED' AND ts >= ${UTC_DAY}),
      'fallback_events_today', count(*) FILTER (WHERE ts >= ${UTC_DAY} AND ${FALLBACK_EVENT}),
      'deterministic_today', count(*) FILTER (WHERE request_status = 'FALLBACK' AND ts >= ${UTC_DAY} AND error_type NOT IN ('NOT_ELIGIBLE')),
      'cached_today', count(*) FILTER (WHERE request_status = 'CACHED' AND ts >= ${UTC_DAY}),
      'cost_today', sum(cost) FILTER (WHERE real AND ts >= ${UTC_DAY}),
      'cost_reported_today', count(cost) FILTER (WHERE real AND ts >= ${UTC_DAY}),
      'requests_7d', count(*) FILTER (WHERE real AND ts > now() - interval '7 days'),
      'cost_7d', sum(cost) FILTER (WHERE real AND ts > now() - interval '7 days'),
      'cost_7d_reported', count(cost) FILTER (WHERE real AND ts > now() - interval '7 days'),
      'requests_30d', count(*) FILTER (WHERE real),
      'cost_30d', sum(cost) FILTER (WHERE real),
      'cost_30d_reported', count(cost) FILTER (WHERE real),
      'requests_24h', count(*) FILTER (WHERE real AND ts > now() - interval '24 hours'),
      'tokens_24h', coalesce(sum(total_tokens) FILTER (WHERE real AND ts > now() - interval '24 hours'), 0),
      'tokens_reported_24h', count(total_tokens) FILTER (WHERE real AND ts > now() - interval '24 hours'),
      'failures_24h', count(*) FILTER (WHERE request_status = 'FAILED' AND ts > now() - interval '24 hours'),
      'fallbacks_24h', count(*) FILTER (WHERE ts > now() - interval '24 hours' AND ${FALLBACK_EVENT}),
      'deterministic_24h', count(*) FILTER (WHERE request_status = 'FALLBACK' AND ts > now() - interval '24 hours' AND error_type NOT IN ('NOT_ELIGIBLE')))
    FROM (SELECT *, request_timestamp AS ts, request_status IN ('SUCCESS', 'FAILED') AS real FROM ai_usage
          WHERE request_timestamp > now() - interval '30 days') u),
  'top_requests_24h', (SELECT model FROM ai_usage WHERE request_status IN ('SUCCESS', 'FAILED') AND request_timestamp > now() - interval '24 hours'
      GROUP BY model ORDER BY count(*) DESC, model LIMIT 1),
  'top_tokens_24h', (SELECT model FROM ai_usage WHERE total_tokens IS NOT NULL AND request_timestamp > now() - interval '24 hours'
      GROUP BY model ORDER BY sum(total_tokens) DESC, model LIMIT 1),
  'last_used', (SELECT jsonb_build_object('model', model, 'at', request_timestamp, 'fallback_level', fallback_level, 'status', request_status)
      FROM ai_usage WHERE request_status IN ('SUCCESS', 'CACHED') ORDER BY request_timestamp DESC LIMIT 1),
  'last_fallback', (SELECT jsonb_build_object('model', f.model, 'at', f.request_timestamp,
        'reason', (SELECT e.error_type FROM ai_usage e WHERE e.related_ref IS NOT DISTINCT FROM f.related_ref AND e.request_status = 'FAILED'
                   AND e.request_timestamp BETWEEN f.request_timestamp - interval '10 minutes' AND f.request_timestamp ORDER BY e.request_timestamp DESC LIMIT 1))
      FROM ai_usage f WHERE ((f.request_status = 'SUCCESS' AND f.fallback_level > 0) OR (f.request_status = 'FALLBACK' AND f.error_type IN ('ALL_MODELS_FAILED', 'MAX_ATTEMPTS_REACHED')))
      ORDER BY f.request_timestamp DESC LIMIT 1),
  'failures', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.request_timestamp DESC), '[]'::jsonb) FROM (
      SELECT f.request_timestamp, f.provider, f.model, f.error_type, f.error_detail, f.fallback_level, f.workflow, f.event_type,
        (SELECT s.model FROM ai_usage s WHERE s.related_ref IS NOT DISTINCT FROM f.related_ref AND s.request_status IN ('SUCCESS', 'FALLBACK', 'CACHED')
           AND s.request_timestamp BETWEEN f.request_timestamp AND f.request_timestamp + interval '10 minutes' ORDER BY s.request_timestamp LIMIT 1) AS resolved_by
      FROM ai_usage f WHERE f.request_status = 'FAILED' ORDER BY f.request_timestamp DESC LIMIT 10) x),
  'performance', (SELECT coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) FROM forecast_performance_by_model p)
))`;

/**
 * Records one batch (router results or health probes). Input $1 = {
 *   runs[] (ai_runs), usage[] (ai_usage rows), model_health[] (full rows), cache_upserts[], cache_hits[],
 *   key_update{}, alert_state{}, quota_state }.
 */
const RECORD_SQL = `
WITH p AS (SELECT $1::jsonb AS j),
runs AS (
  INSERT INTO ai_runs (purpose, provider, model, model_rank, success, failure_reason, http_status, latency_ms,
                       prompt_tokens, completion_tokens, total_tokens, validation, related_ref, is_test)
  SELECT r->>'purpose', r->>'provider', r->>'model', (r->>'model_rank')::smallint, (r->>'success')::boolean,
         r->>'failure_reason', (r->>'http_status')::int, (r->>'latency_ms')::int, (r->>'prompt_tokens')::int,
         (r->>'completion_tokens')::int, (r->>'total_tokens')::int, r->'validation', r->>'related_ref',
         coalesce((r->>'is_test')::boolean, false)
  FROM p, jsonb_array_elements(coalesce(p.j->'runs', '[]'::jsonb)) r
  RETURNING 1
),
u AS (
  INSERT INTO ai_usage (provider, model, key_alias, request_timestamp, input_tokens, output_tokens, total_tokens, cost,
                        request_status, latency_ms, fallback_level, error_type, error_detail, http_status, ratelimit_limit,
                        ratelimit_remaining, ratelimit_reset, retry_after_s, workflow, event_type, priority, related_ref,
                        fingerprint, is_test)
  SELECT x->>'provider', x->>'model', x->>'key_alias', coalesce((x->>'request_timestamp')::timestamptz, now()),
         (x->>'input_tokens')::int, (x->>'output_tokens')::int, (x->>'total_tokens')::int, (x->>'cost')::numeric,
         x->>'request_status', (x->>'latency_ms')::int, coalesce((x->>'fallback_level')::smallint, 0), x->>'error_type',
         left(x->>'error_detail', 300), (x->>'http_status')::int, (x->>'ratelimit_limit')::int, (x->>'ratelimit_remaining')::int,
         (x->>'ratelimit_reset')::timestamptz, (x->>'retry_after_s')::int, x->>'workflow', x->>'event_type',
         (x->>'priority')::smallint, x->>'related_ref', x->>'fingerprint', coalesce((x->>'is_test')::boolean, false)
  FROM p, jsonb_array_elements(coalesce(p.j->'usage', '[]'::jsonb)) x
  RETURNING provider, model, request_timestamp, request_status, fallback_level, input_tokens, output_tokens, total_tokens, cost
),
d AS (
  INSERT INTO ai_usage_daily AS t (date, provider, model, requests, successful_requests, failed_requests, fallback_requests,
        cached_requests, token_reported_requests, input_tokens, output_tokens, total_tokens, cost_reported_requests,
        estimated_cost, quota_state, last_request_at)
  SELECT (request_timestamp AT TIME ZONE 'UTC')::date, provider, model,
         count(*) FILTER (WHERE request_status IN ('SUCCESS', 'FAILED')),
         count(*) FILTER (WHERE request_status = 'SUCCESS'),
         count(*) FILTER (WHERE request_status = 'FAILED'),
         count(*) FILTER (WHERE fallback_level > 0 AND request_status IN ('SUCCESS', 'FAILED', 'FALLBACK')),
         count(*) FILTER (WHERE request_status = 'CACHED'),
         count(total_tokens), coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0), coalesce(sum(total_tokens), 0),
         count(cost), sum(cost), coalesce((SELECT p.j->>'quota_state' FROM p), 'UNKNOWN'),
         max(request_timestamp) FILTER (WHERE request_status IN ('SUCCESS', 'FAILED'))
  FROM u GROUP BY 1, 2, 3
  ON CONFLICT (date, provider, model) DO UPDATE SET
    requests = t.requests + EXCLUDED.requests,
    successful_requests = t.successful_requests + EXCLUDED.successful_requests,
    failed_requests = t.failed_requests + EXCLUDED.failed_requests,
    fallback_requests = t.fallback_requests + EXCLUDED.fallback_requests,
    cached_requests = t.cached_requests + EXCLUDED.cached_requests,
    token_reported_requests = t.token_reported_requests + EXCLUDED.token_reported_requests,
    input_tokens = t.input_tokens + EXCLUDED.input_tokens,
    output_tokens = t.output_tokens + EXCLUDED.output_tokens,
    total_tokens = t.total_tokens + EXCLUDED.total_tokens,
    cost_reported_requests = t.cost_reported_requests + EXCLUDED.cost_reported_requests,
    estimated_cost = CASE WHEN EXCLUDED.estimated_cost IS NULL THEN t.estimated_cost ELSE coalesce(t.estimated_cost, 0) + EXCLUDED.estimated_cost END,
    quota_state = EXCLUDED.quota_state,
    last_request_at = GREATEST(t.last_request_at, EXCLUDED.last_request_at)
  RETURNING 1
),
hr AS (
  INSERT INTO ai_usage_hourly AS t (hour_bucket, provider, model, requests, tokens, failures, fallbacks)
  SELECT date_trunc('hour', request_timestamp AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', provider, model,
         count(*) FILTER (WHERE request_status IN ('SUCCESS', 'FAILED')), coalesce(sum(total_tokens), 0),
         count(*) FILTER (WHERE request_status = 'FAILED'),
         count(*) FILTER (WHERE fallback_level > 0 AND request_status IN ('SUCCESS', 'FAILED', 'FALLBACK'))
  FROM u GROUP BY 1, 2, 3
  ON CONFLICT (hour_bucket, provider, model) DO UPDATE SET
    requests = t.requests + EXCLUDED.requests, tokens = t.tokens + EXCLUDED.tokens,
    failures = t.failures + EXCLUDED.failures, fallbacks = t.fallbacks + EXCLUDED.fallbacks
  RETURNING 1
),
mh AS (
  INSERT INTO ai_model_health AS t (provider, model, display_name, rank, listed, free, context_length, last_success, last_failure,
        last_error_type, success_count, failure_count, consecutive_failures, average_latency, latency_samples, current_status,
        status_reason, skip_until, current_fallback_level, last_health_check, last_probe_at, updated_at)
  SELECT m->>'provider', m->>'model', m->>'display_name', (m->>'rank')::smallint, (m->>'listed')::boolean, (m->>'free')::boolean,
         (m->>'context_length')::int, (m->>'last_success')::timestamptz, (m->>'last_failure')::timestamptz, m->>'last_error_type',
         coalesce((m->>'success_count')::int, 0), coalesce((m->>'failure_count')::int, 0), coalesce((m->>'consecutive_failures')::int, 0),
         (m->>'average_latency')::int, coalesce((m->>'latency_samples')::int, 0), coalesce(m->>'current_status', 'UNKNOWN'),
         m->>'status_reason', (m->>'skip_until')::timestamptz, (m->>'current_fallback_level')::smallint,
         (m->>'last_health_check')::timestamptz, (m->>'last_probe_at')::timestamptz, now()
  FROM p, jsonb_array_elements(coalesce(p.j->'model_health', '[]'::jsonb)) m
  WHERE coalesce(m->>'write', 'full') = 'full'
  ON CONFLICT (provider, model) DO UPDATE SET
    display_name = coalesce(EXCLUDED.display_name, t.display_name), rank = EXCLUDED.rank,
    listed = coalesce(EXCLUDED.listed, t.listed), free = coalesce(EXCLUDED.free, t.free),
    context_length = coalesce(EXCLUDED.context_length, t.context_length),
    last_success = GREATEST(t.last_success, EXCLUDED.last_success), last_failure = GREATEST(t.last_failure, EXCLUDED.last_failure),
    last_error_type = EXCLUDED.last_error_type, success_count = EXCLUDED.success_count, failure_count = EXCLUDED.failure_count,
    consecutive_failures = EXCLUDED.consecutive_failures, average_latency = EXCLUDED.average_latency,
    latency_samples = EXCLUDED.latency_samples, current_status = EXCLUDED.current_status, status_reason = EXCLUDED.status_reason,
    skip_until = EXCLUDED.skip_until, current_fallback_level = EXCLUDED.current_fallback_level,
    last_health_check = coalesce(EXCLUDED.last_health_check, t.last_health_check),
    last_probe_at = coalesce(EXCLUDED.last_probe_at, t.last_probe_at), updated_at = now()
  RETURNING 1
),
-- Metadata-only rows (Health Monitor, not probed): never overwrite counters the router updated concurrently.
mhm AS (
  INSERT INTO ai_model_health AS t (provider, model, display_name, rank, listed, free, context_length, current_status,
        status_reason, current_fallback_level, last_health_check, updated_at)
  SELECT m->>'provider', m->>'model', m->>'display_name', (m->>'rank')::smallint, (m->>'listed')::boolean, (m->>'free')::boolean,
         (m->>'context_length')::int, coalesce(m->>'current_status', 'UNKNOWN'), m->>'status_reason',
         (m->>'current_fallback_level')::smallint, (m->>'last_health_check')::timestamptz, now()
  FROM p, jsonb_array_elements(coalesce(p.j->'model_health', '[]'::jsonb)) m
  WHERE m->>'write' = 'meta'
  ON CONFLICT (provider, model) DO UPDATE SET
    display_name = coalesce(EXCLUDED.display_name, t.display_name), rank = EXCLUDED.rank,
    listed = coalesce(EXCLUDED.listed, t.listed), free = coalesce(EXCLUDED.free, t.free),
    context_length = coalesce(EXCLUDED.context_length, t.context_length),
    current_fallback_level = EXCLUDED.current_fallback_level,
    last_health_check = coalesce(EXCLUDED.last_health_check, t.last_health_check),
    current_status = CASE WHEN EXCLUDED.listed IS FALSE OR EXCLUDED.free IS FALSE THEN EXCLUDED.current_status
                          WHEN t.status_reason LIKE 'MODEL_UNAVAILABLE%' OR t.status_reason LIKE 'NOT_FREE%' THEN EXCLUDED.current_status
                          ELSE t.current_status END,
    status_reason = CASE WHEN EXCLUDED.listed IS FALSE OR EXCLUDED.free IS FALSE THEN EXCLUDED.status_reason
                         WHEN t.status_reason LIKE 'MODEL_UNAVAILABLE%' OR t.status_reason LIKE 'NOT_FREE%' THEN EXCLUDED.status_reason
                         WHEN t.current_status = 'UNKNOWN' THEN EXCLUDED.status_reason
                         ELSE t.status_reason END,
    updated_at = now()
  RETURNING 1
),
-- Models no longer in the configured chain keep their history but lose their rank.
unranked AS (
  UPDATE ai_model_health SET rank = NULL, current_fallback_level = NULL
  WHERE provider = 'openrouter' AND rank IS NOT NULL AND (SELECT p.j ? 'configured_models' FROM p)
    AND NOT (model = ANY (ARRAY(SELECT jsonb_array_elements_text((SELECT p.j->'configured_models' FROM p)))))
  RETURNING 1
),
c AS (
  INSERT INTO ai_cache (fingerprint, purpose, ref, provider, model, output, regime, created_at, expires_at)
  SELECT x->>'fingerprint', x->>'purpose', x->>'ref', x->>'provider', x->>'model', x->'output', x->>'regime', now(),
         now() + make_interval(mins => (x->>'ttl_min')::int)
  FROM p, jsonb_array_elements(coalesce(p.j->'cache_upserts', '[]'::jsonb)) x
  ON CONFLICT (fingerprint) DO UPDATE SET output = EXCLUDED.output, provider = EXCLUDED.provider, model = EXCLUDED.model,
    regime = EXCLUDED.regime, created_at = now(), expires_at = EXCLUDED.expires_at, hits = 0, last_hit_at = NULL
  RETURNING 1
),
ch AS (
  UPDATE ai_cache SET hits = hits + 1, last_hit_at = now()
  WHERE fingerprint IN (SELECT jsonb_array_elements_text(coalesce(p.j->'cache_hits', '[]'::jsonb)) FROM p)
  RETURNING 1
),
cp AS (DELETE FROM ai_cache WHERE expires_at < now() - interval '1 day' RETURNING 1),
k AS (
  INSERT INTO ai_api_keys AS t (key_alias, provider, status, last_success, last_failure, last_error, is_free_tier,
        free_requests_used, free_requests_limit, free_requests_remaining, credit_limit, credit_limit_remaining,
        usage_daily, usage_monthly, checked_at, updated_at)
  SELECT x->>'key_alias', coalesce(x->>'provider', 'openrouter'), coalesce(x->>'status', 'UNKNOWN'),
         (x->>'last_success')::timestamptz, (x->>'last_failure')::timestamptz, left(x->>'last_error', 200),
         (x->>'is_free_tier')::boolean, (x->>'free_requests_used')::int, (x->>'free_requests_limit')::int,
         (x->>'free_requests_remaining')::int, (x->>'credit_limit')::numeric, (x->>'credit_limit_remaining')::numeric,
         (x->>'usage_daily')::numeric, (x->>'usage_monthly')::numeric, (x->>'checked_at')::timestamptz, now()
  FROM p, LATERAL (SELECT p.j->'key_update' AS x) kk WHERE x IS NOT NULL AND x->>'key_alias' IS NOT NULL
  ON CONFLICT (key_alias) DO UPDATE SET
    status = coalesce(EXCLUDED.status, t.status),
    last_success = GREATEST(t.last_success, EXCLUDED.last_success), last_failure = GREATEST(t.last_failure, EXCLUDED.last_failure),
    last_error = coalesce(EXCLUDED.last_error, t.last_error),
    is_free_tier = coalesce(EXCLUDED.is_free_tier, t.is_free_tier),
    free_requests_used = CASE WHEN EXCLUDED.checked_at IS NOT NULL THEN EXCLUDED.free_requests_used ELSE t.free_requests_used END,
    free_requests_limit = CASE WHEN EXCLUDED.checked_at IS NOT NULL THEN EXCLUDED.free_requests_limit ELSE t.free_requests_limit END,
    free_requests_remaining = CASE WHEN EXCLUDED.checked_at IS NOT NULL THEN EXCLUDED.free_requests_remaining ELSE t.free_requests_remaining END,
    credit_limit = CASE WHEN EXCLUDED.checked_at IS NOT NULL THEN EXCLUDED.credit_limit ELSE t.credit_limit END,
    credit_limit_remaining = CASE WHEN EXCLUDED.checked_at IS NOT NULL THEN EXCLUDED.credit_limit_remaining ELSE t.credit_limit_remaining END,
    usage_daily = CASE WHEN EXCLUDED.checked_at IS NOT NULL THEN EXCLUDED.usage_daily ELSE t.usage_daily END,
    usage_monthly = CASE WHEN EXCLUDED.checked_at IS NOT NULL THEN EXCLUDED.usage_monthly ELSE t.usage_monthly END,
    checked_at = coalesce(EXCLUDED.checked_at, t.checked_at), updated_at = now()
  RETURNING 1
),
kv AS (
  INSERT INTO kv_state (key, value, updated_at)
  SELECT 'ai_alert_state', p.j->'alert_state', now() FROM p WHERE p.j->'alert_state' IS NOT NULL AND jsonb_typeof(p.j->'alert_state') = 'object'
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() RETURNING 1
)
SELECT (SELECT count(*) FROM runs)::int AS runs_logged, (SELECT count(*) FROM u)::int AS usage_logged,
       ((SELECT count(*) FROM mh) + (SELECT count(*) FROM mhm))::int AS models_updated, (SELECT count(*) FROM unranked)::int AS models_unranked, (SELECT count(*) FROM c)::int AS cache_stored,
       (SELECT count(*) FROM ch)::int AS cache_hits, (SELECT count(*) FROM k)::int AS key_updated`;

module.exports = { UTC_DAY, FALLBACK_EVENT, COUNTERS_SQL, HEALTH_ROWS_SQL, KEY_ROW_SQL, ALERT_STATE_SQL, LAST_FAILURES_SQL, SNAPSHOT_SQL, RECORD_SQL };
