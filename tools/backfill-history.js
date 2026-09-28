'use strict';
/**
 * Historical reaction database backfill (real data only).
 *
 *   node tools/backfill-history.js [--from=2021-01-01] [--source=auto|dukascopy|binance] [--load]
 *
 * Outputs:
 *   seed/historical_event_reactions.sql  (+ .json for inspection)
 *   seed/market_history.sql              (daily yields, DXY proxy, gold daily proxy, CFTC COT)
 * With --load, applies both to the database from .env.
 *
 * Sources: BLS news-release archives (release dates + reference months), Fed FOMC calendar,
 * BEA release calendar (ICS), US Treasury yield curves, Frankfurter (ECB reference FX),
 * CFTC COT (Socrata), BLS public API v1 (actuals, current vintage), Dukascopy (preferred)
 * or Binance (fallback) 1-minute prices.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { ROOT } = require('./env');
const { releasesFromFomcPage, releasesFromIcs, parseBlsApi } = require('../src/lib/calendar');
const { parseTreasuryCsv, parseCftcCot, dxyFromPairs } = require('../src/lib/market');
const { usEasternToUtcIso } = require('../src/lib/feeds');
const { SOURCES, dayStartUtc } = require('../src/lib/pricefeeds');
const { buildReactionRow } = require('../src/lib/reactions');
const { round } = require('../src/lib/util');

const UA = 'GoldIntel-n8n/0.1 (automated macro research bot)';
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v === undefined ? true : v]));
const FROM = args.from || '2021-01-01';
const SOURCE_MODE = args.source || 'auto';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet({ url, binary, headers, method, body }) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request(url, { method: method || 'GET', headers: { 'user-agent': UA, accept: '*/*', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(headers || {}) } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(httpGet({ url: new URL(res.headers.location, url).toString(), binary, headers }));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let parsed = buf;
        if (!binary) {
          const text = buf.toString('utf8');
          try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
        }
        resolve({ statusCode: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

let lastCall = 0;
const HTTP_CACHE = path.join(ROOT, 'runtime', 'cache', 'http');
const CACHEABLE = /bls\.gov\/bls\/news-release|federalreserve\.gov\/monetarypolicy|bea\.gov\/news\/schedule|home\.treasury\.gov|api\.frankfurter|publicreporting\.cftc\.gov|api\.binance\.com/;

async function politeGet(opts, gapMs = 120) {
  // Official schedule pages / immutable history are cached for 12h so re-runs survive slow hosts.
  const key = !opts.method && !opts.binary && CACHEABLE.test(opts.url)
    ? path.join(HTTP_CACHE, require('crypto').createHash('sha1').update(opts.url).digest('hex')) : null;
  if (key && fs.existsSync(key) && Date.now() - fs.statSync(key).mtimeMs < 12 * 3600000) {
    const text = fs.readFileSync(key, 'utf8');
    let body = text;
    try { body = JSON.parse(text); } catch (_) { /* text */ }
    return { statusCode: 200, body, cached: true };
  }
  const wait = lastCall + gapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const r = await httpGet(opts);
      if (r.statusCode >= 500 || r.statusCode === 429) { await sleep(3000 * attempt); continue; }
      if (key && r.statusCode === 200) {
        fs.mkdirSync(HTTP_CACHE, { recursive: true });
        fs.writeFileSync(key, typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
      }
      return r;
    } catch (e) {
      if (attempt === 6) throw new Error(`${e.message} (${opts.url.slice(0, 90)})`);
      await sleep(3000 * attempt);
    }
  }
  throw new Error(`failed ${opts.url}`);
}

/**
 * Dukascopy fetch with on-disk cache (resumable runs) and 429 back-off.
 * Historical files are immutable, so a cached copy is authoritative.
 */
const CACHE_DIR = path.join(ROOT, 'runtime', 'cache', 'dukascopy');
async function dukaGet(opts) {
  const rel = opts.url.replace('https://datafeed.dukascopy.com/datafeed/', '');
  const file = path.join(CACHE_DIR, rel);
  if (fs.existsSync(file)) return { statusCode: 200, body: fs.readFileSync(file) };
  if (fs.existsSync(`${file}.404`)) return { statusCode: 404, body: Buffer.alloc(0) };
  for (let attempt = 1; attempt <= 6; attempt++) {
    const r = await politeGet({ url: opts.url, binary: true }, 1800);
    if (r.statusCode === 200) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, r.body);
      return r;
    }
    if (r.statusCode === 404) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.404`, '');
      return r;
    }
    if (r.statusCode === 429) {
      console.warn(`  dukascopy 429 on ${rel} — backing off ${60 * attempt}s`);
      await sleep(60000 * attempt);
      continue;
    }
    return r;
  }
  return { statusCode: 429, body: Buffer.alloc(0) };
}

const MONTHS = { january: '01', february: '02', march: '03', april: '04', may: '05', june: '06', july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };

async function blsArchive(series, type, hourEt, minuteEt) {
  const r = await politeGet({ url: `https://www.bls.gov/bls/news-release/${series}.htm` });
  if (r.statusCode !== 200) throw new Error(`BLS archive ${series} HTTP ${r.statusCode}`);
  const html = String(r.body);
  const re = new RegExp(`<a href="[^"]*archives/${series}_(\\d{2})(\\d{2})(\\d{4})\\.htm"[^>]*>([^<]*)</a>`, 'g');
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, mm, dd, yyyy, text] = m;
    const iso = usEasternToUtcIso(Number(yyyy), Number(mm), Number(dd), hourEt, minuteEt);
    if (seen.has(iso)) continue;
    seen.add(iso);
    const ref = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i.exec(text);
    out.push({ event_type: type, scheduled_at: iso, reference_period: ref ? `${ref[2]}-${MONTHS[ref[1].toLowerCase()]}` : null, release_source: `bls.gov news release archive (${series})`, title: text.trim() });
  }
  return out;
}

async function treasury(fromYear, toYear) {
  const out = [];
  for (let y = fromYear; y <= toYear; y++) {
    for (const [kind, type] of [['nominal', 'daily_treasury_yield_curve'], ['real', 'daily_treasury_real_yield_curve']]) {
      const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=${type}&field_tdr_date_value=${y}&page&_format=csv`;
      const r = await politeGet({ url }, 300);
      if (r.statusCode !== 200) throw new Error(`treasury ${y} ${kind} HTTP ${r.statusCode}`);
      out.push(...parseTreasuryCsv(String(r.body), kind));
    }
  }
  return out;
}

async function frankfurterDxy(fromIso, toIso) {
  const out = [];
  // Frankfurter returns ECB reference rates; query in yearly windows.
  const startYear = Number(fromIso.slice(0, 4));
  const endYear = Number(toIso.slice(0, 4));
  for (let y = startYear; y <= endYear; y++) {
    const a = y === startYear ? fromIso : `${y}-01-01`;
    const b = y === endYear ? toIso : `${y}-12-31`;
    const r = await politeGet({ url: `https://api.frankfurter.dev/v1/${a}..${b}?from=USD&to=EUR,JPY,GBP,CAD,SEK,CHF` }, 300);
    if (r.statusCode !== 200 || !r.body.rates) throw new Error(`frankfurter ${y} HTTP ${r.statusCode}`);
    for (const [date, rates] of Object.entries(r.body.rates)) {
      const pairs = { EURUSD: 1 / rates.EUR, USDJPY: rates.JPY, GBPUSD: 1 / rates.GBP, USDCAD: rates.CAD, USDSEK: rates.SEK, USDCHF: rates.CHF };
      const v = dxyFromPairs(pairs);
      if (v) out.push({ observed_at: `${date}T16:00:00.000Z`, instrument: 'USD_PROXY', value: round(v, 4), unit: 'index', source: 'frankfurter(ECB ref)/ICE-formula', resolution: 'daily', quality: 'OFFICIAL_REF', details: null });
    }
  }
  return out;
}

async function blsActuals() {
  const series = ['CUSR0000SA0', 'CES0000000001', 'WPSFD4', 'JTS000000000000000JOL'];
  const endYear = new Date().getUTCFullYear();
  const out = {};
  for (const [a, b] of [[endYear - 9, endYear]]) {
    const r = await politeGet({ url: 'https://api.bls.gov/publicAPI/v1/timeseries/data/', method: 'POST', body: { seriesid: series, startyear: String(a), endyear: String(b) } }, 500);
    if (r.statusCode !== 200 || !r.body || r.body.status !== 'REQUEST_SUCCEEDED') {
      console.warn(`BLS API unavailable (${r.statusCode} ${r.body && r.body.status}); actuals left NULL`);
      return {};
    }
    Object.assign(out, parseBlsApi(r.body));
  }
  return out;
}

function actualFor(type, refPeriod, bls) {
  const def = { CPI: ['CUSR0000SA0', 'mom'], NFP: ['CES0000000001', 'diff'], PPI: ['WPSFD4', 'mom'], JOLTS: ['JTS000000000000000JOL', 'level'] }[type];
  if (!def || !refPeriod || !bls[def[0]]) return { actual: null, previous: null };
  const pts = bls[def[0]];
  const i = pts.findIndex((p) => p.period === refPeriod);
  if (i < 1) return { actual: null, previous: null };
  const val = (k) => {
    if (k < 1) return null;
    if (def[1] === 'level') return pts[k].value;
    if (def[1] === 'diff') return round(pts[k].value - pts[k - 1].value, 0);
    return round((pts[k].value / pts[k - 1].value - 1) * 100, 1);
  };
  return { actual: val(i), previous: val(i - 1) };
}

async function pickSource() {
  if (SOURCE_MODE !== 'auto') return SOURCE_MODE;
  // Dukascopy throttles aggressively per IP: require three consecutive successes.
  const probes = ['2026/00/15/BID_candles_min_1.bi5', '2026/00/16/BID_candles_min_1.bi5', '2025/11/BID_candles_hour_1.bi5'];
  for (const p of probes) {
    const r = await politeGet({ url: `https://datafeed.dukascopy.com/datafeed/XAUUSD/${p}`, binary: true }, 3000);
    console.log(`dukascopy probe ${p}: HTTP ${r.statusCode}`);
    if (r.statusCode !== 200) return 'binance';
  }
  return 'dukascopy';
}

function sqlVal(v) {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function insertSql(table, cols, rows, conflict) {
  const out = [];
  for (let i = 0; i < rows.length; i += 200) {
    const part = rows.slice(i, i + 200);
    out.push(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES\n${part.map((r) => `(${cols.map((c) => sqlVal(r[c])).join(', ')})`).join(',\n')}\n${conflict};`);
  }
  return out.join('\n\n');
}

async function main() {
  const now = Date.now();
  const fromMs = Date.parse(`${FROM}T00:00:00Z`);
  console.log(`backfill from ${FROM}, source mode ${SOURCE_MODE}`);
  // 1. Event calendar (official). --events-from-db reuses release dates already verified from the
  //    official archives in a previous run (useful when the official sites are unreachable).
  const events = [];
  if (args['events-from-db']) {
    const { withClient } = require('./db');
    await withClient(async (c) => {
      const r = await c.query('SELECT event_type, event_date, data_source, event_notes FROM historical_event_reactions ORDER BY event_date');
      for (const x of r.rows) {
        events.push({
          event_type: x.event_type, scheduled_at: new Date(x.event_date).toISOString(),
          reference_period: (x.data_source && x.data_source.reference_period) || null,
          release_source: (x.data_source && x.data_source.release_source) || 'stored official release date',
          title: x.event_notes ? String(x.event_notes).split(' — ')[0] : x.event_type,
        });
      }
    });
    console.log(`reusing ${events.length} release dates from the database`);
  } else {
    events.push(...(await blsArchive('cpi', 'CPI', 8, 30)));
    events.push(...(await blsArchive('empsit', 'NFP', 8, 30)));
    events.push(...(await blsArchive('ppi', 'PPI', 8, 30)));
    events.push(...(await blsArchive('jolts', 'JOLTS', 10, 0)));
    const fomc = await politeGet({ url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm' });
    events.push(...releasesFromFomcPage(String(fomc.body)).map((r) => ({ event_type: 'FOMC', scheduled_at: r.scheduled_at, reference_period: null, release_source: r.source, title: r.title })));
    const bea = await politeGet({ url: 'https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics', headers: { 'user-agent': 'Mozilla/5.0 (compatible; GoldIntel-n8n/0.1)' } });
    events.push(...releasesFromIcs(String(bea.body), 'BEA').map((r) => ({ event_type: r.event_type, scheduled_at: r.scheduled_at, reference_period: null, release_source: r.source, title: r.details.official_title })));
  }
  const due = events.filter((e) => Date.parse(e.scheduled_at) >= fromMs && Date.parse(e.scheduled_at) <= now - 3600000)
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  console.log(`events: ${events.length} total, ${due.length} in range`);

  // 2. Daily context series.
  const fromYear = Number(FROM.slice(0, 4));
  const toYear = new Date(now).getUTCFullYear();
  let yields;
  let dxy;
  let cot;
  let bls;
  const storedActuals = new Map();
  if (args['context-from-db']) {
    // Reuse the official daily series and actuals already stored by a previous full run.
    const { withClient } = require('./db');
    await withClient(async (c) => {
      const q = async (sql) => (await c.query(sql)).rows;
      const obs = await q("SELECT observed_at, instrument, value, unit, source, resolution, quality, details FROM market_observations WHERE resolution IN ('daily','weekly') AND instrument IN ('US2Y','US10Y','US30Y','US10Y_REAL','USD_PROXY','GOLD_COT_NONCOMM_NET') ORDER BY observed_at");
      const map = (o) => ({ ...o, observed_at: new Date(o.observed_at).toISOString(), value: Number(o.value) });
      yields = obs.filter((o) => ['US2Y', 'US10Y', 'US30Y', 'US10Y_REAL'].includes(o.instrument)).map(map);
      dxy = obs.filter((o) => o.instrument === 'USD_PROXY').map(map);
      cot = obs.filter((o) => o.instrument === 'GOLD_COT_NONCOMM_NET').map(map);
      for (const r of await q('SELECT event_type, event_date, actual, previous FROM historical_event_reactions')) {
        storedActuals.set(`${r.event_type}|${new Date(r.event_date).toISOString()}`, { actual: r.actual === null ? null : Number(r.actual), previous: r.previous === null ? null : Number(r.previous) });
      }
    });
    bls = {};
    console.log(`context from database: ${yields.length} yield obs, ${dxy.length} USD proxy obs, ${cot.length} COT weeks, ${storedActuals.size} stored actuals`);
  } else {
    yields = await treasury(fromYear, toYear);
    console.log(`treasury observations: ${yields.length}`);
    dxy = await frankfurterDxy(`${fromYear - 1}-11-01`, new Date(now).toISOString().slice(0, 10));
    console.log(`USD proxy daily (ECB ref FX): ${dxy.length}`);
    const cotRes = await politeGet({ url: "https://publicreporting.cftc.gov/resource/6dca-aqww.json?$where=cftc_contract_market_code='088691'&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=320" });
    cot = parseCftcCot(Array.isArray(cotRes.body) ? cotRes.body : []);
    console.log(`CFTC COT weeks: ${cot.length}`);
    bls = await blsActuals();
  }

  const source = await pickSource();
  const src = SOURCES[source];
  console.log(`intraday source: ${source}`);
  const httpForFeeds = (o) => (source === 'dukascopy' ? dukaGet(o) : politeGet({ ...o, binary: Boolean(o.binary) }, 120));
  const pf = require('../src/lib/pricefeeds');
  const historyStart = Date.parse(`${fromYear - 1}-11-01T00:00:00Z`);
  let goldHoursAll = [];
  let goldDaily;
  let goldDailyLabel;
  if (source === 'dukascopy') {
    // Monthly hourly files: 24h/3d horizons and true-spot daily closes for trend context.
    goldHoursAll = await src.gold.fetchHours(httpForFeeds, historyStart, now);
    goldDaily = pf.dailyClosesFromHours(goldHoursAll, now);
    goldDailyLabel = 'dukascopy-xauusd-1h (daily close)';
  } else {
    goldDaily = (await pf.binanceMinutes(httpForFeeds, 'PAXGUSDT', historyStart, now, '1d'))
      .filter((c) => c.t + 86399000 <= now) // completed days only (no future-stamped partial candle)
      .map((c) => ({ t: new Date(c.t + 86399000).toISOString(), v: c.c }));
    goldDailyLabel = 'binance-paxgusdt-1d (gold proxy)';
  }
  console.log(`gold hourly candles: ${goldHoursAll.length}; daily closes (${goldDailyLabel}): ${goldDaily.length}`);

  const series = (instr) => yields.filter((o) => o.instrument === instr).map((o) => ({ t: o.observed_at, v: o.value })).sort((a, b) => a.t.localeCompare(b.t));
  const daily = {
    US2Y: series('US2Y'), US10Y: series('US10Y'), US10Y_REAL: series('US10Y_REAL'),
    USD: dxy.map((o) => ({ t: o.observed_at, v: o.value })).sort((a, b) => a.t.localeCompare(b.t)),
    GOLD: goldDaily,
  };

  // 3. Reactions.
  const rows = [];
  let n = 0;
  for (const ev of due) {
    n++;
    const t = Date.parse(ev.scheduled_at);
    try {
      const goldMin = await src.gold.fetch(httpForFeeds, t - 20 * 60000, t + 245 * 60000);
      const goldHour = source === 'dukascopy'
        ? goldHoursAll.filter((c) => c.t >= t - 3600000 && c.t <= t + 4 * 86400000)
        : await src.gold.fetchHours(httpForFeeds, t, t + 4 * 86400000);
      const usdMin = await src.usd.fetch(httpForFeeds, t - 20 * 60000, t + 245 * 60000);
      const oilMin = src.oil ? await src.oil.fetch(httpForFeeds, t - 20 * 60000, t + 65 * 60000) : null;
      const act = storedActuals.size
        ? (storedActuals.get(`${ev.event_type}|${new Date(t).toISOString()}`) || { actual: null, previous: null })
        : actualFor(ev.event_type, ev.reference_period, bls);
      const { row } = buildReactionRow({
        eventType: ev.event_type, eventMs: t, goldMin, goldHour, usdMin, usdInvert: Boolean(src.usd.invert), oilMin, daily,
        sources: { gold: src.gold.label, usd: src.usd.label, oil: src.oil ? src.oil.label : null },
        actual: act.actual, previous: act.previous, actualVintage: act.actual === null ? null : 'CURRENT_REVISED (BLS API v1; not first print)',
        referencePeriod: ev.reference_period, releaseSource: ev.release_source, origin: 'BACKFILL',
        eventNotes: `${ev.title || ev.event_type}${ev.reference_period ? ` (ref ${ev.reference_period})` : ''} — ${ev.release_source}`,
      });
      rows.push(row);
      if (n % 25 === 0) console.log(`  ${n}/${due.length} ${ev.event_type} ${ev.scheduled_at} dir=${row.gold_direction} q=${row.data_quality}`);
    } catch (e) {
      console.warn(`  skip ${ev.event_type} ${ev.scheduled_at}: ${e.message}`);
      if (e.code === 'RATE_LIMITED') { console.warn('  rate limited — backing off 60s'); await sleep(60000); }
    }
  }
  // Macro states as known at each event date (inflation / labour from BLS actuals, policy from 2Y repricing).
  const { annotateHistory } = require('../src/lib/forecast');
  const cpiRows = rows.filter((r) => r.event_type === 'CPI' && r.actual !== null).map((r) => ({ event_date: r.event_date, actual: r.actual }));
  const nfpRows = rows.filter((r) => r.event_type === 'NFP' && r.actual !== null).map((r) => ({ event_date: r.event_date, actual: r.actual }));
  const annotated = annotateHistory(rows, { cpiRows, nfpRows, us2ySeries: daily.US2Y });
  const usable = annotated.filter((r) => r.data_quality !== 'INSUFFICIENT');
  const summary = {};
  for (const r of usable) {
    const s = summary[r.event_type] || (summary[r.event_type] = { n: 0, BULLISH: 0, BEARISH: 0, MIXED: 0 });
    s.n++;
    s[r.gold_direction || 'MIXED']++;
  }
  console.log('usable reactions by type:', JSON.stringify(summary));
  console.log(`insufficient-data rows (kept out): ${rows.length - usable.length}`);

  // 4. Write seeds.
  fs.mkdirSync(path.join(ROOT, 'seed'), { recursive: true });
  const cols = ['event_type', 'event_date', 'consensus', 'actual', 'previous', 'revised_previous', 'surprise', 'surprise_basis', 'gold_before', 'gold_5m', 'gold_30m', 'gold_1h', 'gold_4h', 'gold_24h', 'gold_3d', 'usd_before', 'usd_after', 'usd_instrument', '2y_before', '2y_after', '10y_before', '10y_after', 'oil_before', 'oil_after', 'regime', 'gold_direction', 'reaction_strength', 'usd_reaction_direction', 'pre_gold_trend', 'pre_usd_trend', 'pre_10y_trend', 'data_source', 'data_quality', 'origin',
    'event_time', 'surprise_normalized', 'surprise_normalized_basis', 'gold_15m', 'usd_5m', 'usd_30m', 'usd_1h', 'usd_4h', '2y_1h', '10y_1h',
    'real10y_before', 'real10y_after', 'macro_regime', 'inflation_state', 'labor_state', 'policy_state', 'geopolitical_state', 'market_confirmation', 'event_notes'];
  const header = `-- Generated by tools/backfill-history.js on ${new Date().toISOString()} (source: ${source}). Real data only.\n`;
  const conflict = `ON CONFLICT (event_type, event_date) DO UPDATE SET ${cols.filter((c) => !['event_type', 'event_date'].includes(c)).map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ')}`;
  fs.writeFileSync(path.join(ROOT, 'seed', 'historical_event_reactions.sql'), `${header}${insertSql('historical_event_reactions', cols, usable, conflict)}\n`);
  fs.writeFileSync(path.join(ROOT, 'seed', 'historical_event_reactions.json'), JSON.stringify(usable, null, 1));
  const mo = [...yields, ...dxy, ...cot];
  const moCols = ['observed_at', 'instrument', 'value', 'unit', 'source', 'resolution', 'quality', 'details'];
  const goldObs = goldDaily.map((g) => ({ observed_at: g.t, price: round(g.v, 3), source: goldDailyLabel, quality: source === 'dukascopy' ? 'OK' : 'PROXY' }));
  fs.writeFileSync(path.join(ROOT, 'seed', 'market_history.sql'), `${header}${insertSql('market_observations', moCols, mo, 'ON CONFLICT (instrument, source, observed_at) DO NOTHING')}\n\n${goldObs.length ? insertSql('gold_observations', ['observed_at', 'price', 'source', 'quality'], goldObs, 'ON CONFLICT (source, observed_at) DO NOTHING') : ''}\n`);
  console.log(`wrote seed/historical_event_reactions.sql (${usable.length} rows) and seed/market_history.sql (${mo.length} market + ${goldObs.length} gold rows)`);

  if (args.load) {
    const { withClient } = require('./db');
    await withClient(async (c) => {
      await c.query(fs.readFileSync(path.join(ROOT, 'seed', 'market_history.sql'), 'utf8'));
      await c.query(fs.readFileSync(path.join(ROOT, 'seed', 'historical_event_reactions.sql'), 'utf8'));
      const r = await c.query('SELECT event_type, count(*)::int n FROM historical_event_reactions GROUP BY 1 ORDER BY 1');
      console.log('loaded:', JSON.stringify(r.rows));
    });
  }
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
