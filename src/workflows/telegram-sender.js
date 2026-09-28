'use strict';
// GI · Telegram Sender (sub-workflow): dedup, chunking, retries, logging.
module.exports = {
  id: 'giTelegramSend01',
  file: 'gold-intelligence-telegram-sender.json',
  build(h) {
    h.lane(0);
    const called = h.subTrigger('When Called By Pipeline');
    h.lane(1);
    const test = h.manual('🧪 Telegram Test');
    const testMsg = h.code('Build Test Message', 'telegram/test-message.js');
    h.at(2, 0);
    const dup = h.pg('Check Duplicates', `
WITH p AS (SELECT $1::jsonb AS j),
m AS (
  SELECT x->>'dedup_key' AS k, coalesce((x->>'dedup_window_min')::int, 0) AS w
  FROM p, jsonb_array_elements(coalesce(p.j->'messages', '[]'::jsonb)) x
  WHERE x->>'dedup_key' IS NOT NULL
)
SELECT coalesce((
  SELECT jsonb_agg(DISTINCT m.k) FROM m
  WHERE m.w > 0 AND EXISTS (
    SELECT 1 FROM telegram_messages t
    WHERE t.direction = 'OUT' AND t.dedup_key = m.k AND t.status = 'SENT'
      AND t.created_at > now() - make_interval(mins => m.w))
), '[]'::jsonb) AS duplicates,
(SELECT j FROM p) AS payload`, '$json.payload || {}', { notes: 'Do not spam: identical dedup keys inside their window are skipped' });
    const send = h.code('Send Messages', 'telegram/send.js', { notes: 'HTML, ≤4000-char chunks, 429/5xx retries' });
    const log = h.pg('Log Messages', `
WITH p AS (SELECT $1::jsonb AS j),
ins AS (
  INSERT INTO telegram_messages (direction, chat_id, message_type, dedup_key, text_hash, body, status,
                                 telegram_message_id, attempts, parts, error, related_ref, is_test)
  SELECT 'OUT', r->>'chat_id', r->>'message_type', r->>'dedup_key', r->>'text_hash', r->>'body', r->>'status',
         (r->>'telegram_message_id')::bigint, coalesce((r->>'attempts')::int, 0), (r->>'parts')::int, r->>'error',
         r->>'related_ref', coalesce((r->>'is_test')::boolean, false)
  FROM p, jsonb_array_elements(coalesce(p.j->'results', '[]'::jsonb)) r
  RETURNING id
)
SELECT count(*)::int AS logged FROM ins`, '{ results: $json.results }');
    const ret = h.code('Return Results', 'telegram/return.js');
    h.chain(called, dup, send, log, ret);
    h.chain(test, testMsg, dup);
    h.note('About', '## GI · Telegram Sender\nShared delivery service. Secrets come from the environment (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) and never appear in workflow data.\n\n* Dedup window per message (`dedup_key`, `dedup_window_min`).\n* 429 → honours `retry_after`; 5xx/network → exponential backoff; HTML parse error → plain text.\n* Every message is logged in `telegram_messages`.', [0, 420], [520, 220], 5);
    return h.result({ name: 'GI · Telegram Sender (sub-workflow)' });
  },
};
