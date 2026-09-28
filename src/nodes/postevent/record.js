'use strict';
// Attaches delivery results to the review record.
const rev = $('Review Releases').first().json;
const tg = $input.first().json;
return [{ json: { record: { ...rev.record, stats: { ...rev.record.stats, telegram: { sent: tg.sent, failed: tg.failed, skipped: tg.skipped_duplicates, not_configured: tg.not_configured, status: tg.telegram } } } } }];
