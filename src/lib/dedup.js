'use strict';
/**
 * Deduplication and event clustering: many reports -> one canonical event.
 *
 * Similarity uses the overlap coefficient |A∩B| / min(|A|,|B|) against each
 * event's canonical title tokens (fixed size), never a growing vocabulary union.
 * Scheduled macro releases cluster by (subcategory, time window) regardless of wording.
 */
const { tokenize, uniq, hashOf, hoursBetween } = require('./util');

const SYNONYMS = [
  [/federal reserve|fomc|the fed\b|fed's/g, ' fed '],
  [/european central bank/g, ' ecb '],
  [/bank of england/g, ' boe '],
  [/bank of japan/g, ' boj '],
  [/people's bank of china/g, ' pboc '],
  [/\b(?:lowers?|lowered|slash(?:es|ed)?|trims?|trimmed|reduces?|reduced)\b(?= (?:its |key |benchmark |interest )*rates?)/g, ' cut '],
  [/\b(?:raises?|raised|hikes?|hiked|lifts?|lifted)\b(?= (?:its |key |benchmark |interest )*rates?)/g, ' hike '],
  [/interest rates?|policy rates?|benchmark rates?|key rates?/g, ' rate '],
  [/quarter[- ]point|25 ?(?:basis points?|bps?|bp)/g, ' 25bp '],
  [/half[- ]point|50 ?(?:basis points?|bps?|bp)/g, ' 50bp '],
  [/consumer price index|consumer prices?|cpi/g, ' cpi '],
  [/nonfarm payrolls?|non-farm payrolls?|jobs report|payrolls/g, ' payrolls '],
  [/united states|u\.s\.|\bus\b|american/g, ' us '],
  [/\biranian\b/g, ' iran '], [/\brussian\b/g, ' russia '], [/\bchinese\b/g, ' china '], [/\bisraeli\b/g, ' israel '], [/\bukrainian\b/g, ' ukraine '],
  [/\b(?:proposals?|offers?|plans?|deals?|proposed|offered)\b/g, ' proposal '],
  [/\b(?:rejects?|rejected|rebuffs?|rebuffed|dismiss(?:es|ed)?|spurns?|spurned)\b/g, ' reject '],
  [/missiles?|rockets?/g, ' missile '],
  [/air ?strikes?|strikes?/g, ' strike '],
  [/cease-?fire|truce/g, ' ceasefire '],
  [/tariffs?|duties/g, ' tariff '],
  [/crude|oil prices?/g, ' oil '],
  [/greenback|dollar index|dxy/g, ' dollar '],
];

const SCHEDULED_MACRO = new Set([
  'FOMC_DECISION', 'CPI', 'PCE', 'NFP', 'PPI', 'GDP', 'JOLTS', 'JOBLESS_CLAIMS', 'RETAIL_SALES', 'PMI_ISM',
  'ECB_POLICY', 'BOE_POLICY', 'BOJ_POLICY',
]);
const MACRO_WINDOW_HOURS = 12;

function clusterTokens(title) {
  let t = ` ${String(title || '').toLowerCase()} `;
  for (const [re, rep] of SYNONYMS) t = t.replace(re, rep);
  return uniq(tokenize(t)).slice(0, 24);
}

function overlap(a, b) {
  if (!a.length || !b.length) return { coef: 0, shared: 0 };
  const sb = new Set(b);
  let shared = 0;
  for (const x of a) if (sb.has(x)) shared++;
  return { coef: shared / Math.min(a.length, b.length), shared };
}

function compatibleCategories(a, b) {
  if (a === b) return true;
  const soft = new Set(['GEOPOLITICS', 'POLITICS', 'MARKET']);
  return soft.has(a) && soft.has(b);
}

/**
 * Score an item against a cluster. Returns 0 when not the same event.
 */
function matchScore(item, cluster, cfg) {
  const within = Math.abs(hoursBetween(item.published_at || item.fetched_at, cluster.last_seen_at)) <= cfg.windowHours
    || Math.abs(hoursBetween(item.published_at || item.fetched_at, cluster.first_seen_at)) <= cfg.windowHours;
  if (!within) return 0;
  const cls = item.classification;
  if (SCHEDULED_MACRO.has(cls.subcategory) && cls.subcategory === cluster.subcategory) {
    const h = Math.abs(hoursBetween(item.published_at || item.fetched_at, cluster.first_seen_at));
    if (h <= MACRO_WINDOW_HOURS) return 0.95;
  }
  if (!compatibleCategories(cls.category, cluster.category)) return 0;
  const { coef, shared } = overlap(item.tokens, cluster.tokens);
  const sameRegion = cls.region === cluster.region && cls.region !== 'GLOBAL';
  const shortTitles = Math.min(item.tokens.length, cluster.tokens.length) <= 4;
  const minShared = shortTitles ? 2 : 3;
  const need = cls.category === cluster.category ? cfg.minCoverage : Math.max(cfg.minCoverage, 0.7);
  if (shared >= minShared && coef >= need) return coef + (sameRegion ? 0.05 : 0);
  // Same theatre + same subcategory + strong partial overlap (different wording of one event).
  if (sameRegion && cls.subcategory === cluster.subcategory && shared >= 2 && coef >= need - 0.15) return coef;
  return 0;
}

function mergeChannels(target, source) {
  for (const [name, ev] of Object.entries(source || {})) {
    const t = target[name] || (target[name] = { bull: 0, bear: 0, neutral: 0, hits: 0, evidence: [], tags: [] });
    t.bull = Math.max(t.bull, ev.bull);
    t.bear = Math.max(t.bear, ev.bear);
    t.neutral = Math.max(t.neutral, ev.neutral);
    t.hits = Math.max(t.hits, ev.hits);
    for (const e of ev.evidence) if (!t.evidence.includes(e) && t.evidence.length < 6) t.evidence.push(e);
    for (const g of ev.tags || []) if (!t.tags.includes(g)) t.tags.push(g);
  }
  return target;
}

/** Merges item classifications into one event-level classification. */
function mergeClassification(base, add) {
  if (!base) return JSON.parse(JSON.stringify(add));
  const out = base;
  out.channels = mergeChannels(out.channels || {}, add.channels);
  out.severity = Math.max(out.severity || 0, add.severity || 0);
  out.hedged = Boolean(out.hedged && add.hedged);
  out.preview = Boolean(out.preview && add.preview);
  // Presence flags: any report; noise flags (caps): only when EVERY report is noise;
  // price moves: agreed direction, 0 when reports disagree.
  const og = out.gold || {};
  const ag = add.gold || {};
  const either = (k) => Boolean(og[k] || ag[k]);
  const both = (k) => Boolean(og[k] && ag[k]);
  const dir = (k) => { const a = og[k] || 0; const b = ag[k] || 0; return a && b && a !== b ? 0 : a || b; };
  out.gold = {
    mentioned: either('mentioned'), inTitle: either('inTitle'),
    priceAction: dir('priceAction'), priceMove: dir('priceMove'),
    noiseMasked: both('noiseMasked'), minerEquity: both('minerEquity'), localPriceListing: both('localPriceListing'), forecastOnly: both('forecastOnly'),
  };
  out.institutions = uniq([...(out.institutions || []), ...(add.institutions || [])]);
  out.regions = uniq([...(out.regions || []), ...(add.regions || [])]);
  out.keywords = uniq([...(out.keywords || []), ...(add.keywords || [])]).slice(0, 16);
  out.macroFamily = out.macroFamily || add.macroFamily || null;
  if (!out.macroTone || out.macroTone === 'IN_LINE_OR_UNCLEAR') out.macroTone = add.macroTone || out.macroTone || null;
  return out;
}

/**
 * @param {Array} items    retained items: {item_hash, title, publisher, source_id, tier, published_at, fetched_at, classification, relevance}
 * @param {Array} recent   recent events from DB: {id, event_key, title, category, subcategory, region, tokens, first_seen_at, last_seen_at, best_tier, publishers, source_count, classification, signature, alert_signature, last_alerted_at, alert_count, is_test}
 * @param {{windowHours:number, minCoverage:number}} cfg
 */
function clusterItems(items, recent, cfg) {
  const clusters = (recent || []).map((e) => ({
    existing: true,
    id: e.id,
    event_key: e.event_key,
    title: e.title,
    category: e.category,
    subcategory: e.subcategory,
    region: e.region,
    tokens: e.tokens && e.tokens.length ? e.tokens : clusterTokens(e.title),
    first_seen_at: e.first_seen_at,
    last_seen_at: e.last_seen_at,
    best_tier: e.best_tier,
    publishers: [...(e.publishers || [])],
    source_count: e.source_count || 0,
    classification: e.classification || null,
    previous: e,
    newItems: [],
  }));
  const sorted = items.slice().sort((a, b) => new Date(a.published_at || a.fetched_at) - new Date(b.published_at || b.fetched_at));
  for (const item of sorted) {
    item.tokens = item.tokens || clusterTokens(item.title);
    let best = null;
    let bestScore = 0;
    for (const c of clusters) {
      if (Boolean(c.previous && c.previous.is_test) !== Boolean(item.is_test) && c.existing) continue;
      if (!c.existing && Boolean(c.is_test) !== Boolean(item.is_test)) continue;
      const s = matchScore(item, c, cfg);
      if (s > bestScore) { best = c; bestScore = s; }
    }
    if (best) {
      best.newItems.push({ ...item, match_score: Number(bestScore.toFixed(3)) });
      const t = item.published_at || item.fetched_at;
      if (new Date(t) > new Date(best.last_seen_at)) best.last_seen_at = t;
      if (new Date(t) < new Date(best.first_seen_at)) best.first_seen_at = t;
      if (item.tier < best.best_tier) {
        // A better-tier source becomes the canonical headline (tokens replaced, not grown).
        best.best_tier = item.tier;
        best.title = item.title;
        best.tokens = item.tokens;
        best.category = item.classification.category;
        best.subcategory = item.classification.subcategory;
        best.region = item.classification.region;
      }
      if (!best.publishers.includes(item.publisher)) best.publishers.push(item.publisher);
    } else {
      const t = item.published_at || item.fetched_at;
      clusters.push({
        existing: false,
        id: null,
        event_key: `ev_${hashOf(item.item_hash, item.title)}`,
        title: item.title,
        category: item.classification.category,
        subcategory: item.classification.subcategory,
        region: item.classification.region,
        tokens: item.tokens,
        first_seen_at: t,
        last_seen_at: t,
        best_tier: item.tier,
        publishers: [item.publisher],
        source_count: 0,
        classification: null,
        previous: null,
        is_test: Boolean(item.is_test),
        newItems: [{ ...item, match_score: 1 }],
      });
    }
  }
  const touched = clusters.filter((c) => c.newItems.length > 0);
  for (const c of touched) {
    let merged = c.classification ? JSON.parse(JSON.stringify(c.classification)) : null;
    for (const it of c.newItems) merged = mergeClassification(merged, it.classification);
    merged.category = c.category;
    merged.subcategory = c.subcategory;
    merged.region = c.region;
    c.classification = merged;
    c.source_count += c.newItems.length;
  }
  return touched;
}

/** Signature of the materially relevant state; a change re-qualifies an event for alerting. */
function materialSignature(ev) {
  return hashOf(ev.importance_class, ev.net_pressure, ev.confirmation_status, ev.subcategory,
    ev.best_tier === 1 ? 'OFFICIAL' : 'NONOFFICIAL', (ev.severity || 0) >= 0.9 ? 'SEVERE' : 'NORMAL', ev.dominant_driver);
}

module.exports = { clusterItems, clusterTokens, overlap, matchScore, mergeClassification, materialSignature, SCHEDULED_MACRO };
