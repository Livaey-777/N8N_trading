'use strict';
/**
 * Gold relevance (0-100), importance (0-100) and importance class.
 * Weights are explicit so thresholds (config) and scores stay explainable.
 */
const T = require('./taxonomy');
const { clamp } = require('./util');

const RELEVANCE_DIMINISHING = [1, 0.8, 0.6, 0.45, 0.35, 0.25];
// Scheduled releases matter by type even when an official title is generic ("FOMC statement").
const SCHEDULED_RELEASES = new Set(['FOMC_DECISION', 'CPI', 'PCE', 'NFP', 'PPI', 'GDP', 'JOLTS', 'JOBLESS_CLAIMS', 'RETAIL_SALES', 'PMI_ISM', 'ECB_POLICY', 'BOE_POLICY', 'BOJ_POLICY']);
const TIER_RELIABILITY = { 1: 1.0, 2: 0.85, 3: 0.75, 4: 0.35 };
const IMPORTANCE_WEIGHTS = {
  novelty: 0.08, reliability: 0.17, marketSensitivity: 0.20, goldSensitivity: 0.30, severity: 0.12, transmission: 0.13,
};

function channelStrength(ev) {
  const directional = ev.bull + ev.bear;
  const raw = directional + 0.5 * ev.neutral;
  if (raw <= 0) return 0;
  if (raw < 0.9) return 0.45;
  if (raw < 1.5) return 0.6;
  if (raw < 2.5) return 0.85;
  return 1;
}

function marketSensitivity(cls) {
  let s = T.MARKET_SENSITIVITY[cls.subcategory];
  if (s === undefined) s = 0.3;
  if (T.MAJOR_GEO_REGIONS.has(cls.region) && ['GEOPOLITICS', 'POLITICS'].includes(cls.category)) s += 0.1;
  if (cls.category === 'GEOPOLITICS' && cls.channels.ENERGY && cls.channels.ENERGY.bull > 0) s += 0.05;
  // Conflicts outside the gold-relevant theatres, without an energy / trade channel, move markets far less.
  if (cls.category === 'GEOPOLITICS' && !T.MAJOR_GEO_REGIONS.has(cls.region) && !(cls.channels.ENERGY || cls.channels.TRADE_SUPPLY_SHOCK)) s -= 0.2;
  if (cls.institutions.includes('FED') && cls.category === 'MACRO') s += 0.05;
  return clamp(s, 0, 1);
}

/**
 * @returns {{score:number, parts:object}}
 */
function goldRelevance(cls) {
  const parts = { base: T.CATEGORY_BASE_RELEVANCE[cls.category] || 0, channels: 0, sensitivity: 0, goldDirect: 0, bonus: 0, capped: null };
  const contribs = Object.entries(cls.channels)
    .map(([name, ev]) => (T.CHANNELS[name] ? T.CHANNELS[name].weight * channelStrength(ev) : 0))
    .filter((x) => x > 0)
    .sort((a, b) => b - a);
  parts.channels = contribs.reduce((s, c, i) => s + c * (RELEVANCE_DIMINISHING[i] || 0.2), 0);
  const sens = marketSensitivity(cls);
  parts.sensitivity = 30 * sens;
  if (cls.gold.mentioned) parts.goldDirect = cls.gold.inTitle === false ? 10 : 20;
  if (cls.institutions.includes('FED')) parts.bonus += 8;
  if (T.MAJOR_GEO_REGIONS.has(cls.region)) parts.bonus += 5;
  let score = parts.base + parts.channels + parts.sensitivity + parts.goldDirect + parts.bonus;
  const activeChannels = contribs.length;
  const directionalAny = Object.values(cls.channels).some((ev) => ev.bull + ev.bear > 0);
  const scheduled = SCHEDULED_RELEASES.has(cls.subcategory);
  if (cls.supervisory && !directionalAny) {
    // Bank supervision / enforcement notices from central banks: no macro transmission.
    score = Math.min(score, 20);
    parts.capped = 'SUPERVISORY_NOTICE';
  } else if (!directionalAny && !scheduled && !cls.gold.mentioned) {
    // No directional transmission evidence: at most informational context.
    score = Math.min(score, activeChannels === 0 ? (cls.category === 'MACRO' ? 30 : 20) : (cls.category === 'MACRO' ? 45 : 30));
    parts.capped = 'NO_DIRECTIONAL_TRANSMISSION';
  }
  if (cls.category === 'GENERAL' && !cls.gold.mentioned) { score = Math.min(score, 15); parts.capped = 'GENERAL_NOISE'; }
  if (cls.gold.noiseMasked && !cls.gold.mentioned && activeChannels === 0) { score = Math.min(score, 5); parts.capped = 'GOLD_WORD_NOISE'; }
  const directional = Object.values(cls.channels).some((ev) => ev.bull + ev.bear > 0);
  if (cls.gold.localPriceListing || cls.gold.minerEquity) {
    // Local retail price tables and single-miner equity pages are not macro intelligence.
    score = Math.min(score, directional ? 40 : 20);
    parts.capped = cls.gold.localPriceListing ? 'LOCAL_PRICE_LISTING' : 'MINER_EQUITY';
  } else if (cls.category === 'GOLD' && !directional) {
    // Gold price commentary / forecasts with no identified transmission driver: informational.
    score = Math.min(score, cls.gold.forecastOnly ? 38 : 42);
    parts.capped = 'GOLD_NO_DRIVER';
  }
  if (cls.preview) {
    // Previews / outlook pieces: context for the pre-event engine, not an event.
    score = Math.min(score, 50);
    parts.capped = 'PREVIEW_OR_OUTLOOK';
  }
  return { score: Math.round(clamp(score, 0, 100)), parts, marketSensitivity: sens };
}

function importanceClass(score) {
  if (score >= 80) return 'CRITICAL';
  if (score >= 65) return 'HIGH';
  if (score >= 45) return 'MEDIUM';
  if (score >= 25) return 'LOW';
  return 'INFORMATIONAL';
}

function confirmationStatus(bestTier, publisherCount, tierCounts) {
  if (bestTier === 1) return 'CONFIRMED_OFFICIAL';
  const credible = (tierCounts[2] || 0) + (tierCounts[3] || 0);
  if (publisherCount >= 2 && credible >= 2) return 'CORROBORATED';
  // One credible newsroom plus independent outlets (original publishers behind aggregator links).
  if (credible >= 1 && publisherCount >= 3) return 'CORROBORATED';
  if (bestTier <= 3) return 'SINGLE_SOURCE';
  return 'UNCONFIRMED';
}

/**
 * @param {{novelty:number, bestTier:number, publisherCount:number, relevance:number,
 *          marketSensitivity:number, severity:number, transmissionStrength:number,
 *          confirmation:string, hedged?:boolean, preview?:boolean}} f
 */
function importance(f) {
  let reliability = TIER_RELIABILITY[f.bestTier] || 0.35;
  if (f.publisherCount >= 3) reliability += 0.15;
  else if (f.publisherCount === 2) reliability += 0.08;
  reliability = clamp(reliability, 0, 1);
  const w = IMPORTANCE_WEIGHTS;
  const parts = {
    novelty: w.novelty * clamp(f.novelty, 0, 1),
    reliability: w.reliability * reliability,
    marketSensitivity: w.marketSensitivity * clamp(f.marketSensitivity, 0, 1),
    goldSensitivity: w.goldSensitivity * clamp(f.relevance / 100, 0, 1),
    severity: w.severity * clamp(f.severity, 0, 1),
    transmission: w.transmission * clamp(f.transmissionStrength, 0, 1),
  };
  let score = Math.round(100 * Object.values(parts).reduce((s, x) => s + x, 0));
  let klass = importanceClass(score);
  const notes = [];
  // Tier-4-only reporting can never be the sole confirmation of a critical event.
  if (f.confirmation === 'UNCONFIRMED' && klass === 'CRITICAL') {
    score = Math.min(score, 79);
    klass = 'HIGH';
    notes.push('capped: tier-4-only sources cannot confirm a CRITICAL event');
  }
  if (f.confirmation === 'SINGLE_SOURCE' && klass === 'CRITICAL') {
    score = Math.min(score, 79);
    klass = 'HIGH';
    notes.push('capped: CRITICAL requires official confirmation or corroboration');
  }
  if (f.hedged && klass === 'CRITICAL') {
    score = Math.min(score, 79);
    klass = 'HIGH';
    notes.push('capped: hedged / speculative headline');
  }
  if (f.preview && score > 64) {
    score = 64;
    klass = importanceClass(score);
    notes.push('capped: preview / outlook piece');
  }
  return { score: clamp(score, 0, 100), class: klass, parts, notes };
}

module.exports = { goldRelevance, importance, importanceClass, confirmationStatus, marketSensitivity, TIER_RELIABILITY };
