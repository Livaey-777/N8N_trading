'use strict';
// DEDUPLICATION -> CLASSIFICATION -> GOLD RELEVANCE -> CLUSTERING -> IMPORTANCE ->
// TRANSMISSION -> MARKET CONFIRMATION -> HISTORICAL CONTEXT -> ALERT ELIGIBILITY.
const { loadConfig } = require('../../lib/config');
const { classifyItem } = require('../../lib/classify');
const { goldRelevance, importance, confirmationStatus, marketSensitivity } = require('../../lib/scoring');
const { computeTransmission, expectedResponse } = require('../../lib/transmission');
const { clusterItems, materialSignature } = require('../../lib/dedup');
const { confirmEvent } = require('../../lib/market');
const { hoursBetween } = require('../../lib/util');

const cfg = loadConfig($env);
const T = cfg.thresholds;
const ctx = $('Load News Context').first().json;
const parsed = $('Parse & Normalize Reports').first().json;
const seen = new Set($input.first().json.seen || []);
const nowIso = new Date().toISOString();
const run = ctx.run || {};

const SUBCAT_TO_TYPE = { FOMC_DECISION: 'FOMC', CPI: 'CPI', NFP: 'NFP', PCE: 'PCE', PPI: 'PPI', GDP: 'GDP', JOLTS: 'JOLTS', RETAIL_SALES: 'RETAIL_SALES', JOBLESS_CLAIMS: 'JOBLESS_CLAIMS' };
const series = { GOLD: ctx.gold_series || [], USD_PROXY: ctx.usd_series || [] };
const stats = { new_items: 0, duplicates_seen: 0, irrelevant: 0, retained: 0, events_new: 0, events_updated: 0, alert_candidates: 0 };

// 1) Exact dedup against storage + classification + relevance filter.
const newItems = [];
const storeItems = [];
for (const it of parsed.items || []) {
  if (seen.has(it.item_hash)) { stats.duplicates_seen++; continue; }
  stats.new_items++;
  const cls = classifyItem({ title: it.title, summary: it.summary, categoryHint: it.category_hint });
  const rel = goldRelevance(cls);
  const status = rel.score >= T.retainRelevance ? 'RETAINED' : 'IRRELEVANT';
  if (status === 'RETAINED') { stats.retained++; newItems.push({ ...it, classification: cls, relevance: rel.score, relevance_parts: rel.parts }); }
  else stats.irrelevant++;
  storeItems.push({
    item_hash: it.item_hash, source_id: it.source_id, publisher: it.publisher, title: it.title, summary: it.summary,
    url: it.url, published_at: it.published_at, fetched_at: it.fetched_at, effective_tier: it.tier,
    category: cls.category, relevance_score: rel.score, status, event_key: null, is_test: Boolean(it.is_test),
  });
}

// 2) Cluster retained items into canonical events (new or existing).
// Live news never merges into simulated test events (and vice versa); each synthetic run is self-contained.
const recent = run.is_test ? [] : (ctx.recent_events || []).filter((e) => !e.is_test).map((e) => ({ ...e, publishers: e.publishers || [] }));
const clusters = clusterItems(newItems, recent, { windowHours: T.dedupWindowHours, minCoverage: T.dedupMinCoverage });

// 3) Event-level scoring and transmission.
const events = [];
const candidates = [];
for (const c of clusters) {
  const cls = c.classification;
  const rel = goldRelevance(cls);
  // Distinct publishers per tier across all linked reports (stored + this run).
  const tierCounts = { ...((c.previous && c.previous.tier_counts) || {}) };
  const allReports = [...(c.previous && c.previous.reports ? c.previous.reports : []), ...c.newItems];
  const prevPublishers = new Set((c.previous && c.previous.publishers) || []);
  for (const r of c.newItems) {
    if (prevPublishers.has(r.publisher)) continue;
    prevPublishers.add(r.publisher);
    tierCounts[r.tier] = (tierCounts[r.tier] || 0) + 1;
  }
  const publisherCount = c.publishers.length;
  const confirmation = confirmationStatus(c.best_tier, publisherCount, tierCounts);
  const tx = computeTransmission(cls, { bestTier: c.best_tier, publisherCount, severity: cls.severity });
  const prevSig = c.previous ? c.previous.signature : null;
  const draft = {
    importance_class: null, net_pressure: tx.net_pressure, confirmation_status: confirmation, subcategory: c.subcategory,
    best_tier: c.best_tier, severity: cls.severity, dominant_driver: tx.dominant_driver,
  };
  // Novelty: new event 1.0; existing with material change 0.6; repeat coverage 0.2.
  const provisional = importance({ novelty: 1, bestTier: c.best_tier, publisherCount, relevance: rel.score, marketSensitivity: marketSensitivity(cls), severity: cls.severity, transmissionStrength: tx.transmission_strength, confirmation, hedged: cls.hedged, preview: cls.preview });
  draft.importance_class = provisional.class;
  const signature = materialSignature(draft);
  const novelty = !c.existing ? 1 : signature !== prevSig ? 0.6 : 0.2;
  const imp = importance({ novelty, bestTier: c.best_tier, publisherCount, relevance: rel.score, marketSensitivity: marketSensitivity(cls), severity: cls.severity, transmissionStrength: tx.transmission_strength, confirmation, hedged: cls.hedged, preview: cls.preview });
  const expected = expectedResponse(tx);
  const mc = confirmEvent(expected, series, c.first_seen_at, nowIso);
  const evType = SUBCAT_TO_TYPE[c.subcategory];
  const hist = evType && ctx.hist_summary ? ctx.hist_summary[evType] : null;
  const release = evType ? (ctx.releases_now || []).find((r) => r.event_type === evType) : null;
  const historical_context = hist ? [`Historical ${evType} releases (n=${hist.n}, reaction DB): gold up ${hist.bullish}, down ${hist.bearish}, mixed ${hist.mixed} at 4h; median |4h move| ${hist.median_abs_4h_pct}%.`] : [];
  const ev = {
    event_key: c.event_key,
    id: c.id || null,
    existing: c.existing,
    title: c.title,
    summary: (c.newItems[0] && c.newItems[0].summary) || null,
    category: c.category, subcategory: c.subcategory, region: c.region,
    first_seen_at: c.first_seen_at, last_seen_at: c.last_seen_at,
    published_at: c.newItems.map((x) => x.published_at).sort()[0] || null,
    source_count: c.source_count, publisher_count: publisherCount, publishers: c.publishers, best_tier: c.best_tier,
    gold_relevance_score: rel.score, importance_score: imp.score, importance_class: imp.class, importance_notes: imp.notes,
    confirmation_status: confirmation,
    net_pressure: tx.net_pressure, net_score: tx.net_score, dominant_driver: tx.dominant_driver, counter_driver: tx.counter_driver,
    transmission: tx.channels, bullish_forces: tx.bullish_forces, bearish_forces: tx.bearish_forces,
    horizon_biases: tx.horizons, transmission_strength: tx.transmission_strength,
    keywords: cls.keywords, tokens: c.tokens, classification: cls, market_confirmation: mc,
    signature, is_test: Boolean(run.is_test),
    reports: allReports.slice(-8).map((r) => ({ publisher: r.publisher, tier: r.tier, title: r.title, url: r.url, published_at: r.published_at })),
    new_item_hashes: c.newItems.map((x) => x.item_hash),
    historical_context,
    linked_release: release ? { release_key: release.release_key, consensus: release.consensus, previous: release.previous, actual: release.actual, scheduled_at: release.scheduled_at } : null,
    linked_release_id: release ? release.id : null,
  };
  if (c.existing) stats.events_updated++; else stats.events_new++;
  // Alert eligibility: relevance AND importance thresholds AND new/materially changed AND confirmed enough.
  const prev = c.previous;
  const cooledDown = !prev || !prev.last_alerted_at || hoursBetween(prev.last_alerted_at, nowIso) * 60 >= T.alertCooldownMin;
  const changed = !prev || !prev.alert_signature || prev.alert_signature !== signature;
  const fresh = hoursBetween(c.last_seen_at, nowIso) <= 6;
  const eligible = rel.score >= T.alertRelevance && imp.score >= T.alertImportance
    && confirmation !== 'UNCONFIRMED' && changed && cooledDown && fresh;
  ev.alert = { eligible, is_update: Boolean(prev && prev.alert_signature && eligible), reasons: {
    relevance: `${rel.score} vs ${T.alertRelevance}`, importance: `${imp.score} vs ${T.alertImportance}`, confirmation,
    new_or_changed: changed, cooled_down: cooledDown, fresh,
  } };
  if (eligible) candidates.push(ev);
  events.push(ev);
}
candidates.sort((a, b) => b.importance_score - a.importance_score);
const selected = candidates.slice(0, T.alertMaxPerRun);
stats.alert_candidates = candidates.length;
stats.alerts_selected = selected.length;

// Map stored items to their event.
const itemToEvent = {};
for (const ev of events) for (const h of ev.new_item_hashes) itemToEvent[h] = ev.event_key;
for (const s of storeItems) {
  s.event_key = itemToEvent[s.item_hash] || null;
  if (s.event_key) s.status = 'LINKED';
}

return [{
  json: {
    run,
    persist: {
      events: events.map((e) => ({
        event_key: e.event_key, title: e.title, summary: e.summary, category: e.category, subcategory: e.subcategory, region: e.region,
        first_seen_at: e.first_seen_at, last_seen_at: e.last_seen_at, published_at: e.published_at,
        source_count: e.source_count, publisher_count: e.publisher_count, publishers: e.publishers, best_tier: e.best_tier,
        gold_relevance_score: e.gold_relevance_score, importance_score: e.importance_score, importance_class: e.importance_class,
        confirmation_status: e.confirmation_status, net_pressure: e.net_pressure, net_score: e.net_score,
        dominant_driver: e.dominant_driver, counter_driver: e.counter_driver, transmission: e.transmission,
        keywords: e.keywords, horizon_biases: e.horizon_biases, market_confirmation: e.market_confirmation,
        tokens: e.tokens, signature: e.signature, classification: e.classification, is_test: e.is_test,
        linked_release_id: e.linked_release_id,
      })),
      items: storeItems,
    },
    events,
    selected_keys: selected.map((e) => e.event_key),
    stats: { ...parsed.stats, ...stats },
  },
}];
