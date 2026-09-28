'use strict';
/**
 * Intraday historical price feeds for reaction measurement.
 *  - Dukascopy public datafeed (preferred): true spot XAUUSD and the USD index CFD,
 *    1-minute candles per UTC day, LZMA-compressed .bi5 (month index is zero-based).
 *  - Binance public klines (fallback): PAXGUSDT (tokenised London gold; tracks spot
 *    within a small basis) and EURUSDT (inverted as a USD proxy).
 * Every series is labelled with its source so reactions are never mis-attributed.
 */
const { decompress } = require('./lzma');

const DUKA_BASE = 'https://datafeed.dukascopy.com/datafeed';
const DUKA_SCALE = { XAUUSD: 1000, DOLLARIDXUSD: 1000, LIGHTCMDUSD: 1000, EURUSD: 100000 };
const BINANCE_BASE = 'https://api.binance.com/api/v3/klines';

function dayStartUtc(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function dukascopyDayUrl(symbol, dayMs) {
  const d = new Date(dayMs);
  const mm = String(d.getUTCMonth()).padStart(2, '0'); // zero-based month
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${DUKA_BASE}/${symbol}/${d.getUTCFullYear()}/${mm}/${dd}/BID_candles_min_1.bi5`;
}

function dukascopyMonthHourUrl(symbol, monthMs) {
  const d = new Date(monthMs);
  const mm = String(d.getUTCMonth()).padStart(2, '0'); // zero-based month
  return `${DUKA_BASE}/${symbol}/${d.getUTCFullYear()}/${mm}/BID_candles_hour_1.bi5`;
}

function monthStartUtc(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** 1-hour candles from monthly files (offsets are seconds from the month start). */
async function dukascopyHours(http, symbol, fromMs, toMs) {
  const out = [];
  let m = monthStartUtc(fromMs);
  while (m <= toMs) {
    const r = await http({ url: dukascopyMonthHourUrl(symbol, m), binary: true });
    if (r.statusCode === 429) throw Object.assign(new Error('dukascopy rate limited (429)'), { code: 'RATE_LIMITED' });
    if (r.statusCode === 200) {
      for (const c of parseDukascopyCandles(toBytes(r.body), m, symbol)) if (c.t >= fromMs && c.t <= toMs) out.push(c);
    } else if (r.statusCode !== 404) throw new Error(`dukascopy HTTP ${r.statusCode}`);
    const d = new Date(m);
    m = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return out;
}

/** Decodes a candle .bi5 file (minute: day-relative offsets; hour: month-relative) -> [{t, o, h, l, c}]. */
function parseDukascopyCandles(bytes, dayMs, symbol) {
  const scale = DUKA_SCALE[symbol] || 1000;
  if (!bytes || bytes.length === 0) return [];
  const raw = decompress(bytes);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out = [];
  for (let off = 0; off + 24 <= raw.length; off += 24) {
    const sec = dv.getUint32(off);
    const o = dv.getUint32(off + 4) / scale;
    const c = dv.getUint32(off + 8) / scale;
    const l = dv.getUint32(off + 12) / scale;
    const h = dv.getUint32(off + 16) / scale;
    const v = dv.getFloat32(off + 20);
    if (v > 0) out.push({ t: dayMs + sec * 1000, o, h, l, c });
  }
  return out;
}

function toBytes(body) {
  if (!body) return null;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body.type === 'Buffer' && Array.isArray(body.data)) return Uint8Array.from(body.data);
  if (typeof body === 'string') return Uint8Array.from(Buffer.from(body, 'binary'));
  return null;
}

/**
 * @param {Function} http async ({url, binary:true}) => {statusCode, body}
 */
async function dukascopyMinutes(http, symbol, fromMs, toMs) {
  const out = [];
  for (let day = dayStartUtc(fromMs); day <= toMs; day += 86400000) {
    const r = await http({ url: dukascopyDayUrl(symbol, day), binary: true });
    if (r.statusCode === 429) throw Object.assign(new Error('dukascopy rate limited (429)'), { code: 'RATE_LIMITED' });
    if (r.statusCode === 404) continue;
    if (r.statusCode !== 200) throw new Error(`dukascopy HTTP ${r.statusCode}`);
    for (const c of parseDukascopyCandles(toBytes(r.body), day, symbol)) if (c.t >= fromMs && c.t <= toMs) out.push(c);
  }
  return out;
}

async function binanceMinutes(http, symbol, fromMs, toMs, interval = '1m') {
  const out = [];
  let start = fromMs;
  const stepMs = { '1m': 60000, '5m': 300000, '1h': 3600000, '1d': 86400000 }[interval];
  for (let guard = 0; guard < 50 && start <= toMs; guard++) {
    const url = `${BINANCE_BASE}?symbol=${symbol}&interval=${interval}&startTime=${start}&endTime=${toMs}&limit=1000`;
    const r = await http({ url });
    if (r.statusCode === 429 || r.statusCode === 418) throw Object.assign(new Error(`binance rate limited (${r.statusCode})`), { code: 'RATE_LIMITED' });
    if (r.statusCode !== 200 || !Array.isArray(r.body)) throw new Error(`binance HTTP ${r.statusCode}`);
    if (!r.body.length) break;
    for (const k of r.body) out.push({ t: k[0], o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]) });
    const last = r.body[r.body.length - 1][0];
    if (r.body.length < 1000) break;
    start = last + stepMs;
  }
  return out;
}

const SOURCES = {
  dukascopy: {
    gold: { symbol: 'XAUUSD', label: 'Dukascopy XAUUSD spot (bid, 1m)', fetch: (http, a, b) => dukascopyMinutes(http, 'XAUUSD', a, b), fetchHours: (http, a, b) => dukascopyHours(http, 'XAUUSD', a, b) },
    usd: { symbol: 'DOLLARIDXUSD', label: 'Dukascopy USD index CFD (bid, 1m)', invert: false, fetch: (http, a, b) => dukascopyMinutes(http, 'DOLLARIDXUSD', a, b) },
    oil: { symbol: 'LIGHTCMDUSD', label: 'Dukascopy WTI CFD (bid, 1m)', fetch: (http, a, b) => dukascopyMinutes(http, 'LIGHTCMDUSD', a, b) },
  },
  binance: {
    gold: { symbol: 'PAXGUSDT', label: 'Binance PAXG/USDT (tokenised gold proxy, 1m)', fetch: (http, a, b) => binanceMinutes(http, 'PAXGUSDT', a, b), fetchHours: (http, a, b) => binanceMinutes(http, 'PAXGUSDT', a, b, '1h') },
    usd: { symbol: 'EURUSDT', label: 'Binance EUR/USDT inverted (USD proxy, 1m)', invert: true, fetch: (http, a, b) => binanceMinutes(http, 'EURUSDT', a, b) },
    oil: null,
  },
};

/** Close of the last candle at or before t (within maxLagMin minutes). */
function closeAt(candles, t, maxLagMin = 10) {
  let best = null;
  for (const c of candles) {
    if (c.t <= t) best = c;
    else break;
  }
  if (!best || (t - best.t) / 60000 > maxLagMin) return null;
  return best.c;
}

/** Open of the first candle at or after t (within maxLagMin) — the pre-release reference. */
function openAt(candles, t, maxLagMin = 5) {
  for (const c of candles) {
    if (c.t >= t) return (c.t - t) / 60000 <= maxLagMin ? c.o : null;
  }
  return null;
}

/** Daily closes (last traded hourly candle per UTC day) -> [{t, v}] stamped 23:59:59 UTC. */
// Daily closes stamped 23:59:59 UTC; with nowMs, the current (incomplete) day is dropped so no
// point is ever stamped in the future.
function dailyClosesFromHours(hours, nowMs) {
  const byDay = new Map();
  for (const c of hours) byDay.set(dayStartUtc(c.t), c.c);
  return Array.from(byDay.entries()).sort((a, b) => a[0] - b[0])
    .filter(([d]) => nowMs === undefined || d + 86399000 <= nowMs)
    .map(([d, v]) => ({ t: new Date(d + 86399000).toISOString(), v }));
}

module.exports = {
  dukascopyDayUrl, dukascopyMonthHourUrl, parseDukascopyCandles, dukascopyMinutes, dukascopyHours, binanceMinutes,
  SOURCES, closeAt, openAt, toBytes, dayStartUtc, dailyClosesFromHours,
};
