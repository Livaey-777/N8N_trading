'use strict';
/**
 * Scheduled-event calendar: official release schedules (BLS ICS, BEA ICS, Fed FOMC
 * calendar page) merged with the ForexFactory weekly export for consensus/previous.
 * Also parses FOMC decisions from statement text and BLS actuals (public API v1).
 */
const { parseIcs, usEasternToUtcIso } = require('./feeds');
const { parseCalendarNumber, round } = require('./util');

const HIGH = 'HIGH';
const MEDIUM = 'MEDIUM';

const EVENT_TYPES = {
  CPI: { label: 'US CPI', impact: HIGH, unit: '% m/m' },
  NFP: { label: 'US Nonfarm Payrolls', impact: HIGH, unit: 'K jobs' },
  PCE: { label: 'US PCE / Personal Income & Outlays', impact: HIGH, unit: '% m/m (core)' },
  PPI: { label: 'US PPI', impact: MEDIUM, unit: '% m/m' },
  GDP: { label: 'US GDP', impact: HIGH, unit: '% q/q annualised' },
  FOMC: { label: 'FOMC Rate Decision', impact: HIGH, unit: '% (upper bound)' },
  JOLTS: { label: 'US JOLTS Job Openings', impact: MEDIUM, unit: 'M openings' },
  RETAIL_SALES: { label: 'US Retail Sales', impact: MEDIUM, unit: '% m/m' },
  ISM_MANUFACTURING: { label: 'ISM Manufacturing PMI', impact: MEDIUM, unit: 'index' },
  ISM_SERVICES: { label: 'ISM Services PMI', impact: MEDIUM, unit: 'index' },
  JOBLESS_CLAIMS: { label: 'US Initial Jobless Claims', impact: MEDIUM, unit: 'K claims' },
  FED_CHAIR_SPEECH: { label: 'Fed Chair Speech', impact: HIGH, unit: null },
  ECB: { label: 'ECB Rate Decision', impact: MEDIUM, unit: '%' },
  BOE: { label: 'BoE Rate Decision', impact: MEDIUM, unit: '%' },
  BOJ: { label: 'BoJ Rate Decision', impact: MEDIUM, unit: '%' },
  GEOPOLITICAL_DEADLINE: { label: 'Geopolitical / fiscal deadline', impact: HIGH, unit: null },
};

function releaseKey(type, iso) {
  return `${type}:${iso.slice(0, 16)}Z`;
}

function mapBls(summary) {
  const s = summary.toLowerCase();
  if (s === 'consumer price index') return 'CPI';
  if (s === 'employment situation') return 'NFP';
  if (s === 'producer price index') return 'PPI';
  if (s === 'job openings and labor turnover survey') return 'JOLTS';
  return null;
}

function mapBea(summary) {
  const s = summary.toLowerCase();
  if (/^personal income and outlays/.test(s)) return 'PCE';
  if (/^(?:gdp|gross domestic product)/.test(s)) return 'GDP';
  return null;
}

/** BLS/BEA iCalendar -> releases (official schedule, exact timestamps). */
function releasesFromIcs(text, agency) {
  const out = [];
  for (const ev of parseIcs(text)) {
    const type = agency === 'BLS' ? mapBls(ev.summary) : mapBea(ev.summary);
    if (!type) continue;
    const t = EVENT_TYPES[type];
    out.push({
      release_key: releaseKey(type, ev.start), event_type: type, country: 'US', title: `${t.label} — ${ev.summary}`,
      scheduled_at: ev.start, impact: type === 'GDP' && !/advance/i.test(ev.summary) ? MEDIUM : t.impact,
      source: agency === 'BLS' ? 'bls.gov schedule (ICS)' : 'bea.gov schedule (ICS)', details: { official_title: ev.summary },
    });
  }
  return out;
}

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** federalreserve.gov/monetarypolicy/fomccalendars.htm -> FOMC decision times (2:00pm ET, last meeting day). */
function releasesFromFomcPage(html) {
  const out = [];
  const panels = String(html || '').split(/(\d{4}) FOMC Meetings<\/a>/);
  for (let i = 1; i < panels.length; i += 2) {
    const year = Number(panels[i]);
    const body = panels[i + 1] || '';
    const re = /fomc-meeting__month[^>]*><strong>([^<]+)<\/strong><\/div>\s*<div class="fomc-meeting__date[^"]*">([^<]+)<\/div>/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      const monthText = m[1].trim().toLowerCase();
      const dateText = m[2].trim();
      if (/notation|unscheduled|conference call/i.test(dateText)) continue;
      const days = /(\d{1,2})(?:\s*-\s*(\d{1,2}))?/.exec(dateText);
      if (!days) continue;
      const monthParts = monthText.split('/');
      const lastDay = Number(days[2] || days[1]);
      const startDay = Number(days[1]);
      let month = MONTHS[monthParts[monthParts.length - 1]] || MONTHS[monthParts[0]];
      if (monthParts.length === 1) month = MONTHS[monthParts[0]];
      else if (lastDay >= startDay) month = MONTHS[monthParts[0]];
      if (!month) continue;
      const iso = usEasternToUtcIso(year, month, lastDay, 14, 0);
      out.push({
        release_key: releaseKey('FOMC', iso), event_type: 'FOMC', country: 'US', title: `FOMC Rate Decision (${m[1].trim()} ${dateText.replace('*', '')} ${year})`,
        scheduled_at: iso, impact: HIGH, source: 'federalreserve.gov FOMC calendar',
        details: { sep_meeting: dateText.includes('*'), meeting_dates: dateText.replace('*', '') },
      });
    }
  }
  return out;
}

// ForexFactory weekly export -------------------------------------------------
const FF_MAP = [
  [/^CPI m\/m$/i, 'CPI', 'headline_mm', true],
  [/^Core CPI m\/m$/i, 'CPI', 'core_mm', false],
  [/^CPI y\/y$/i, 'CPI', 'headline_yy', false],
  [/^Non-Farm Employment Change$/i, 'NFP', 'payrolls_k', true],
  [/^Unemployment Rate$/i, 'NFP', 'unemployment_rate', false],
  [/^Average Hourly Earnings m\/m$/i, 'NFP', 'ahe_mm', false],
  [/^Core PCE Price Index m\/m$/i, 'PCE', 'core_pce_mm', true],
  [/^PPI m\/m$/i, 'PPI', 'headline_mm', true],
  [/^Core PPI m\/m$/i, 'PPI', 'core_mm', false],
  [/^(?:Advance|Prelim|Final) GDP q\/q$/i, 'GDP', 'gdp_qq', true],
  [/^Federal Funds Rate$/i, 'FOMC', 'fed_funds_upper', true],
  [/^Retail Sales m\/m$/i, 'RETAIL_SALES', 'headline_mm', true],
  [/^Core Retail Sales m\/m$/i, 'RETAIL_SALES', 'core_mm', false],
  [/^ISM Manufacturing PMI$/i, 'ISM_MANUFACTURING', 'index', true],
  [/^ISM Services PMI$/i, 'ISM_SERVICES', 'index', true],
  [/^Unemployment Claims$/i, 'JOBLESS_CLAIMS', 'claims_k', true],
  [/^JOLTS Job Openings$/i, 'JOLTS', 'openings_m', true],
  [/^Fed Chair .* Speaks$/i, 'FED_CHAIR_SPEECH', null, true],
  [/^Main Refinancing Rate$/i, 'ECB', 'mro', true],
  [/^Official Bank Rate$/i, 'BOE', 'bank_rate', true],
  [/^BOJ Policy Rate$/i, 'BOJ', 'policy_rate', true],
];
const FF_COUNTRY = { USD: 'US', EUR: 'EA', GBP: 'UK', JPY: 'JP' };

function ffEntries(json) {
  const out = [];
  for (const x of Array.isArray(json) ? json : []) {
    const country = FF_COUNTRY[x.country];
    if (!country) continue;
    const hit = FF_MAP.find(([re]) => re.test(String(x.title || '').trim()));
    if (!hit) continue;
    const [, type, field, primary] = hit;
    if (['ECB', 'BOE', 'BOJ'].includes(type) !== (country !== 'US')) continue;
    const d = new Date(x.date);
    if (Number.isNaN(d.getTime())) continue;
    out.push({ type, field, primary, scheduled_at: d.toISOString(), title: x.title, country, impact: x.impact, forecast: x.forecast || null, previous: x.previous || null });
  }
  return out;
}

/**
 * Merge official schedules and FF consensus. Official timestamps win; FF supplies
 * consensus/previous and adds events with no official feed here (ISM, retail, claims, ECB/BoE/BoJ, speeches).
 */
function mergeCalendar(official, ffJson) {
  const byKey = new Map();
  for (const r of official) byKey.set(r.release_key, { ...r, consensus: null, previous: null, details: { ...(r.details || {}), consensus_fields: {} } });
  const findOfficial = (type, iso) => {
    const t = new Date(iso).getTime();
    for (const r of byKey.values()) {
      if (r.event_type === type && Math.abs(new Date(r.scheduled_at).getTime() - t) <= 20 * 60000) return r;
    }
    return null;
  };
  for (const e of ffEntries(ffJson)) {
    let r = findOfficial(e.type, e.scheduled_at);
    if (!r) {
      if (!e.primary) continue;
      const t = EVENT_TYPES[e.type];
      r = {
        release_key: releaseKey(e.type, e.scheduled_at), event_type: e.type, country: e.country,
        title: `${t.label}${e.type === 'FED_CHAIR_SPEECH' ? ` — ${e.title}` : ''}`, scheduled_at: e.scheduled_at,
        impact: e.impact === 'High' ? HIGH : t.impact, source: 'forexfactory weekly export', consensus: null, previous: null,
        details: { consensus_fields: {} },
      };
      byKey.set(r.release_key, r);
    }
    if (e.field) r.details.consensus_fields[e.field] = { forecast: e.forecast, previous: e.previous, ff_title: e.title };
    if (e.primary) {
      r.consensus = e.forecast;
      r.previous = e.previous;
      r.consensus_source = 'forexfactory weekly export';
      r.details.primary_field = e.field;
    }
  }
  return Array.from(byKey.values()).map((r) => ({
    ...r,
    consensus_num: parseCalendarNumber(r.consensus),
    previous_num: parseCalendarNumber(r.previous),
  }));
}

/** Extracts the policy decision from an FOMC statement (HTML or text). */
function parseFomcStatement(html) {
  const text = String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const m = /decided to (raise|lower|maintain|reduce|increase)(?: the target range for the federal funds rate)?(?: by ([\d/\s-]+|one-quarter|one-half|three-quarters|\d+(?:\.\d+)?) (?:percentage )?points?)?(?: the target range for the federal funds rate)? (?:to|at) ([\d\s/.-]+?) to ([\d\s/.-]+?) percent/i.exec(text);
  if (!m) return null;
  const frac = (s) => {
    const t = s.trim();
    const parts = /^(\d+)?\s*(?:-?\s*(\d)\/(\d))?$/.exec(t);
    if (parts && (parts[1] || parts[2])) return Number(parts[1] || 0) + (parts[2] ? Number(parts[2]) / Number(parts[3]) : 0);
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };
  const verb = m[1].toLowerCase();
  const decision = /raise|increase/.test(verb) ? 'HIKE' : /lower|reduce/.test(verb) ? 'CUT' : 'HOLD';
  const low = frac(m[3]);
  const high = frac(m[4]);
  const dissent = /Voting against (?:this|the) action (?:were|was):? ([^.]+)\./i.exec(text);
  const dissents = dissent ? dissent[1].split(/,| and /).map((s) => s.trim()).filter((s) => s && s.length > 2).length : 0;
  return { decision, target_low: low, target_high: high, dissents, sentence: m[0].slice(0, 240) };
}

// BLS public API v1 (keyless; 25 queries/day) --------------------------------
const BLS_SERIES = {
  CPI: [{ id: 'CUSR0000SA0', field: 'headline_mm', kind: 'mom_pct' }, { id: 'CUSR0000SA0L1E', field: 'core_mm', kind: 'mom_pct' }],
  NFP: [{ id: 'CES0000000001', field: 'payrolls_k', kind: 'diff' }, { id: 'LNS14000000', field: 'unemployment_rate', kind: 'level' }],
  PPI: [{ id: 'WPSFD4', field: 'headline_mm', kind: 'mom_pct' }],
  JOLTS: [{ id: 'JTS000000000000000JOL', field: 'openings_k', kind: 'level' }],
};

/** Parses BLS API v1 response -> {seriesId: [{period:'2026-08', value}]} ascending. */
function parseBlsApi(json) {
  const out = {};
  for (const s of (json && json.Results && json.Results.series) || []) {
    const pts = (s.data || []).filter((d) => /^M(0[1-9]|1[0-2])$/.test(d.period))
      .map((d) => ({ period: `${d.year}-${d.period.slice(1)}`, value: Number(d.value) }))
      .filter((d) => Number.isFinite(d.value))
      .sort((a, b) => a.period.localeCompare(b.period));
    out[s.seriesID] = pts;
  }
  return out;
}

/** Latest print for a release type from BLS series, in the same units as the FF consensus. */
function blsActual(type, seriesData, referencePeriod) {
  const defs = BLS_SERIES[type];
  if (!defs) return null;
  const fields = {};
  for (const d of defs) {
    const pts = seriesData[d.id] || [];
    const idx = referencePeriod ? pts.findIndex((p) => p.period === referencePeriod) : pts.length - 1;
    if (idx < 0) continue;
    const cur = pts[idx];
    const prev = pts[idx - 1];
    let v = null;
    if (d.kind === 'level') v = cur.value;
    else if (!prev) continue;
    else if (d.kind === 'diff') v = round(cur.value - prev.value, 0);
    else v = round(((cur.value / prev.value) - 1) * 100, 1);
    fields[d.field] = { value: v, period: cur.period, series: d.id };
  }
  const primary = defs[0].field;
  return Object.keys(fields).length ? { primary, fields } : null;
}

/** Surprise in consensus units (NFP consensus like "119K" is compared in thousands). */
function surprise(type, actualPrimary, consensusText) {
  const c = parseCalendarNumber(consensusText);
  if (actualPrimary === null || actualPrimary === undefined || c === null) return null;
  if (type === 'NFP') return round(actualPrimary - c / 1000, 1);
  return round(actualPrimary - c, 2);
}

const AGENCY_OF = { CPI: 'BLS', NFP: 'BLS', PPI: 'BLS', JOLTS: 'BLS', PCE: 'BEA', GDP: 'BEA', FOMC: 'FED' };

/**
 * Detects cancelled / rescheduled official releases: an upcoming SCHEDULED release that no longer
 * appears in a successfully synced official calendar is RESCHEDULED (if a new same-type slot exists
 * within ±12 days that is not yet stored) or CANCELLED. Agencies whose calendar failed to sync are
 * never reconciled (source failure must not cancel events).
 * @param {Array} existing  stored releases {id, release_key, event_type, scheduled_at, source, pre_event_sent_at}
 * @param {Array} fresh     releases parsed from the official calendars this run
 * @param {Set<string>} syncedAgencies e.g. new Set(['BLS','BEA','FED'])
 * @param {string} nowIso
 */
function reconcileCalendar(existing, fresh, syncedAgencies, nowIso) {
  const now = Date.parse(nowIso);
  const freshKeys = new Set(fresh.map((r) => r.release_key));
  const existingKeys = new Set(existing.map((r) => r.release_key));
  const updates = [];
  const notices = [];
  for (const r of existing) {
    const agency = AGENCY_OF[r.event_type];
    if (!agency || !syncedAgencies.has(agency)) continue;
    if (!/bls\.gov|bea\.gov|federalreserve\.gov/.test(r.source || '')) continue;
    const t = Date.parse(r.scheduled_at);
    if (t < now || t > now + 21 * 86400000) continue;
    if (freshKeys.has(r.release_key)) continue;
    const moved = fresh.find((f) => f.event_type === r.event_type && !existingKeys.has(f.release_key)
      && Math.abs(Date.parse(f.scheduled_at) - t) <= 12 * 86400000);
    const kind = moved ? 'RESCHEDULED' : 'CANCELLED';
    updates.push({ id: r.id, status: kind, rescheduled_to_key: moved ? moved.release_key : null });
    if (r.pre_event_sent_at) {
      notices.push({ kind, label: (EVENT_TYPES[r.event_type] || {}).label || r.event_type, old_time: r.scheduled_at, new_time: moved ? moved.scheduled_at : null, release_id: r.id });
    }
  }
  return { updates, notices };
}

module.exports = {
  reconcileCalendar, AGENCY_OF,
  EVENT_TYPES, releaseKey, releasesFromIcs, releasesFromFomcPage, ffEntries, mergeCalendar, parseFomcStatement,
  parseBlsApi, blsActual, surprise, BLS_SERIES,
};
