'use strict';
// Direct technical alert (no DB / sub-workflow dependency, so it works when those fail).
const { loadConfig, secretsFrom } = require('../../lib/config');
const { sendMessages, formatTechAlert } = require('../../lib/telegram');
const { makeHttp, sleep } = require('../../lib/http');

const cfg = loadConfig($env);
const secrets = secretsFrom($env);
const d = $input.first().json;
const text = `${formatTechAlert(d.error, cfg.timezone)}${d.db_recorded ? '' : '\n⚠️ The error could not be written to the database (database unreachable?).'}`;
const res = await sendMessages({
  messages: [{ chat_id: cfg.telegram.defaultChatId, text, message_type: 'TECH_ALERT' }],
  token: secrets.telegramToken, http: makeHttp(this.helpers, { userAgent: cfg.http.userAgent }), sleep, secrets: secrets.list(),
});
return [{ json: { status: res[0].status, error: res[0].error, parts: res[0].parts } }];
