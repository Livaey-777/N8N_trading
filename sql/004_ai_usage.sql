-- AI usage / quota monitoring + AI control center.
-- Token and cost figures are stored only when the provider returns them (NULL = unknown).
-- Days and hours are UTC buckets: OpenRouter's free-model request counter resets per UTC day.

-- One row per provider attempt, cached reuse or deterministic fallback.
CREATE TABLE IF NOT EXISTS ai_usage (
  id                  bigserial PRIMARY KEY,
  provider            text NOT NULL,                 -- 'openrouter' | 'deterministic'
  model               text NOT NULL,
  key_alias           text,                          -- non-secret label of the API key used
  request_timestamp   timestamptz NOT NULL DEFAULT now(),
  input_tokens        integer,
  output_tokens       integer,
  total_tokens        integer,
  cost                numeric,                       -- provider-reported usage.cost (credits); NULL = unknown
  request_status      text NOT NULL CHECK (request_status IN ('SUCCESS', 'FAILED', 'CACHED', 'FALLBACK', 'SKIPPED')),
  latency_ms          integer,
  fallback_level      smallint NOT NULL DEFAULT 0,   -- 0 primary, 1 secondary, 2 tertiary, 3 deterministic
  error_type          text,
  error_detail        text,                          -- redacted, short
  http_status         integer,
  ratelimit_limit     integer,                       -- X-RateLimit-* from provider 429 responses, when present
  ratelimit_remaining integer,
  ratelimit_reset     timestamptz,
  retry_after_s       integer,
  workflow            text,                          -- master / pre_event / daily / bot / health_probe / test
  event_type          text,                          -- request purpose: EVENT / PRE_EVENT / DAILY / BIGGEST / ...
  priority            smallint,
  related_ref         text,
  fingerprint         text,
  is_test             boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_usage_ts_idx ON ai_usage (request_timestamp DESC);
CREATE INDEX IF NOT EXISTS ai_usage_model_ts_idx ON ai_usage (provider, model, request_timestamp DESC);
CREATE INDEX IF NOT EXISTS ai_usage_failed_idx ON ai_usage (request_timestamp DESC) WHERE request_status = 'FAILED';

-- Daily summary (UTC day), maintained incrementally with every logged request.
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  date                date NOT NULL,
  provider            text NOT NULL,
  model               text NOT NULL,
  requests            integer NOT NULL DEFAULT 0,    -- real provider requests (SUCCESS + FAILED)
  successful_requests integer NOT NULL DEFAULT 0,
  failed_requests     integer NOT NULL DEFAULT 0,
  fallback_requests   integer NOT NULL DEFAULT 0,    -- attempts made because a higher-ranked model failed / deterministic fallbacks
  cached_requests     integer NOT NULL DEFAULT 0,
  token_reported_requests integer NOT NULL DEFAULT 0,
  input_tokens        bigint NOT NULL DEFAULT 0,
  output_tokens       bigint NOT NULL DEFAULT 0,
  total_tokens        bigint NOT NULL DEFAULT 0,
  cost_reported_requests integer NOT NULL DEFAULT 0,
  estimated_cost      numeric,                       -- sum of provider-reported cost; NULL until reported
  quota_state         text NOT NULL DEFAULT 'UNKNOWN',
  last_request_at     timestamptz,
  PRIMARY KEY (date, provider, model)
);

-- Hourly buckets (UTC) to detect bursts before a daily limit is hit.
CREATE TABLE IF NOT EXISTS ai_usage_hourly (
  hour_bucket         timestamptz NOT NULL,
  provider            text NOT NULL,
  model               text NOT NULL,
  requests            integer NOT NULL DEFAULT 0,
  tokens              bigint NOT NULL DEFAULT 0,
  failures            integer NOT NULL DEFAULT 0,
  fallbacks           integer NOT NULL DEFAULT 0,
  PRIMARY KEY (hour_bucket, provider, model)
);

-- Health record per provider/model (updated by requests and by the Health Monitor).
CREATE TABLE IF NOT EXISTS ai_model_health (
  provider               text NOT NULL,
  model                  text NOT NULL,
  display_name           text,
  rank                   smallint,                   -- 1 primary, 2 secondary, 3 tertiary (current configuration)
  listed                 boolean,                    -- present in the provider's model list at the last check
  free                   boolean,                    -- provider pricing prompt = completion = 0 at the last check
  context_length         integer,
  last_success           timestamptz,
  last_failure           timestamptz,
  last_error_type        text,
  success_count          integer NOT NULL DEFAULT 0,
  failure_count          integer NOT NULL DEFAULT 0,
  consecutive_failures   integer NOT NULL DEFAULT 0,
  average_latency        integer,                    -- ms, successful requests
  latency_samples        integer NOT NULL DEFAULT 0,
  current_status         text NOT NULL DEFAULT 'UNKNOWN'
                         CHECK (current_status IN ('HEALTHY', 'DEGRADED', 'RATE_LIMITED', 'OFFLINE', 'UNKNOWN')),
  status_reason          text,
  skip_until             timestamptz,                -- router circuit breaker / rate-limit backoff
  current_fallback_level smallint,
  last_health_check      timestamptz,
  last_probe_at          timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model)
);

-- API keys by non-secret alias. Values are never stored here.
CREATE TABLE IF NOT EXISTS ai_api_keys (
  key_alias               text PRIMARY KEY,
  provider                text NOT NULL,
  status                  text NOT NULL DEFAULT 'UNKNOWN',   -- ACTIVE / INVALID / LIMIT_REACHED / UNKNOWN / NOT_CONFIGURED
  last_success            timestamptz,
  last_failure            timestamptz,
  last_error              text,
  is_free_tier            boolean,
  free_requests_used      integer,       -- provider: free_model_daily_requests.used (current UTC day)
  free_requests_limit     integer,       -- provider: free_model_daily_requests.limit
  free_requests_remaining integer,       -- provider: free_model_daily_requests.remaining
  credit_limit            numeric,
  credit_limit_remaining  numeric,
  usage_daily             numeric,       -- credits used, current UTC day
  usage_monthly           numeric,
  checked_at              timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- AI result cache: reuse an analysis while its material context is unchanged.
CREATE TABLE IF NOT EXISTS ai_cache (
  fingerprint  text PRIMARY KEY,
  purpose      text NOT NULL,
  ref          text,
  provider     text NOT NULL,
  model        text NOT NULL,
  output       jsonb NOT NULL,
  regime       text,
  hits         integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_hit_at  timestamptz
);
CREATE INDEX IF NOT EXISTS ai_cache_expires_idx ON ai_cache (expires_at);

-- Which AI model explained each pre-event forecast (the forecast itself stays deterministic).
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS ai_provider text;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS ai_fallback_level smallint;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS ai_tokens integer;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS ai_latency_ms integer;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS ai_status text;
ALTER TABLE pre_event_forecasts ADD COLUMN IF NOT EXISTS ai_at timestamptz;

CREATE OR REPLACE VIEW forecast_ai_usage AS
SELECT id AS forecast_id, macro_release_id, event_type, kind,
       coalesce(ai_provider, 'deterministic') AS provider,
       coalesce(ai_model, 'deterministic') AS model,
       coalesce(ai_fallback_level, 3) AS fallback_level,
       ai_tokens AS tokens, ai_latency_ms AS latency_ms,
       coalesce(ai_at, created_at) AS timestamp,
       coalesce(ai_status, CASE WHEN mode = 'AI' THEN 'AI' ELSE 'DETERMINISTIC' END) AS status
FROM pre_event_forecasts WHERE NOT is_test;

-- Descriptive statistics per explaining model. Forecast state / score / confidence are deterministic,
-- so these rows describe the forecasts each model explained; they are not a model ranking.
CREATE OR REPLACE VIEW forecast_performance_by_model AS
WITH f AS (
  SELECT DISTINCT ON (macro_release_id) * FROM pre_event_forecasts
  WHERE NOT is_test AND kind IN ('DAILY', 'UPDATE', 'MANUAL', 'REFRESH') AND status <> 'CANCELLED'
  ORDER BY macro_release_id, created_at DESC
),
e AS (SELECT * FROM evaluation_results WHERE horizon = '4H')
SELECT
  coalesce(f.ai_model, 'deterministic') AS model,
  count(*)::int AS forecasts,
  count(e.id)::int AS evaluated,
  count(*) FILTER (WHERE e.forecast_result = 'CORRECT')::int AS correct,
  count(*) FILTER (WHERE e.forecast_result = 'INCORRECT')::int AS incorrect,
  count(*) FILTER (WHERE e.forecast_result = 'MIXED')::int AS mixed,
  round(avg(f.confidence), 1) AS average_confidence,
  round(avg(abs(e.forecast_error)), 3) AS average_error,
  round(avg(f.ai_latency_ms))::int AS average_latency,
  round(avg(CASE WHEN f.ai_fallback_level IS NULL THEN NULL WHEN f.ai_fallback_level > 0 THEN 1.0 ELSE 0.0 END), 3) AS fallback_rate,
  count(*) FILTER (WHERE f.ai_disagreement)::int AS ai_disagreements,
  CASE WHEN count(e.id) < 20 THEN 'INSUFFICIENT SAMPLE — descriptive only'
       ELSE 'descriptive only — not a model ranking' END AS note
FROM f LEFT JOIN e ON e.forecast_id = f.id
GROUP BY 1;
