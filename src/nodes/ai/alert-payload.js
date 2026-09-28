'use strict';
// Hands the AI usage / limit / fallback alerts to the Telegram sender.
return [{ json: { payload: $('AI Router').first().json.alert_payload } }];
