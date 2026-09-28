'use strict';
// GI · AI Analyst (sub-workflow): cache → priority/quota gate → OpenRouter PRIMARY → SECONDARY →
// TERTIARY → DETERMINISTIC, with usage/quota monitoring and alerts.
const S = require('./shared/ai-sql');

module.exports = {
  id: 'giAiAnalystSub01',
  file: 'gold-intelligence-ai-analyst.json',
  build(h) {
    h.lane(0);
    const called = h.subTrigger('When Called By Pipeline');
    h.lane(1);
    const test = h.manual('🧪 AI Router Test');
    const testReq = h.code('Build AI Test Requests', 'ai/test-requests.js', { notes: 'Normal / PRIMARY unavailable / ALL unavailable' });
    h.at(2, 0);
    const prep = h.code('Prepare AI Requests', 'ai/prepare.js', { notes: 'priority (§26) + material-context fingerprint (§25)' });
    const state = h.pg('Load AI State', `
WITH p AS (SELECT $1::jsonb AS j)
SELECT (SELECT j FROM p) AS prepared,
 ${S.COUNTERS_SQL} AS counters,
 ${S.HEALTH_ROWS_SQL} AS health,
 ${S.KEY_ROW_SQL} AS key,
 ${S.ALERT_STATE_SQL} AS alert_state,
 ${S.LAST_FAILURES_SQL} AS last_failures,
 (SELECT value FROM kv_state WHERE key = 'models_check') AS models_check,
 (SELECT coalesce(jsonb_object_agg(fingerprint, jsonb_build_object('output', output, 'model', model, 'provider', provider,
         'created_at', created_at, 'expires_at', expires_at)), '{}'::jsonb)
    FROM ai_cache WHERE expires_at > now()
      AND fingerprint IN (SELECT jsonb_array_elements_text(coalesce((SELECT j->'fingerprints' FROM p), '[]'::jsonb)))) AS cache,
 (SELECT max(first_seen_at) FROM events WHERE NOT is_test AND importance_class = 'CRITICAL' AND first_seen_at > now() - interval '7 days') AS critical_since,
 (SELECT coalesce(jsonb_object_agg(model, jsonb_build_object('requests_today', n, 'tokens_today', t)), '{}'::jsonb) FROM (
    SELECT model, count(*) AS n, coalesce(sum(total_tokens), 0) AS t FROM ai_usage
    WHERE request_status IN ('SUCCESS', 'FAILED') AND request_timestamp >= ${S.UTC_DAY} GROUP BY model) x) AS per_model_today`,
    '$json', { notes: 'usage counters (UTC day), model health, provider key status, cache entries, alert state' });
    const router = h.code('AI Router', 'ai/router.js', { notes: 'cache → gate → PRIMARY → SECONDARY → TERTIARY → DETERMINISTIC' });
    const record = h.pg('Record AI Usage', S.RECORD_SQL, '$json.record',
      { notes: 'ai_usage (+ daily/hourly), ai_runs, model health, cache, key status, alert state — never keys' });
    const alertIf = h.ifTrue('Usage Alert?', "($('AI Router').first().json.alert_payload.messages || []).length > 0");
    const alertPayload = h.code('Usage Alert Payload', 'ai/alert-payload.js');
    const send = h.callWorkflow('Send Usage Alert', 'giTelegramSend01');
    const ret = h.code('Return Results', 'ai/return.js');
    h.chain(called, prep, state, router, record, alertIf);
    h.chain(test, testReq, prep);
    h.connect(alertIf, alertPayload, 0);
    h.chain(alertPayload, send, ret);
    h.connect(alertIf, ret, 1);
    h.note('About', '## GI · AI Analyst\nCalled by the pipeline, pre-event, daily and bot workflows.\n\n* **Cache**: an unchanged material context (regime, event/forecast state, USD ±0.3 %, yields ±5 bp, gold ±0.5 %) reuses the last analysis for `AI_CACHE_TTL_MIN`; numbers are re-checked against current facts; a new CRITICAL event invalidates.\n* **Priority gate** (§26): LOW quota → no daily summary; NEAR_LIMIT → critical/high events only.\n* **Router**: PRIMARY → SECONDARY → TERTIARY (`OPENROUTER_*_MODEL`) → DETERMINISTIC; models under rate-limit backoff, circuit breaker or no longer listed/free are skipped without spending a request.\n* Output is schema-validated + factuality-guarded; the deterministic state/confidence always win.\n* Every attempt → `ai_usage` (tokens/cost only as reported), daily/hourly summaries, model health; alerts once per state change.', [0, 420], [620, 300], 7);
    return h.result({ name: 'GI · AI Analyst (sub-workflow)' });
  },
};
