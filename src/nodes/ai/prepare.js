'use strict';
// Prepares AI requests: priority (spec §26) and a fingerprint of the MATERIAL context for the
// result cache (spec §25). Test requests are never cached.
const { loadConfig } = require('../../lib/config');
const { requestPriority, fingerprint } = require('../../lib/aiusage');

const cfg = loadConfig($env);
const payload = $input.first().json.payload || {};
const WORKFLOW = { EVENT: 'master', TEST: 'test', PRE_EVENT: 'pre_event', DAILY: 'daily', BIGGEST: 'bot' };
const requests = (Array.isArray(payload.requests) ? payload.requests : []).map((r) => {
  const cacheable = cfg.ai.cacheTtlMin > 0 && r.use_ai && !r.is_test && r.cache !== false;
  return {
    ...r,
    priority: requestPriority(r),
    workflow: payload.workflow || WORKFLOW[String(r.purpose)] || 'bot',
    fingerprint: cacheable ? fingerprint(r) : null,
  };
});
return [{ json: { payload: { ...payload, requests }, fingerprints: requests.map((r) => r.fingerprint).filter(Boolean) } }];
