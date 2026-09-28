'use strict';
// Returns the delivery results to the calling workflow.
const send = $('Send Messages').first().json;
return [{
  json: {
    results: send.results.map((r) => ({
      status: r.status, message_type: r.message_type, dedup_key: r.dedup_key, related_ref: r.related_ref,
      telegram_message_id: r.telegram_message_id, parts: r.parts, attempts: r.attempts, error: r.error,
    })),
    telegram: send.telegram,
    sent: send.sent,
    failed: send.failed,
    skipped_duplicates: send.skipped_duplicates,
    not_configured: send.not_configured,
    logged: Number($input.first().json.logged || 0),
  },
}];
