'use strict';
// Attaches delivery results to the daily report record.
const c = $('Compose Daily Report').first().json;
const tg = $input.first().json;
return [{ json: { record: { analysis: c.analysis, ...c.job, status: tg.failed ? 'DEGRADED' : 'OK', stats: { mode: c.analysis.mode, model: c.analysis.model, telegram: { sent: tg.sent, failed: tg.failed, skipped: tg.skipped_duplicates, not_configured: tg.not_configured, status: tg.telegram } } } } }];
