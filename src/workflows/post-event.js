'use strict';
// GI · Post-Event Review: actual capture, reaction measurement, forecast evaluation.
const REVIEW_TYPES = "ARRAY['CPI','NFP','PPI','PCE','FOMC','GDP','JOLTS']";
const DAILY = (instrument) => `(SELECT coalesce(jsonb_agg(jsonb_build_object('t', observed_at, 'v', value) ORDER BY observed_at), '[]'::jsonb) FROM (
    SELECT DISTINCT ON (date_trunc('day', observed_at)) observed_at, value FROM market_observations
    WHERE instrument = '${instrument}' AND observed_at > now() - interval '60 days'
    ORDER BY date_trunc('day', observed_at), observed_at DESC) s)`;
const COLS = ['event_type', 'event_date', 'consensus', 'actual', 'previous', 'revised_previous', 'surprise', 'surprise_basis', 'gold_before',
  'gold_5m', 'gold_30m', 'gold_1h', 'gold_4h', 'gold_24h', 'gold_3d', 'usd_before', 'usd_after', 'usd_instrument', '2y_before', '2y_after',
  '10y_before', '10y_after', 'oil_before', 'oil_after', 'regime', 'gold_direction', 'reaction_strength', 'usd_reaction_direction',
  'pre_gold_trend', 'pre_usd_trend', 'pre_10y_trend', 'data_source', 'data_quality', 'origin',
  'event_time', 'surprise_normalized', 'surprise_normalized_basis', 'gold_15m', 'usd_5m', 'usd_30m', 'usd_1h', 'usd_4h', '2y_1h', '10y_1h',
  'real10y_before', 'real10y_after', 'macro_regime', 'market_confirmation', 'event_notes'];
const TEXT = new Set(['event_type', 'surprise_basis', 'usd_instrument', 'regime', 'gold_direction', 'reaction_strength', 'usd_reaction_direction', 'pre_gold_trend', 'pre_usd_trend', 'pre_10y_trend', 'data_quality', 'origin', 'event_time', 'surprise_normalized_basis', 'macro_regime', 'market_confirmation', 'event_notes']);
const sel = (c) => (c === 'event_date' ? `(x->>'event_date')::timestamptz` : c === 'data_source' ? `coalesce(x->'data_source', '{}'::jsonb)` : TEXT.has(c) ? `x->>'${c}'` : `(x->>'${c}')::numeric`);
const upd = (c) => (['event_type', 'event_date', 'origin'].includes(c) ? null
  : c === 'data_source' ? `"data_source" = historical_event_reactions.data_source || EXCLUDED.data_source`
    : c === 'data_quality' ? `"data_quality" = EXCLUDED.data_quality`
      : `"${c}" = coalesce(EXCLUDED."${c}", historical_event_reactions."${c}")`);

module.exports = {
  id: 'giPostEventRevw1',
  file: 'gold-intelligence-post-event.json',
  build(h) {
    h.lane(0);
    const sched = h.schedule('⏱ Post-Event Schedule', { field: 'minutes', minutesInterval: '={{ Number($env.GI_POST_EVENT_INTERVAL_MIN) || 30 }}' }, { notes: 'reviews at +4h, +24h, +3d' });
    const mAuto = h.code('Mode: Auto', 'postevent/mode-auto.js');
    h.lane(1);
    const manual = h.manual('🧪 Post-Event Test');
    const mManual = h.code('Mode: Manual', 'postevent/mode-manual.js', { notes: 're-reviews the most recent real release' });
    h.at(2, 0);
    const load = h.pg('Load Due Reviews', `
WITH p AS (SELECT $1::jsonb AS j),
params AS (SELECT j->>'mode' AS mode, j->>'started_at' AS started_at FROM p),
auto_due AS (
  SELECT r.*, CASE WHEN r.status IN ('SCHEDULED', 'RELEASED') THEN '4H' WHEN r.status = 'REVIEWED_4H' THEN '24H' ELSE '3D' END AS stage
  FROM macro_releases r
  WHERE NOT r.is_test AND r.event_type = ANY(${REVIEW_TYPES}) AND r.scheduled_at > now() - interval '12 days' AND (
        (r.status IN ('SCHEDULED', 'RELEASED') AND r.scheduled_at < now() - interval '4 hours 5 minutes')
     OR (r.status = 'REVIEWED_4H' AND r.scheduled_at < now() - interval '24 hours 5 minutes')
     OR (r.status = 'REVIEWED_24H' AND r.scheduled_at < now() - interval '72 hours 5 minutes'))
  ORDER BY r.scheduled_at LIMIT 4
),
manual_due AS (
  SELECT r.*, '4H' AS stage FROM macro_releases r
  WHERE NOT r.is_test AND r.event_type = ANY(${REVIEW_TYPES})
    AND r.scheduled_at < now() - interval '4 hours 5 minutes' AND r.scheduled_at > now() - interval '15 days'
  ORDER BY r.scheduled_at DESC LIMIT 1
),
due AS (
  SELECT * FROM auto_due WHERE (SELECT mode FROM params) = 'AUTO'
  UNION ALL
  SELECT * FROM manual_due WHERE (SELECT mode FROM params) = 'MANUAL'
)
SELECT (SELECT mode FROM params) AS mode, (SELECT started_at FROM params) AS started_at,
 (SELECT coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb) FROM due d) AS due,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'macro_release_id', f.macro_release_id, 'pre_event_bias', f.pre_event_bias,
         'historical_bias', f.historical_bias, 'bias_score', f.final->'bias_score', 'historical', f.historical,
         'forecast_state', coalesce(f.forecast_state, f.pre_event_bias), 'pre_event_score', f.pre_event_score, 'confidence', f.confidence)), '[]'::jsonb)
    FROM (SELECT DISTINCT ON (macro_release_id) * FROM pre_event_forecasts
          WHERE macro_release_id IN (SELECT id FROM due) AND status <> 'CANCELLED' AND NOT is_test ORDER BY macro_release_id, created_at DESC) f) AS forecasts,
 ${DAILY('US2Y')} AS us2y, ${DAILY('US10Y')} AS us10y, ${DAILY('US10Y_REAL')} AS us10y_real, ${DAILY('USD_PROXY')} AS usd_daily, ${DAILY('WTI')} AS wti,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('t', observed_at, 'v', price) ORDER BY observed_at), '[]'::jsonb) FROM (
    SELECT DISTINCT ON (date_trunc('day', observed_at)) observed_at, price FROM gold_observations
    WHERE observed_at > now() - interval '60 days' ORDER BY date_trunc('day', observed_at), observed_at DESC) g) AS gold_daily`, '$json');
    const review = h.code('Review Releases', 'postevent/review.js', { notes: 'actual · reaction 5m→3d · forecast vs actual' });
    const tg = h.callWorkflow('Telegram Sender', 'giTelegramSend01');
    const rec = h.code('Prepare Review Record', 'postevent/record.js');
    const persist = h.pg('Persist Reviews', `
WITH p AS (SELECT $1::jsonb AS j),
hr AS (
  INSERT INTO historical_event_reactions (${COLS.map((c) => `"${c}"`).join(', ')})
  SELECT ${COLS.map(sel).join(', ')}
  FROM p, jsonb_array_elements(coalesce(p.j->'reactions', '[]'::jsonb)) x
  ON CONFLICT (event_type, event_date) DO UPDATE SET ${COLS.map(upd).filter(Boolean).join(', ')}
  RETURNING 1
),
ru AS (
  UPDATE macro_releases r SET
    status = u->>'status', actual = coalesce(u->>'actual', r.actual), actual_num = coalesce((u->>'actual_num')::numeric, r.actual_num),
    surprise = coalesce((u->>'surprise')::numeric, r.surprise),
    reviewed_at = CASE WHEN (u->>'reviewed')::boolean THEN now() ELSE r.reviewed_at END, updated_at = now()
  FROM p, jsonb_array_elements(coalesce(p.j->'release_updates', '[]'::jsonb)) u
  WHERE r.id = (u->>'id')::bigint
  RETURNING 1
),
ev AS (
  INSERT INTO evaluation_results (forecast_id, macro_release_id, horizon, forecast_bias, realized_direction, realized_move_pct, actual,
    consensus, surprise, hit, prediction_error, reason_for_error, historical_bias, historical_analogy_accuracy, details,
    forecast_state, pre_event_score, confidence, forecast_direction_correct, realized_scenario, scenario_correct,
    market_confirmation_correct, timing_quality, forecast_error, forecast_result, lesson, reactions)
  SELECT (e->>'forecast_id')::bigint, (e->>'macro_release_id')::bigint, e->>'horizon', e->>'forecast_bias', e->>'realized_direction',
         (e->>'realized_move_pct')::numeric, e->>'actual', e->>'consensus', (e->>'surprise')::numeric, (e->>'hit')::boolean,
         (e->>'prediction_error')::numeric, e->>'reason_for_error', e->>'historical_bias', (e->>'historical_analogy_accuracy')::numeric, e->'details',
         e->>'forecast_state', (e->>'pre_event_score')::int, (e->>'confidence')::int, (e->>'forecast_direction_correct')::boolean,
         e->>'realized_scenario', (e->>'scenario_correct')::boolean, (e->>'market_confirmation_correct')::boolean, e->>'timing_quality',
         (e->>'forecast_error')::numeric, e->>'forecast_result', e->>'lesson', e->'reactions'
  FROM p, jsonb_array_elements(coalesce(p.j->'evaluations', '[]'::jsonb)) e
  ON CONFLICT (forecast_id, horizon) DO UPDATE SET realized_direction = EXCLUDED.realized_direction, realized_move_pct = EXCLUDED.realized_move_pct,
    actual = EXCLUDED.actual, surprise = EXCLUDED.surprise, hit = EXCLUDED.hit, prediction_error = EXCLUDED.prediction_error,
    reason_for_error = EXCLUDED.reason_for_error, historical_analogy_accuracy = EXCLUDED.historical_analogy_accuracy, details = EXCLUDED.details,
    forecast_direction_correct = coalesce(EXCLUDED.forecast_direction_correct, evaluation_results.forecast_direction_correct),
    realized_scenario = coalesce(EXCLUDED.realized_scenario, evaluation_results.realized_scenario), scenario_correct = coalesce(EXCLUDED.scenario_correct, evaluation_results.scenario_correct),
    market_confirmation_correct = coalesce(EXCLUDED.market_confirmation_correct, evaluation_results.market_confirmation_correct),
    timing_quality = coalesce(EXCLUDED.timing_quality, evaluation_results.timing_quality), forecast_error = coalesce(EXCLUDED.forecast_error, evaluation_results.forecast_error),
    forecast_result = coalesce(EXCLUDED.forecast_result, evaluation_results.forecast_result), lesson = coalesce(EXCLUDED.lesson, evaluation_results.lesson), reactions = EXCLUDED.reactions
  RETURNING 1
),
fe AS (
  UPDATE pre_event_forecasts f SET evaluated = true
  FROM p, jsonb_array_elements(coalesce(p.j->'release_updates', '[]'::jsonb)) u
  WHERE (u->>'forecast_evaluated')::boolean AND f.macro_release_id = (u->>'id')::bigint
  RETURNING 1
),
jr AS (
  INSERT INTO job_runs (job, started_at, finished_at, status, stats, execution_id)
  SELECT p.j->>'job', (p.j->>'started_at')::timestamptz, now(), p.j->>'status', p.j->'stats', p.j->>'execution_id' FROM p RETURNING id
)
SELECT (SELECT count(*) FROM hr)::int AS reactions, (SELECT count(*) FROM ru)::int AS releases_updated,
       (SELECT count(*) FROM ev)::int AS evaluations, (SELECT id FROM jr) AS job_run_id`, '$json.record');
    h.chain(sched, mAuto, load);
    h.chain(manual, mManual, load);
    h.chain(load, review, tg, rec, persist);
    h.note('About', '## GI · Post-Event Review\nAfter each important release: capture the actual (BLS API / FOMC statement), measure the gold & USD reaction (5m → 3d), append to `historical_event_reactions` (origin LIVE) and score the stored pre-event forecast in `evaluation_results`.\n\nWeights are **never** auto-adjusted from a single event.', [0, 420], [560, 220], 5);
    return h.result({ name: 'GI · Post-Event Review' });
  },
};
