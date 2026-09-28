'use strict';
// Formats the daily report and prepares its storage record.
const { formatDaily } = require('../../lib/telegram');
const { dailyAiSection } = require('../../lib/telegram-ai');

const b = $('Build Daily Report').first().json;
const ai = $input.first().json;
const res = (ai.results || [])[0];
const out = res ? res.output : b.payload.requests[0].deterministic;
const meta = { mode: res ? res.mode : 'DETERMINISTIC', model: res ? res.model : null, fallbackReason: res ? res.fallback_reason : 'NO_RESULT', dataQuality: b.data_quality };
const aiLines = b.ai_section ? dailyAiSection(b.ai_section) : [];
const text = `${b.manual ? '🧪 <i>manual run (real data)</i>\n' : ''}${formatDaily(b.report, out, meta, b.timezone)}${aiLines.length ? `\n${aiLines.join('\n')}` : ''}`;
const localDay = new Date().toLocaleDateString('en-CA', { timeZone: b.timezone });
return [{
  json: {
    payload: { messages: [{ text, message_type: 'DAILY', dedup_key: b.manual ? `daily:manual:${new Date().toISOString().slice(0, 16)}` : `daily:${localDay}`, dedup_window_min: b.manual ? 10 : 1440, related_ref: `daily:${localDay}`, is_test: false }] },
    analysis: {
      mode: meta.mode, model: meta.model, deterministic: b.payload.requests[0].deterministic,
      ai_output: res && res.mode === 'AI' ? out : null, final: { text, output: out, desk: b.report.desk, forecasts: b.report.forecasts, fallback_reason: meta.fallbackReason, attempts: res ? res.attempts : [] },
      regime: b.report.desk.regime, short_bias: out.short_bias, tactical_bias: out.tactical_bias, swing_bias: out.swing_bias, structural_bias: out.structural_bias,
      confidence: out.confidence, data_quality: b.report.desk.data_quality,
    },
    job: { job: `DAILY_${b.mode}`, started_at: b.started_at, execution_id: $execution.id },
  },
}];
