'use strict';
/**
 * Tolerant parsers for RSS 2.0 / RSS 1.0 (RDF) / Atom, iCalendar and CSV,
 * plus item normalisation and validation. Regex-based (no DOM in n8n Code nodes).
 */
const { cleanText, decodeEntities, hashOf, toIso } = require('./util');

// Publishers recognised when reached through an aggregator (e.g. Google News <source>).
const PUBLISHER_TIERS = [
  [/^(?:federal reserve|board of governors of the federal reserve|u\.?s\.? treasury|bureau of labor statistics|bureau of economic analysis|european central bank|bank of england|bank of japan|international monetary fund|imf|world bank|the white house|white house|ustr)/i, 1],
  [/^(?:cme group|cftc|lbma|world gold council|nasdaq|ice|lseg|refinitiv)/i, 2],
  [/^(?:reuters|associated press|ap news|the associated press|bloomberg|financial times|ft|the wall street journal|wall street journal|wsj|cnbc|bbc|bbc news|the new york times|new york times|the guardian|al jazeera|marketwatch|nikkei|nikkei asia|axios|politico|the economist|barron's|fox business|abc news|nbc news|cbs news|npr|deutsche welle|dw|france 24|kitco|mining\.com)/i, 3],
];

function publisherTier(name) {
  const n = String(name || '').trim();
  for (const [re, tier] of PUBLISHER_TIERS) if (re.test(n)) return tier;
  return 4;
}

function tag(block, names) {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
    const m = re.exec(block);
    if (m) return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
  }
  return '';
}

function attr(block, tagName, attrName, where) {
  const re = new RegExp(`<${tagName}\\b([^>]*)/?>`, 'gi');
  let m;
  while ((m = re.exec(block)) !== null) {
    const attrs = m[1];
    if (where && !where(attrs)) continue;
    const a = new RegExp(`${attrName}\\s*=\\s*["']([^"']+)["']`, 'i').exec(attrs);
    if (a) return decodeEntities(a[1]);
  }
  return '';
}

function parseDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  let d = new Date(t);
  if (Number.isNaN(d.getTime())) {
    // "26 Sep 2026 10:00:00 +0100" without weekday, or "2026-09-26 10:00:00"
    d = new Date(t.replace(/^\w{3},\s*/, '').replace(' ', 'T'));
  }
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * @returns {{format:string, items:Array<{title,link,summary,published,guid,sourceName}>}}
 */
function parseFeed(xml) {
  const text = String(xml || '');
  if (!/<(?:rss|feed|rdf:RDF)\b/i.test(text)) {
    return { format: 'UNKNOWN', items: [], error: 'not an RSS/Atom document' };
  }
  const isAtom = /<feed\b/i.test(text) && !/<rss\b/i.test(text);
  const blocks = text.match(isAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi) || [];
  const items = blocks.map((b) => {
    const title = tag(b, ['title']);
    let link = isAtom
      ? attr(b, 'link', 'href', (a) => !/rel\s*=\s*["'](?!alternate)/i.test(a))
      : tag(b, ['link']) || attr(b, 'link', 'href');
    if (!link) link = tag(b, ['guid', 'id']);
    const summary = tag(b, ['description', 'summary', 'content:encoded', 'content']);
    const published = tag(b, ['pubDate', 'published', 'dc:date', 'updated', 'a10:updated']);
    const sourceName = tag(b, ['source']);
    return {
      title: cleanText(title, 400),
      link: decodeEntities(link).trim(),
      summary: cleanText(summary, 600),
      published: parseDate(published),
      guid: tag(b, ['guid', 'id']),
      sourceName: cleanText(sourceName, 120),
    };
  });
  return { format: isAtom ? 'ATOM' : 'RSS', items };
}

function canonicalUrl(u) {
  try {
    const url = new URL(u);
    for (const k of Array.from(url.searchParams.keys())) {
      if (/^(utm_|fbclid|gclid|ref|cmpid|mod|taid|at_)/i.test(k)) url.searchParams.delete(k);
    }
    url.hash = '';
    return url.toString();
  } catch (_) {
    return String(u || '');
  }
}

/**
 * Normalise + validate one feed item for a registered source.
 * @returns {{ok:boolean, reason?:string, item?:object}}
 */
function normaliseItem(raw, source, nowIso, maxAgeHours) {
  let title = raw.title || '';
  let publisher = source.publisher;
  let tier = source.tier;
  let viaAggregator = false;
  if (source.tier === 4 && raw.sourceName) {
    // Aggregator: attribute to the original publisher, keep tier conservative.
    publisher = raw.sourceName;
    tier = Math.max(publisherTier(raw.sourceName), 3);
    viaAggregator = true;
    title = title.replace(new RegExp(`\\s+[-|–]\\s+${raw.sourceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`), '');
  }
  if (!title || title.length < 12) return { ok: false, reason: 'TITLE_MISSING_OR_SHORT' };
  if (!/^https?:\/\//i.test(raw.link || '')) return { ok: false, reason: 'LINK_INVALID' };
  const now = new Date(nowIso).getTime();
  let published = raw.published;
  if (!published) return { ok: false, reason: 'DATE_MISSING' };
  const pubMs = new Date(published).getTime();
  if (pubMs - now > 15 * 60000) return { ok: false, reason: 'DATE_IN_FUTURE' };
  const ageHours = (now - pubMs) / 3600000;
  const item = {
    item_hash: `it_${hashOf(publisher.toLowerCase(), title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())}`,
    source_id: source.id,
    publisher,
    tier,
    via_aggregator: viaAggregator,
    title,
    summary: raw.summary || '',
    url: canonicalUrl(raw.link),
    published_at: toIso(published),
    fetched_at: nowIso,
    category_hint: source.category_hint,
    age_hours: Number(ageHours.toFixed(2)),
    stale: ageHours > maxAgeHours,
  };
  return { ok: true, item };
}

// ---------------------------------------------------------------------------
// iCalendar
// ---------------------------------------------------------------------------

/** Second Sunday of March .. first Sunday of November, 02:00 local (US rules since 2007). */
function usEasternOffsetHours(year, month, day, hour) {
  const nthSunday = (y, m, n) => {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + 7 * (n - 1);
  };
  const dstStart = nthSunday(year, 3, 2);
  const dstEnd = nthSunday(year, 11, 1);
  const key = month * 10000 + day * 100 + hour;
  const inDst = key >= 3 * 10000 + dstStart * 100 + 2 && key < 11 * 10000 + dstEnd * 100 + 2;
  return inDst ? -4 : -5;
}

function usEasternToUtcIso(y, m, d, hh, mm) {
  const off = usEasternOffsetHours(y, m, d, hh);
  return new Date(Date.UTC(y, m - 1, d, hh - off, mm)).toISOString();
}

function parseIcsDate(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, hh, mi, , z] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0, m[6], m[7]];
  if (z) return new Date(Date.UTC(y, mo - 1, d, hh, mi)).toISOString();
  const tzid = /TZID=([^;:]+)/i.exec(params || '');
  if (tzid && /(US-Eastern|America\/New_York|Eastern)/i.test(tzid[1])) return usEasternToUtcIso(y, mo, d, hh, mi);
  if (!m[4]) return new Date(Date.UTC(y, mo - 1, d, 12, 0)).toISOString();
  return usEasternToUtcIso(y, mo, d, hh, mi);
}

function parseIcs(text) {
  const unfolded = String(text || '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const events = [];
  const blocks = unfolded.split('BEGIN:VEVENT').slice(1);
  for (const b of blocks) {
    const body = b.split('END:VEVENT')[0];
    const get = (name) => {
      const re = new RegExp(`^${name}((?:;[^:\\n]*)?):(.*)$`, 'mi');
      const m = re.exec(body);
      return m ? { params: m[1], value: m[2].trim() } : null;
    };
    const dt = get('DTSTART');
    const summary = get('SUMMARY');
    if (!dt || !summary) continue;
    const start = parseIcsDate(dt.value, dt.params);
    if (!start) continue;
    events.push({
      uid: (get('UID') || {}).value || null,
      start,
      summary: summary.value.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/gi, ' ').trim(),
      description: ((get('DESCRIPTION') || {}).value || '').replace(/\\,/g, ',').replace(/\\n/gi, ' ').trim(),
    });
  }
  return events;
}

// ---------------------------------------------------------------------------
// CSV (quoted fields supported)
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((x) => x !== '')) rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
}

module.exports = {
  parseFeed, normaliseItem, publisherTier, canonicalUrl, parseIcs, parseIcsDate, usEasternToUtcIso,
  usEasternOffsetHours, parseCsv, parseDate,
};
