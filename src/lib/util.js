'use strict';
/**
 * Pure helpers shared by every engine. No n8n globals, no I/O.
 */

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-',
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', hellip: '...', laquo: '"', raquo: '"',
  euro: 'EUR', pound: 'GBP', yen: 'JPY', copy: '(c)', reg: '(R)', trade: '(TM)', middot: '.',
};

function decodeEntities(text) {
  if (!text) return '';
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return ' ';
      try { return String.fromCodePoint(n); } catch (_) { return ' '; }
    }
    const v = HTML_ENTITIES[code.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** Normalises typography so lexicon matching is stable (curly quotes, dashes, NBSP). */
function normaliseTypography(text) {
  return String(text || '')
    .replace(/[‘’‚‛′´`]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[  -​  　]/g, ' ')
    .replace(/…/g, '...');
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h\d)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function cleanText(text, maxLen) {
  let t = normaliseTypography(decodeEntities(stripHtml(decodeEntities(text))));
  t = t.replace(/\s+/g, ' ').trim();
  if (maxLen && t.length > maxLen) t = `${t.slice(0, maxLen - 1).replace(/\s+\S*$/, '')}…`;
  return t;
}

/** cyrb53 — fast, well-distributed 53-bit string hash, returned as 14-char hex. */
function hash53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, '0');
}

function hashOf(...parts) {
  const s = parts.map((p) => (p === undefined || p === null ? '' : String(p))).join('␟');
  return hash53(s) + hash53(s, 7919).slice(0, 6);
}

const STOPWORDS = new Set((
  'a an the and or but if then than of in on at to for from by with without into onto over under about after before ' +
  'as is are was were be been being has have had do does did will would can could should may might must shall ' +
  'this that these those it its he she they them his her their we our you your i me my not no yes so such ' +
  'up down out off again further once here there when where why how all any both each few more most other some ' +
  'own same too very just also new says said say report reports reported according amid while during via per ' +
  'says update updates live latest week weeks day days today tomorrow yesterday year years month months ' +
  'mr mrs ms dr us u.s one two three first second what who which'
).split(/\s+/));

/** Light stemmer: enough to align "rates/rate", "hikes/hiked/hiking", "strikes/striking". */
function stem(word) {
  let w = word;
  if (w.length > 5 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('es') && !w.endsWith('ses')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

function tokenize(text) {
  const t = normaliseTypography(String(text || '')).toLowerCase()
    .replace(/u\.s\./g, 'us').replace(/'s\b/g, '')
    .replace(/[^a-z0-9%$.\- ]+/g, ' ');
  const out = [];
  for (const raw of t.split(/\s+/)) {
    const w = raw.replace(/^[.\-]+|[.\-]+$/g, '');
    if (!w || w.length < 2 || STOPWORDS.has(w)) continue;
    if (/^\d+$/.test(w) && w.length < 3) continue;
    out.push(stem(w));
  }
  return out;
}

function uniq(arr) { return Array.from(new Set(arr)); }

function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

function round(x, dp = 2) {
  if (x === null || x === undefined || !Number.isFinite(Number(x))) return null;
  const f = 10 ** dp;
  return Math.round(Number(x) * f) / f;
}

function pctChange(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / from) * 100;
}

function toIso(d) {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function hoursBetween(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / 3600000;
}

/** Removes any occurrence of the given secret values from a string (defence in depth for logs). */
function redact(text, secrets) {
  let out = String(text === undefined || text === null ? '' : text);
  for (const s of secrets || []) {
    if (s && String(s).length >= 6) out = out.split(String(s)).join('***');
  }
  // Telegram bot tokens and bearer keys, even if not passed explicitly.
  out = out.replace(/bot\d{6,}:[A-Za-z0-9_-]{20,}/g, 'bot***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer ***')
    .replace(/sk-or-[A-Za-z0-9_-]{10,}/g, 'sk-or-***');
  return out;
}

function numberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Parses calendar-style values such as "0.3%", "-15.8K", "1.2M", "4.25%". */
function parseCalendarNumber(text) {
  if (text === null || text === undefined) return null;
  const m = /^\s*([<>]?)\s*(-?\d+(?:\.\d+)?)\s*([KMBT%]?)\s*$/i.exec(String(text));
  if (!m) return null;
  let n = Number(m[2]);
  const unit = m[3].toUpperCase();
  if (unit === 'K') n *= 1e3;
  else if (unit === 'M') n *= 1e6;
  else if (unit === 'B') n *= 1e9;
  else if (unit === 'T') n *= 1e12;
  return n;
}

module.exports = {
  decodeEntities, normaliseTypography, stripHtml, cleanText, hash53, hashOf, tokenize, stem, uniq,
  clamp, round, pctChange, toIso, hoursBetween, redact, numberOrNull, parseCalendarNumber, STOPWORDS,
};
