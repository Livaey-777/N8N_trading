-- Calibrated directional probabilities (empirical, walk-forward validated).
-- A probability exists ONLY for cells with status CALIBRATED; it is never derived from a score or a
-- confidence value. Rebuilt daily by the Daily Report workflow and by `node tools/calibrate.js`.
CREATE TABLE IF NOT EXISTS calibration_cells (
  kind               text NOT NULL CHECK (kind IN ('DESK', 'EVENT_SCENARIO')),
  horizon            text NOT NULL CHECK (horizon IN ('SHORT', 'TACTICAL', 'SWING', 'STRUCTURAL')),
  class_key          text NOT NULL,          -- DESK: market-driver state (BULLISH/BEARISH/NEUTRAL); EVENT: <TYPE|FAMILY>:<SCENARIO>
  status             text NOT NULL CHECK (status IN ('CALIBRATED', 'UNAVAILABLE')),
  bullish_pct        integer,                -- NULL unless CALIBRATED; the three sum to 100
  bearish_pct        integer,
  neutral_pct        integer,
  probs              jsonb,                  -- unrounded estimator output
  ci95               jsonb,                  -- Wilson 95 % interval per class (raw frequencies)
  counts             jsonb NOT NULL,         -- outcome counts of the (non-overlapping) sample
  n                  integer NOT NULL,       -- non-overlapping observations used
  window_start       date,
  window_end         date,
  method             text NOT NULL,
  conditioned_on     text NOT NULL,
  outcome_definition text NOT NULL,
  walk_forward       jsonb,                  -- n_eval, brier, brier_uniform, brier_climatology, skill_*
  evidence           text NOT NULL CHECK (evidence IN ('STRONG', 'MODERATE', 'WEAK', 'INSUFFICIENT')),
  warnings           jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason             text,                   -- why UNAVAILABLE
  data_source        text,
  built_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, horizon, class_key)
);
