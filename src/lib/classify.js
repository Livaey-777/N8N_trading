'use strict';
/**
 * Deterministic classification of a normalised report: category, subcategory,
 * region, per-channel gold-transmission evidence, severity and gold mention.
 */
const T = require('./taxonomy');
const { normaliseTypography, uniq } = require('./util');

const TAG_LABELS = {
  xtradewarx: 'trade war', xtradeescx: 'trade war escalation', xretaltariffx: 'retaliatory tariffs',
  xlaborstrikex: 'labour strike',
};

const B_OPEN = '(?<![a-z0-9])';
const B_CLOSE = '(?![a-z0-9])';
const cache = new Map();

function compile(fragment, flags = 'g') {
  const key = `${flags}:${fragment}`;
  let re = cache.get(key);
  if (!re) {
    re = new RegExp(`${B_OPEN}(?:${fragment})${B_CLOSE}`, flags);
    cache.set(key, re);
  }
  re.lastIndex = 0;
  return re;
}

function test(fragment, text) {
  return compile(fragment, '').test(text);
}

function countMatches(fragment, text) {
  const re = compile(fragment, 'g');
  let n = 0;
  while (re.exec(text)) n++;
  return n;
}

/** Lowercase, typography-normalised, with false-positive phrases masked. */
function prepareText(title, summary) {
  let text = ` ${normaliseTypography(`${title || ''} . ${summary || ''}`).toLowerCase().replace(/\s+/g, ' ')} `;
  for (const m of T.MASKS) text = text.replace(compile(m.re, 'g'), m.tag);
  return text;
}

/** Evaluates one channel lexicon; matched spans are masked so generic terms don't double count. */
function matchTerms(terms, text) {
  let work = text;
  const res = { bull: 0, bear: 0, neutral: 0, hits: 0, evidence: [], tags: [] };
  for (const term of terms) {
    const re = compile(term.re, 'g');
    let m;
    const spans = [];
    while ((m = re.exec(work)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      spans.push([m.index, m[0].length]);
      res.hits++;
      if (term.dir > 0) res.bull += term.w;
      else if (term.dir < 0) res.bear += term.w;
      else res.neutral += term.w;
      const ev = m[0].trim().replace(/\s+/g, ' ').replace(/\bx[a-z]+x\b/g, (t) => TAG_LABELS[t] || '').trim().slice(0, 60);
      if (ev && !res.evidence.includes(ev)) res.evidence.push(ev);
      if (term.tag && !res.tags.includes(term.tag)) res.tags.push(term.tag);
    }
    for (const [i, len] of spans) work = work.slice(0, i) + ' '.repeat(len) + work.slice(i + len);
  }
  res.evidence = res.evidence.slice(0, 5);
  return res;
}

function emptyChannel() {
  return { bull: 0, bear: 0, neutral: 0, hits: 0, evidence: [], tags: [] };
}

function addSignal(channels, name, dir, weight, evidence, tag) {
  const ch = channels[name] || (channels[name] = emptyChannel());
  if (dir > 0) ch.bull += weight;
  else if (dir < 0) ch.bear += weight;
  else ch.neutral += weight;
  ch.hits++;
  if (evidence && !ch.evidence.includes(evidence)) ch.evidence.push(evidence);
  if (tag && !ch.tags.includes(tag)) ch.tags.push(tag);
}

function detectInstitutions(text) {
  const out = [];
  for (const [id, re] of Object.entries(T.INSTITUTIONS)) if (test(re, text)) out.push(id);
  return out;
}

function detectRegions(text) {
  const scores = [];
  for (const [id, re] of Object.entries(T.REGIONS)) {
    const n = countMatches(re, text);
    if (n > 0) scores.push([id, n]);
  }
  scores.sort((a, b) => b[1] - a[1]);
  const ids = scores.map((s) => s[0]);
  // Prefer a specific geopolitical theatre over generic US/China/Europe mentions.
  const major = ids.find((r) => T.MAJOR_GEO_REGIONS.has(r));
  return { primary: major || ids[0] || 'GLOBAL', all: ids };
}

function severityOf(text) {
  let sev = 0.2;
  for (const s of T.SEVERITY) {
    if (test(s.re, text)) { sev = Math.max(sev, s.level); }
  }
  const hedged = test(T.HEDGES, text);
  return { severity: hedged ? sev * 0.8 : sev, hedged };
}

function goldMention(text) {
  const mentioned = test(T.GOLDWORDS, text);
  let priceAction = 0;
  if (mentioned) {
    const subj = '(?:spot )?gold(?: prices?| futures)?|bullion|precious metals';
    if (test(T.near(subj, T.UP), text) || test('gold (?:hits?|at|to) (?:a )?(?:fresh |new )?(?:record|all-time)', text)) priceAction = 1;
    else if (test(T.near(subj, T.DOWN), text)) priceAction = -1;
  }
  return {
    mentioned,
    priceAction,
    noiseMasked: text.includes('xgoldnoisex'),
    minerEquity: text.includes('xminerequityx'),
    localPriceListing: text.includes('xlocalpricex'),
    forecastOnly: mentioned && test('forecasts?|outlook|price targets?|technical analysis|price predictions?|could (?:reach|hit)|may (?:reach|hit)|targets?', text),
  };
}

function applyMonetaryInstitutionWeights(channels, institutions) {
  const mp = channels.MONETARY_POLICY;
  if (!mp || mp.hits === 0) return;
  const hasFed = institutions.includes('FED');
  const nonFed = institutions.filter((i) => ['ECB', 'BOE', 'BOJ', 'SNB'].includes(i));
  const pboc = institutions.includes('PBOC');
  if (!hasFed && (nonFed.length || pboc)) {
    const dovish = mp.bull;
    const hawkish = mp.bear;
    // Direct global-rates effect is weak for non-Fed banks; the main path is the USD cross.
    mp.bull *= 0.4;
    mp.bear *= 0.4;
    mp.tags.push('NON_FED');
    if (nonFed.length) {
      // Hawkish ECB/BoE/BoJ/SNB -> their currency up -> USD down -> gold up (and vice versa).
      if (hawkish > 0) addSignal(channels, 'USD', 1, hawkish * 0.35, `${nonFed[0]} hawkish -> USD cross weaker`, 'VIA_FX_CROSS');
      if (dovish > 0) addSignal(channels, 'USD', -1, dovish * 0.35, `${nonFed[0]} dovish -> USD cross stronger`, 'VIA_FX_CROSS');
    }
    if (pboc && dovish > 0) addSignal(channels, 'PHYSICAL_DEMAND', 1, dovish * 0.3, 'PBoC easing -> China demand', 'PBOC');
  } else if (!hasFed && !institutions.length) {
    mp.bull *= 0.7;
    mp.bear *= 0.7;
    mp.tags.push('INSTITUTION_UNSPECIFIED');
  }
}

function applyMacroFamilies(channels, text) {
  let family = null;
  let tone = null;
  const inflation = channels.INFLATION;
  if (inflation && inflation.hits > 0) {
    if (!test(T.CHANNELS.INFLATION.detect, text)) {
      // Tone words without an inflation subject are not inflation evidence.
      delete channels.INFLATION;
    } else {
      family = 'INFLATION';
      if (inflation.bull > inflation.bear) tone = 'HOT';
      else if (inflation.bear > inflation.bull) tone = 'COOL';
      else tone = 'IN_LINE_OR_UNCLEAR';
    }
  } else if (test(T.CHANNELS.INFLATION.detect, text)) {
    addSignal(channels, 'INFLATION', 0, 0.7, 'inflation data', null);
    family = 'INFLATION';
    tone = 'IN_LINE_OR_UNCLEAR';
  }
  if (test(T.LABOR.detect, text)) {
    const strong = countMatches(T.LABOR.strong, text);
    const weak = countMatches(T.LABOR.weak, text);
    family = family || 'LABOR';
    if (strong > weak) { addSignal(channels, 'MONETARY_POLICY', -1, 0.9, 'labour data stronger -> hawkish repricing', 'LABOR'); tone = tone || 'STRONG'; }
    else if (weak > strong) { addSignal(channels, 'MONETARY_POLICY', 1, 0.9, 'labour data weaker -> dovish repricing', 'LABOR'); tone = tone || 'WEAK'; }
    else addSignal(channels, 'MONETARY_POLICY', 0, 0.6, 'labour data', 'LABOR');
  }
  if (test(T.GROWTH.detect, text)) {
    const strong = countMatches(T.GROWTH.strong, text);
    const weak = countMatches(T.GROWTH.weak, text);
    family = family || 'GROWTH';
    if (strong > weak) {
      addSignal(channels, 'MONETARY_POLICY', -1, 0.5, 'growth data stronger -> fewer cuts', 'GROWTH');
      addSignal(channels, 'RISK_SENTIMENT', -1, 0.5, 'growth data stronger -> risk-on', 'GROWTH');
      tone = tone || 'STRONG';
    } else if (weak > strong) {
      addSignal(channels, 'MONETARY_POLICY', 1, 0.5, 'growth data weaker -> easier policy', 'GROWTH');
      addSignal(channels, 'RISK_SENTIMENT', 1, 0.6, 'growth data weaker -> risk-off', 'GROWTH');
      tone = tone || 'WEAK';
    } else addSignal(channels, 'RISK_SENTIMENT', 0, 0.4, 'growth data', 'GROWTH');
  }
  return { family, tone };
}

/** Political pressure on a central bank also transmits via USD credibility and safe-haven demand. */
function applyInstitutionalRisk(channels) {
  const mp = channels.MONETARY_POLICY;
  if (!mp || !mp.tags.includes('CB_INDEPENDENCE')) return;
  addSignal(channels, 'USD', 1, 0.8, 'central-bank independence risk -> USD credibility discount', 'CB_INDEPENDENCE');
  addSignal(channels, 'SAFE_HAVEN', 1, 0.6, 'institutional risk -> hedging demand', 'CB_INDEPENDENCE');
}

function pickCategory(text, hint, gold, channels) {
  const scores = {};
  for (const [cat, def] of Object.entries(T.CATEGORIES)) {
    const n = countMatches(def.re, text);
    scores[cat] = n * def.weight;
  }
  if (!gold.mentioned) scores.GOLD = 0;
  // Direct CB gold buying / physical flows are gold fundamentals even if phrased as macro.
  if ((channels.CENTRAL_BANK_DEMAND && channels.CENTRAL_BANK_DEMAND.bull + channels.CENTRAL_BANK_DEMAND.bear > 0)
    || (channels.PHYSICAL_DEMAND && channels.PHYSICAL_DEMAND.bull + channels.PHYSICAL_DEMAND.bear > 0)) {
    scores.GOLD += 3;
  }
  if (channels.MONETARY_POLICY && channels.MONETARY_POLICY.tags.includes('CB_INDEPENDENCE')) scores.POLITICS += 3;
  if (hint && scores[hint] !== undefined) scores[hint] += 0.75;
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] <= 0) return { category: 'GENERAL', scores };
  return { category: ranked[0][0], scores };
}

const CB_POLICY_SUBCATEGORY = { ECB: 'ECB_POLICY', BOE: 'BOE_POLICY', BOJ: 'BOJ_POLICY', PBOC: 'PBOC_POLICY' };

/** The institution named first is the grammatical subject ("BoE defies Fed ..." is a BoE story). */
function firstInstitution(text) {
  let best = null;
  let bestIdx = Infinity;
  for (const [id, re] of Object.entries(T.INSTITUTIONS)) {
    if (id === 'OTHER_CB') continue;
    const m = compile(re, 'g').exec(text);
    if (m && m.index < bestIdx) { best = id; bestIdx = m.index; }
  }
  return best;
}

function pickSubcategory(category, text, channels) {
  if (category === 'MACRO') {
    const first = firstInstitution(text);
    if (first && CB_POLICY_SUBCATEGORY[first]) return CB_POLICY_SUBCATEGORY[first];
  }
  for (const rule of T.SUBCATEGORIES) {
    if (rule.cat !== category) continue;
    if (rule.channelTag) {
      const has = Object.values(channels).some((c) => c.tags.includes(rule.channelTag));
      if (has) return rule.id;
      continue;
    }
    if (rule.channel) {
      const c = channels[rule.channel];
      if (c && c.bull + c.bear > 0) return rule.id;
      continue;
    }
    if (rule.channelDir) {
      const [name, dir] = rule.channelDir;
      const c = channels[name];
      if (c && (dir > 0 ? c.bull > c.bear && c.bull > 0 : c.bear > c.bull && c.bear > 0)) return rule.id;
      continue;
    }
    if (rule.all.every((re) => test(re === 'FED' ? T.INSTITUTIONS.FED : re, text))) return rule.id;
  }
  return category === 'GENERAL' ? 'GENERAL' : `${category}_OTHER`;
}

/**
 * @param {{title:string, summary?:string, categoryHint?:string}} item
 */
/** Title evidence at full weight; summary-only evidence at half weight (background noise guard). */
function matchChannels(titleText, summaryText) {
  const channels = {};
  for (const [name, def] of Object.entries(T.CHANNELS)) {
    const t = matchTerms(def.terms, titleText);
    const s = summaryText ? matchTerms(def.terms, summaryText) : null;
    if (t.hits === 0 && (!s || s.hits === 0)) continue;
    const merged = { bull: t.bull, bear: t.bear, neutral: t.neutral, hits: t.hits, evidence: [...t.evidence], tags: [...t.tags] };
    if (s && s.hits) {
      merged.bull += s.bull * 0.5;
      merged.bear += s.bear * 0.5;
      merged.neutral += s.neutral * 0.5;
      merged.hits += s.hits;
      for (const e of s.evidence) if (!merged.evidence.includes(e) && merged.evidence.length < 5) merged.evidence.push(e);
      for (const g of s.tags) if (!merged.tags.includes(g)) merged.tags.push(g);
    }
    channels[name] = merged;
  }
  return channels;
}

const MILITARY_CONTEXT = 'missiles?|air ?strikes?|drones?|troops|military|bomb\\w*|invasion|invad\\w*|navy|naval|warships?|killed|artillery|shelling|armed forces|ceasefire|hostages?';

/** "Vows to retaliate" in a tariff story is trade escalation, not military escalation. */
function reassignTradeRetaliation(channels, text) {
  const sh = channels.SAFE_HAVEN;
  const tr = channels.TRADE_SUPPLY_SHOCK;
  if (!sh || !tr || tr.bull + tr.bear === 0) return;
  if (test(MILITARY_CONTEXT, text)) return;
  const generic = sh.evidence.every((e) => /^(?:retaliat|escalat|conflict|wars?\b|clash)/i.test(e));
  if (!generic) return;
  tr.bull += sh.bull;
  tr.evidence.push(...sh.evidence.filter((e) => !tr.evidence.includes(e)).slice(0, 2));
  tr.tags.push('TRADE_RETALIATION');
  delete channels.SAFE_HAVEN;
}

function classifyItem(item) {
  const titleText = prepareText(item.title, '');
  const summaryText = item.summary ? prepareText('', item.summary) : '';
  const text = prepareText(item.title, item.summary);
  const channels = matchChannels(titleText, summaryText);
  reassignTradeRetaliation(channels, text);
  const institutions = detectInstitutions(text);
  // Institution weighting applies to explicit policy language only; data-driven
  // repricing signals (labour/growth/inflation) are added afterwards at full weight.
  applyMonetaryInstitutionWeights(channels, institutions);
  const macro = applyMacroFamilies(channels, text);
  applyInstitutionalRisk(channels);
  const gold = goldMention(text);
  gold.inTitle = test(T.GOLDWORDS, titleText);
  // Observed gold price move reported in the headline (+1 up / -1 down / 0 none).
  gold.priceMove = goldMention(titleText).priceAction;
  const regions = detectRegions(text);
  const titleSev = severityOf(titleText);
  const bodySev = summaryText ? severityOf(summaryText) : { severity: 0, hedged: false };
  const severity = Math.max(titleSev.severity, Math.min(bodySev.severity * 0.8, 0.65));
  const hedged = titleSev.hedged;
  const { category, scores } = pickCategory(text, item.categoryHint, gold, channels);
  const subcategory = pickSubcategory(category, text, channels);
  const keywords = uniq(Object.values(channels).flatMap((c) => c.evidence)).slice(0, 12);
  return {
    category, subcategory, categoryScores: scores,
    region: regions.primary, regions: regions.all,
    institutions, channels, gold, severity, hedged,
    macroFamily: macro.family, macroTone: macro.tone, keywords,
    supervisory: text.includes('xsupervisoryx'),
    preview: test(T.PREVIEW, titleText),
  };
}

module.exports = { classifyItem, prepareText, matchTerms, compile, test, countMatches };
