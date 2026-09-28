'use strict';
// 🧪 Telegram delivery test (one short message; dedup key per minute prevents double sends).
const { esc, localTime } = require('../../lib/telegram');

const now = new Date().toISOString();
const text = [
  '🧪 <b>GOLD INTELLIGENCE — TELEGRAM TEST</b>',
  `Delivery check at ${esc(localTime(now, 'Africa/Casablanca'))} (Africa/Casablanca).`,
  'If you can read this, the bot token and chat id are configured correctly.',
  '<i>Intelligence only — no trade execution.</i>',
].join('\n');
return [{ json: { payload: { is_test: true, messages: [{ text, message_type: 'TEST', dedup_key: `test:telegram:${now.slice(0, 16)}`, dedup_window_min: 5, related_ref: 'telegram-test', is_test: true }] } } }];
