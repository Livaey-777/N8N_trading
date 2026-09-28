'use strict';
// GI · Pre-Event Engine: calendar sync + Forecast & Conditional Scenario Engine
// (daily forecast, forecast updates / invalidations, T-minus check, cancellations / reschedules).
const SERIES = (instrument, days) => `(SELECT coalesce(jsonb_agg(jsonb_build_object('t', t, 'v', v, 'src', src) ORDER BY t), '[]'::jsonb) FROM (
    SELECT observed_at AS t, value AS v, source AS src FROM market_observations WHERE instrument = '${instrument}' AND observed_at > now() - interval '8 days'
    UNION ALL
    SELECT * FROM (SELECT DISTINCT ON (date_trunc('day', observed_at)) observed_at, value, source FROM market_observations
      WHERE instrument = '${instrument}' AND observed_at <= now() - interval '8 days' AND observed_at > now() - interval '${days} days'
      ORDER BY date_trunc('day', observed_at), observed_at DESC) d) s)`;
const PRE_EVENT_TYPES = "ARRAY['CPI','PCE','NFP','FOMC','GDP','PPI','ECB','BOE','BOJ','FED_CHAIR_SPEECH','GEOPOLITICAL_DEADLINE']";

module.exports = {
  id: 'giPreEventEngine',
  file: 'gold-intelligence-pre-event.json',
  build(h) {
    h.lane(0);
    const daily = h.schedule('⏱ Daily Pre-Event', { field: 'days', daysInterval: 1, triggerAtHour: '={{ Number($env.GI_PREEVENT_DAILY_HOUR) || 6 }}', triggerAtMinute: 0 }, { notes: 'GI_PREEVENT_DAILY_HOUR (local)' });
    const mDaily = h.code('Mode: Daily', 'preevent/mode-daily.js');
    h.lane(1);
    const refresh = h.schedule('⏱ Refresh & Calendar Sync', { field: 'minutes', minutesInterval: '={{ Number($env.GI_PREEVENT_REFRESH_INTERVAL_MIN) || 30 }}' }, { notes: 'forecast updates / invalidations + T-minus check + 6h calendar sync' });
    const mRefresh = h.code('Mode: Refresh', 'preevent/mode-refresh.js');
    h.lane(2);
    const manual = h.manual('🧪 Pre-Event Test');
    const mManual = h.code('Mode: Manual', 'preevent/mode-manual.js');
    h.at(2, 1);
    const calState = h.pg('Load Calendar State', `
SELECT ($1::jsonb)->>'mode' AS mode, now() AS started_at,
       (SELECT value->>'at' FROM kv_state WHERE key = 'calendar_last_sync') AS last_sync,
       (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'release_key', release_key, 'event_type', event_type,
               'scheduled_at', scheduled_at, 'source', source, 'pre_event_sent_at', pre_event_sent_at)), '[]'::jsonb)
          FROM macro_releases WHERE status = 'SCHEDULED' AND NOT is_test
           AND scheduled_at BETWEEN now() AND now() + interval '21 days') AS scheduled`, '$json');
    const plan = h.code('Plan Calendar Sync', 'preevent/plan-sync.js');
    const syncIf = h.ifTrue('Sync Due?', '$json.fetch === true');
    const fetchCal = h.http('Fetch Calendars', { batchSize: 2, batchInterval: 500, timeout: 45000, notes: 'BLS ICS · BEA ICS · Fed FOMC page · FF weekly JSON' });
    const parse = h.code('Parse Calendars', 'preevent/parse-calendars.js', { notes: 'merge consensus · detect cancelled / rescheduled' });
    const upsert = h.pg('Upsert Releases', `
WITH p AS (SELECT $1::jsonb AS j),
up AS (
  INSERT INTO macro_releases (release_key, event_type, country, title, scheduled_at, impact, consensus, previous,
                              consensus_num, previous_num, source, consensus_source, details)
  SELECT r->>'release_key', r->>'event_type', coalesce(r->>'country', 'US'), r->>'title', (r->>'scheduled_at')::timestamptz,
         coalesce(r->>'impact', 'MEDIUM'), r->>'consensus', r->>'previous', (r->>'consensus_num')::numeric, (r->>'previous_num')::numeric,
         r->>'source', r->>'consensus_source', coalesce(r->'details', '{}'::jsonb)
  FROM p, jsonb_array_elements(coalesce(p.j->'releases', '[]'::jsonb)) r
  ON CONFLICT (release_key) DO UPDATE SET
    title = EXCLUDED.title, impact = EXCLUDED.impact,
    consensus = coalesce(EXCLUDED.consensus, macro_releases.consensus), previous = coalesce(EXCLUDED.previous, macro_releases.previous),
    consensus_num = coalesce(EXCLUDED.consensus_num, macro_releases.consensus_num), previous_num = coalesce(EXCLUDED.previous_num, macro_releases.previous_num),
    consensus_source = coalesce(EXCLUDED.consensus_source, macro_releases.consensus_source),
    details = macro_releases.details || EXCLUDED.details, updated_at = now()
  RETURNING id, release_key
),
rs AS (
  UPDATE macro_releases m SET status = u->>'status', updated_at = now(),
         rescheduled_to = (SELECT up.id FROM up WHERE up.release_key = u->>'rescheduled_to_key')
  FROM p, jsonb_array_elements(coalesce(p.j->'updates', '[]'::jsonb)) u
  WHERE m.id = (u->>'id')::bigint AND m.status = 'SCHEDULED'
  RETURNING m.id
),
fc AS (
  UPDATE pre_event_forecasts f SET status = 'CANCELLED' FROM rs WHERE f.macro_release_id = rs.id AND f.status = 'ACTIVE' RETURNING 1
),
dl AS (
  INSERT INTO macro_releases (release_key, event_type, country, title, scheduled_at, impact, source, details)
  SELECT 'GEOPOLITICAL_DEADLINE:' || d.id, d.event_type, 'GLOBAL', d.title, d.deadline_at, 'HIGH', 'curated deadline (' || d.source_url || ')',
         jsonb_build_object('description', d.description, 'source_url', d.source_url, 'category', d.category)
  FROM scheduled_deadlines d WHERE d.active AND d.deadline_at BETWEEN now() AND now() + interval '21 days'
  ON CONFLICT (release_key) DO UPDATE SET title = EXCLUDED.title, scheduled_at = EXCLUDED.scheduled_at, updated_at = now()
  RETURNING 1
),
kv AS (
  INSERT INTO kv_state (key, value, updated_at)
  SELECT 'calendar_last_sync', jsonb_build_object('at', now(), 'releases', jsonb_array_length(coalesce(p.j->'releases', '[]'::jsonb))), now()
  FROM p WHERE (p.j->>'synced')::boolean AND coalesce((p.j->>'calendar_ok')::int, 0) > 0
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() RETURNING 1
)
SELECT (SELECT count(*) FROM up)::int AS upserted, (SELECT count(*) FROM rs)::int AS status_changes,
       (SELECT count(*) FROM fc)::int AS forecasts_cancelled, (SELECT count(*) FROM dl)::int AS deadlines, (SELECT count(*) FROM kv)::int AS sync_marked`,
    '{ releases: $json.releases, synced: $json.synced, calendar_ok: $json.calendar_ok, updates: $json.updates }');
    const ctx = h.pg('Load Forecast Context', `
WITH p AS (SELECT $1::jsonb AS j),
params AS (
  SELECT j->>'mode' AS mode,
         coalesce((j->>'lookahead_h')::int, 36) AS lookahead_h,
         coalesce((j->>'lead_min')::int, 90) AS lead_min,
         (date_trunc('day', now() AT TIME ZONE 'Africa/Casablanca') AT TIME ZONE 'Africa/Casablanca') AS local_midnight
  FROM p
),
due AS (
  SELECT r.* FROM macro_releases r, params
  WHERE NOT r.is_test AND r.event_type = ANY(${PRE_EVENT_TYPES}) AND r.status = 'SCHEDULED' AND (
    (params.mode = 'DAILY' AND r.scheduled_at BETWEEN now() AND now() + make_interval(hours => params.lookahead_h)
       AND (r.pre_event_sent_at IS NULL OR r.pre_event_sent_at < params.local_midnight))
    OR (params.mode = 'REFRESH' AND r.scheduled_at BETWEEN now() AND now() + make_interval(hours => params.lookahead_h)
       AND (EXISTS (SELECT 1 FROM pre_event_forecasts f WHERE f.macro_release_id = r.id AND f.status = 'ACTIVE')
            OR (r.impact = 'HIGH' AND r.scheduled_at <= now() + make_interval(mins => params.lead_min) AND r.refresh_sent_at IS NULL)))
    OR (params.mode = 'MANUAL' AND r.scheduled_at BETWEEN now() AND now() + interval '7 days'))
  ORDER BY r.scheduled_at, CASE WHEN r.impact = 'HIGH' THEN 0 ELSE 1 END
  LIMIT CASE WHEN (SELECT mode FROM params) = 'MANUAL' THEN 1 ELSE 6 END
)
SELECT (SELECT mode FROM params) AS mode,
 (SELECT jsonb_build_object('sources_ok', count(DISTINCT component), 'last_ok', max(checked_at)) FROM system_health
    WHERE component LIKE 'calendar:%' AND status = 'OK' AND checked_at > now() - interval '24 hours') AS calendar_24h,
 (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.scheduled_at), '[]'::jsonb) FROM due d) AS due,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'macro_release_id', f.macro_release_id, 'forecast_state', f.forecast_state,
         'pre_event_score', f.pre_event_score, 'confidence', f.confidence, 'snapshot', f.data_snapshot)), '[]'::jsonb)
    FROM (SELECT DISTINCT ON (macro_release_id) * FROM pre_event_forecasts
          WHERE status = 'ACTIVE' AND macro_release_id IN (SELECT id FROM due) ORDER BY macro_release_id, created_at DESC) f) AS active_forecasts,
 (SELECT coalesce(jsonb_agg(to_jsonb(hr)), '[]'::jsonb) FROM historical_event_reactions hr
    WHERE hr.data_quality <> 'INSUFFICIENT' AND hr.event_type IN (SELECT DISTINCT event_type FROM due)) AS history,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('event_date', x.event_date, 'actual', x.actual)), '[]'::jsonb) FROM (
    SELECT event_date, actual FROM historical_event_reactions WHERE event_type = 'CPI' AND actual IS NOT NULL
    UNION ALL SELECT scheduled_at, actual_num FROM macro_releases WHERE event_type = 'CPI' AND actual_num IS NOT NULL) x) AS cpi_rows,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('event_date', x.event_date, 'actual', x.actual)), '[]'::jsonb) FROM (
    SELECT event_date, actual FROM historical_event_reactions WHERE event_type = 'NFP' AND actual IS NOT NULL
    UNION ALL SELECT scheduled_at, actual_num FROM macro_releases WHERE event_type = 'NFP' AND actual_num IS NOT NULL) x) AS nfp_rows,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('t', observed_at, 'v', value) ORDER BY observed_at), '[]'::jsonb) FROM (
    SELECT DISTINCT ON (date_trunc('day', observed_at)) observed_at, value FROM market_observations
    WHERE instrument = 'US2Y' ORDER BY date_trunc('day', observed_at), observed_at DESC) s) AS us2y_long,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('t', t, 'v', v, 'src', src) ORDER BY t), '[]'::jsonb) FROM (
    SELECT observed_at AS t, price AS v, source AS src FROM gold_observations WHERE observed_at > now() - interval '8 days'
    UNION ALL
    SELECT * FROM (SELECT DISTINCT ON (date_trunc('day', observed_at)) observed_at, price, source FROM gold_observations
      WHERE observed_at <= now() - interval '8 days' AND observed_at > now() - interval '130 days'
      ORDER BY date_trunc('day', observed_at), observed_at DESC) d) g) AS gold,
 ${SERIES('USD_PROXY', 130)} AS usd, ${SERIES('US2Y', 130)} AS us2y, ${SERIES('US10Y', 130)} AS us10y, ${SERIES('US30Y', 130)} AS us30y,
 ${SERIES('US10Y_REAL', 130)} AS us10y_real, ${SERIES('WTI', 130)} AS wti,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('t', observed_at, 'v', value) ORDER BY observed_at), '[]'::jsonb)
    FROM market_observations WHERE instrument = 'GOLD_COT_NONCOMM_NET' AND observed_at > now() - interval '1150 days') AS cot,
 (SELECT coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb) FROM (
    SELECT id, title, category, subcategory, importance_score, gold_relevance_score, net_pressure, first_seen_at, last_seen_at, transmission
    FROM events WHERE NOT is_test AND last_seen_at > now() - interval '30 days' AND gold_relevance_score >= 35
    ORDER BY last_seen_at DESC LIMIT 500) e) AS events,
 (SELECT final FROM analysis_results WHERE analysis_type = 'DESK_STATE' AND NOT is_test ORDER BY created_at DESC LIMIT 1) AS desk`,
    "{ mode: $('Load Calendar State').first().json.mode, lookahead_h: Number($env.GI_PREEVENT_LOOKAHEAD_HOURS) || 36, lead_min: Number($env.GI_PREEVENT_REFRESH_LEAD_MIN) || 90 }",
    { notes: 'due releases, active forecasts, history, macro actuals, market series, events, desk' });
    h.at(5, 2);
    const engine = h.code('Forecast Engine', 'preevent/engine.js', { notes: 'layers → analogues → score/confidence/state → scenarios · updates/invalidations' });
    const ai = h.callWorkflow('AI Analyst', 'giAiAnalystSub01');
    const compose = h.code('Compose Pre-Event Messages', 'preevent/compose.js');
    const tg = h.callWorkflow('Telegram Sender', 'giTelegramSend01');
    const rec = h.code('Prepare Forecast Record', 'preevent/record.js');
    const persist = h.pg('Persist Forecasts', `
WITH p AS (SELECT $1::jsonb AS j),
fc AS (
  INSERT INTO pre_event_forecasts (macro_release_id, kind, event_type, scheduled_at, historical, market_context, historical_bias,
      pre_event_bias, confidence, mode, model, final, forecast_state, pre_event_score, historical_sample_size, historical_evidence_quality,
      regime_match, data_quality, data_quality_reasons, undetermined_reasons, bullish_scenario, bearish_scenario, base_scenario,
      confirmation_conditions, invalidation_conditions, ai_summary, ai_model, ai_disagreement, ai_disagreement_reason, data_snapshot,
      update_reason, sent, ai_provider, ai_fallback_level, ai_tokens, ai_latency_ms, ai_status, ai_at)
  SELECT (f->>'macro_release_id')::bigint, f->>'kind', f->>'event_type', (f->>'scheduled_at')::timestamptz, f->'historical', f->'market_context',
         f->>'historical_bias', f->>'pre_event_bias', (f->>'confidence')::int, f->>'mode', f->>'model', f->'final', f->>'forecast_state',
         (f->>'pre_event_score')::int, (f->>'historical_sample_size')::int, (f->>'historical_evidence_quality')::int, f->>'regime_match',
         f->>'data_quality', f->'data_quality_reasons', f->'undetermined_reasons', f->'bullish_scenario', f->'bearish_scenario', f->'base_scenario',
         f->'confirmation_conditions', f->'invalidation_conditions', f->>'ai_summary', f->>'model', coalesce((f->>'ai_disagreement')::boolean, false),
         f->>'ai_disagreement_reason', f->'data_snapshot', f->'update_reason', coalesce((f->>'sent')::boolean, false),
         f->>'ai_provider', (f->>'ai_fallback_level')::smallint, (f->>'ai_tokens')::int, (f->>'ai_latency_ms')::int, f->>'ai_status', now()
  FROM p, jsonb_array_elements(coalesce(p.j->'forecasts', '[]'::jsonb)) f
  RETURNING id, macro_release_id
),
sup AS (
  UPDATE pre_event_forecasts o SET status = f->>'supersede_status', superseded_by = fc.id
  FROM p, jsonb_array_elements(coalesce(p.j->'forecasts', '[]'::jsonb)) f
  JOIN fc ON fc.macro_release_id = (f->>'macro_release_id')::bigint
  WHERE f->>'supersedes_id' IS NOT NULL AND o.id = (f->>'supersedes_id')::bigint
  RETURNING 1
),
older AS (
  UPDATE pre_event_forecasts o SET status = 'UPDATED', superseded_by = fc.id
  FROM fc WHERE o.macro_release_id = fc.macro_release_id AND o.id <> fc.id AND o.status = 'ACTIVE'
    AND o.id NOT IN (SELECT (f->>'supersedes_id')::bigint FROM p, jsonb_array_elements(coalesce(p.j->'forecasts', '[]'::jsonb)) f WHERE f->>'supersedes_id' IS NOT NULL)
  RETURNING 1
),
sc AS (
  INSERT INTO scenarios (forecast_id, kind, trigger_text, mechanism, expected_confirmation, expected_gold_response, invalidation,
                         historical_support, support, confidence, causal_chain)
  SELECT fc.id, s->>'kind', s->>'trigger_text', s->>'mechanism', s->>'expected_confirmation', s->>'expected_gold_response', s->>'invalidation',
         s->'historical_support', s->>'support', (s->>'confidence')::int, s->>'causal_chain'
  FROM p, jsonb_array_elements(coalesce(p.j->'forecasts', '[]'::jsonb)) f
  JOIN fc ON fc.macro_release_id = (f->>'macro_release_id')::bigint
  CROSS JOIN LATERAL jsonb_array_elements(f->'scenarios') s
  RETURNING 1
),
an AS (
  INSERT INTO analysis_results (analysis_type, macro_release_id, mode, model, deterministic, ai_output, final, regime,
                                short_bias, tactical_bias, confidence, data_quality)
  SELECT 'PRE_EVENT', (f->>'macro_release_id')::bigint, f->>'mode', f->>'model', f->'deterministic', f->'ai_output', f->'final',
         f->'market_context'->'macro'->>'primary', f->>'forecast_state', f->>'forecast_state', (f->>'confidence')::int, f->>'data_quality'
  FROM p, jsonb_array_elements(coalesce(p.j->'forecasts', '[]'::jsonb)) f
  RETURNING 1
),
fl AS (
  UPDATE macro_releases r SET
    pre_event_sent_at = CASE WHEN (f->>'kind') IN ('DAILY', 'MANUAL') AND (f->>'sent')::boolean THEN now() ELSE r.pre_event_sent_at END,
    refresh_sent_at = CASE WHEN (f->>'kind') IN ('REFRESH', 'UPDATE') AND (f->>'sent')::boolean
                            AND r.scheduled_at <= now() + interval '3 hours' THEN now() ELSE r.refresh_sent_at END,
    updated_at = now()
  FROM p, jsonb_array_elements(coalesce(p.j->'forecasts', '[]'::jsonb)) f
  WHERE r.id = (f->>'macro_release_id')::bigint
  RETURNING 1
),
hs AS (
  INSERT INTO system_health (component, status, detail, metrics)
  SELECT hh->>'component', hh->>'status', hh->>'detail', hh->'metrics' FROM p, jsonb_array_elements(coalesce(p.j->'health', '[]'::jsonb)) hh RETURNING 1
),
jr AS (
  INSERT INTO job_runs (job, started_at, finished_at, status, stats, execution_id)
  SELECT p.j->>'job', (p.j->>'started_at')::timestamptz, now(), p.j->>'status', p.j->'stats', p.j->>'execution_id' FROM p RETURNING id
)
SELECT (SELECT coalesce(jsonb_agg(id), '[]'::jsonb) FROM fc) AS forecast_ids, (SELECT count(*) FROM sc)::int AS scenarios,
       (SELECT count(*) FROM sup)::int + (SELECT count(*) FROM older)::int AS superseded,
       (SELECT count(*) FROM fl)::int AS flags_updated, (SELECT id FROM jr) AS job_run_id`, '$json.record');
    h.chain(daily, mDaily, calState);
    h.chain(refresh, mRefresh, calState);
    h.chain(manual, mManual, calState);
    h.chain(calState, plan, syncIf);
    h.connect(syncIf, fetchCal, 0);
    h.connect(syncIf, parse, 1);
    h.chain(fetchCal, parse, upsert, ctx, engine, ai, compose, tg, rec, persist);
    h.note('About', '## GI · Pre-Event Engine — Forecast & Conditional Scenario Engine\nBefore CPI, PCE, NFP, FOMC, GDP, PPI, ECB/BoE/BoJ, Fed Chair speeches and curated deadlines:\n\n* 7 input layers (gold, USD, yields, macro regime, geopolitics, politics, event)\n* historical analogues ranked by similarity · evidence quality · regime match\n* **pre_event_score** (−100…+100, not a probability) · deterministic confidence · BULLISH/BEARISH/MIXED/NEUTRAL/UNDETERMINED\n* conditional scenarios with STRONG/MODERATE/WEAK/INSUFFICIENT support\n* refresh: FORECAST UPDATE / FORECAST INVALIDATED; cancelled / rescheduled events\n\n> Conditional scenario analysis — never knowledge of undisclosed future information.', [0, 640], [600, 300], 4);
    return h.result({ name: 'GI · Pre-Event Engine (forecasts)' });
  },
};
