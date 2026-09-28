'use strict';
// POST-EVENT REVIEW: capture actual (BLS API / FOMC statement), measure the real gold / USD /
// yield reaction, store it (origin LIVE), score the stored forecast (direction, scenario,
// market confirmation, timing, error) — never auto-adjusting weights.
const { loadConfig } = require('../../lib/config');
const { makeHttp } = require('../../lib/http');
const { SOURCES } = require('../../lib/pricefeeds');
const { buildReactionRow } = require('../../lib/reactions');
const { reactionMetrics } = require('../../lib/history');
const { parseBlsApi, blsActual, surprise, parseFomcStatement, EVENT_TYPES } = require('../../lib/calendar');
const { evaluateForecast } = require('../../lib/evaluation');
const { scoreForecast } = require('../../lib/forecast');
const { formatEventReview } = require('../../lib/telegram');
const { parseCalendarNumber, round } = require('../../lib/util');

const cfg = loadConfig($env);
const ctx = $input.first().json;
const http = makeHttp(this.helpers, { userAgent: cfg.http.userAgent, timeoutMs: 60000 });
const now = Date.now();
const ser = (a) => (a || []).map((p) => ({ t: p.t, v: Number(p.v) })).filter((p) => Number.isFinite(p.v));
const daily = { US2Y: ser(ctx.us2y), US10Y: ser(ctx.us10y), US10Y_REAL: ser(ctx.us10y_real), USD: ser(ctx.usd_daily), GOLD: ser(ctx.gold_daily), WTI: ser(ctx.wti) };
const due = ctx.due || [];
const NEXT = { '4H': 'REVIEWED_4H', '24H': 'REVIEWED_24H', '3D': 'REVIEWED_3D' };
const HORIZONS = { '4H': ['1H', '4H'], '24H': ['24H'], '3D': ['3D'] };
const notes = [];

// BLS actuals (one keyless v1 request for all due BLS releases).
let bls = {};
const blsTypes = { CPI: ['CUSR0000SA0', 'CUSR0000SA0L1E'], NFP: ['CES0000000001', 'LNS14000000'], PPI: ['WPSFD4'], JOLTS: ['JTS000000000000000JOL'] };
const needed = [...new Set(due.filter((r) => blsTypes[r.event_type] && (r.stage === '4H' || !r.actual)).flatMap((r) => blsTypes[r.event_type]))];
if (needed.length) {
  const y = new Date().getUTCFullYear();
  try {
    const r = await http({ url: 'https://api.bls.gov/publicAPI/v1/timeseries/data/', method: 'POST', body: { seriesid: needed, startyear: String(y - 1), endyear: String(y) } });
    if (r.statusCode === 200 && r.body && r.body.status === 'REQUEST_SUCCEEDED') bls = parseBlsApi(r.body);
    else notes.push(`BLS API unavailable (HTTP ${r.statusCode}); actual left empty`);
  } catch (e) { notes.push(`BLS API error: ${e.message}`); }
}

async function prices(stage, t) {
  // Dukascopy day files exist only after the UTC day closes; Binance proxies are real-time.
  const order = stage === '4H' && now - t < 20 * 3600000 ? ['binance'] : ['dukascopy', 'binance'];
  for (const name of order) {
    const src = SOURCES[name];
    try {
      const goldMin = await src.gold.fetch(http, t - 20 * 60000, t + 245 * 60000);
      if (!goldMin.length) throw new Error('no gold candles');
      const goldHour = await src.gold.fetchHours(http, t - 3600000, Math.min(now, t + 4 * 86400000));
      const usdMin = await src.usd.fetch(http, t - 20 * 60000, t + 245 * 60000);
      return { name, src, goldMin, goldHour, usdMin };
    } catch (e) {
      notes.push(`${name} prices unavailable for ${new Date(t).toISOString()}: ${e.message}`);
    }
  }
  return null;
}

const reactions = [];
const releaseUpdates = [];
const evaluations = [];
const messages = [];
for (const r of due) {
  const t = Date.parse(r.scheduled_at);
  const label = (EVENT_TYPES[r.event_type] || {}).label || r.event_type;
  const p = await prices(r.stage, t);
  let actualText = r.actual || null;
  let actualNum = r.actual_num !== null && r.actual_num !== undefined ? Number(r.actual_num) : null;
  let surp = r.surprise !== null && r.surprise !== undefined ? Number(r.surprise) : null;
  if (r.stage === '4H' || !actualText) {
    if (blsTypes[r.event_type] && Object.keys(bls).length) {
      const a = blsActual(r.event_type, bls);
      if (a) {
        actualNum = a.fields[a.primary].value;
        actualText = `${actualNum}${r.event_type === 'NFP' ? 'K' : r.event_type === 'JOLTS' ? 'K openings' : '%'} (${a.fields[a.primary].period}, BLS API)`;
        surp = surprise(r.event_type, actualNum, r.consensus);
      }
    } else if (r.event_type === 'FOMC') {
      const d = new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replace(/-/g, '');
      try {
        const s = await http({ url: `https://www.federalreserve.gov/newsevents/pressreleases/monetary${d}a.htm`, headers: { Accept: 'text/html' } });
        const dec = s.statusCode === 200 ? parseFomcStatement(String(s.body)) : null;
        if (dec) {
          actualNum = dec.target_high;
          actualText = `${dec.decision} — target ${dec.target_low}-${dec.target_high}%${dec.dissents ? `, ${dec.dissents} dissent(s)` : ''} (Fed statement)`;
          const c = parseCalendarNumber(r.consensus);
          surp = c === null ? null : round(dec.target_high - c, 2);
        } else notes.push(`FOMC statement ${d} not parsed (HTTP ${s.statusCode})`);
      } catch (e) { notes.push(`FOMC statement fetch failed: ${e.message}`); }
    } else if (!actualText) {
      notes.push(`${r.event_type} actual NOT AVAILABLE from free sources (BEA API requires a key)`);
    }
  }
  if (!p) {
    releaseUpdates.push({ id: r.id, status: r.status, actual: actualText, actual_num: actualNum, surprise: surp, reviewed: false });
    continue;
  }
  const { row } = buildReactionRow({
    eventType: r.event_type, eventMs: t, goldMin: p.goldMin, goldHour: p.goldHour, usdMin: p.usdMin, usdInvert: Boolean(p.src.usd.invert),
    oilMin: null, daily, sources: { gold: p.src.gold.label, usd: p.src.usd.label, oil: null },
    consensus: r.consensus_num === null || r.consensus_num === undefined ? null : Number(r.consensus_num),
    actual: actualNum, previous: r.previous_num === null || r.previous_num === undefined ? null : Number(r.previous_num),
    surprise: surp, releaseSource: r.source, origin: 'LIVE', actualVintage: actualText ? 'FIRST_PRINT (captured at release)' : null,
    eventNotes: `${r.title} — live post-event review`,
  });
  const metrics = reactionMetrics(row);
  reactions.push(row);
  const fc = (ctx.forecasts || []).find((f) => Number(f.macro_release_id) === Number(r.id)) || null;
  const releaseInfo = { consensus: r.consensus, actual: actualText, surprise: surp, event_type: r.event_type };
  const score = fc ? scoreForecast(fc, metrics, releaseInfo) : null;
  const evs = fc ? evaluateForecast({ ...fc, bias_score: (fc.pre_event_score || 0) / 100, pre_event_bias: fc.forecast_state }, metrics, releaseInfo, HORIZONS[r.stage]) : [];
  const bp = (a, b) => (a === null || a === undefined || b === null || b === undefined ? null : round((Number(b) - Number(a)) * 100, 0));
  const y2 = bp(row['2y_before'], row['2y_after']);
  const y10 = bp(row['10y_before'], row['10y_after']);
  const real = bp(row.real10y_before, row.real10y_after);
  for (const e of evs) {
    evaluations.push({
      ...e, macro_release_id: r.id, forecast_state: fc.forecast_state, pre_event_score: fc.pre_event_score, confidence: fc.confidence,
      ...(e.horizon === '4H' && score ? {
        forecast_direction_correct: score.forecast_direction_correct, realized_scenario: score.realized_scenario, scenario_correct: score.scenario_correct,
        market_confirmation_correct: score.market_confirmation_correct, timing_quality: score.timing_quality, forecast_error: score.forecast_error,
        forecast_result: score.forecast_result, lesson: score.lesson, reason_for_error: e.reason_for_error || (score.forecast_result === 'CORRECT' ? null : score.why),
      } : {}),
      reactions: { gold: metrics, usd_move_pct: metrics.usd_move_pct, us2y_bp: y2, us10y_bp: y10, real10y_bp: real, regime: row.regime, market_confirmation: row.market_confirmation },
    });
  }
  releaseUpdates.push({ id: r.id, status: ctx.mode === 'MANUAL' ? r.status : NEXT[r.stage], actual: actualText, actual_num: actualNum, surprise: surp, reviewed: true, forecast_evaluated: r.stage === '3D' && Boolean(fc) });
  const ageH = (now - t) / 3600000;
  if (r.stage === '4H' && (ageH <= 12 || ctx.mode === 'MANUAL')) {
    messages.push({
      text: formatEventReview({
        label, scheduled_at: r.scheduled_at, manual: ctx.mode === 'MANUAL', forecast: fc, actual: actualText, consensus: r.consensus, surprise: surp,
        metrics, score, y2_bp: y2, y10_bp: y10, real_bp: real, oil_text: 'NOT AVAILABLE (no free intraday oil source configured)',
        dataQuality: (() => {
          const goldProxy = /paxg/i.test(p.src.gold.label);
          let level = row.data_quality === 'OK' ? 'GOOD' : row.data_quality === 'PARTIAL' ? 'PARTIAL' : 'DEGRADED';
          // A reaction measured on a proxy (direct spot unavailable) is never GOOD.
          if (goldProxy && level === 'GOOD') level = 'PARTIAL';
          return {
            level,
            gold_source: goldProxy ? `PROXY (${p.src.gold.label})` : `DIRECT (${p.src.gold.label})`,
            usd_source: `PROXY (${p.src.usd.label})`,
            reasons: [...(goldProxy ? ['gold reaction measured on a proxy (direct spot unavailable)'] : []), ...notes.slice(0, 2)],
          };
        })(),
      }, cfg.timezone),
      message_type: 'EVENT_REVIEW', dedup_key: `review:${r.release_key}:${ctx.mode}`, dedup_window_min: ctx.mode === 'MANUAL' ? 10 : 1440,
      related_ref: `release:${r.id}`, is_test: ctx.mode === 'MANUAL',
    });
  }
}
return [{ json: { payload: { messages }, record: { reactions, release_updates: releaseUpdates, evaluations, notes, job: `POST_EVENT_${ctx.mode}`, started_at: ctx.started_at, execution_id: $execution.id, status: notes.length ? 'DEGRADED' : 'OK', stats: { due: due.length, reviewed: reactions.length, evaluations: evaluations.length, notes } } } }];
