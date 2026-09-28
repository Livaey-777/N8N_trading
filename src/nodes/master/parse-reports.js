'use strict';
// SOURCE VALIDATION + NORMALISATION: parse each feed, validate items, record source health.
const { parseFeed, normaliseItem } = require('../../lib/feeds');
const { loadConfig } = require('../../lib/config');

const cfg = loadConfig($env);
const ctx = $('Load News Context').first().json;
const run = ctx.run || {};
const nowIso = new Date().toISOString();
const sourcesById = Object.fromEntries((ctx.sources || []).map((s) => [s.id, s]));
const items = [];
const health = [];
const rejected = {};
const stats = { sources_ok: 0, sources_failed: 0, raw_items: 0, valid_items: 0, stale_items: 0 };

if (run.is_test) {
  for (const r of run.synthetic || []) {
    const n = normaliseItem(r.raw, r.source, nowIso, cfg.thresholds.maxItemAgeHours);
    stats.raw_items++;
    if (!n.ok) { rejected[n.reason] = (rejected[n.reason] || 0) + 1; continue; }
    items.push({ ...n.item, is_test: true });
  }
} else {
  const requests = $('Build Feed Requests').all().map((i) => i.json);
  const responses = $input.all();
  responses.forEach((resp, idx) => {
    const pair = resp.pairedItem && typeof resp.pairedItem.item === 'number' ? resp.pairedItem.item : idx;
    const req = requests[pair] || requests[idx] || {};
    const source = sourcesById[req.source_id];
    if (!source) return;
    const status = resp.json.statusCode;
    const body = resp.json.body !== undefined ? resp.json.body : resp.json.data;
    if (resp.json.error || status !== 200 || typeof body !== 'string') {
      stats.sources_failed++;
      const msg = resp.json.error ? (resp.json.error.message || String(resp.json.error)) : `HTTP ${status}`;
      health.push({ source_id: source.id, ok: false, error: String(msg).slice(0, 300), items: 0 });
      return;
    }
    const feed = parseFeed(body);
    if (feed.format === 'UNKNOWN') {
      stats.sources_failed++;
      health.push({ source_id: source.id, ok: false, error: feed.error || 'unparseable feed', items: 0 });
      return;
    }
    stats.sources_ok++;
    let valid = 0;
    for (const raw of feed.items) {
      stats.raw_items++;
      const n = normaliseItem(raw, source, nowIso, cfg.thresholds.maxItemAgeHours);
      if (!n.ok) { rejected[n.reason] = (rejected[n.reason] || 0) + 1; continue; }
      if (n.item.stale) { stats.stale_items++; continue; }
      valid++;
      items.push({ ...n.item, is_test: false });
    }
    health.push({ source_id: source.id, ok: true, error: null, items: valid });
  });
}
// Exact duplicates inside this batch (same publisher + title).
const seen = new Set();
const unique = items.filter((it) => (seen.has(it.item_hash) ? false : seen.add(it.item_hash)));
stats.valid_items = unique.length;
stats.rejected = rejected;
return [{ json: { items: unique, source_health: health, hashes: unique.map((i) => i.item_hash), stats } }];
