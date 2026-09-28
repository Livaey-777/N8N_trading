'use strict';
// 🧪 Simulated inbound traffic from the authorised chat: typed commands and inline-button presses
// (callback_query), normalised exactly like real getUpdates results. Edit the lists to test others.
const { loadConfig } = require('../../lib/config');
const { normaliseUpdates } = require('../../lib/telegram');

const COMMANDS = ['/now', '/status'];
const BUTTONS = ['/usage'];

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
const chatId = cfg.telegram.defaultChatId || 'SIMULATED_CHAT';
const nowSec = Math.floor(Date.now() / 1000);
const raw = [
  ...COMMANDS.map((text, i) => ({ update_id: i + 1, message: { message_id: i + 1, date: nowSec, chat: { id: chatId, type: 'private' }, from: { id: 0, is_bot: false, first_name: 'Simulation' }, text } })),
  ...BUTTONS.map((data, i) => ({ update_id: COMMANDS.length + i + 1, callback_query: { id: `sim-${i}`, data, from: { id: 0, is_bot: false, first_name: 'Simulation' }, message: { message_id: 1000 + i, chat: { id: chatId, type: 'private' } } } })),
];
const { updates } = normaliseUpdates(raw, [chatId]);
return [{ json: { has_updates: true, configured: cfg.secrets.telegramConfigured, updates, new_offset: null, simulated: true, ...eventRequests(updates) } }];
