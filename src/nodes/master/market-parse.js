'use strict';
// MARKET CONTEXT + DESK STATE: parse market responses, mark unavailable sources,
// merge with stored history, compute the multi-horizon desk state (regime w/ hysteresis).
const { loadConfig, secretsFrom } = require('../../lib/config');
const { parseGoldApi, parseCoinbaseRates, parseTreasuryCsv, parseCftcCot, parseFred, marketSnapshot } = require('../../lib/market');
const { computeDeskState } = require('../../lib/desk');
const { goldLayer, usdLayer, yieldLayer, macroLayer, geoLayer, politicalLayer } = require('../../lib/forecast');
const { sourceQuality } = require('../../lib/market');
const { makeHttp } = require('../../lib/http');
const { redact } = require('../../lib/util');

const cfg = loadConfig($env);
const secrets = secretsFrom($env);
const ctx = $('Load Market Context').first().json;
const reqs = $('Plan Market Requests').all().map((i) => i.json);
const nowIso = new Date().toISOString();
const observations = [];
const gold = [];
const health = [];
const fetchState = { ...((ctx.fetch_state && ctx.fetch_state.value) || {}) };

$input.all().forEach((resp, idx) => {
  const pair = resp.pairedItem && typeof resp.pairedItem.item === 'number' ? resp.pairedItem.item : idx;
  const req = reqs[pair] || {};
  const status = resp.json.statusCode;
  const body = resp.json.body !== undefined ? resp.json.body : resp.json.data;
  const fail = (msg) => health.push({ component: `market:${req.kind}`, status: 'DEGRADED', detail: String(msg).slice(0, 200), metrics: { http_status: status || null } });
  if (resp.json.error || status !== 200 || body === undefined) { fail(resp.json.error ? resp.json.error.message || resp.json.error : `HTTP ${status}`); return; }
  let json = null;
  if (typeof body === 'string' && /^\s*[[{]/.test(body)) { try { json = JSON.parse(body); } catch (_) { json = null; } } else if (typeof body === 'object') json = body;
  try {
    if (req.kind === 'gold') {
      const g = parseGoldApi(json);
      if (!g) { fail('unparseable gold-api response'); return; }
      gold.push({ observed_at: g.observed_at, price: g.price, source: g.source, quality: 'OK' });
    } else if (req.kind === 'fx') {
      const obs = parseCoinbaseRates(json, nowIso);
      if (!obs.length) { fail('no FX rates'); return; }
      observations.push(...obs);
    } else if (req.kind === 'treasury_nominal' || req.kind === 'treasury_real') {
      const obs = parseTreasuryCsv(String(body), req.kind === 'treasury_nominal' ? 'nominal' : 'real');
      if (!obs.length) { fail('empty Treasury CSV'); return; }
      observations.push(...obs.filter((o) => Date.parse(o.observed_at) > Date.now() - 20 * 86400000));
      fetchState.treasury = nowIso;
    } else if (req.kind === 'cot') {
      const obs = parseCftcCot(json);
      if (!obs.length) { fail('empty COT response'); return; }
      observations.push(...obs);
      fetchState.cot = nowIso;
    }
    health.push({ component: `market:${req.kind}`, status: 'OK', detail: null, metrics: null });
  } catch (e) {
    fail(e.message);
  }
});

// Optional FRED series (oil, VIX) — key kept inside this node.
const fredAge = fetchState.fred ? (Date.now() - Date.parse(fetchState.fred)) / 60000 : Infinity;
if (cfg.secrets.fredConfigured && fredAge >= 360) {
  const http = makeHttp(this.helpers, { userAgent: cfg.http.userAgent });
  for (const [id, instr, unit] of [['DCOILWTICO', 'WTI', 'USD/bbl'], ['VIXCLS', 'VIX', 'index']]) {
    try {
      const r = await http({ url: 'https://api.stlouisfed.org/fred/series/observations', qs: { series_id: id, api_key: secrets.fredKey, file_type: 'json', sort_order: 'desc', limit: 30 } });
      if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}`);
      observations.push(...parseFred(r.body, id, instr, unit));
      health.push({ component: `market:fred:${instr}`, status: 'OK', detail: null, metrics: null });
    } catch (e) {
      health.push({ component: `market:fred:${instr}`, status: 'DEGRADED', detail: redact(e.message, secrets.list()).slice(0, 200), metrics: null });
    }
  }
  fetchState.fred = nowIso;
} else if (!cfg.secrets.fredConfigured) {
  health.push({ component: 'market:fred', status: 'NOT_CONFIGURED', detail: 'oil/VIX unavailable (optional FRED_API_KEY)', metrics: null });
}

// Sanity: never accept future-stamped observations (clock skew / partial candles).
const horizonMs = Date.now() + 5 * 60000;
for (const arr of [observations, gold]) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (Date.parse(arr[i].observed_at) > horizonMs) {
      health.push({ component: 'market:sanity', status: 'DEGRADED', detail: `dropped future-stamped ${arr[i].instrument || 'GOLD'} observation ${arr[i].observed_at}`, metrics: null });
      arr.splice(i, 1);
    }
  }
}
// Merge stored history with this tick's observations.
const ser = (arr) => (arr || []).map((p) => ({ t: p.t, v: Number(p.v), src: p.src })).filter((p) => Number.isFinite(p.v) && Date.parse(p.t) <= horizonMs);
const series = {
  GOLD: ser(ctx.gold), USD_PROXY: ser(ctx.usd), US2Y: ser(ctx.us2y), US10Y: ser(ctx.us10y), US30Y: ser(ctx.us30y), US10Y_REAL: ser(ctx.us10y_real),
  WTI: ser(ctx.wti), VIX: ser(ctx.vix), GOLD_COT_NONCOMM_NET: ser(ctx.cot),
};
for (const g of gold) series.GOLD.push({ t: g.observed_at, v: g.price, src: g.source });
for (const o of observations) if (series[o.instrument]) series[o.instrument].push({ t: o.observed_at, v: o.value, src: o.source });
for (const k of Object.keys(series)) {
  const m = new Map();
  for (const p of series[k]) m.set(p.t, p);
  series[k] = Array.from(m.values()).sort((a, b) => a.t.localeCompare(b.t));
}
const snap = marketSnapshot(series, nowIso);
const prev = ctx.prev_desk || null;
const desk = computeDeskState(ctx.events || [], snap, prev, nowIso);
const regimeChanged = Boolean(prev && prev.regime && prev.regime !== desk.regime && desk.regime !== 'UNDETERMINED');
// Forecast-engine input layers, stored with the desk state for /now, the daily report and forecasts.
const evts = (ctx.events || []).map((e) => ({ ...e, transmission: e.transmission || [] }));
const dailyGold = series.GOLD.filter((pt, i, a) => i === a.length - 1 || String(pt.t).slice(0, 10) !== String(a[i + 1].t).slice(0, 10));
desk.layers = {
  gold: goldLayer(snap, dailyGold, nowIso),
  usd: usdLayer(snap, []),
  yields: yieldLayer(snap),
  macro: macroLayer({ cpiRows: ctx.cpi_rows || [], nfpRows: ctx.nfp_rows || [], us2ySeries: ser(ctx.us2y_long), events: evts, snap, nowIso }),
  geopolitics: geoLayer(evts, nowIso),
  politics: politicalLayer(evts, nowIso),
};
desk.source_quality = sourceQuality(snap);
return [{
  json: {
    persist: {
      observations, gold, desk, snapshot: snap, health,
      fetch_state: fetchState,
      job: 'MARKET', started_at: $('Load Market Context').first().json.started_at || nowIso, status: health.some((h) => h.status === 'DEGRADED') ? 'DEGRADED' : 'OK',
      execution_id: $execution.id,
      stats: { observations: observations.length, gold: gold.length, data_quality: snap.data_quality, regime: desk.regime, regime_changed: regimeChanged },
    },
    regime_changed: regimeChanged,
    previous_regime: prev ? prev.regime : null,
  },
}];
