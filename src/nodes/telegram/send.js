'use strict';
// Sends outgoing Telegram messages (dedup-filtered), with retries and plain-text fallback.
const { loadConfig, secretsFrom } = require('../../lib/config');
const { sendMessages } = require('../../lib/telegram');
const { makeHttp, sleep } = require('../../lib/http');

const row = $input.first().json;
const payload = row.payload || {};
const duplicates = new Set(row.duplicates || []);
const cfg = loadConfig($env);
const secrets = secretsFrom($env);
const messages = (payload.messages || []).filter((m) => m && m.text);

const toSend = [];
const skipped = [];
for (const m of messages) {
  const msg = { ...m, chat_id: m.chat_id || cfg.telegram.defaultChatId };
  if (m.dedup_key && duplicates.has(m.dedup_key)) skipped.push({ ...msg, status: 'SKIPPED_DUPLICATE', attempts: 0, parts: 0, telegram_message_ids: [], error: null });
  else toSend.push(msg);
}

const http = makeHttp(this.helpers, { userAgent: cfg.http.userAgent });
const sent = await sendMessages({
  messages: toSend,
  token: cfg.secrets.telegramTokenConfigured ? secrets.telegramToken : '',
  http,
  sleep,
  secrets: secrets.list(),
});

const results = [...sent, ...skipped].map((r) => ({
  chat_id: r.chat_id ? String(r.chat_id) : null,
  message_type: r.message_type || 'GENERIC',
  dedup_key: r.dedup_key || null,
  text_hash: r.text_hash || null,
  body: r.text,
  status: r.status,
  telegram_message_id: r.telegram_message_ids && r.telegram_message_ids.length ? r.telegram_message_ids[0] : null,
  telegram_message_ids: r.telegram_message_ids || [],
  attempts: r.attempts || 0,
  parts: r.parts || 0,
  error: r.error || null,
  related_ref: r.related_ref || null,
  is_test: Boolean(r.is_test),
}));

return [{
  json: {
    results,
    telegram: cfg.secrets.telegramTokenConfigured ? 'CONFIGURED' : 'NOT CONFIGURED',
    sent: results.filter((r) => r.status === 'SENT').length,
    failed: results.filter((r) => r.status === 'FAILED').length,
    skipped_duplicates: skipped.length,
    not_configured: results.filter((r) => r.status === 'NOT_CONFIGURED').length,
  },
}];
