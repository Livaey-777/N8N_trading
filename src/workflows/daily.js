'use strict';
// GI · Daily Report.
const SERIES = (instrument, days) => `(SELECT coalesce(jsonb_agg(jsonb_build_object('t', t, 'v', v) ORDER BY t), '[]'::jsonb) FROM (
    SELECT observed_at AS t, value AS v FROM market_observations WHERE instrument = '${instrument}' AND observed_at > now() - interval '8 days'
    UNION ALL
    SELECT * FROM (SELECT DISTINCT ON (date_trunc('day', observed_at)) observed_at, value FROM market_observations
      WHERE instrument = '${instrument}' AND observed_at <= now() - interval '8 days' AND observed_at > now() - interval '${days} days'
      ORDER BY date_trunc('day', observed_at), observed_at DESC) d) s)`;

const S = require('./shared/ai-sql');
const CS = require('./shared/calibration-sql');

module.exports = {
  id: 'giDailyReport001',
  file: 'gold-intelligence-daily.json',
  build(h) {
    h.lane(0);
    const sched = h.schedule('⏱ Daily Report', { field: 'days', daysInterval: 1, triggerAtHour: '={{ Number($env.GI_DAILY_REPORT_HOUR) || 7 }}', triggerAtMinute: 0 }, { notes: 'GI_DAILY_REPORT_HOUR (local)' });
    const mS = h.code('Mode: Scheduled', 'daily/mode-scheduled.js');
    h.lane(1);
    const manual = h.manual('🧪 Daily Report Test');
    const mM = h.code('Mode: Manual', 'daily/mode-manual.js');
    h.at(2, 0);
    const load = h.pg('Load Report Data', `
WITH p AS (SELECT $1::jsonb AS j)
SELECT (SELECT j->>'mode' FROM p) AS mode, (SELECT j->>'started_at' FROM p) AS started_at,
 (SELECT final FROM analysis_results WHERE analysis_type = 'DESK_STATE' AND NOT is_test ORDER BY created_at DESC LIMIT 1) AS desk,
 (SELECT coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb) FROM (
    SELECT id, title, category, importance_score, first_seen_at, last_seen_at, transmission FROM events
    WHERE NOT is_test AND last_seen_at > now() - interval '95 days' AND gold_relevance_score >= 35 ORDER BY last_seen_at DESC LIMIT 600) e) AS desk_events,
 (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.importance_score DESC), '[]'::jsonb) FROM (
    SELECT id, title, category, subcategory, importance_class, importance_score, net_pressure FROM events
    WHERE NOT is_test AND last_seen_at > now() - interval '24 hours' AND gold_relevance_score >= 35
    ORDER BY importance_score DESC LIMIT 30) e) AS top_events,
 (SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY u.scheduled_at), '[]'::jsonb) FROM (
    SELECT r.id, r.event_type, r.title, r.scheduled_at, r.impact, r.consensus, f.pre_event_bias, f.confidence
    FROM macro_releases r
    LEFT JOIN LATERAL (SELECT pre_event_bias, confidence FROM pre_event_forecasts WHERE macro_release_id = r.id ORDER BY created_at DESC LIMIT 1) f ON true
    WHERE r.scheduled_at BETWEEN now() AND now() + interval '48 hours' AND r.impact IN ('HIGH', 'MEDIUM') AND NOT r.is_test
    ORDER BY r.scheduled_at LIMIT 10) u) AS upcoming,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('t', t, 'v', v, 'src', src) ORDER BY t), '[]'::jsonb) FROM (
    SELECT observed_at AS t, price AS v, source AS src FROM gold_observations WHERE observed_at > now() - interval '8 days'
    UNION ALL
    SELECT * FROM (SELECT DISTINCT ON (date_trunc('day', observed_at)) observed_at, price, source FROM gold_observations
      WHERE observed_at <= now() - interval '8 days' AND observed_at > now() - interval '130 days'
      ORDER BY date_trunc('day', observed_at), observed_at DESC) d) g) AS gold,
 ${SERIES('USD_PROXY', 130)} AS usd, ${SERIES('US2Y', 130)} AS us2y, ${SERIES('US10Y', 130)} AS us10y,
 ${SERIES('US10Y_REAL', 130)} AS us10y_real, ${SERIES('WTI', 130)} AS wti,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('t', observed_at, 'v', value) ORDER BY observed_at), '[]'::jsonb)
    FROM market_observations WHERE instrument = 'GOLD_COT_NONCOMM_NET' AND observed_at > now() - interval '1150 days') AS cot,
 (SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.scheduled_at), '[]'::jsonb) FROM (
    SELECT DISTINCT ON (pf.macro_release_id) pf.id, pf.macro_release_id, pf.event_type, pf.scheduled_at, r.impact, pf.forecast_state,
           pf.pre_event_score, pf.confidence, pf.historical_evidence_quality, pf.historical_sample_size, pf.historical_bias,
           pf.bullish_scenario->>'trigger' AS bullish_trigger, pf.bearish_scenario->>'trigger' AS bearish_trigger,
           (pf.invalidation_conditions->>0) AS main_invalidation, pf.final->'what_matters_most'->>1 AS watch
    FROM pre_event_forecasts pf JOIN macro_releases r ON r.id = pf.macro_release_id
    WHERE pf.status = 'ACTIVE' AND NOT pf.is_test AND r.status = 'SCHEDULED'
      AND pf.scheduled_at BETWEEN now() AND now() + interval '48 hours'
    ORDER BY pf.macro_release_id, pf.created_at DESC) f) AS forecasts,
 ${S.SNAPSHOT_SQL} AS ai_usage`, '$json');
    const build = h.code('Build Daily Report', 'daily/build.js');
    const ai = h.callWorkflow('AI Analyst', 'giAiAnalystSub01');
    const compose = h.code('Compose Daily Report', 'daily/compose.js');
    const tg = h.callWorkflow('Telegram Sender', 'giTelegramSend01');
    const rec = h.code('Prepare Report Record', 'daily/record.js');
    const persist = h.pg('Persist Daily Report', `
WITH p AS (SELECT $1::jsonb AS j),
an AS (
  INSERT INTO analysis_results (analysis_type, mode, model, deterministic, ai_output, final, regime, short_bias, tactical_bias,
                                swing_bias, structural_bias, confidence, data_quality)
  SELECT 'DAILY', a->>'mode', a->>'model', a->'deterministic', a->'ai_output', a->'final', a->>'regime', a->>'short_bias',
         a->>'tactical_bias', a->>'swing_bias', a->>'structural_bias', (a->>'confidence')::int, a->>'data_quality'
  FROM p, LATERAL (SELECT p.j->'analysis' AS a) x RETURNING id
),
jr AS (
  INSERT INTO job_runs (job, started_at, finished_at, status, stats, execution_id)
  SELECT p.j->>'job', (p.j->>'started_at')::timestamptz, now(), p.j->>'status', p.j->'stats', p.j->>'execution_id' FROM p RETURNING id
)
SELECT (SELECT id FROM an) AS analysis_id, (SELECT id FROM jr) AS job_run_id`, '$json.record');
    h.chain(sched, mS, load);
    h.chain(manual, mM, load);
    const calLoad = h.pg('Load Calibration Inputs', CS.LOAD_SQL, null, { notes: 'daily closes (gold, USD proxy, yields), COT, release reactions' });
    const calBuild = h.code('Build Calibration', 'daily/calibration.js', { notes: 'empirical, non-overlapping, walk-forward validated; UNAVAILABLE without evidence' });
    const calStore = h.pg('Store Calibration', CS.STORE_SQL, '$json.store', { notes: 'calibration_cells' });
    h.chain(load, build, ai, compose, tg, rec, persist, calLoad, calBuild, calStore);
    h.note('About', '## GI · Daily Report\nREGIME · horizon biases · top geopolitics / politics / macro · USD / 2Y / 10Y / real yield / oil / gold · market confirmation · drivers · upcoming events with pre-event biases · scenarios · what could change the regime · AI summary (1 AI request/day).', [0, 420], [560, 180], 5);
    return h.result({ name: 'GI · Daily Report' });
  },
};
