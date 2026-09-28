'use strict';
/**
 * Typed configuration from the process environment ($env inside n8n).
 * Every threshold and interval is configurable; defaults document the pilot values.
 * Secrets are exposed only as booleans (configured / not) plus accessor functions.
 */

const DEFAULTS = {
  GI_AI_MODELS: 'nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-31b-it:free,qwen/qwen3.8-27b:free',
  GI_AI_TIMEOUT_MS: 60000,
  GI_AI_MAX_TOKENS: 3000,
  GI_AI_DAILY_BUDGET: 40,
  GI_AI_MIN_RELEVANCE: 70,
  GI_AI_MIN_IMPORTANCE: 70,
  GI_AI_MAX_EVENTS_PER_RUN: 2,
  GI_RETAIN_MIN_RELEVANCE: 35,
  GI_ALERT_MIN_RELEVANCE: 60,
  GI_ALERT_MIN_IMPORTANCE: 65,
  GI_ALERT_MAX_PER_RUN: 3,
  GI_ALERT_COOLDOWN_MIN: 120,
  GI_DEDUP_WINDOW_HOURS: 36,
  GI_DEDUP_MIN_COVERAGE: 0.6,
  GI_MAX_ITEM_AGE_HOURS: 24,
  GI_HIST_MIN_SAMPLE: 8,
  GI_NEWS_INTERVAL_MIN: 15,
  GI_MARKET_INTERVAL_MIN: 10,
  GI_BOT_POLL_SECONDS: 30,
  GI_BOT_LONGPOLL_SECONDS: 20,
  GI_HEALTH_INTERVAL_MIN: 5,
  GI_POST_EVENT_INTERVAL_MIN: 30,
  GI_PREEVENT_REFRESH_INTERVAL_MIN: 30,
  GI_PREEVENT_DAILY_HOUR: 6,
  GI_DAILY_REPORT_HOUR: 7,
  GI_PREEVENT_LOOKAHEAD_HOURS: 36,
  GI_PREEVENT_REFRESH_LEAD_MIN: 90,
  GI_TECH_ALERT_COOLDOWN_MIN: 60,
  GI_HTTP_TIMEOUT_MS: 20000,
  GI_HTTP_USER_AGENT: 'GoldIntel-n8n/0.1 (automated macro research bot)',
  GENERIC_TIMEZONE: 'Africa/Casablanca',
  // AI usage / quota monitoring. Empty model vars fall back to GI_AI_MODELS (in order).
  OPENROUTER_PRIMARY_MODEL: '',
  OPENROUTER_SECONDARY_MODEL: '',
  OPENROUTER_TERTIARY_MODEL: '',
  AI_USAGE_WARNING_PERCENT: 70,
  AI_USAGE_CRITICAL_PERCENT: 90,
  AI_MAX_REQUESTS_DAY: 40,
  AI_MAX_REQUESTS_HOUR: 12,
  AI_MAX_TOKENS_DAY: 0,
  AI_MAX_TOKENS_REQUEST: 3000,
  AI_FALLBACK_THRESHOLD: 3,
  AI_HEALTH_CHECK_INTERVAL: 60,
  AI_HEALTH_PROBE: 'idle',
  AI_HEALTH_PROBE_IDLE_HOURS: 12,
  AI_CACHE_TTL_MIN: 180,
  AI_USAGE_ALERT_COOLDOWN_MIN: 180,
  AI_DAILY_REPORT_SECTION: 'auto',
  AI_KEY_ALIAS: 'openrouter-main',
  AI_BOT_TIMEOUT_MS: 25000,
  // Reasoning for the AI analyst: off (default; reasoning tokens exhausted the budget in live tests) | low
  AI_REASONING: 'off',
  // Calibrated probabilities: minimum non-overlapping cases / walk-forward checks / warm-up (see calibration.js)
  GI_PROB_MIN_SAMPLE: 20,
  GI_PROB_MIN_EVAL: 10,
  GI_PROB_WARMUP: 10,
};

const NUMERIC_BOUNDS = {
  GI_AI_TIMEOUT_MS: [5000, 180000],
  GI_AI_MAX_TOKENS: [400, 8000],
  GI_AI_DAILY_BUDGET: [0, 1000],
  GI_AI_MIN_RELEVANCE: [0, 100],
  GI_AI_MIN_IMPORTANCE: [0, 100],
  GI_AI_MAX_EVENTS_PER_RUN: [0, 10],
  GI_RETAIN_MIN_RELEVANCE: [0, 100],
  GI_ALERT_MIN_RELEVANCE: [0, 100],
  GI_ALERT_MIN_IMPORTANCE: [0, 100],
  GI_ALERT_MAX_PER_RUN: [0, 20],
  GI_ALERT_COOLDOWN_MIN: [0, 10080],
  GI_DEDUP_WINDOW_HOURS: [1, 240],
  GI_DEDUP_MIN_COVERAGE: [0.2, 1],
  GI_MAX_ITEM_AGE_HOURS: [1, 336],
  GI_HIST_MIN_SAMPLE: [3, 200],
  GI_NEWS_INTERVAL_MIN: [5, 240],
  GI_MARKET_INTERVAL_MIN: [2, 240],
  GI_BOT_POLL_SECONDS: [10, 600],
  GI_BOT_LONGPOLL_SECONDS: [0, 50],
  GI_HEALTH_INTERVAL_MIN: [1, 120],
  GI_POST_EVENT_INTERVAL_MIN: [5, 240],
  GI_PREEVENT_REFRESH_INTERVAL_MIN: [5, 240],
  GI_PREEVENT_DAILY_HOUR: [0, 23],
  GI_DAILY_REPORT_HOUR: [0, 23],
  GI_PREEVENT_LOOKAHEAD_HOURS: [6, 240],
  GI_PREEVENT_REFRESH_LEAD_MIN: [15, 720],
  GI_TECH_ALERT_COOLDOWN_MIN: [5, 1440],
  GI_HTTP_TIMEOUT_MS: [2000, 120000],
  AI_USAGE_WARNING_PERCENT: [1, 99],
  AI_USAGE_CRITICAL_PERCENT: [1, 100],
  AI_MAX_REQUESTS_DAY: [0, 100000],
  AI_MAX_REQUESTS_HOUR: [0, 10000],
  AI_MAX_TOKENS_DAY: [0, 1000000000],
  AI_MAX_TOKENS_REQUEST: [200, 8000],
  AI_FALLBACK_THRESHOLD: [1, 100],
  AI_HEALTH_CHECK_INTERVAL: [5, 1440],
  AI_HEALTH_PROBE_IDLE_HOURS: [1, 168],
  AI_CACHE_TTL_MIN: [0, 10080],
  AI_USAGE_ALERT_COOLDOWN_MIN: [10, 10080],
  AI_BOT_TIMEOUT_MS: [5000, 60000],
  GI_PROB_MIN_SAMPLE: [10, 500],
  GI_PROB_MIN_EVAL: [5, 200],
  GI_PROB_WARMUP: [5, 200],
};

function num(env, key) {
  const raw = env[key];
  const def = DEFAULTS[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  const [lo, hi] = NUMERIC_BOUNDS[key] || [-Infinity, Infinity];
  return Math.min(hi, Math.max(lo, n));
}

function str(env, key) {
  const raw = env[key];
  return raw === undefined || raw === null || String(raw).trim() === '' ? DEFAULTS[key] : String(raw).trim();
}

function loadConfig(env) {
  const e = env || {};
  const chatIds = String(e.TELEGRAM_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
  // Model chain: OPENROUTER_{PRIMARY,SECONDARY,TERTIARY}_MODEL, each falling back to GI_AI_MODELS[i].
  const legacy = str(e, 'GI_AI_MODELS').split(',').map((s) => s.trim()).filter(Boolean);
  const ranked = ['OPENROUTER_PRIMARY_MODEL', 'OPENROUTER_SECONDARY_MODEL', 'OPENROUTER_TERTIARY_MODEL']
    .map((k, i) => String(e[k] || '').trim() || legacy[i] || '');
  const models = ranked.filter((m, i) => m && ranked.indexOf(m) === i);
  const modelSource = ['OPENROUTER_PRIMARY_MODEL', 'OPENROUTER_SECONDARY_MODEL', 'OPENROUTER_TERTIARY_MODEL'].some((k) => String(e[k] || '').trim())
    ? 'OPENROUTER_*_MODEL' : 'GI_AI_MODELS';
  // AI_MAX_REQUESTS_DAY / AI_MAX_TOKENS_REQUEST supersede the older GI_AI_DAILY_BUDGET / GI_AI_MAX_TOKENS.
  const pick = (key, legacyKey) => (String(e[key] ?? '').trim() !== '' ? num(e, key) : num(e, legacyKey));
  const cfg = {
    timezone: str(e, 'GENERIC_TIMEZONE'),
    http: { timeoutMs: num(e, 'GI_HTTP_TIMEOUT_MS'), userAgent: str(e, 'GI_HTTP_USER_AGENT') },
    secrets: {
      telegramConfigured: Boolean(String(e.TELEGRAM_BOT_TOKEN || '').trim()) && chatIds.length > 0,
      telegramTokenConfigured: Boolean(String(e.TELEGRAM_BOT_TOKEN || '').trim()),
      telegramChatConfigured: chatIds.length > 0,
      openrouterConfigured: Boolean(String(e.OPENROUTER_API_KEY || '').trim()),
      fredConfigured: Boolean(String(e.FRED_API_KEY || '').trim()),
    },
    telegram: { chatIds, defaultChatId: chatIds[0] || null },
    ai: {
      models,
      modelSource,
      timeoutMs: num(e, 'GI_AI_TIMEOUT_MS'),
      maxTokens: pick('AI_MAX_TOKENS_REQUEST', 'GI_AI_MAX_TOKENS'),
      dailyBudget: pick('AI_MAX_REQUESTS_DAY', 'GI_AI_DAILY_BUDGET'),
      maxRequestsHour: num(e, 'AI_MAX_REQUESTS_HOUR'),
      maxTokensDay: num(e, 'AI_MAX_TOKENS_DAY'),
      warningPct: num(e, 'AI_USAGE_WARNING_PERCENT'),
      criticalPct: Math.max(num(e, 'AI_USAGE_CRITICAL_PERCENT'), num(e, 'AI_USAGE_WARNING_PERCENT')),
      fallbackThreshold: num(e, 'AI_FALLBACK_THRESHOLD'),
      healthCheckIntervalMin: num(e, 'AI_HEALTH_CHECK_INTERVAL'),
      probeMode: /^off$/i.test(str(e, 'AI_HEALTH_PROBE')) ? 'off' : 'idle',
      probeIdleHours: num(e, 'AI_HEALTH_PROBE_IDLE_HOURS'),
      cacheTtlMin: num(e, 'AI_CACHE_TTL_MIN'),
      alertCooldownMin: num(e, 'AI_USAGE_ALERT_COOLDOWN_MIN'),
      dailyReportSection: ['always', 'never'].includes(str(e, 'AI_DAILY_REPORT_SECTION').toLowerCase()) ? str(e, 'AI_DAILY_REPORT_SECTION').toLowerCase() : 'auto',
      keyAlias: str(e, 'AI_KEY_ALIAS').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'openrouter-main',
      botTimeoutMs: num(e, 'AI_BOT_TIMEOUT_MS'),
      reasoning: /^low$/i.test(str(e, 'AI_REASONING')) ? 'low' : 'off',
      minRelevance: num(e, 'GI_AI_MIN_RELEVANCE'),
      minImportance: num(e, 'GI_AI_MIN_IMPORTANCE'),
      maxEventsPerRun: num(e, 'GI_AI_MAX_EVENTS_PER_RUN'),
    },
    thresholds: {
      retainRelevance: num(e, 'GI_RETAIN_MIN_RELEVANCE'),
      alertRelevance: num(e, 'GI_ALERT_MIN_RELEVANCE'),
      alertImportance: num(e, 'GI_ALERT_MIN_IMPORTANCE'),
      alertMaxPerRun: num(e, 'GI_ALERT_MAX_PER_RUN'),
      alertCooldownMin: num(e, 'GI_ALERT_COOLDOWN_MIN'),
      dedupWindowHours: num(e, 'GI_DEDUP_WINDOW_HOURS'),
      dedupMinCoverage: num(e, 'GI_DEDUP_MIN_COVERAGE'),
      maxItemAgeHours: num(e, 'GI_MAX_ITEM_AGE_HOURS'),
      histMinSample: num(e, 'GI_HIST_MIN_SAMPLE'),
    },
    calibration: {
      minSample: num(e, 'GI_PROB_MIN_SAMPLE'),
      minEval: num(e, 'GI_PROB_MIN_EVAL'),
      warmup: num(e, 'GI_PROB_WARMUP'),
      marketThreshold: 0.15,
    },
    schedule: {
      newsIntervalMin: num(e, 'GI_NEWS_INTERVAL_MIN'),
      marketIntervalMin: num(e, 'GI_MARKET_INTERVAL_MIN'),
      botPollSeconds: num(e, 'GI_BOT_POLL_SECONDS'),
      botLongPollSeconds: num(e, 'GI_BOT_LONGPOLL_SECONDS'),
      healthIntervalMin: num(e, 'GI_HEALTH_INTERVAL_MIN'),
      postEventIntervalMin: num(e, 'GI_POST_EVENT_INTERVAL_MIN'),
      preEventRefreshIntervalMin: num(e, 'GI_PREEVENT_REFRESH_INTERVAL_MIN'),
      preEventDailyHour: num(e, 'GI_PREEVENT_DAILY_HOUR'),
      dailyReportHour: num(e, 'GI_DAILY_REPORT_HOUR'),
      preEventLookaheadHours: num(e, 'GI_PREEVENT_LOOKAHEAD_HOURS'),
      preEventRefreshLeadMin: num(e, 'GI_PREEVENT_REFRESH_LEAD_MIN'),
      techAlertCooldownMin: num(e, 'GI_TECH_ALERT_COOLDOWN_MIN'),
    },
  };
  return cfg;
}

/** Secret accessors — values never leave the calling Code node except in outbound auth. */
function secretsFrom(env) {
  const e = env || {};
  return {
    telegramToken: String(e.TELEGRAM_BOT_TOKEN || '').trim(),
    openrouterKey: String(e.OPENROUTER_API_KEY || '').trim(),
    fredKey: String(e.FRED_API_KEY || '').trim(),
    list() { return [this.telegramToken, this.openrouterKey, this.fredKey].filter(Boolean); },
  };
}

/** Non-secret view for /status and logs. */
function describeConfig(cfg) {
  const s = (b) => (b ? 'CONFIGURED' : 'NOT CONFIGURED');
  return {
    telegram: s(cfg.secrets.telegramConfigured),
    openrouter: s(cfg.secrets.openrouterConfigured),
    fred: s(cfg.secrets.fredConfigured),
    models: cfg.ai.models,
    model_source: cfg.ai.modelSource,
    ai_daily_budget: cfg.ai.dailyBudget,
    ai_limits: {
      max_requests_day: cfg.ai.dailyBudget, max_requests_hour: cfg.ai.maxRequestsHour, max_tokens_day: cfg.ai.maxTokensDay,
      max_tokens_request: cfg.ai.maxTokens, warning_pct: cfg.ai.warningPct, critical_pct: cfg.ai.criticalPct,
      fallback_threshold: cfg.ai.fallbackThreshold, health_check_interval_min: cfg.ai.healthCheckIntervalMin,
      probe: cfg.ai.probeMode, probe_idle_hours: cfg.ai.probeIdleHours, cache_ttl_min: cfg.ai.cacheTtlMin,
      alert_cooldown_min: cfg.ai.alertCooldownMin, key_alias: cfg.ai.keyAlias, reasoning: cfg.ai.reasoning,
    },
    thresholds: cfg.thresholds,
    schedule: cfg.schedule,
    timezone: cfg.timezone,
  };
}

module.exports = { loadConfig, secretsFrom, describeConfig, DEFAULTS };
