'use strict';
// Passes the degradation alert and any AI usage / limit / fallback alerts to the Telegram sender.
const health = $('Evaluate Health').first().json;
const ai = $('AI Health Check').first().json;
const messages = [...(health.send ? health.payload.messages || [] : []), ...(ai.ai_messages || [])];
return [{ json: { payload: { messages } } }];
