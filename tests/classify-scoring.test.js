'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyItem } = require('../src/lib/classify');
const { goldRelevance, importance, confirmationStatus } = require('../src/lib/scoring');
const { computeTransmission } = require('../src/lib/transmission');

const rel = (title, summary) => goldRelevance(classifyItem({ title, summary })).score;
const tx = (title, tier = 3) => {
  const c = classifyItem({ title });
  return computeTransmission(c, { bestTier: tier, publisherCount: 1, severity: c.severity });
};

test('Fed decision is macro / FOMC and highly gold-relevant', () => {
  const c = classifyItem({ title: 'Fed cuts rates by 25 basis points, signals more easing ahead' });
  assert.equal(c.category, 'MACRO');
  assert.equal(c.subcategory, 'FOMC_DECISION');
  assert.ok(rel('Fed cuts rates by 25 basis points, signals more easing ahead') >= 75);
  assert.equal(tx('Fed cuts rates by 25 basis points, signals more easing ahead', 1).net_pressure.includes('BULLISH'), true);
});

test('noise is filtered: sports gold medal, generic politics, miner equities, local price tables', () => {
  assert.ok(rel('Olympic swimmer wins gold medal in Paris') < 20);
  assert.ok(rel('Senate passes annual defense policy bill') < 35);
  assert.ok(rel('Why Kinross Gold (TSX:K) Is Back In Focus After Its Latest Update') <= 40);
  assert.ok(rel('Gold Rate Today In Patna, Check Live 22 And 24 Carat Gold Price') <= 40);
});

test('supervisory central-bank notices carry no macro relevance', () => {
  assert.ok(rel('Federal Reserve Board announces approval of application by Peoples Bancorp Inc.') <= 20);
});

test('generic official FOMC statement title still scores as a scheduled release', () => {
  assert.ok(rel('Federal Reserve issues FOMC statement') >= 60);
});

test('negated de-escalation is escalation; ceasefire agreement is de-escalation', () => {
  const rejected = classifyItem({ title: "Trump rejects Iran's ceasefire proposal to reopen Strait of Hormuz" });
  assert.ok(rejected.channels.SAFE_HAVEN.bull > rejected.channels.SAFE_HAVEN.bear);
  const agreed = classifyItem({ title: 'Israel and Hamas agree to ceasefire deal' });
  assert.equal(agreed.subcategory, 'DE_ESCALATION');
});

test('trade retaliation is trade, not military escalation', () => {
  const c = classifyItem({ title: "Trump's 50% tariffs on Canada take effect as Carney vows to retaliate" });
  assert.equal(c.channels.SAFE_HAVEN, undefined);
  assert.ok(c.channels.TRADE_SUPPLY_SHOCK.bull > 0);
});

test('hot inflation is bearish short-term, bullish structurally', () => {
  const t = tx('US consumer prices rise 0.4% in August, hotter than expected');
  assert.equal(t.horizons.SHORT.bias, 'BEARISH');
  assert.equal(t.horizons.STRUCTURAL.bias, 'BULLISH');
  const hi = tx('Fed holds interest rates steady as inflation hits 3-year high');
  assert.equal(hi.dominant_driver, 'INFLATION');
});

test('BoE story mentioning the Fed is attributed to the BoE', () => {
  assert.equal(classifyItem({ title: "Bank of England defies Fed's rate-hike lead, leaving rates unchanged" }).subcategory, 'BOE_POLICY');
});

test('non-Fed hawkish decision is MIXED (policy vs USD cross)', () => {
  assert.equal(tx('ECB raises rates, signals more hikes', 1).net_pressure, 'MIXED');
});

test('summary-only background words are down-weighted', () => {
  const withNoise = rel('Scandal and succession in a political family', 'The war over the legacy continues as missiles of criticism fly.');
  assert.ok(withNoise < 60);
});

test('tier-4-only sources can never confirm a CRITICAL event', () => {
  const conf = confirmationStatus(4, 1, { 4: 1 });
  assert.equal(conf, 'UNCONFIRMED');
  const imp = importance({ novelty: 1, bestTier: 4, publisherCount: 1, relevance: 100, marketSensitivity: 1, severity: 1, transmissionStrength: 1, confirmation: conf });
  assert.notEqual(imp.class, 'CRITICAL');
});

test('a short-lived geopolitical shock is not labelled a STRUCTURAL driver', () => {
  const t = tx('Government confirms naval blockade of the Strait of Hormuz after missile strikes on oil tankers', 1);
  assert.equal(t.horizons.SHORT.bias, 'BULLISH');
  assert.equal(t.horizons.STRUCTURAL.bias, 'NEUTRAL');
});

test('headline gold price move against the channel makes the net pressure MIXED', () => {
  const t = tx('Why gold prices are plunging amid the Iran war, despite being a supposedly safe asset');
  assert.equal(t.net_pressure, 'MIXED');
  assert.match(t.price_action_conflict, /falling/);
  const ok = tx('Gold jumps as Iran war escalates');
  assert.match(ok.net_pressure, /BULLISH/);
  assert.equal(ok.price_action_conflict, undefined);
});

test('tariffs mentioned only as background of a company story are not a trade-policy event', () => {
  const r = rel('Audemars Piguet says its Royal Pop collaboration with Swatch is breaking sales records, despite luxury watch slump and tariffs');
  assert.ok(r < 30, `relevance ${r}`);
  assert.ok(rel("Trump's 50% tariffs on Canada take effect as Carney vows to retaliate") >= 45);
});

test('rising Fed cut bets are bullish; rising hike bets and fading cut bets are bearish', () => {
  assert.match(tx('Gold hits record high as Fed cut bets rise').net_pressure, /BULLISH/);
  assert.match(tx('Fed hike bets mount after hot payrolls').net_pressure, /BEARISH/);
  assert.match(tx('Fed cut bets fade as inflation stays sticky').net_pressure, /BEARISH/);
});

test('a channel with both bullish and bearish evidence yields MIXED net pressure, not a direction', () => {
  const t = tx('Cooper urges scrutiny of tax amendments and calls for tariffs rollback, end to Iran war', 4);
  assert.equal(t.net_pressure, 'MIXED');
  assert.ok(['MIXED', 'NEUTRAL', 'UNDETERMINED'].includes(t.horizons.SHORT.bias));
});

test('previews / outlook pieces are context, not events (relevance and importance capped)', () => {
  const c = classifyItem({ title: 'Why the upcoming jobs report could send 10-year and 30-year Treasury yields surging' });
  assert.equal(c.preview, true);
  assert.ok(goldRelevance(c).score <= 50);
  const imp = importance({ novelty: 1, bestTier: 3, publisherCount: 3, relevance: 90, marketSensitivity: 0.95, severity: 0.6, transmissionStrength: 0.9, confirmation: 'CORROBORATED', preview: true });
  assert.ok(imp.score <= 64 && imp.class !== 'HIGH' && imp.class !== 'CRITICAL');
  assert.equal(classifyItem({ title: 'US payrolls jump 250,000, beating expectations' }).preview, false);
});

test('CRITICAL needs official confirmation or corroboration; hedged headlines cap at HIGH', () => {
  const base = { novelty: 1, bestTier: 3, publisherCount: 1, relevance: 95, marketSensitivity: 0.95, severity: 0.9, transmissionStrength: 1 };
  assert.equal(importance({ ...base, confirmation: 'SINGLE_SOURCE' }).class, 'HIGH');
  assert.equal(importance({ ...base, bestTier: 1, confirmation: 'CONFIRMED_OFFICIAL' }).class, 'CRITICAL');
  assert.equal(importance({ ...base, bestTier: 1, confirmation: 'CONFIRMED_OFFICIAL', hedged: true }).class, 'HIGH');
  assert.equal(confirmationStatus(3, 13, { 3: 1, 4: 12 }), 'CORROBORATED');
  assert.equal(confirmationStatus(4, 5, { 4: 5 }), 'UNCONFIRMED');
});

test('a conflict outside the gold-relevant theatres has lower market sensitivity', () => {
  const far = classifyItem({ title: "Recreational Aerial Craft Become Weapons in Myanmar's War" });
  const near = classifyItem({ title: 'Iran fires missiles at US base in Iraq' });
  assert.ok(goldRelevance(far).score < goldRelevance(near).score);
  assert.ok(goldRelevance(far).score < 45, `far ${goldRelevance(far).score}`);
});
