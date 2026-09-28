-- =============================================================================
-- Gold Intelligence n8n — data store schema (PostgreSQL 14+)
-- Intelligence only: no orders, no broker/execution tables by design.
-- Idempotent: safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Source registry (news feeds, calendars, market endpoints) + health counters
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id                   text PRIMARY KEY,
  name                 text NOT NULL,
  publisher            text NOT NULL,
  url                  text NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('rss','atom','ics','json','csv','xml')),
  tier                 smallint NOT NULL CHECK (tier BETWEEN 1 AND 4),
  category_hint        text NOT NULL DEFAULT 'GENERAL',
  poll_group           text NOT NULL DEFAULT 'news',
  enabled              boolean NOT NULL DEFAULT true,
  notes                text,
  last_ok_at           timestamptz,
  last_error_at        timestamptz,
  last_error           text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_item_count      integer,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Every normalised report seen (exact-duplicate guard + audit of filtering)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS news_items (
  id              bigserial PRIMARY KEY,
  item_hash       text NOT NULL UNIQUE,
  source_id       text NOT NULL REFERENCES sources(id),
  publisher       text,
  title           text NOT NULL,
  summary         text,
  url             text,
  published_at    timestamptz,
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  effective_tier  smallint NOT NULL,
  category        text,
  relevance_score integer,
  status          text NOT NULL CHECK (status IN ('IRRELEVANT','RETAINED','LINKED','STALE','INVALID')),
  event_id        bigint,
  is_test         boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS news_items_fetched_idx ON news_items (fetched_at DESC);

-- ---------------------------------------------------------------------------
-- Canonical events (one row per real-world event, many reports)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id                   bigserial PRIMARY KEY,
  event_key            text NOT NULL UNIQUE,
  title                text NOT NULL,
  summary              text,
  category             text NOT NULL,
  subcategory          text,
  region               text,
  first_seen_at        timestamptz NOT NULL,
  last_seen_at         timestamptz NOT NULL,
  published_at         timestamptz,
  source_count         integer NOT NULL DEFAULT 1,
  publisher_count      integer NOT NULL DEFAULT 1,
  best_tier            smallint NOT NULL,
  gold_relevance_score integer NOT NULL,
  importance_score     integer NOT NULL,
  importance_class     text NOT NULL,
  confirmation_status  text NOT NULL,
  net_pressure         text,
  net_score            numeric,
  dominant_driver      text,
  counter_driver       text,
  transmission         jsonb NOT NULL DEFAULT '[]'::jsonb,
  keywords             text[] NOT NULL DEFAULT '{}',
  horizon_biases       jsonb,
  market_confirmation  jsonb,
  tokens               text[] NOT NULL DEFAULT '{}',
  signature            text NOT NULL,
  alert_signature      text,
  last_alerted_at      timestamptz,
  alert_count          integer NOT NULL DEFAULT 0,
  ai_analysis_id       bigint,
  is_test              boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_last_seen_idx ON events (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS events_category_idx ON events (category, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS event_sources (
  event_id     bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  news_item_id bigint NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
  source_id    text NOT NULL,
  publisher    text,
  tier         smallint NOT NULL,
  url          text,
  title        text,
  published_at timestamptz,
  linked_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, news_item_id)
);

-- ---------------------------------------------------------------------------
-- Scheduled macro releases / central-bank decisions (calendar + actuals)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS macro_releases (
  id                   bigserial PRIMARY KEY,
  release_key          text NOT NULL UNIQUE,
  event_type           text NOT NULL,
  country              text NOT NULL DEFAULT 'US',
  title                text NOT NULL,
  scheduled_at         timestamptz NOT NULL,
  impact               text NOT NULL DEFAULT 'HIGH',
  consensus            text,
  previous             text,
  actual               text,
  revised_previous     text,
  consensus_num        numeric,
  previous_num         numeric,
  actual_num           numeric,
  revised_previous_num numeric,
  surprise             numeric,
  surprise_unit        text,
  source               text NOT NULL,
  consensus_source     text,
  status               text NOT NULL DEFAULT 'SCHEDULED'
                       CHECK (status IN ('SCHEDULED','RELEASED','REVIEWED_4H','REVIEWED_24H','REVIEWED_3D','CANCELLED')),
  pre_event_sent_at    timestamptz,
  refresh_sent_at      timestamptz,
  reviewed_at          timestamptz,
  details              jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_test              boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS macro_releases_sched_idx ON macro_releases (scheduled_at);

-- ---------------------------------------------------------------------------
-- Market data
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS market_observations (
  id          bigserial PRIMARY KEY,
  observed_at timestamptz NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  instrument  text NOT NULL,
  value       numeric NOT NULL,
  unit        text,
  source      text NOT NULL,
  resolution  text NOT NULL,
  quality     text NOT NULL DEFAULT 'OK',
  details     jsonb,
  UNIQUE (instrument, source, observed_at)
);
CREATE INDEX IF NOT EXISTS market_obs_instr_idx ON market_observations (instrument, observed_at DESC);

CREATE TABLE IF NOT EXISTS gold_observations (
  id          bigserial PRIMARY KEY,
  observed_at timestamptz NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  price       numeric NOT NULL,
  bid         numeric,
  ask         numeric,
  source      text NOT NULL,
  quality     text NOT NULL DEFAULT 'OK',
  UNIQUE (source, observed_at)
);
CREATE INDEX IF NOT EXISTS gold_obs_time_idx ON gold_observations (observed_at DESC);

-- ---------------------------------------------------------------------------
-- Historical reaction database (backfilled from real data + live post-event)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS historical_event_reactions (
  id                     bigserial PRIMARY KEY,
  event_type             text NOT NULL,
  event_date             timestamptz NOT NULL,
  consensus              numeric,
  actual                 numeric,
  previous               numeric,
  revised_previous       numeric,
  surprise               numeric,
  surprise_basis         text NOT NULL DEFAULT 'NOT_AVAILABLE',
  gold_before            numeric,
  gold_5m                numeric,
  gold_30m               numeric,
  gold_1h                numeric,
  gold_4h                numeric,
  gold_24h               numeric,
  gold_3d                numeric,
  usd_before             numeric,
  usd_after              numeric,
  usd_instrument         text,
  "2y_before"            numeric,
  "2y_after"             numeric,
  "10y_before"           numeric,
  "10y_after"            numeric,
  oil_before             numeric,
  oil_after              numeric,
  regime                 text,
  gold_direction         text,
  reaction_strength      text,
  usd_reaction_direction text,
  pre_gold_trend         text,
  pre_usd_trend          text,
  pre_10y_trend          text,
  data_source            jsonb NOT NULL DEFAULT '{}'::jsonb,
  data_quality           text NOT NULL DEFAULT 'OK',
  origin                 text NOT NULL DEFAULT 'BACKFILL' CHECK (origin IN ('BACKFILL','LIVE')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_type, event_date)
);

-- ---------------------------------------------------------------------------
-- AI, analysis, forecasts, scenarios, evaluation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_runs (
  id                bigserial PRIMARY KEY,
  created_at        timestamptz NOT NULL DEFAULT now(),
  purpose           text NOT NULL,
  provider          text NOT NULL,
  model             text NOT NULL,
  model_rank        smallint,
  success           boolean NOT NULL,
  failure_reason    text,
  http_status       integer,
  latency_ms        integer,
  prompt_tokens     integer,
  completion_tokens integer,
  total_tokens      integer,
  validation        jsonb,
  related_ref       text,
  is_test           boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS ai_runs_created_idx ON ai_runs (created_at DESC);

CREATE TABLE IF NOT EXISTS analysis_results (
  id               bigserial PRIMARY KEY,
  created_at       timestamptz NOT NULL DEFAULT now(),
  analysis_type    text NOT NULL CHECK (analysis_type IN ('EVENT','DESK_STATE','PRE_EVENT','DAILY','POST_EVENT')),
  event_id         bigint,
  macro_release_id bigint,
  mode             text NOT NULL CHECK (mode IN ('AI','DETERMINISTIC')),
  model            text,
  deterministic    jsonb NOT NULL,
  ai_output        jsonb,
  final            jsonb NOT NULL,
  regime           text,
  short_bias       text,
  tactical_bias    text,
  swing_bias       text,
  structural_bias  text,
  confidence       integer,
  data_quality     text,
  is_test          boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS analysis_type_idx ON analysis_results (analysis_type, created_at DESC);

CREATE TABLE IF NOT EXISTS pre_event_forecasts (
  id               bigserial PRIMARY KEY,
  created_at       timestamptz NOT NULL DEFAULT now(),
  macro_release_id bigint NOT NULL REFERENCES macro_releases(id),
  kind             text NOT NULL DEFAULT 'DAILY' CHECK (kind IN ('DAILY','REFRESH')),
  event_type       text NOT NULL,
  scheduled_at     timestamptz NOT NULL,
  historical       jsonb NOT NULL,
  market_context   jsonb NOT NULL,
  historical_bias  text,
  pre_event_bias   text NOT NULL,
  confidence       integer NOT NULL,
  mode             text NOT NULL,
  model            text,
  analysis_id      bigint,
  final            jsonb NOT NULL,
  evaluated        boolean NOT NULL DEFAULT false,
  is_test          boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS pre_event_release_idx ON pre_event_forecasts (macro_release_id, created_at DESC);

CREATE TABLE IF NOT EXISTS scenarios (
  id                     bigserial PRIMARY KEY,
  created_at             timestamptz NOT NULL DEFAULT now(),
  forecast_id            bigint REFERENCES pre_event_forecasts(id) ON DELETE CASCADE,
  analysis_id            bigint REFERENCES analysis_results(id) ON DELETE CASCADE,
  kind                   text NOT NULL CHECK (kind IN ('BULLISH','BEARISH','BASE')),
  trigger_text           text NOT NULL,
  mechanism              text NOT NULL,
  expected_confirmation  text NOT NULL,
  expected_gold_response text NOT NULL,
  invalidation           text NOT NULL,
  historical_support     jsonb,
  is_test                boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS evaluation_results (
  id                          bigserial PRIMARY KEY,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  forecast_id                 bigint NOT NULL REFERENCES pre_event_forecasts(id),
  macro_release_id            bigint NOT NULL REFERENCES macro_releases(id),
  horizon                     text NOT NULL,
  forecast_bias               text NOT NULL,
  realized_direction          text,
  realized_move_pct           numeric,
  actual                      text,
  consensus                   text,
  surprise                    numeric,
  hit                         boolean,
  prediction_error            numeric,
  reason_for_error            text,
  historical_bias             text,
  historical_analogy_accuracy numeric,
  details                     jsonb,
  UNIQUE (forecast_id, horizon)
);

-- ---------------------------------------------------------------------------
-- Delivery, operations, health
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telegram_messages (
  id                  bigserial PRIMARY KEY,
  created_at          timestamptz NOT NULL DEFAULT now(),
  direction           text NOT NULL CHECK (direction IN ('OUT','IN')),
  chat_id             text,
  message_type        text NOT NULL,
  dedup_key           text,
  text_hash           text,
  body                text,
  status              text NOT NULL,
  telegram_message_id bigint,
  attempts            integer NOT NULL DEFAULT 0,
  parts               integer,
  error               text,
  related_ref         text,
  is_test             boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS tg_dedup_idx ON telegram_messages (dedup_key, created_at DESC);
CREATE INDEX IF NOT EXISTS tg_created_idx ON telegram_messages (created_at DESC);

CREATE TABLE IF NOT EXISTS system_health (
  id         bigserial PRIMARY KEY,
  checked_at timestamptz NOT NULL DEFAULT now(),
  component  text NOT NULL,
  status     text NOT NULL CHECK (status IN ('OK','DEGRADED','DOWN','NOT_CONFIGURED','UNKNOWN')),
  detail     text,
  metrics    jsonb
);
CREATE INDEX IF NOT EXISTS health_component_idx ON system_health (component, checked_at DESC);

CREATE TABLE IF NOT EXISTS job_runs (
  id           bigserial PRIMARY KEY,
  job          text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL,
  stats        jsonb,
  execution_id text,
  is_test      boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS job_runs_job_idx ON job_runs (job, started_at DESC);

CREATE TABLE IF NOT EXISTS error_events (
  id            bigserial PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  workflow_id   text,
  workflow_name text,
  node_name     text,
  error_message text,
  error_type    text,
  execution_id  text,
  execution_url text,
  severity      text NOT NULL,
  mode          text,
  alerted       boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS error_events_time_idx ON error_events (occurred_at DESC);

CREATE TABLE IF NOT EXISTS kv_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Curated, source-backed geopolitical / fiscal deadlines for the pre-event engine.
CREATE TABLE IF NOT EXISTS scheduled_deadlines (
  id          bigserial PRIMARY KEY,
  title       text NOT NULL,
  deadline_at timestamptz NOT NULL,
  category    text NOT NULL,
  event_type  text NOT NULL DEFAULT 'GEOPOLITICAL_DEADLINE',
  description text,
  source_url  text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version) VALUES ('001_schema') ON CONFLICT DO NOTHING;
