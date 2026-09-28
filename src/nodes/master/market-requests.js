'use strict';
// MARKET CONTEXT: which market sources are due this tick (keyless endpoints only;
// FRED needs a key and is fetched inside the parser so the key never enters item data).
const { loadConfig } = require('../../lib/config');

const cfg = loadConfig($env);
const ctx = $input.first().json;
const fetched = (ctx.fetch_state && ctx.fetch_state.value) || {};
const now = Date.now();
const ageMin = (k) => (fetched[k] ? (now - new Date(fetched[k]).getTime()) / 60000 : Infinity);
const year = new Date().getUTCFullYear();
const ua = cfg.http.userAgent;
const reqs = [
  { kind: 'gold', url: 'https://api.gold-api.com/price/XAU', accept: 'application/json' },
  { kind: 'fx', url: 'https://api.coinbase.com/v2/exchange-rates?currency=USD', accept: 'application/json' },
];
if (ageMin('treasury') >= 180) {
  const years = new Date().getUTCMonth() === 0 && new Date().getUTCDate() <= 10 ? [year - 1, year] : [year];
  for (const y of years) {
    reqs.push({ kind: 'treasury_nominal', url: `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${y}&page&_format=csv`, accept: 'text/csv' });
    reqs.push({ kind: 'treasury_real', url: `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=daily_treasury_real_yield_curve&field_tdr_date_value=${y}&page&_format=csv`, accept: 'text/csv' });
  }
}
if (ageMin('cot') >= 720) {
  reqs.push({ kind: 'cot', url: "https://publicreporting.cftc.gov/resource/6dca-aqww.json?$where=cftc_contract_market_code='088691'&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=8", accept: 'application/json' });
}
return reqs.map((r) => ({ json: { ...r, user_agent: ua } }));
