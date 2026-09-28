'use strict';
// Long-polls Telegram getUpdates (no public webhook needed). Token never leaves this node.
// Inline-button presses (callback_query) are answered here and turned into command messages.
const { loadConfig, secretsFrom } = require('../../lib/config');
const { makeHttp } = require('../../lib/http');
const { redact } = require('../../lib/util');
const { normaliseUpdates } = require('../../lib/telegram');

function eventRequests(updates) {
  const ids = [];
  let latest = false;
  for (const u of updates) {
    const m = /^\/event(?:@\w+)?(?:\s+(\d+))?/i.exec(String((u.message && u.message.text) || '').trim());
    if (m) { if (m[1]) ids.push(Number(m[1])); else latest = true; }
  }
  return { event_ids: ids, want_latest: latest };
}

const cfg = loadConfig($env);
const secrets = secretsFrom($env);
const state = $input.first().json;
if (!cfg.secrets.telegramTokenConfigured) {
  return [{ json: { has_updates: false, configured: false, updates: [], new_offset: null, simulated: false } }];
}
const pollSeconds = Math.max(0, Math.min(cfg.schedule.botLongPollSeconds, cfg.schedule.botPollSeconds - 8));
const http = makeHttp(this.helpers, { userAgent: cfg.http.userAgent });
let r;
try {
  r = await http({
    url: `https://api.telegram.org/bot${secrets.telegramToken}/getUpdates`,
    method: 'POST',
    body: { offset: state.offset ? Number(state.offset) : undefined, timeout: pollSeconds, allowed_updates: ['message', 'callback_query'] },
    timeout: (pollSeconds + 15) * 1000,
  });
} catch (e) {
  throw new Error(`Telegram getUpdates network error: ${redact(e.message, secrets.list())}`);
}
if (r.statusCode !== 200 || !r.body || !r.body.ok) {
  const desc = r.body && r.body.description ? r.body.description : '';
  throw new Error(`Telegram getUpdates HTTP ${r.statusCode}: ${redact(desc, secrets.list()).slice(0, 200)}`);
}
const { updates, callbacks, new_offset: newOffset } = normaliseUpdates(r.body.result || [], cfg.telegram.chatIds);
// Stop the button spinners (authorised or not); errors are irrelevant for the reply.
for (const id of callbacks) {
  try {
    await http({ url: `https://api.telegram.org/bot${secrets.telegramToken}/answerCallbackQuery`, method: 'POST', body: { callback_query_id: id }, timeout: 10000 });
  } catch (_) { /* ignore */ }
}
// Confirm the batch immediately, so an overlapping poll (a long AI explanation) never re-processes it.
if (newOffset) {
  try {
    await http({ url: `https://api.telegram.org/bot${secrets.telegramToken}/getUpdates`, method: 'POST', body: { offset: newOffset, limit: 1, timeout: 0, allowed_updates: ['message', 'callback_query'] }, timeout: 15000 });
  } catch (_) { /* the saved offset still confirms it on the next poll */ }
}
return [{ json: { has_updates: updates.length > 0 || Boolean(newOffset), configured: true, updates, new_offset: newOffset, simulated: false, ...eventRequests(updates) } }];
