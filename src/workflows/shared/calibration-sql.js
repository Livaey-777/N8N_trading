'use strict';
// SQL for the calibrated-probability cells (Daily Report workflow + tools/calibrate.js).

const dailyCloses = (instrument) => `(SELECT coalesce(jsonb_agg(jsonb_build_object('t', t, 'v', v) ORDER BY t), '[]'::jsonb) FROM (
    SELECT DISTINCT ON ((observed_at AT TIME ZONE 'UTC')::date) observed_at AS t, value AS v FROM market_observations
    WHERE instrument = '${instrument}' AND observed_at > now() - interval '7 years'
    ORDER BY (observed_at AT TIME ZONE 'UTC')::date, observed_at DESC) d)`;

/** Inputs: daily closes of gold and the market drivers, weekly COT, historical release reactions. */
const LOAD_SQL = `
SELECT
 (SELECT coalesce(jsonb_agg(jsonb_build_object('t', t, 'v', v, 'src', src) ORDER BY t), '[]'::jsonb) FROM (
    SELECT DISTINCT ON ((observed_at AT TIME ZONE 'UTC')::date) observed_at AS t, price AS v, source AS src FROM gold_observations
    WHERE observed_at > now() - interval '7 years' AND observed_at <= now()
    ORDER BY (observed_at AT TIME ZONE 'UTC')::date, observed_at DESC) g) AS gold,
 ${dailyCloses('USD_PROXY')} AS usd,
 ${dailyCloses('US2Y')} AS us2y,
 ${dailyCloses('US10Y')} AS us10y,
 ${dailyCloses('US10Y_REAL')} AS us10y_real,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('t', observed_at, 'v', value) ORDER BY observed_at), '[]'::jsonb)
    FROM market_observations WHERE instrument = 'GOLD_COT_NONCOMM_NET') AS cot,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('event_type', event_type, 'event_date', event_date, 'gold_before', gold_before,
         'gold_3d', gold_3d, 'gold_direction', gold_direction, 'usd_reaction_direction', usd_reaction_direction,
         'data_source', data_source) ORDER BY event_date), '[]'::jsonb)
    FROM historical_event_reactions WHERE data_quality <> 'INSUFFICIENT') AS reactions`;

/** Upserts the rebuilt cells and removes cells that no longer exist. Input $1 = { cells: [...] }. */
const STORE_SQL = `
WITH p AS (SELECT $1::jsonb AS j),
c AS (SELECT x FROM p, jsonb_array_elements(coalesce(p.j->'cells', '[]'::jsonb)) x),
up AS (
  INSERT INTO calibration_cells AS t (kind, horizon, class_key, status, bullish_pct, bearish_pct, neutral_pct, probs, ci95, counts, n,
        window_start, window_end, method, conditioned_on, outcome_definition, walk_forward, evidence, warnings, reason, data_source, built_at)
  SELECT x->>'kind', x->>'horizon', x->>'class_key', x->>'status', (x->>'bullish_pct')::int, (x->>'bearish_pct')::int,
         (x->>'neutral_pct')::int, x->'probs', x->'ci95', x->'counts', (x->>'n')::int, (x->>'window_start')::date,
         (x->>'window_end')::date, x->>'method', x->>'conditioned_on', x->>'outcome_definition', x->'walk_forward',
         x->>'evidence', coalesce(x->'warnings', '[]'::jsonb), x->>'reason', x->>'data_source', now()
  FROM c
  ON CONFLICT (kind, horizon, class_key) DO UPDATE SET
    status = EXCLUDED.status, bullish_pct = EXCLUDED.bullish_pct, bearish_pct = EXCLUDED.bearish_pct, neutral_pct = EXCLUDED.neutral_pct,
    probs = EXCLUDED.probs, ci95 = EXCLUDED.ci95, counts = EXCLUDED.counts, n = EXCLUDED.n, window_start = EXCLUDED.window_start,
    window_end = EXCLUDED.window_end, method = EXCLUDED.method, conditioned_on = EXCLUDED.conditioned_on,
    outcome_definition = EXCLUDED.outcome_definition, walk_forward = EXCLUDED.walk_forward, evidence = EXCLUDED.evidence,
    warnings = EXCLUDED.warnings, reason = EXCLUDED.reason, data_source = EXCLUDED.data_source, built_at = now()
  RETURNING 1
),
stale AS (
  DELETE FROM calibration_cells t WHERE (SELECT count(*) FROM c) > 0
    AND NOT EXISTS (SELECT 1 FROM c WHERE c.x->>'kind' = t.kind AND c.x->>'horizon' = t.horizon AND c.x->>'class_key' = t.class_key)
  RETURNING 1
)
SELECT (SELECT count(*) FROM up)::int AS stored, (SELECT count(*) FROM stale)::int AS removed,
       (SELECT count(*) FROM c WHERE c.x->>'status' = 'CALIBRATED')::int AS calibrated`;

const CELLS_SQL = `(SELECT coalesce(jsonb_agg(to_jsonb(cc) ORDER BY cc.kind, cc.horizon, cc.class_key), '[]'::jsonb) FROM calibration_cells cc)`;

module.exports = { LOAD_SQL, STORE_SQL, CELLS_SQL };
