'use strict';
// AI GATEWAY: only HIGH relevance + HIGH importance + validated + deduplicated +
// context-rich alert candidates may reach the AI; everything else stays deterministic.
const { loadConfig } = require('../../lib/config');
const { eventFacts, deterministicEvent } = require('../../lib/analyst');
const { marketSnapshot, sourceQuality, agedSourceQuality } = require('../../lib/market');

const cfg = loadConfig($env);
const cc = $('Classify, Score & Cluster').first().json;
const ctx = $('Load News Context').first().json;
const persisted = $input.first().json;
const idByKey = Object.fromEntries((persisted.events || []).map((e) => [e.event_key, e.id]));
const desk = ctx.desk && ctx.desk.desk ? ctx.desk.desk : null;
const snap = marketSnapshot({ GOLD: ctx.gold_series || [], USD_PROXY: ctx.usd_series || [] }, new Date().toISOString());
const dataQuality = desk && desk.source_quality
  ? agedSourceQuality(desk.source_quality, desk.as_of, new Date().toISOString(), cfg.schedule.marketIntervalMin)
  : sourceQuality(snap);

const selected = new Set(cc.selected_keys || []);
const candidates = (cc.events || []).filter((e) => selected.has(e.event_key)).map((e) => ({ ...e, id: idByKey[e.event_key] || e.id }));
const validated = (e) => ['CONFIRMED_OFFICIAL', 'CORROBORATED', 'SINGLE_SOURCE'].includes(e.confirmation_status);
let aiSlots = cfg.ai.maxEventsPerRun;
const requests = candidates.map((e) => {
  const facts = eventFacts(e, desk, snap);
  if (e.historical_context && e.historical_context.length) facts.historical_context = e.historical_context;
  const det = deterministicEvent(facts);
  const eligible = e.gold_relevance_score >= cfg.ai.minRelevance && e.importance_score >= cfg.ai.minImportance && validated(e);
  const useAi = eligible && aiSlots > 0;
  if (useAi) aiSlots--;
  return {
    ref: e.event_key, purpose: e.is_test ? 'TEST' : 'EVENT', use_ai: useAi, is_test: Boolean(e.is_test),
    gateway: { eligible, reason: eligible ? (useAi ? 'SENT_TO_AI' : 'PER_RUN_AI_LIMIT') : 'BELOW_AI_THRESHOLDS_OR_UNVALIDATED' },
    facts, deterministic: det,
  };
});
return [{ json: { payload: { requests: requests.map(({ gateway, ...r }) => r) }, gateway: requests.map((r) => ({ ref: r.ref, ...r.gateway })), candidates: candidates.map((c) => ({ event_key: c.event_key, id: c.id })), source_quality: dataQuality } }];
