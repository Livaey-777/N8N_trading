'use strict';
// Regime-change notice (only when the hysteresis-filtered regime actually changes).
const { esc, localTime } = require('../../lib/telegram');

const m = $('Compute Market & Desk State').first().json;
const desk = m.persist.desk;
if (!m.regime_changed) return [{ json: { send: false, payload: { messages: [] } } }];
const hz = desk.horizons;
const text = [
  `🔄 <b>XAUUSD REGIME CHANGE</b> — ${esc(localTime(desk.as_of, 'Africa/Casablanca'))}`,
  `${esc(m.previous_regime)} → <b>${esc(desk.regime)}</b>`,
  `Horizons: S ${esc(hz.SHORT.bias)} · T ${esc(hz.TACTICAL.bias)} · Sw ${esc(hz.SWING.bias)} · St ${esc(hz.STRUCTURAL.bias)}`,
  `Dominant driver: ${esc(desk.dominant_driver || 'none')} · Counter: ${esc(desk.counter_driver || 'none')}`,
  `Confidence ${esc(desk.confidence)}/100 · data ${esc(desk.data_quality)}`,
  '<i>Intelligence only — not a trade order.</i>',
].join('\n');
return [{ json: { send: true, payload: { messages: [{ text, message_type: 'REGIME_CHANGE', dedup_key: `regime:${desk.regime}`, dedup_window_min: 360, related_ref: 'desk', is_test: false }] } } }];
