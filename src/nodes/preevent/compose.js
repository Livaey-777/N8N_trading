'use strict';
// PRE-EVENT TELEGRAM: full forecast (daily / manual), FORECAST UPDATE / INVALIDATED (refresh),
// calendar notices (cancelled / rescheduled) + forecast memory records.
const { loadConfig } = require('../../lib/config');
const T = require('../../lib/telegram');

const cfg = loadConfig($env);
const eng = $('Forecast Engine').first().json;
const ai = $input.first().json;
const byRef = Object.fromEntries((ai.results || []).map((r) => [r.ref, r]));
const localDay = new Date().toLocaleDateString('en-CA', { timeZone: cfg.timezone });
const messages = [];
const forecasts = [];
for (const it of eng.items || []) {
  const { release, fc, kind, cmp, prev } = it;
  const res = byRef[release.release_key];
  const req = (eng.payload.requests || []).find((q) => q.ref === release.release_key) || {};
  const out = res && res.output ? res.output : req.deterministic;
  const meta = { mode: res ? res.mode : 'DETERMINISTIC', model: res ? res.model : null, fallbackReason: res ? res.fallback_reason : 'NO_RESULT', kind, dataQuality: it.dataQuality };
  let text;
  let type = 'PRE_EVENT';
  if (kind === 'UPDATE' && cmp) {
    text = T.formatForecastUpdate(prev, fc, cmp, cfg.timezone, cmp.invalidated);
    type = cmp.invalidated ? 'FORECAST_INVALIDATED' : 'FORECAST_UPDATE';
  } else if (kind === 'REFRESH') {
    text = `⏱ ${T.esc('T-minus check')}\n${T.formatForecastUpdate(prev || { forecast_state: 'n/a', pre_event_score: 'n/a', confidence: 'n/a' }, fc, { changes: prev ? ['no material change since the daily forecast'] : ['first forecast for this event'] }, cfg.timezone, false)}`;
    type = 'PRE_EVENT_REFRESH';
  } else {
    text = T.formatForecast(fc, out, meta, cfg.timezone);
  }
  messages.push({
    text,
    message_type: type,
    dedup_key: `forecast:${release.release_key}:${type}:${kind === 'MANUAL' ? new Date().toISOString().slice(0, 16) : kind === 'UPDATE' ? `${fc.forecast_state}:${fc.pre_event_score}` : localDay}`,
    dedup_window_min: kind === 'MANUAL' ? 10 : kind === 'UPDATE' ? 360 : 1440,
    related_ref: `release:${release.id}`,
    is_test: false,
  });
  const sc = fc.scenarios;
  const scen = (k, s) => ({ kind: k, trigger_text: s.trigger, mechanism: s.mechanism, expected_confirmation: s.expected_market_confirmation || s.market_confirmation, expected_gold_response: s.gold_response, invalidation: s.invalidation, historical_support: { text: s.historical_support, support: s.support, confidence: s.confidence }, support: s.support, confidence: s.confidence, causal_chain: s.causal_chain });
  forecasts.push({
    macro_release_id: release.id, release_key: release.release_key, kind, event_type: release.event_type, scheduled_at: release.scheduled_at,
    historical: {
      sample_size: fc.analogues.historical_sample_size, effective_sample: fc.analogues.effective_sample, unconditional: fc.analogues.unconditional,
      conditional: fc.analogues.conditional, best_analogues: fc.analogues.best_analogues, conditional_on_usd_reaction: fc.analogues.conditional_on_usd_reaction,
      largest_upside_reaction: fc.analogues.largest_upside_reaction, largest_downside_reaction: fc.analogues.largest_downside_reaction,
      evidence_components: fc.analogues.evidence_components, period: fc.analogues.period,
    },
    market_context: fc.layers,
    historical_bias: fc.analogues.historical_bias,
    pre_event_bias: fc.forecast_state,
    forecast_state: fc.forecast_state,
    pre_event_score: fc.pre_event_score,
    confidence: fc.pre_event_confidence,
    historical_sample_size: fc.analogues.historical_sample_size,
    historical_evidence_quality: fc.analogues.historical_evidence_quality,
    regime_match: fc.analogues.regime_match,
    data_quality: fc.data_quality.level,
    data_quality_reasons: fc.data_quality.reasons,
    undetermined_reasons: fc.undetermined_reasons,
    bullish_scenario: sc.bullish, bearish_scenario: sc.bearish, base_scenario: sc.base,
    confirmation_conditions: fc.confirmation_conditions,
    invalidation_conditions: fc.invalidation_conditions,
    mode: meta.mode, model: meta.model,
    // Which AI explained this forecast (spec §20); the forecast itself is deterministic.
    ai_provider: res && res.mode === 'AI' ? 'openrouter' : 'deterministic',
    ai_fallback_level: res && res.mode === 'AI' ? (res.fallback_level ?? (res.model_rank ? res.model_rank - 1 : null)) : 3,
    ai_tokens: (() => {
      const rep = ((res && res.attempts) || []).filter((a) => Number.isFinite(a.total_tokens));
      return rep.length ? rep.reduce((s, a) => s + a.total_tokens, 0) : null;
    })(),
    ai_latency_ms: (() => {
      const ok = ((res && res.attempts) || []).find((a) => a.success);
      return ok ? ok.latency_ms : null;
    })(),
    ai_status: !res ? 'DETERMINISTIC:NO_RESULT' : res.mode === 'AI' ? (res.cached ? 'CACHED' : 'AI') : `DETERMINISTIC:${res.fallback_reason || 'UNKNOWN'}`,
    ai_summary: res && res.mode === 'AI' ? out.telegram_summary : null,
    ai_disagreement: Boolean(res && res.mode === 'AI' && out.ai_disagreement),
    ai_disagreement_reason: res && res.mode === 'AI' ? out.disagreement_reason || null : null,
    data_snapshot: { ...it.snapshot, context: fc.context, components: fc.components, source_quality: it.dataQuality },
    final: { event: fc.event, components: fc.components, bias_score: fc.pre_event_score / 100, output: out, fallback_reason: meta.fallbackReason, attempts: res ? res.attempts : [], what_matters_most: fc.what_matters_most, disclaimer: fc.disclaimer },
    deterministic: req.deterministic || out,
    ai_output: res && res.mode === 'AI' ? out : null,
    update_reason: cmp ? { changes: cmp.changes, invalidated: cmp.invalidated, score_change: cmp.score_change } : null,
    supersedes_id: prev ? prev.id : null,
    supersede_status: cmp && cmp.invalidated ? 'INVALIDATED' : 'UPDATED',
    scenarios: [scen('BULLISH', sc.bullish), scen('BEARISH', sc.bearish), scen('BASE', sc.base)],
  });
}
for (const n of eng.notices || []) {
  messages.push({ text: T.formatCalendarNotice(n, cfg.timezone), message_type: 'CALENDAR_NOTICE', dedup_key: `calendar:${n.kind}:${n.release_id}`, dedup_window_min: 10080, related_ref: `release:${n.release_id}`, is_test: false });
}
return [{ json: { payload: { messages }, forecasts, mode: eng.mode } }];
