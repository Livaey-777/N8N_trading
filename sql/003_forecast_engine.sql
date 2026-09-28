-- =============================================================================
-- 003 — Forecast & Conditional Scenario Engine (extends existing tables; nothing dropped)
-- =============================================================================

-- ---- Historical event database: spec §4 fields --------------------------------
ALTER TABLE historical_event_reactions ADD COLUMN IF NOT EXISTS event_time text;
ALTER TABLE historical_event_reactions ADD COLUMN IF NOT EXISTS surprise_normalized numeric;
ALTER TABLE historical_event_reactions ADD COLUMN IF NOT EXISTS surprise_normalized_basis text;
ALTER TABLE historical_event_reactions ADD COLUMN IF NOT EXISTS gold_15m numeric;
ALTER TABLE historical_event_reactions ADD COLUMN IF NOT EXISTS usd_5m numeric;
ALTER TABLE historical_event_reactions ADD COLUMN IF NOT EXISTS usd_30m numeric;
ALTER TABLE historical_event_reactions ADD COLUMN IF NOT EXISTS usd_1h numeric;
ALTER TABLE historical_event_reactions ADD COLUMN IF NOT EXISTS usd_4h numeric;
ALTER TABLE historical_event_reactions ADD COLUMN IF NOT EXISTS "2y_1h" numeric;
ALTER TABLE historical_event_reactions ADD COLUMN IF NOT EXISTS "10y_1h" numeric;
ALTER TABLE historical_event_reactions ADD COLUMN IF NOT EXISTS real10y_before numeric;
ALTER TABLE historical_event_reactions ADD COLUMN IF NOT EXISTS real10y_after numeric;
ALTER TABLE historical_event_reactions ADD COLUMN IF NOT EXISTS macro_regime text;
ALTER TABLE historical_event_reactions ADD COLUMN IF NOT EXISTS inflation_state text;
ALTER TABLE historical_event_reactions ADD COLUMN IF NOT EXISTS labor_state text;
ALTER TABLE historical_event_reactions ADD COLUMN IF NOT EXISTS policy_state text;
ALTER TABLE historical_event_reactions ADD COLUMN IF NOT EXISTS geopolitical_state text;
ALTER TABLE historical_event_reactions ADD COLUMN IF NOT EXISTS political_state text;
ALTER TABLE historical_event_reactions ADD COLUMN IF NOT EXISTS market_confirmation text;
ALTER TABLE historical_event_reactions ADD COLUMN IF NOT EXISTS event_notes text;

-- Spec-named read view (aliases, no data duplication).
CREATE OR REPLACE VIEW historical_event_reactions_v AS
SELECT id, event_type, event_date, event_time, consensus, actual, previous, revised_previous, surprise, surprise_normalized,
       gold_before AS pre_event_gold, gold_5m, gold_15m, gold_30m, gold_1h, gold_4h, gold_24h, gold_3d,
       usd_before AS pre_event_usd, usd_5m, usd_30m, usd_1h, usd_4h, usd_instrument,
       "2y_before" AS pre_event_2y, "2y_1h", "2y_after", "10y_before" AS pre_event_10y, "10y_1h", "10y_after",
       real10y_before, real10y_after, oil_before, oil_after,
       coalesce(macro_regime, regime) AS macro_regime, inflation_state, labor_state, policy_state,
       coalesce(geopolitical_state, 'NOT_AVAILABLE') AS geopolitical_state, coalesce(political_state, 'NOT_AVAILABLE') AS political_state,
       gold_direction, reaction_strength AS gold_reaction_strength, market_confirmation, event_notes,
       usd_reaction_direction, pre_gold_trend, pre_usd_trend, pre_10y_trend, data_quality, data_source, origin
FROM historical_event_reactions;

-- ---- Releases: postponement / time-change tracking ---------------------------
ALTER TABLE macro_releases DROP CONSTRAINT IF EXISTS macro_releases_status_check;
ALTER TABLE macro_releases ADD CONSTRAINT macro_releases_status_check
  CHECK (status IN ('SCHEDULED','RELEASED','REVIEWED_4H','REVIEWED_24H','REVIEWED_3D','CANCELLED','RESCHEDULED'));
ALTER TABLE macro_releases ADD COLUMN IF NOT EXISTS rescheduled_to bigint;
ALTER TABLE macro_releases ADD COLUMN IF NOT EXISTS expected_market_sensitivity numeric;
ALTER TABLE macro_releases ADD COLUMN IF NOT EXISTS market_pricing text;

-- ---- Forecast memory (spec §15) ----------------------------------------------
ALTER TABLE pre_event_forecasts DROP CONSTRAINT IF EXISTS pre_event_forecasts_kind_check;
ALTER TABLE pre_event_forecasts ADD CONSTRAINT pre_event_forecasts_kind_check CHECK (kind IN ('DAILY','REFRESH','UPDATE','MANUAL'));
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS forecast_state text;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS pre_event_score integer;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS historical_sample_size integer;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS historical_evidence_quality integer;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS regime_match text;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS data_quality text;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS data_quality_reasons jsonb;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS undetermined_reasons jsonb;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS bullish_scenario jsonb;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS bearish_scenario jsonb;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS base_scenario jsonb;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS confirmation_conditions jsonb;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS invalidation_conditions jsonb;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS ai_summary text;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS ai_model text;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS ai_disagreement boolean NOT NULL DEFAULT false;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS ai_disagreement_reason text;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS data_snapshot jsonb;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS superseded_by bigint;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS update_reason jsonb;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS sent boolean NOT NULL DEFAULT false;

ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS support text;
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS confidence integer;
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS causal_chain text;

-- ---- Post-event evaluation (spec §16) -----------------------------------------
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS forecast_state text;
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS pre_event_score integer;
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS confidence integer;
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS forecast_direction_correct boolean;
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS realized_scenario text;
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS scenario_correct boolean;
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS market_confirmation_correct boolean;
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS timing_quality text;
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS forecast_error numeric;
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS forecast_result text;
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS lesson text;
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS reactions jsonb;

-- ---- Forecast performance (spec §17) — statistics only, never used to auto-tune ----
CREATE OR REPLACE VIEW forecast_performance AS
WITH f AS (
  SELECT DISTINCT ON (macro_release_id) * FROM pre_event_forecasts
  WHERE NOT is_test AND kind IN ('DAILY', 'UPDATE', 'MANUAL', 'REFRESH') AND status <> 'CANCELLED'
  ORDER BY macro_release_id, created_at DESC
),
e AS (SELECT * FROM evaluation_results WHERE horizon = '4H')
SELECT
  count(*)::int AS forecasts_total,
  count(*) FILTER (WHERE f.forecast_state = 'BULLISH')::int AS bullish_forecasts,
  count(*) FILTER (WHERE f.forecast_state = 'BEARISH')::int AS bearish_forecasts,
  count(*) FILTER (WHERE f.forecast_state IN ('MIXED', 'NEUTRAL'))::int AS mixed_forecasts,
  count(*) FILTER (WHERE f.forecast_state = 'UNDETERMINED' OR f.forecast_state IS NULL)::int AS undetermined_forecasts,
  count(*) FILTER (WHERE e.forecast_direction_correct)::int AS directionally_correct,
  count(*) FILTER (WHERE e.forecast_direction_correct = false)::int AS directionally_incorrect,
  count(*) FILTER (WHERE e.scenario_correct)::int AS scenario_correct,
  count(*) FILTER (WHERE e.scenario_correct = false)::int AS scenario_incorrect,
  round(avg(e.forecast_error)::numeric, 3) AS average_forecast_error,
  round(avg(f.confidence)::numeric, 1) AS average_confidence,
  round(avg(abs(coalesce(e.confidence, f.confidence) / 100.0 - CASE WHEN e.forecast_direction_correct THEN 1 ELSE 0 END))
        FILTER (WHERE e.forecast_direction_correct IS NOT NULL)::numeric, 3) AS confidence_calibration_error,
  round(avg(e.historical_analogy_accuracy)::numeric, 3) AS historical_analogue_success,
  count(e.id)::int AS evaluated
FROM f LEFT JOIN e ON e.forecast_id = f.id;

-- ---- Calibration preparation (spec §14): frequencies per cell, NOT probabilities ----
CREATE OR REPLACE VIEW forecast_calibration_cells AS
SELECT event_type,
       coalesce(macro_regime, regime, 'UNKNOWN') AS regime,
       CASE WHEN surprise_normalized IS NULL THEN 'UNKNOWN'
            WHEN surprise_normalized <= -1 THEN 'LARGE_NEGATIVE'
            WHEN surprise_normalized < -0.25 THEN 'NEGATIVE'
            WHEN surprise_normalized <= 0.25 THEN 'IN_LINE'
            WHEN surprise_normalized < 1 THEN 'POSITIVE'
            ELSE 'LARGE_POSITIVE' END AS surprise_range,
       coalesce(usd_reaction_direction, 'UNKNOWN') AS usd_reaction,
       count(*)::int AS n,
       count(*) FILTER (WHERE gold_direction = 'BULLISH')::int AS bullish,
       count(*) FILTER (WHERE gold_direction = 'BEARISH')::int AS bearish,
       count(*) FILTER (WHERE gold_direction = 'MIXED')::int AS mixed,
       round((count(*) FILTER (WHERE gold_direction = 'BULLISH'))::numeric / nullif(count(*), 0), 3) AS freq_bullish,
       round((count(*) FILTER (WHERE gold_direction = 'BEARISH'))::numeric / nullif(count(*), 0), 3) AS freq_bearish,
       round((count(*) FILTER (WHERE gold_direction = 'MIXED'))::numeric / nullif(count(*), 0), 3) AS freq_mixed,
       (count(*) >= 30) AS sample_sufficient,
       'Observed frequencies only. Not calibrated probabilities until sample_sufficient AND out-of-sample calibration is validated.'::text AS note
FROM historical_event_reactions
WHERE data_quality <> 'INSUFFICIENT'
GROUP BY 1, 2, 3, 4;

INSERT INTO schema_migrations (version) VALUES ('003_forecast_engine') ON CONFLICT DO NOTHING;
