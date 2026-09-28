'use strict';
// 🧪 SIMULATED GOLD RELEVANT EVENT — proves input -> classification -> relevance ->
// importance -> transmission -> AI -> Telegram -> storage, including dedup of three
// differently-worded reports of ONE event and filtering of irrelevant / low-value items.
// Publishers are fictitious simulation labels (never real outlets).
const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
const runId = String(now).slice(-6);
const item = (publisher, tier, title, summary, minAgo, n) => ({
  raw: { title, link: `https://simulation.gold-intel.test/${runId}/${n}`, summary, published: iso(minAgo), sourceName: '' },
  source: { id: 'synthetic_test', publisher, tier, category_hint: 'GEOPOLITICS' },
});

const reports = [
  item('SIM Official Statement', 1, `SIMULATED ${runId}: Government confirms naval blockade of the Strait of Hormuz after overnight missile strikes on oil tankers`,
    'Simulation for pipeline testing. Officials confirm the blockade; tanker traffic halted; oil prices surge.', 12, 1),
  item('SIM Newswire', 3, `SIMULATED ${runId}: Oil surges as Strait of Hormuz blockade follows missile strikes on tankers`,
    'Simulation for pipeline testing. Brent crude jumps; safe-haven demand rises.', 10, 2),
  item('SIM Aggregator', 4, `SIMULATED ${runId}: Hormuz blockade: tankers hit by missile strikes, strait closed`,
    'Simulation for pipeline testing.', 8, 3),
  item('SIM Newswire', 3, `SIMULATED ${runId}: Local football club wins regional cup after penalty shootout`,
    'Simulation noise item: must be filtered as irrelevant.', 9, 4),
  item('SIM Aggregator', 4, `SIMULATED ${runId}: Jewellery retailer opens a new flagship store downtown`,
    'Simulation noise item: gold-adjacent but no macro transmission.', 7, 5),
];

return [{ json: { run: { job: 'NEWS_TEST', is_test: true, started_at: new Date().toISOString(), execution_id: $execution.id, synthetic: reports, simulation_id: runId } } }];
