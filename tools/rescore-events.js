#!/usr/bin/env node
'use strict';
/**
 * Re-applies the CURRENT deterministic classifier / relevance / importance / transmission to
 * stored live events, rebuilt from their stored reports (same library code as the Master
 * Pipeline's "Classify, Score & Cluster" node). No network, no AI.
 * Keeps ids, event keys, timestamps, publishers and alert history; test events are never touched.
 *
 *   node tools/rescore-events.js [--days=95] [--dry-run]
 */
const { withClient } = require('./db');
const { classifyItem } = require('../src/lib/classify');
const { goldRelevance, importance, confirmationStatus, marketSensitivity } = require('../src/lib/scoring');
const { computeTransmission } = require('../src/lib/transmission');
const { mergeClassification, materialSignature } = require('../src/lib/dedup');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const days = Number(args.days) || 95;
const dryRun = Boolean(args['dry-run']);

async function main() {
  await withClient(async (c) => {
    const events = (await c.query(`
      SELECT e.id, e.title, e.category, e.subcategory, e.gold_relevance_score, e.importance_score, e.net_pressure,
             e.best_tier, e.publisher_count,
             (SELECT coalesce(jsonb_agg(jsonb_build_object('tier', es.tier, 'publisher', es.publisher, 'title', coalesce(es.title, n.title),
                     'summary', n.summary, 'category_hint', s.category_hint, 'published_at', es.published_at)
                     ORDER BY es.tier, es.published_at), '[]'::jsonb)
                FROM event_sources es LEFT JOIN news_items n ON n.id = es.news_item_id LEFT JOIN sources s ON s.id = es.source_id
               WHERE es.event_id = e.id) AS reports
        FROM events e
       WHERE NOT e.is_test AND e.last_seen_at > now() - make_interval(days => $1::int)
       ORDER BY e.id`, [days])).rows;
    const changes = [];
    for (const ev of events) {
      const reports = ev.reports.length ? ev.reports : [{ tier: ev.best_tier, publisher: null, title: ev.title, summary: null, category_hint: null }];
      let merged = null;
      for (const r of reports) merged = mergeClassification(merged, classifyItem({ title: r.title, summary: r.summary, categoryHint: r.category_hint }));
      // Canonical headline decides category / subcategory / region, as in clustering.
      const canon = reports.find((r) => r.title === ev.title) || reports[0];
      const head = classifyItem({ title: ev.title, summary: canon.summary, categoryHint: canon.category_hint });
      merged.category = head.category;
      merged.subcategory = head.subcategory;
      merged.region = head.region;
      const tierCounts = {};
      const pubs = new Set();
      for (const r of reports) {
        const key = r.publisher || `tier${r.tier}`;
        if (pubs.has(key)) continue;
        pubs.add(key);
        tierCounts[r.tier] = (tierCounts[r.tier] || 0) + 1;
      }
      const bestTier = Math.min(...reports.map((r) => r.tier));
      const publisherCount = Math.max(ev.publisher_count || 0, pubs.size);
      const confirmation = confirmationStatus(bestTier, publisherCount, tierCounts);
      const rel = goldRelevance(merged);
      const tx = computeTransmission(merged, { bestTier, publisherCount, severity: merged.severity });
      const imp = importance({
        novelty: 1, bestTier, publisherCount, relevance: rel.score, marketSensitivity: marketSensitivity(merged),
        severity: merged.severity, transmissionStrength: tx.transmission_strength, confirmation,
        hedged: merged.hedged, preview: merged.preview,
      });
      const signature = materialSignature({
        importance_class: imp.class, net_pressure: tx.net_pressure, confirmation_status: confirmation, subcategory: merged.subcategory,
        best_tier: bestTier, severity: merged.severity, dominant_driver: tx.dominant_driver,
      });
      const next = {
        category: merged.category, subcategory: merged.subcategory, region: merged.region,
        gold_relevance_score: rel.score, importance_score: imp.score, importance_class: imp.class, confirmation_status: confirmation,
        net_pressure: tx.net_pressure, net_score: tx.net_score, dominant_driver: tx.dominant_driver, counter_driver: tx.counter_driver,
        transmission: tx.channels, keywords: merged.keywords, horizon_biases: tx.horizons, classification: merged, signature,
      };
      const moved = ev.category !== next.category || ev.net_pressure !== next.net_pressure
        || Math.abs(ev.gold_relevance_score - next.gold_relevance_score) >= 10 || Math.abs(ev.importance_score - next.importance_score) >= 10;
      if (moved) changes.push({ id: ev.id, title: ev.title.slice(0, 80), from: `${ev.category}/${ev.net_pressure}/rel ${ev.gold_relevance_score}/imp ${ev.importance_score}`, to: `${next.category}/${next.net_pressure}/rel ${next.gold_relevance_score}/imp ${next.importance_score}` });
      if (!dryRun) {
        await c.query(`UPDATE events SET category = $2, subcategory = $3, region = $4, gold_relevance_score = $5, importance_score = $6,
            importance_class = $7, confirmation_status = $8, net_pressure = $9, net_score = $10, dominant_driver = $11, counter_driver = $12,
            transmission = $13::jsonb, keywords = $14::text[], horizon_biases = $15::jsonb, classification = $16::jsonb, signature = $17, updated_at = now()
          WHERE id = $1 AND NOT is_test`,
        [ev.id, next.category, next.subcategory, next.region, next.gold_relevance_score, next.importance_score, next.importance_class,
          next.confirmation_status, next.net_pressure, next.net_score, next.dominant_driver, next.counter_driver,
          JSON.stringify(next.transmission), next.keywords || [], JSON.stringify(next.horizon_biases), JSON.stringify(next.classification), next.signature]);
      }
    }
    for (const ch of changes) console.log(`#${ch.id} ${ch.from}  ->  ${ch.to} | ${ch.title}`);
    console.log(`${dryRun ? '[dry-run] ' : ''}rescored ${events.length} live events (${changes.length} materially changed)`);
  });
}

main().catch((err) => { console.error(err.message); process.exit(1); });
