'use strict';
// GI · Telegram Bot: command polling + inline menu (buttons) + AI control center.
const S = require('./shared/ai-sql');
const CS = require('./shared/calibration-sql');
const SERIES = (instrument) => `(SELECT coalesce(jsonb_agg(jsonb_build_object('t', t, 'v', v) ORDER BY t), '[]'::jsonb) FROM (
    SELECT observed_at AS t, value AS v FROM market_observations WHERE instrument = '${instrument}' AND observed_at > now() - interval '8 days'
    UNION ALL
    SELECT * FROM (SELECT DISTINCT ON (date_trunc('day', observed_at)) observed_at, value FROM market_observations
      WHERE instrument = '${instrument}' AND observed_at <= now() - interval '8 days' AND observed_at > now() - interval '100 days'
      ORDER BY date_trunc('day', observed_at), observed_at DESC) d) s)`;

module.exports = {
  id: 'giTelegramBot001',
  file: 'gold-intelligence-telegram-bot.json',
  build(h) {
    h.lane(0);
    const poll = h.schedule('⏱ Poll Telegram', { field: 'seconds', secondsInterval: '={{ Number($env.GI_BOT_POLL_SECONDS) || 30 }}' }, { notes: 'GI_BOT_POLL_SECONDS; long-poll inside' });
    const state = h.pg('Load Bot State', `SELECT (SELECT value::text FROM kv_state WHERE key = 'telegram_offset') AS offset`, null);
    const get = h.code('Get Updates', 'bot/get-updates.js', { notes: 'getUpdates long-poll; token stays in this node' });
    h.at(0, 1);
    const sim = h.manual('🧪 Simulate Commands');
    const simBuild = h.code('Build Simulated Commands', 'bot/simulate.js', { notes: 'edit COMMANDS to test other commands' });
    h.at(3, 0);
    const route = h.ifTrue('Route Updates', '$json.has_updates === true');
    const load = h.pg('Load Command Data', `
WITH p AS (SELECT $1::jsonb AS j)
SELECT
 (SELECT final FROM analysis_results WHERE analysis_type = 'DESK_STATE' AND NOT is_test ORDER BY created_at DESC LIMIT 1) AS desk,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('t', t, 'v', v) ORDER BY t), '[]'::jsonb) FROM (
    SELECT observed_at AS t, price AS v FROM gold_observations WHERE observed_at > now() - interval '8 days'
    UNION ALL
    SELECT * FROM (SELECT DISTINCT ON (date_trunc('day', observed_at)) observed_at, price FROM gold_observations
      WHERE observed_at <= now() - interval '8 days' AND observed_at > now() - interval '100 days'
      ORDER BY date_trunc('day', observed_at), observed_at DESC) d) g) AS gold,
 ${SERIES('USD_PROXY')} AS usd, ${SERIES('US2Y')} AS us2y, ${SERIES('US10Y')} AS us10y, ${SERIES('US10Y_REAL')} AS us10y_real, ${SERIES('WTI')} AS wti,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('t', observed_at, 'v', value) ORDER BY observed_at), '[]'::jsonb)
    FROM market_observations WHERE instrument = 'GOLD_COT_NONCOMM_NET' AND observed_at > now() - interval '1150 days') AS cot,
 (SELECT coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb) FROM (
    SELECT id, title, category, subcategory, gold_relevance_score, importance_score, importance_class, net_pressure, last_seen_at
    FROM events WHERE NOT is_test AND last_seen_at > now() - interval '48 hours' AND gold_relevance_score >= 35
    ORDER BY importance_score DESC LIMIT 60) e) AS events,
 (SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY u.scheduled_at), '[]'::jsonb) FROM (
    SELECT r.id, r.event_type, r.title, r.scheduled_at, r.impact, r.consensus, f.pre_event_bias, f.confidence
    FROM macro_releases r
    LEFT JOIN LATERAL (SELECT pre_event_bias, confidence FROM pre_event_forecasts WHERE macro_release_id = r.id ORDER BY created_at DESC LIMIT 1) f ON true
    WHERE r.scheduled_at BETWEEN now() AND now() + interval '7 days' AND r.impact IN ('HIGH', 'MEDIUM') AND NOT r.is_test
    ORDER BY r.scheduled_at LIMIT 12) u) AS upcoming,
 (SELECT to_jsonb(x) FROM (
    SELECT f.id, f.event_type, f.scheduled_at, f.pre_event_bias, f.confidence, f.final->'event'->>'label' AS label,
           (SELECT coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) FROM scenarios s WHERE s.forecast_id = f.id) AS scenarios
    FROM pre_event_forecasts f WHERE NOT f.is_test ORDER BY f.created_at DESC LIMIT 1) x) AS scenarios,
 (SELECT to_jsonb(x) FROM (SELECT final, created_at FROM analysis_results WHERE analysis_type = 'DAILY' AND NOT is_test ORDER BY created_at DESC LIMIT 1) x) AS daily,
 (SELECT jsonb_build_object(
    'checked_at', coalesce(max(checked_at), now()),
    'overall', coalesce((SELECT value->>'overall' FROM kv_state WHERE key = 'health_overall'), 'UNKNOWN'),
    'components', coalesce(jsonb_agg(jsonb_build_object('component', component, 'status', status, 'detail', detail) ORDER BY component), '[]'::jsonb),
    'ai_used_today', (SELECT count(*) FROM ai_runs WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Africa/Casablanca') AT TIME ZONE 'Africa/Casablanca')))
  FROM (SELECT DISTINCT ON (component) component, status, detail, checked_at FROM system_health
        WHERE checked_at > now() - interval '2 hours' AND component NOT LIKE 'market:%'
        ORDER BY component, checked_at DESC) hs) AS health,
 (SELECT coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb) FROM (
    SELECT ev.id, ev.title, ev.category, ev.subcategory, ev.region, ev.first_seen_at, ev.last_seen_at, ev.source_count,
           ev.publisher_count, ev.confirmation_status, ev.gold_relevance_score, ev.importance_score, ev.importance_class,
           ev.net_pressure, ev.dominant_driver, ev.counter_driver, ev.transmission, ev.market_confirmation, ev.is_test,
           (SELECT coalesce(jsonb_agg(jsonb_build_object('publisher', publisher, 'tier', tier, 'title', title) ORDER BY tier), '[]'::jsonb)
              FROM event_sources WHERE event_id = ev.id) AS reports
    FROM events ev
    WHERE ev.id IN (SELECT (jsonb_array_elements_text(coalesce((SELECT j->'event_ids' FROM p), '[]'::jsonb)))::bigint)
       OR (coalesce((SELECT (j->>'want_latest')::boolean FROM p), false) AND ev.id = (SELECT max(id) FROM events WHERE NOT is_test AND gold_relevance_score >= 60))
  ) e) AS requested_events,
 (SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.scheduled_at), '[]'::jsonb) FROM (
    SELECT DISTINCT ON (pf.macro_release_id) pf.id, pf.macro_release_id, pf.event_type, pf.scheduled_at, r.impact, pf.forecast_state,
           pf.pre_event_score, pf.confidence, pf.historical_evidence_quality, pf.historical_sample_size, pf.historical_bias,
           pf.bullish_scenario->>'trigger' AS bullish_trigger, pf.bearish_scenario->>'trigger' AS bearish_trigger,
           (pf.invalidation_conditions->>0) AS main_invalidation, pf.final->'what_matters_most'->>1 AS watch,
           pf.regime_match, pf.data_quality, pf.ai_model
    FROM pre_event_forecasts pf JOIN macro_releases r ON r.id = pf.macro_release_id
    WHERE pf.status = 'ACTIVE' AND NOT pf.is_test AND r.status = 'SCHEDULED'
      AND pf.scheduled_at BETWEEN now() AND now() + interval '168 hours'
    ORDER BY pf.macro_release_id, pf.created_at DESC) f) AS forecasts,
 (SELECT jsonb_build_object(
    'last_news', (SELECT max(finished_at) FROM job_runs WHERE job = 'NEWS'),
    'last_market', (SELECT max(finished_at) FROM job_runs WHERE job = 'MARKET'),
    'last_ai', (SELECT jsonb_build_object('at', created_at, 'model', model, 'success', success, 'failure_reason', failure_reason) FROM ai_runs ORDER BY id DESC LIMIT 1),
    'last_telegram', (SELECT max(created_at) FROM telegram_messages WHERE direction = 'OUT' AND status = 'SENT'),
    'errors_24h', (SELECT count(*) FROM error_events WHERE occurred_at > now() - interval '24 hours'),
    'data_quality', (SELECT final->'desk'->>'data_quality' FROM analysis_results WHERE analysis_type = 'DESK_STATE' AND NOT is_test ORDER BY id DESC LIMIT 1)
  )) AS status_extra,
 ${S.SNAPSHOT_SQL} AS ai_usage,
 ${CS.CELLS_SQL} AS calibration,
 (SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.scheduled_at), '[]'::jsonb) FROM (
    SELECT DISTINCT ON (pf.macro_release_id) pf.id, pf.macro_release_id, r.release_key, pf.event_type, pf.scheduled_at, r.impact, r.consensus,
           pf.forecast_state, pf.pre_event_score, pf.confidence, pf.historical_evidence_quality, pf.historical_sample_size,
           (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', s.kind, 'trigger_text', s.trigger_text, 'mechanism', s.mechanism,
                   'expected_confirmation', s.expected_confirmation, 'expected_gold_response', s.expected_gold_response,
                   'invalidation', s.invalidation, 'support', s.support, 'historical_support', s.historical_support->>'text')), '[]'::jsonb)
              FROM scenarios s WHERE s.forecast_id = pf.id) AS scenarios
    FROM pre_event_forecasts pf JOIN macro_releases r ON r.id = pf.macro_release_id
    WHERE pf.status = 'ACTIVE' AND NOT pf.is_test AND r.status = 'SCHEDULED' AND pf.scheduled_at BETWEEN now() AND now() + interval '7 days'
    ORDER BY pf.macro_release_id, pf.created_at DESC) f) AS biggest,
 (SELECT coalesce(jsonb_agg(to_jsonb(h)), '[]'::jsonb) FROM (
    SELECT event_type, count(*) AS n,
      count(*) FILTER (WHERE gold_direction = 'BULLISH') AS up, count(*) FILTER (WHERE gold_direction = 'BEARISH') AS down,
      count(*) FILTER (WHERE gold_direction = 'MIXED') AS mixed,
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY (gold_4h / gold_before - 1) * 100))::numeric, 3) AS med_4h,
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(gold_4h / gold_before - 1) * 100))::numeric, 3) AS med_abs_4h,
      count(*) FILTER (WHERE usd_reaction_direction = 'UP') AS usd_up,
      count(*) FILTER (WHERE usd_reaction_direction = 'UP' AND gold_direction = 'BEARISH') AS usd_up_gold_down,
      count(*) FILTER (WHERE usd_reaction_direction = 'DOWN') AS usd_down,
      count(*) FILTER (WHERE usd_reaction_direction = 'DOWN' AND gold_direction = 'BULLISH') AS usd_down_gold_up,
      min(event_date) AS first, max(event_date) AS last, bool_or(data_source::text ILIKE '%dukascopy%') AS any_direct
    FROM historical_event_reactions WHERE data_quality <> 'INSUFFICIENT' AND gold_before > 0 AND gold_4h IS NOT NULL
    GROUP BY event_type) h) AS history,
 (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.created_at DESC), '[]'::jsonb) FROM (
    SELECT t.created_at, t.status, t.related_ref, e.id AS event_id, e.title, e.importance_class, e.net_pressure
    FROM telegram_messages t LEFT JOIN events e ON t.related_ref = 'event:' || e.id
    WHERE t.direction = 'OUT' AND t.message_type = 'ALERT' AND NOT t.is_test AND t.created_at > now() - interval '24 hours'
    ORDER BY t.created_at DESC LIMIT 10) a) AS recent_alerts,
 (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.importance_score DESC), '[]'::jsonb) FROM (
    SELECT id, title, importance_class, importance_score, net_pressure, confirmation_status FROM events
    WHERE NOT is_test AND importance_class IN ('HIGH', 'CRITICAL') AND last_seen_at > now() - interval '6 hours' AND gold_relevance_score >= 60
    ORDER BY importance_score DESC LIMIT 6) e) AS alert_grade,
 (SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.scheduled_at DESC), '[]'::jsonb) FROM (
    SELECT r.event_type, r.scheduled_at, ev.forecast_state, ev.pre_event_score, ev.realized_direction, ev.realized_move_pct,
           ev.forecast_result, ev.timing_quality, ev.lesson
    FROM evaluation_results ev JOIN macro_releases r ON r.id = ev.macro_release_id
    WHERE ev.horizon = '4H' ORDER BY r.scheduled_at DESC LIMIT 5) v) AS reviews,
 (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.event_date DESC), '[]'::jsonb) FROM (
    SELECT h.event_type, h.event_date, h.gold_direction, h.usd_reaction_direction,
           round(((h.gold_1h / nullif(h.gold_before, 0) - 1) * 100)::numeric, 3) AS ret_1h,
           round(((h.gold_4h / nullif(h.gold_before, 0) - 1) * 100)::numeric, 3) AS ret_4h,
           (SELECT pf.forecast_state FROM pre_event_forecasts pf JOIN macro_releases mr ON mr.id = pf.macro_release_id
             WHERE mr.event_type = h.event_type AND mr.scheduled_at = h.event_date AND NOT pf.is_test ORDER BY pf.created_at DESC LIMIT 1) AS forecast_state
    FROM historical_event_reactions h WHERE h.event_date > now() - interval '45 days' AND h.event_date < now()
    ORDER BY h.event_date DESC LIMIT 4) x) AS recent_reactions,
 (SELECT to_jsonb(p) FROM forecast_performance p) AS performance,
 (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.created_at DESC), '[]'::jsonb) FROM (
    SELECT ar.analysis_type, ar.created_at, ar.mode, ar.model, ar.final->>'fallback_reason' AS fallback_reason,
           coalesce(ev.title, mr.title) AS subject,
           coalesce(ar.final->'output'->>'telegram_summary', ar.final->'output'->>'summary', ar.final->>'summary', ar.final->>'text') AS summary,
           coalesce((ar.final->'output'->>'ai_disagreement')::boolean, false) AS ai_disagreement,
           ar.final->'output'->>'disagreement_reason' AS disagreement_reason
    FROM analysis_results ar LEFT JOIN events ev ON ev.id = ar.event_id LEFT JOIN macro_releases mr ON mr.id = ar.macro_release_id
    WHERE NOT ar.is_test AND ar.analysis_type IN ('EVENT', 'PRE_EVENT', 'DAILY')
    ORDER BY (ar.mode = 'AI') DESC, ar.created_at DESC LIMIT 5) a) AS analyses`, '{ event_ids: $json.event_ids || [], want_latest: $json.want_latest || false }', { notes: 'stored desk state, events, releases, forecasts, health' });
    const build = h.code('Build Replies', 'bot/build-replies.js', { notes: 'authorised chats only; menus, AI control center' });
    const aiIf = h.ifTrue('AI Explanation?', '$json.has_ai === true');
    const aiReq = h.code('AI Request Payload', 'bot/ai-payload.js');
    const ai = h.callWorkflow('AI Analyst', 'giAiAnalystSub01');
    const merge = h.code('Merge AI Replies', 'bot/merge-ai.js', { notes: 'deterministic ranking kept; AI only explains it' });
    const outgoing = h.code('Outgoing Replies', 'bot/outgoing.js');
    const send = h.callWorkflow('Telegram Sender', 'giTelegramSend01');
    const save = h.pg('Save Offset & Log Inbound', `
WITH p AS (SELECT $1::jsonb AS j),
kv AS (
  INSERT INTO kv_state (key, value, updated_at)
  SELECT 'telegram_offset', to_jsonb((p.j->>'offset')::bigint), now() FROM p WHERE p.j->>'offset' IS NOT NULL
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() RETURNING 1
),
inb AS (
  INSERT INTO telegram_messages (direction, chat_id, message_type, body, status, is_test)
  SELECT 'IN', m->>'chat_id', m->>'message_type', m->>'body', m->>'status', coalesce((m->>'is_test')::boolean, false)
  FROM p, jsonb_array_elements(coalesce(p.j->'inbound', '[]'::jsonb)) m RETURNING 1
)
SELECT (SELECT count(*) FROM kv)::int AS offset_saved, (SELECT count(*) FROM inb)::int AS inbound_logged`, "$('Build Replies').first().json.save");
    h.chain(poll, state, get, route);
    h.chain(sim, simBuild, route);
    h.connect(route, load, 0);
    h.chain(load, build, aiIf);
    h.connect(aiIf, aiReq, 0);
    h.chain(aiReq, ai, merge, outgoing);
    h.connect(aiIf, outgoing, 1);
    h.chain(outgoing, send, save);
    h.note('About', '## GI · Telegram Bot\nPolls `getUpdates` (works behind NAT, no public webhook). Replies only to chats listed in `TELEGRAM_CHAT_ID`; with no chat configured, `/start` replies with the sender\'s chat id for setup.\n\nMenu (/start, inline buttons): GOLD NOW · BIGGEST SCENARIOS · TOP NEWS · GEOPOLITICS · POLITICS · MACRO · MARKET STATE · UPCOMING EVENTS · PRE-EVENT BIAS · HISTORICAL PATTERNS · ACTIVE ALERTS · FORECAST REVIEW · AI ANALYSIS · SYSTEM STATUS; AI: /ai /usage /ai_usage\n\nReplies are built from stored state; only 🔮 BIGGEST SCENARIOS asks the AI Analyst to explain the deterministic ranking (cached, priority-gated).', [0, 420], [560, 240], 5);
    return h.result({ name: 'GI · Telegram Bot (commands)', saveSuccess: 'none', timeoutSeconds: 240 });
  },
};
