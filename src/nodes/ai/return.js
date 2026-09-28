'use strict';
// Returns the router results to the calling workflow (one item), after usage was recorded
// and any usage alert was handed to the Telegram sender.
const router = $('AI Router').first().json;
const logged = $('Record AI Usage').first().json;
return [{
  json: {
    results: router.results,
    budget: router.budget,
    quota: router.quota,
    openrouter: router.openrouter,
    runs_logged: Number(logged.runs_logged || 0),
    usage_logged: Number(logged.usage_logged || 0),
    alerts: (router.alert_payload.messages || []).length,
    summary: router.results.map((r) => ({
      ref: r.ref, mode: r.mode, cached: Boolean(r.cached), model: r.model, model_rank: r.model_rank, fallback_level: r.fallback_level,
      fallback_reason: r.fallback_reason, priority: r.priority, cache_miss_reason: r.cache_miss_reason || null,
      attempts: (r.attempts || []).map((a) => `${a.rank}:${a.model}:${a.skipped ? a.failure_reason : a.success ? 'OK' : a.failure_reason}:${a.latency_ms}ms:${a.total_tokens ?? 'tok?'}`),
    })),
  },
}];
