'use strict';
/**
 * Gold transmission engine: turns classification evidence into 15 channel
 * assessments (direction, strength, confidence, time horizon, evidence),
 * per-horizon effects, net pressure and dominant / counter drivers.
 */
const T = require('./taxonomy');
const { clamp, round } = require('./util');

const CHANNEL_ORDER = [
  'SAFE_HAVEN', 'REAL_YIELD', 'NOMINAL_YIELD', 'USD', 'INFLATION', 'MONETARY_POLICY', 'FISCAL_POLICY',
  'LIQUIDITY', 'RISK_SENTIMENT', 'CENTRAL_BANK_DEMAND', 'PHYSICAL_DEMAND', 'ENERGY', 'TRADE_SUPPLY_SHOCK',
  'POSITIONING', 'VOLATILITY',
];
const HORIZONS = ['SHORT', 'TACTICAL', 'SWING', 'STRUCTURAL'];
const TIER_CONFIDENCE = { 1: 0.9, 2: 0.8, 3: 0.7, 4: 0.4 };

// Inflation surprises act in opposite directions across horizons.
const INFLATION_HOT = { SHORT: -1.0, TACTICAL: -0.8, SWING: -0.2, STRUCTURAL: 0.6 };
const INFLATION_COOL = { SHORT: 1.0, TACTICAL: 0.8, SWING: 0.3, STRUCTURAL: -0.2 };

function primaryHorizon(profile) {
  return HORIZONS.reduce((best, h) => (Math.abs(profile[h]) > Math.abs(profile[best]) ? h : best), 'SHORT');
}

function horizonLabel(profile) {
  const active = HORIZONS.filter((h) => Math.abs(profile[h]) >= 0.6);
  if (!active.length) return primaryHorizon(profile);
  return active.length === 1 ? active[0] : `${active[0]}-${active[active.length - 1]}`;
}

function directionLabel(bull, bear) {
  const total = bull + bear;
  if (total < 1e-9) return 'NEUTRAL';
  const skew = (bull - bear) / total;
  if (Math.abs(skew) < 0.25) return 'MIXED';
  return skew > 0 ? 'BULLISH' : 'BEARISH';
}

/**
 * @param {object} cls  classification from classify.classifyItem (or merged event classification)
 * @param {{bestTier:number, publisherCount:number, severity:number}} ctx
 */
function computeTransmission(cls, ctx) {
  const tierConf = TIER_CONFIDENCE[ctx.bestTier] || 0.5;
  const corroboration = ctx.publisherCount >= 3 ? 0.12 : ctx.publisherCount === 2 ? 0.07 : 0;
  const hedgePenalty = cls.hedged ? 0.85 : 1;
  const channels = [];
  for (const name of CHANNEL_ORDER) {
    const ev = cls.channels[name];
    const def = T.CHANNELS[name];
    if (!ev || ev.hits === 0) {
      channels.push({ channel: name, active: false, direction: 'NEUTRAL', strength: 0, confidence: 0, time_horizon: horizonLabel(def.horizons), evidence: [], horizon_effects: { SHORT: 0, TACTICAL: 0, SWING: 0, STRUCTURAL: 0 }, signed: 0 });
      continue;
    }
    const directional = ev.bull + ev.bear;
    const direction = directionLabel(ev.bull, ev.bear);
    const explicitness = directional > 0 ? 1 : 0.6;
    const strength = clamp((0.3 + 0.25 * Math.min(directional + ev.neutral * 0.3, 3)) * (0.75 + 0.35 * ctx.severity) * hedgePenalty, 0, 1);
    const confidence = clamp((tierConf + corroboration) * explicitness * hedgePenalty, 0, 1);
    let sign = 0;
    if (directional > 0) sign = (ev.bull - ev.bear) / directional; // in [-1, 1]; ~0 when mixed
    let profile = def.horizons;
    let horizonText;
    if (name === 'INFLATION') {
      const hot = ev.bull > ev.bear;
      const cool = ev.bear > ev.bull;
      profile = hot ? INFLATION_HOT : cool ? INFLATION_COOL : { SHORT: 0, TACTICAL: 0, SWING: 0, STRUCTURAL: 0 };
      sign = directional > 0 ? Math.abs(ev.bull - ev.bear) / directional : 0;
      horizonText = hot ? 'SHORT-TACTICAL bearish (hawkish repricing) / STRUCTURAL bullish (inflation hedge)'
        : cool ? 'SHORT-TACTICAL bullish (easier policy path)' : 'UNCLEAR (tone not stated)';
    }
    const effects = {};
    for (const h of HORIZONS) effects[h] = round(sign * strength * confidence * profile[h], 4);
    const signed = name === 'INFLATION'
      ? round(effects.SHORT * 0.5 + effects.TACTICAL * 0.3 + effects.STRUCTURAL * 0.2, 4)
      : round(sign * strength * confidence, 4);
    channels.push({
      channel: name,
      active: true,
      direction: name === 'INFLATION' && (ev.bull > ev.bear || ev.bear > ev.bull)
        ? (ev.bull > ev.bear ? 'MIXED' : 'BULLISH')
        : direction,
      strength: round(strength, 2),
      confidence: round(confidence, 2),
      time_horizon: horizonText || horizonLabel(profile),
      evidence: ev.evidence.slice(0, 4),
      tags: ev.tags,
      horizon_effects: effects,
      signed,
      // Unsigned directional magnitude: a channel with both bullish and bearish evidence
      // contributes to BOTH sides of the net pressure (INFLATION's sign is horizon-dependent instead).
      gross: name === 'INFLATION' || directional === 0 ? null : round(strength * confidence, 4),
    });
  }
  const out = summarise(channels);
  // Headline reports gold moving AGAINST the channel direction (e.g. "gold plunges amid war"):
  // the market is not confirming the channel, so the net pressure is MIXED, not directional.
  const move = cls.gold && cls.gold.priceMove;
  if (move && Math.sign(out.net_score) === -move && /BULLISH|BEARISH/.test(out.net_pressure)) {
    out.net_pressure = 'MIXED';
    out.price_action_conflict = `headline reports gold ${move > 0 ? 'rising' : 'falling'} against the ${out.dominant_driver || 'channel'} direction`;
    for (const h of ['SHORT', 'TACTICAL']) if (/BULLISH|BEARISH/.test(out.horizons[h].bias)) out.horizons[h].bias = 'MIXED';
  }
  return out;
}

function pressureLabel(bull, bear) {
  const m = bull + bear;
  if (m < 0.05) return { label: 'NEUTRAL', score: 0, magnitude: round(m, 3) };
  const s = (bull - bear) / m;
  let label;
  if (Math.abs(s) < 0.25) label = 'MIXED';
  else if (s > 0) label = s >= 0.6 && m >= 0.6 ? 'STRONGLY BULLISH' : 'BULLISH';
  else label = s <= -0.6 && m >= 0.6 ? 'STRONGLY BEARISH' : 'BEARISH';
  return { label, score: round(s, 3), magnitude: round(m, 3) };
}

function summarise(channels) {
  const weighted = channels.filter((c) => c.active).map((c) => {
    const w = T.CHANNELS[c.channel].weight / 30;
    return { c, contribution: c.signed * w };
  });
  const sideOf = (x) => {
    const w = T.CHANNELS[x.c.channel].weight / 30;
    if (x.c.gross === null || x.c.gross === undefined) return { bull: Math.max(x.contribution, 0), bear: Math.max(-x.contribution, 0) };
    return { bull: ((x.c.gross + x.c.signed) / 2) * w, bear: ((x.c.gross - x.c.signed) / 2) * w };
  };
  const bull = weighted.reduce((s, x) => s + sideOf(x).bull, 0);
  const bear = weighted.reduce((s, x) => s + sideOf(x).bear, 0);
  const net = pressureLabel(bull, bear);
  const ranked = weighted.slice().sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const dominant = ranked.find((x) => Math.abs(x.contribution) > 1e-6) || null;
  const netSign = Math.sign(bull - bear);
  const counter = ranked.find((x) => Math.sign(x.contribution) === -netSign && Math.abs(x.contribution) > 1e-6 && netSign !== 0)
    || (net.label === 'MIXED' ? ranked.find((x) => dominant && Math.sign(x.contribution) === -Math.sign(dominant.contribution)) : null);
  const horizons = {};
  const perH = {};
  for (const h of HORIZONS) {
    let hb = 0;
    let hr = 0;
    for (const x of weighted) {
      const def = T.CHANNELS[x.c.channel];
      const w = def.weight / 30;
      if (x.c.gross === null || x.c.gross === undefined) {
        const e = x.c.horizon_effects[h] * w;
        if (e > 0) hb += e; else hr -= e;
      } else {
        hb += ((x.c.gross + x.c.signed) / 2) * def.horizons[h] * w;
        hr += ((x.c.gross - x.c.signed) / 2) * def.horizons[h] * w;
      }
    }
    perH[h] = pressureLabel(hb, hr);
  }
  // A horizon where the event's effect is small relative to its peak horizon is NEUTRAL
  // (e.g. a short-lived geopolitical shock is not a STRUCTURAL driver).
  const peak = Math.max(...HORIZONS.map((h) => perH[h].magnitude));
  for (const h of HORIZONS) {
    const p = perH[h];
    const bias = p.magnitude < 0.02 ? 'UNDETERMINED' : p.magnitude < 0.25 * peak ? 'NEUTRAL' : p.label.replace('STRONGLY ', '');
    horizons[h] = { bias, score: p.score, magnitude: p.magnitude };
  }
  const strength = weighted.length ? Math.max(...weighted.map((x) => x.c.strength)) : 0;
  return {
    channels,
    active_channels: weighted.map((x) => x.c.channel),
    bullish_forces: weighted.filter((x) => x.contribution > 0).sort((a, b) => b.contribution - a.contribution)
      .map((x) => ({ channel: x.c.channel, contribution: round(x.contribution, 3), evidence: x.c.evidence })),
    bearish_forces: weighted.filter((x) => x.contribution < 0).sort((a, b) => a.contribution - b.contribution)
      .map((x) => ({ channel: x.c.channel, contribution: round(x.contribution, 3), evidence: x.c.evidence })),
    net_pressure: net.label,
    net_score: net.score,
    net_magnitude: net.magnitude,
    dominant_driver: dominant ? dominant.c.channel : null,
    counter_driver: counter ? counter.c.channel : null,
    transmission_strength: round(strength, 2),
    horizons,
  };
}

/** Expected cross-asset response implied by the active channels (for market confirmation). */
function expectedResponse(tx) {
  const get = (n) => tx.channels.find((c) => c.channel === n && c.active);
  const mp = get('MONETARY_POLICY');
  const infl = get('INFLATION');
  const usd = get('USD');
  const sh = get('SAFE_HAVEN');
  const energy = get('ENERGY');
  let usdDir = 0;
  let yieldDir = 0;
  if (usd && usd.signed !== 0) usdDir = -Math.sign(usd.signed);
  if (mp && mp.signed !== 0) { yieldDir = -Math.sign(mp.signed); usdDir = usdDir || -Math.sign(mp.signed); }
  if (infl && infl.horizon_effects.SHORT !== 0) { yieldDir = yieldDir || -Math.sign(infl.horizon_effects.SHORT); usdDir = usdDir || -Math.sign(infl.horizon_effects.SHORT); }
  if (sh && sh.signed > 0 && !yieldDir) yieldDir = -1; // flight to quality
  const goldDir = tx.net_pressure.includes('BULLISH') ? 1 : tx.net_pressure.includes('BEARISH') ? -1 : 0;
  return {
    gold: goldDir,
    usd: usdDir,
    yields: yieldDir,
    oil: energy ? Math.sign(energy.signed) : 0,
  };
}

module.exports = { computeTransmission, expectedResponse, pressureLabel, CHANNEL_ORDER, HORIZONS };
