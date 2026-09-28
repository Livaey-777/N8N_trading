'use strict';
/**
 * Desk state: multi-horizon gold bias, regime (with hysteresis), dominant and
 * counter drivers, market confirmation of the bias, confidence and data quality.
 * Combines decayed event transmission (news) with market-driver trends.
 */
const { round, clamp } = require('./util');
const { marketDriverScores } = require('./market');

const HORIZONS = ['SHORT', 'TACTICAL', 'SWING', 'STRUCTURAL'];
const HALF_LIFE_H = { SHORT: 12, TACTICAL: 72, SWING: 240, STRUCTURAL: 1080 };
const WINDOW_H = { SHORT: 36, TACTICAL: 240, SWING: 720, STRUCTURAL: 2160 };
const NEWS_WEIGHT = { SHORT: 0.6, TACTICAL: 0.5, SWING: 0.45, STRUCTURAL: 0.4 };
const GOLD_TREND_KEY = { SHORT: '4h', TACTICAL: '5d', SWING: '20d', STRUCTURAL: '90d' };

const REGIMES = [
  { id: 'SAFE-HAVEN BID', channels: ['SAFE_HAVEN', 'RISK_SENTIMENT', 'ENERGY', 'TRADE_SUPPLY_SHOCK'], sign: 1 },
  { id: 'RISK-ON DRAG', channels: ['SAFE_HAVEN', 'RISK_SENTIMENT', 'TRADE_SUPPLY_SHOCK'], sign: -1 },
  { id: 'RATES / REAL-YIELD PRESSURE', channels: ['REAL_YIELD', 'NOMINAL_YIELD', 'MONETARY_POLICY', 'INFLATION', 'M:REAL_YIELD', 'M:US10Y', 'M:US2Y'], sign: -1 },
  { id: 'EASING / FALLING-YIELD TAILWIND', channels: ['REAL_YIELD', 'NOMINAL_YIELD', 'MONETARY_POLICY', 'M:REAL_YIELD', 'M:US10Y', 'M:US2Y'], sign: 1 },
  { id: 'DOLLAR STRENGTH HEADWIND', channels: ['USD', 'M:USD'], sign: -1 },
  { id: 'DOLLAR WEAKNESS TAILWIND', channels: ['USD', 'M:USD'], sign: 1 },
  { id: 'STRUCTURAL BID (CB DEMAND / FISCAL RISK)', channels: ['CENTRAL_BANK_DEMAND', 'FISCAL_POLICY', 'PHYSICAL_DEMAND'], sign: 1 },
];

function decay(ageH, horizon) {
  if (ageH < 0 || ageH > WINDOW_H[horizon]) return 0;
  return 0.5 ** (ageH / HALF_LIFE_H[horizon]);
}

function biasLabel(score, magnitude, conflict) {
  if (magnitude === 0) return 'UNDETERMINED';
  if (conflict) return 'MIXED';
  if (Math.abs(score) < 0.1) return 'NEUTRAL';
  return score > 0 ? 'BULLISH' : 'BEARISH';
}

/**
 * @param {Array} events recent events: {id,title,category,importance_score,last_seen_at,first_seen_at,transmission:[{channel,horizon_effects,signed,active}]}
 * @param {object} snap  market.marketSnapshot()
 * @param {object|null} previous previous desk state {regime, regime_candidate, candidate_count}
 * @param {string} nowIso
 */
function computeDeskState(events, snap, previous, nowIso) {
  const now = new Date(nowIso).getTime();
  const channelTotals = {};
  const news = {};
  const eventCounts = {};
  for (const h of HORIZONS) { news[h] = { score: 0, weight: 0, contributors: [] }; eventCounts[h] = 0; }
  for (const ev of events || []) {
    const ageH = (now - new Date(ev.last_seen_at || ev.first_seen_at).getTime()) / 3600000;
    const imp = clamp((ev.importance_score || 0) / 100, 0, 1);
    for (const h of HORIZONS) {
      const d = decay(ageH, h);
      if (d === 0) continue;
      let evScore = 0;
      for (const c of ev.transmission || []) {
        if (!c.active) continue;
        const e = (c.horizon_effects && c.horizon_effects[h]) || 0;
        evScore += e;
        if (h === 'TACTICAL' || h === 'SWING') channelTotals[c.channel] = (channelTotals[c.channel] || 0) + e * d * imp;
      }
      if (evScore !== 0) {
        news[h].score += evScore * d * imp;
        news[h].weight += d * imp;
        eventCounts[h]++;
        news[h].contributors.push({ id: ev.id, title: ev.title, contribution: round(evScore * d * imp, 4) });
      }
    }
  }
  // Normalise news channel totals by the total decayed event weight so that headline VOLUME
  // cannot swamp market drivers (100 war headlines are one theme, not 100 independent signals).
  const newsWeight = Math.max(news.TACTICAL.weight + news.SWING.weight, 1);
  for (const k of Object.keys(channelTotals)) channelTotals[k] /= newsWeight;
  const market = marketDriverScores(snap);
  for (const h of ['TACTICAL', 'SWING']) {
    for (const d of (market[h] && market[h].drivers) || []) {
      channelTotals[`M:${d.driver}`] = (channelTotals[`M:${d.driver}`] || 0) + d.score * 0.5;
    }
  }
  const horizons = {};
  const goldInfo = snap.instruments.GOLD || { available: false };
  for (const h of HORIZONS) {
    const n = news[h].weight > 0 ? clamp(news[h].score / Math.max(news[h].weight, 0.5), -1, 1) : null;
    const m = market[h] ? market[h].score : null;
    let combined = null;
    let conflict = false;
    if (n !== null && m !== null) {
      combined = NEWS_WEIGHT[h] * n + (1 - NEWS_WEIGHT[h]) * m;
      conflict = Math.sign(n) !== Math.sign(m) && Math.abs(n) >= 0.15 && Math.abs(m) >= 0.15;
    } else if (n !== null) combined = n * 0.8;
    else if (m !== null) combined = m * 0.8;
    const magnitude = combined === null ? 0 : Math.abs(combined) + 0.001;
    const bias = biasLabel(combined || 0, combined === null ? 0 : magnitude, conflict);
    const trendKey = GOLD_TREND_KEY[h];
    const goldState = goldInfo.available && goldInfo.states ? goldInfo.states[trendKey] : 'UNAVAILABLE';
    let confirmation = 'UNAVAILABLE';
    if (goldState && goldState !== 'UNAVAILABLE' && (bias === 'BULLISH' || bias === 'BEARISH')) {
      const want = bias === 'BULLISH' ? 'UP' : 'DOWN';
      confirmation = goldState === want ? 'CONFIRMED' : goldState === 'FLAT' ? 'NOT CONFIRMED (FLAT)' : 'DIVERGENCE';
    } else if (goldState && goldState !== 'UNAVAILABLE') confirmation = `N/A (bias ${bias})`;
    horizons[h] = {
      bias,
      score: combined === null ? null : round(combined, 3),
      news_score: n === null ? null : round(n, 3),
      market_score: m === null ? null : round(m, 3),
      conflict,
      events_considered: eventCounts[h],
      gold_trend: goldState,
      gold_change_pct: goldInfo.available && goldInfo.changes ? goldInfo.changes[trendKey] : null,
      market_confirmation: confirmation,
      market_drivers: market[h] ? market[h].drivers : [],
    };
  }
  // Drivers across tactical+swing.
  const ranked = Object.entries(channelTotals).filter(([, v]) => Math.abs(v) > 1e-4).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const dominant = ranked[0] || null;
  const counter = dominant ? ranked.find(([, v]) => Math.sign(v) === -Math.sign(dominant[1])) || null : null;
  // Regime scoring.
  const regimeScores = REGIMES.map((r) => {
    const s = r.channels.reduce((acc, ch) => acc + (channelTotals[ch] || 0), 0) * r.sign;
    return { id: r.id, score: round(s, 4) };
  }).sort((a, b) => b.score - a.score);
  const tact = horizons.TACTICAL;
  const REGIME_SIGN = Object.fromEntries(REGIMES.map((r) => [r.id, r.sign]));
  const topRegime = regimeScores[0];
  // A regime whose gold direction contradicts the market-confirmed tactical bias is a conflict,
  // not a regime (e.g. war headlines imply a safe-haven bid while rates pressure drives price).
  const tactSign = tact.bias === 'BULLISH' ? 1 : tact.bias === 'BEARISH' ? -1 : 0;
  const regimeContradictsMarket = Boolean(topRegime && tactSign !== 0 && REGIME_SIGN[topRegime.id] === -tactSign
    && tact.market_confirmation === 'CONFIRMED');
  let candidate;
  let conflictNote = null;
  if (tact.bias === 'UNDETERMINED' && horizons.SWING.bias === 'UNDETERMINED') candidate = 'UNDETERMINED';
  else if (tact.conflict || (tact.bias === 'MIXED')) candidate = 'MIXED / CONFLICTED';
  else if (!regimeScores.length || regimeScores[0].score < 0.02) candidate = 'QUIET / RANGE';
  else if (regimeContradictsMarket) {
    const aligned = regimeScores.find((r) => REGIME_SIGN[r.id] === tactSign && r.score >= 0.02);
    candidate = 'MIXED / CONFLICTED';
    conflictNote = `${topRegime.id} (news) vs ${aligned ? aligned.id : 'market trend'} (price-confirmed)`;
  } else candidate = regimeScores[0].id;
  // Hysteresis: switch only when the candidate persists for 2 runs or clearly dominates.
  const prevRegime = previous && previous.regime;
  let regime = candidate;
  let candidateCount = 1;
  if (prevRegime && prevRegime !== candidate) {
    const prevScore = (regimeScores.find((r) => r.id === prevRegime) || { score: 0 }).score;
    const candScore = (regimeScores.find((r) => r.id === candidate) || { score: 0 }).score;
    candidateCount = previous.regime_candidate === candidate ? (previous.candidate_count || 1) + 1 : 1;
    const clearlyBetter = candScore - prevScore > 0.1;
    if (candidateCount < 2 && !clearlyBetter && prevRegime !== 'UNDETERMINED') regime = prevRegime;
  }
  // Confidence 0-100: data coverage, evidence volume, agreement between news and market.
  const coverage = snap.coverage || 0;
  const evidence = clamp((eventCounts.TACTICAL + eventCounts.SWING) / 12, 0, 1);
  // Agreement: a horizon counts fully when price CONFIRMS its bias, half when nothing contradicts
  // it but price confirmation is unavailable/flat, zero on news-vs-market conflict or DIVERGENCE.
  // Cross-horizon consistency: short vs longer horizons pointing opposite ways lowers confidence.
  // Directional agreement dominates; data coverage and evidence volume only enable it.
  const agreement = HORIZONS.reduce((acc, h) => {
    const x = horizons[h];
    if (x.conflict || x.bias === 'UNDETERMINED' || x.market_confirmation === 'DIVERGENCE') return acc;
    return acc + (x.market_confirmation === 'CONFIRMED' ? 1 : 0.5);
  }, 0) / 4;
  const signs = HORIZONS.map((h) => (horizons[h].bias === 'BULLISH' ? 1 : horizons[h].bias === 'BEARISH' ? -1 : 0)).filter((s) => s !== 0);
  const crossHorizon = signs.length ? Math.abs(signs.reduce((a, s) => a + s, 0)) / signs.length : 0;
  let confidence = Math.round(100 * clamp(0.1 + 0.2 * coverage + 0.15 * evidence + 0.3 * agreement + 0.25 * crossHorizon, 0, 0.85));
  if (candidate === 'MIXED / CONFLICTED') confidence = Math.min(confidence, 55);
  const missing = snap.missing || [];
  return {
    as_of: nowIso,
    regime,
    regime_candidate: candidate,
    candidate_count: candidateCount,
    regime_scores: regimeScores.slice(0, 4),
    regime_conflict: conflictNote,
    horizons,
    dominant_driver: dominant ? dominant[0].replace(/^M:/, 'MARKET:') : null,
    dominant_value: dominant ? round(dominant[1], 4) : null,
    counter_driver: counter ? counter[0].replace(/^M:/, 'MARKET:') : null,
    counter_value: counter ? round(counter[1], 4) : null,
    confidence,
    data_quality: snap.data_quality,
    data_missing: missing,
    events_used: (events || []).length,
    top_contributors: news.TACTICAL.contributors.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 5),
  };
}

module.exports = { computeDeskState, HORIZONS };
