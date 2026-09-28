'use strict';
// Inserts the AI explanation of the 🔮 BIGGEST SCENARIOS into the reply (or states why the
// deterministic text was kept). The ranking itself never changes.
const { loadConfig } = require('../../lib/config');
const B = require('../../lib/biggest');
const { fallbackReasonText } = require('../../lib/aiusage');

const cfg = loadConfig($env);
const built = $('Build Replies').first().json;
const ai = $input.first().json || {};
const byRef = Object.fromEntries((ai.results || []).map((r) => [r.ref, r]));
const messages = (built.payload.messages || []).map((m) => {
  if (!m.ai_ref) return m;
  const res = byRef[m.ai_ref];
  let explanation;
  if (res && res.mode === 'AI' && res.output) {
    const text = String(res.output.interpretation || res.output.summary || '').slice(0, 1800);
    explanation = { text, label: `${res.model}${res.cached ? `, cached ${res.cache_age_min} min` : ''}${res.model_rank > 1 ? `, fallback level ${res.model_rank - 1}` : ''}` };
  } else {
    explanation = { label: `deterministic — ${res ? fallbackReasonText(res.fallback_reason) : 'AI analyst unavailable'}` };
  }
  const { ai_ref: _ref, biggest, prefix, ...rest } = m;
  return { ...rest, text: `${prefix || ''}${B.formatBiggest(biggest || [], explanation, cfg.timezone)}` };
});
return [{ json: { payload: { messages } } }];
