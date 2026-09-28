'use strict';
// SCENARIO/INTERPRETATION -> TELEGRAM: one alert per selected event (spec §30 format).
const { formatAlert } = require('../../lib/telegram');
const { loadConfig } = require('../../lib/config');

const cfg = loadConfig($env);
const cc = $('Classify, Score & Cluster').first().json;
const gw = $('AI Gateway').first().json;
const ai = $input.first().json;
const idByKey = Object.fromEntries((gw.candidates || []).map((c) => [c.event_key, c.id]));
const byRef = Object.fromEntries((ai.results || []).map((r) => [r.ref, r]));
const selected = new Set(cc.selected_keys || []);
const messages = [];
const analyses = [];
for (const ev of cc.events || []) {
  if (!selected.has(ev.event_key)) continue;
  const res = byRef[ev.event_key];
  if (!res) continue;
  const id = idByKey[ev.event_key];
  const out = res.output;
  const withId = { ...ev, id };
  const isUpdate = ev.alert && ev.alert.is_update;
  messages.push({
    text: formatAlert(withId, out, { mode: res.mode, model: res.model, isUpdate, fallbackReason: res.fallback_reason, dataQuality: gw.source_quality }),
    message_type: ev.is_test ? 'TEST_ALERT' : 'ALERT',
    dedup_key: `alert:${ev.event_key}:${ev.signature}`,
    dedup_window_min: 24 * 60,
    related_ref: `event:${id}`,
    is_test: Boolean(ev.is_test),
  });
  const req = (gw.payload.requests || []).find((r) => r.ref === ev.event_key);
  analyses.push({
    event_id: id, mode: res.mode, model: res.model, deterministic: req ? req.deterministic : out,
    ai_output: res.mode === 'AI' ? out : null, final: { output: out, fallback_reason: res.fallback_reason, attempts: res.attempts, event_key: ev.event_key },
    regime: out.regime, short_bias: out.short_bias, tactical_bias: out.tactical_bias, swing_bias: out.swing_bias, structural_bias: out.structural_bias,
    confidence: out.confidence, data_quality: ev.market_confirmation ? ev.market_confirmation.status : null, is_test: Boolean(ev.is_test),
  });
}
return [{ json: { payload: { messages }, analyses, telegram: cfg.secrets.telegramConfigured ? 'CONFIGURED' : 'NOT CONFIGURED' } }];
