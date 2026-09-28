'use strict';
// tools/verify-live.js: scheduled-slot timing and the TEMPORARY / PERSISTENT degradation rules.
const test = require('node:test');
const assert = require('node:assert');
const { localSlotUtc, classify } = require('../tools/verify-live');

const NOW = Date.parse('2026-09-28T12:00:00Z');
const at = (h) => new Date(NOW - h * 3600000).toISOString();
const ok = (h) => ({ request_timestamp: at(h), request_status: 'SUCCESS' });
const fail = (h, error_type, http_status = null) => ({ request_timestamp: at(h), request_status: 'FAILED', error_type, http_status });

test('scheduled slots are local wall-clock hours converted to UTC', () => {
  // Morocco is UTC+1 outside Ramadan: 06:00 / 07:00 Africa/Casablanca = 05:00 / 06:00 UTC.
  assert.strictEqual(new Date(localSlotUtc('2026-09-28', 6, 'Africa/Casablanca')).toISOString(), '2026-09-28T05:00:00.000Z');
  assert.strictEqual(new Date(localSlotUtc('2026-09-28', 7, 'Africa/Casablanca')).toISOString(), '2026-09-28T06:00:00.000Z');
  assert.strictEqual(new Date(localSlotUtc('2026-09-28', 6, 'UTC')).toISOString(), '2026-09-28T06:00:00.000Z');
  // DST change day in New York (2026-11-01): 06:00 is already standard time (UTC-5).
  assert.strictEqual(new Date(localSlotUtc('2026-11-01', 6, 'America/New_York')).toISOString(), '2026-11-01T11:00:00.000Z');
});

test('degradation: healthy, recovered and rate-limited models are not persistent', () => {
  assert.strictEqual(classify({ listed: true, free: true }, [ok(1), ok(3)], NOW)[0], 'NONE');
  assert.strictEqual(classify({ listed: true, free: true }, [ok(1), fail(2, 'RATE_LIMIT', 429), fail(3, 'INVALID_OUTPUT')], NOW)[0], 'TEMPORARY');
  assert.strictEqual(classify({ listed: true, free: true }, [fail(1, 'RATE_LIMIT', 429), fail(2, 'QUOTA_EXHAUSTED'), ok(30)], NOW)[0], 'TEMPORARY');
});

test('degradation: delisted, not free, auth errors and long failure streaks are persistent', () => {
  assert.strictEqual(classify({ listed: false }, [ok(1)], NOW)[0], 'PERSISTENT');
  assert.strictEqual(classify({ listed: true, free: false }, [ok(1)], NOW)[0], 'PERSISTENT');
  assert.strictEqual(classify({ listed: true, free: true }, [fail(1, 'MODEL_UNAVAILABLE', 404)], NOW)[0], 'PERSISTENT');
  // Rate limits that never clear for over 6 h with no success count as persistent, not temporary.
  assert.strictEqual(classify({ listed: true, free: true }, [fail(1, 'RATE_LIMIT', 429), fail(4, 'RATE_LIMIT', 429), fail(8, 'RATE_LIMIT', 429)], NOW)[0], 'PERSISTENT');
});

test('degradation: too little or mixed evidence is not guessed', () => {
  assert.strictEqual(classify(null, [], NOW)[0], 'NO DATA');
  assert.strictEqual(classify({ listed: true, free: true }, [fail(1, 'INVALID_OUTPUT'), ok(2)], NOW)[0], 'UNDETERMINED');
});
