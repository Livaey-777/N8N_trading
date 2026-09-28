'use strict';
// 🧪 AI router test harness: builds real requests from a simulated event and
// exercises (1) the normal path, (2) PRIMARY forced unavailable -> SECONDARY,
// (3) all models unavailable -> DETERMINISTIC. Invalid model ids produce genuine
// OpenRouter errors; nothing is mocked.
const { loadConfig } = require('../../lib/config');
const { classifyItem } = require('../../lib/classify');
const { computeTransmission } = require('../../lib/transmission');
const { eventFacts, deterministicEvent } = require('../../lib/analyst');

const cfg = loadConfig($env);
const title = 'SIMULATED: Federal Reserve raises rates by 50 basis points in surprise move; dollar surges and Treasury yields jump';
const cls = classifyItem({ title, summary: 'Test scenario for the AI router. Not a real event.' });
const tx = computeTransmission(cls, { bestTier: 1, publisherCount: 2, severity: cls.severity });
const ev = {
  id: 0, is_test: true, title, category: cls.category, subcategory: cls.subcategory, region: cls.region,
  first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
  confirmation_status: 'CONFIRMED_OFFICIAL', best_tier: 1, publisher_count: 2,
  gold_relevance_score: 90, importance_score: 88, importance_class: 'CRITICAL',
  reports: [{ publisher: 'Simulation', tier: 1, title, published_at: new Date().toISOString() }],
  transmission: tx.channels, net_pressure: tx.net_pressure, dominant_driver: tx.dominant_driver,
  counter_driver: tx.counter_driver, horizon_biases: tx.horizons, market_confirmation: { status: 'NOT_YET_MEASURABLE' },
};
const snap = { instruments: {}, data_quality: 'POOR', missing: ['simulation'] };
const facts = eventFacts(ev, null, snap);
const det = deterministicEvent(facts);
const models = cfg.ai.models;
const scenario = (ref, override) => ({ ref, purpose: 'TEST', use_ai: true, is_test: true, facts, deterministic: det, models_override: override });

return [{
  json: {
    payload: {
      is_test: true,
      requests: [
        scenario('test:normal', models),
        scenario('test:primary-unavailable', ['gold-intel-test/nonexistent-primary:free', ...models.slice(1)]),
        scenario('test:all-unavailable', ['gold-intel-test/nonexistent-a:free', 'gold-intel-test/nonexistent-b:free', 'gold-intel-test/nonexistent-c:free']),
      ],
    },
  },
}];
