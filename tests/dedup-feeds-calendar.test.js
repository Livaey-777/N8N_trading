'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyItem } = require('../src/lib/classify');
const { clusterItems, clusterTokens, overlap } = require('../src/lib/dedup');
const { parseFeed, normaliseItem, parseIcs, usEasternToUtcIso, parseCsv } = require('../src/lib/feeds');
const { releasesFromFomcPage, mergeCalendar, parseFomcStatement, reconcileCalendar, surprise, blsActual } = require('../src/lib/calendar');

const item = (title, publisher, tier, minAgo, extra = {}) => ({
  item_hash: `h_${title}`, title, publisher, tier, source_id: 's', published_at: new Date(Date.now() - minAgo * 60000).toISOString(),
  fetched_at: new Date().toISOString(), classification: classifyItem({ title }), ...extra,
});

test('three reports of one event become ONE canonical event; unrelated item separate', () => {
  const items = [
    item('Government confirms naval blockade of the Strait of Hormuz after missile strikes on tankers', 'Official', 1, 12),
    item('Oil surges as Strait of Hormuz blockade follows missile strikes on tankers', 'Wire', 3, 10),
    item('Hormuz blockade: tankers hit by missile strikes, strait closed', 'Aggregator', 4, 8),
    item('Local football club wins regional cup after penalty shootout', 'Wire', 3, 9),
  ];
  const clusters = clusterItems(items, [], { windowHours: 36, minCoverage: 0.6 });
  const big = clusters.find((c) => c.newItems.length === 3);
  assert.ok(big, 'expected one 3-report cluster');
  assert.equal(big.best_tier, 1);
  assert.equal(clusters.length, 2);
});

test('synonym normalisation merges differently worded reports', () => {
  const a = clusterTokens('Trump rejects Iranian proposal to open Hormuz and end fighting');
  const b = clusterTokens("Trump rejects Iran's latest Strait of Hormuz deal offer");
  assert.ok(overlap(a, b).coef >= 0.6);
});

test('scheduled macro releases cluster by type and time window regardless of wording', () => {
  const items = [item('US CPI rises 0.4% in August', 'A', 3, 30), item('Consumer prices hotter than expected as shelter costs climb', 'B', 3, 20)];
  assert.equal(clusterItems(items, [], { windowHours: 36, minCoverage: 0.6 }).length, 1);
});

test('test events never merge with live events', () => {
  const live = { id: 1, event_key: 'ev_live', title: 'Oil surges as Strait of Hormuz blockade follows missile strikes', category: 'GEOPOLITICS', subcategory: 'MILITARY_ESCALATION', region: 'MIDDLE_EAST', tokens: clusterTokens('Oil surges as Strait of Hormuz blockade follows missile strikes'), first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), best_tier: 3, publishers: ['Wire'], source_count: 1, is_test: false };
  const t = item('Oil surges as Strait of Hormuz blockade follows missile strikes on tankers', 'SIM', 3, 1, { is_test: true });
  const out = clusterItems([t], [live], { windowHours: 36, minCoverage: 0.6 });
  assert.equal(out[0].existing, false);
});

test('RSS / Atom parsing and item validation', () => {
  const rss = '<rss><channel><item><title><![CDATA[Fed holds rates steady &amp; signals patience]]></title><link>https://x.test/a?utm_source=y</link><pubDate>Sat, 26 Sep 2026 20:00:00 GMT</pubDate><description>&lt;p&gt;Body&lt;/p&gt;</description></item></channel></rss>';
  const f = parseFeed(rss);
  assert.equal(f.format, 'RSS');
  assert.equal(f.items[0].title, 'Fed holds rates steady & signals patience');
  const src = { id: 's', publisher: 'P', tier: 3, category_hint: 'MACRO' };
  const ok = normaliseItem(f.items[0], src, '2026-09-26T21:00:00Z', 24);
  assert.equal(ok.ok, true);
  assert.equal(ok.item.url, 'https://x.test/a');
  const future = normaliseItem({ ...f.items[0], published: '2026-09-27T21:00:00Z' }, src, '2026-09-26T21:00:00Z', 24);
  assert.equal(future.reason, 'DATE_IN_FUTURE');
  const atom = parseFeed('<feed><entry><title>Atom item title here</title><link rel="alternate" href="https://a.test/1"/><updated>2026-09-26T10:00:00Z</updated></entry></feed>');
  assert.equal(atom.format, 'ATOM');
  assert.equal(atom.items[0].link, 'https://a.test/1');
});

test('aggregator items are attributed to the original publisher', () => {
  const raw = { title: 'Gold rallies as dollar weakens - Reuters', link: 'https://news.google.com/x', summary: '', published: new Date().toISOString(), sourceName: 'Reuters' };
  const n = normaliseItem(raw, { id: 'g', publisher: 'Google News', tier: 4, category_hint: 'GOLD' }, new Date().toISOString(), 24);
  assert.equal(n.item.publisher, 'Reuters');
  assert.equal(n.item.tier, 3);
  assert.equal(n.item.title, 'Gold rallies as dollar weakens');
});

test('US Eastern DST conversion and ICS parsing', () => {
  assert.equal(usEasternToUtcIso(2026, 10, 2, 8, 30), '2026-10-02T12:30:00.000Z');
  assert.equal(usEasternToUtcIso(2026, 1, 13, 8, 30), '2026-01-13T13:30:00.000Z');
  const ics = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;TZID=US-Eastern:20261014T083000\nSUMMARY:Consumer Price Index\nEND:VEVENT\nEND:VCALENDAR';
  assert.equal(parseIcs(ics)[0].start, '2026-10-14T12:30:00.000Z');
  assert.deepEqual(parseCsv('a,"b,c"\n1,"x ""y"""\n'), [{ a: '1', 'b,c': 'x "y"' }]);
});

test('FOMC calendar page and statement parsing', () => {
  const html = '2026 FOMC Meetings</a></h4></div><div class="fomc-meeting__month col"><strong>October</strong></div>\n<div class="fomc-meeting__date col">27-28</div>';
  const r = releasesFromFomcPage(html);
  assert.equal(r[0].scheduled_at, '2026-10-28T18:00:00.000Z');
  const s = parseFomcStatement('<p>the Committee decided to raise the target range for the federal funds rate by 1/4 percentage point to 3-3/4 to 4 percent.</p>');
  assert.deepEqual([s.decision, s.target_low, s.target_high], ['HIKE', 3.75, 4]);
});

test('consensus merge from the weekly calendar onto the official time', () => {
  const official = [{ release_key: 'NFP:2026-10-02T12:30Z', event_type: 'NFP', scheduled_at: '2026-10-02T12:30:00.000Z', title: 'NFP', impact: 'HIGH', source: 'bls.gov schedule (ICS)', details: {} }];
  const ff = [{ title: 'Non-Farm Employment Change', country: 'USD', date: '2026-10-02T08:30:00-04:00', impact: 'High', forecast: '120K', previous: '162K' }];
  const m = mergeCalendar(official, ff);
  assert.equal(m[0].consensus, '120K');
  assert.equal(surprise('NFP', 150, '120K'), 30);
});

test('BLS actual extraction (m/m % and payroll change)', () => {
  const data = { CUSR0000SA0: [{ period: '2026-07', value: 100 }, { period: '2026-08', value: 100.4 }], CUSR0000SA0L1E: [] };
  assert.equal(blsActual('CPI', data).fields.headline_mm.value, 0.4);
});

test('calendar reconciliation: rescheduled vs cancelled vs source failure', () => {
  const now = '2026-09-27T00:00:00.000Z';
  const existing = [
    { id: 1, release_key: 'CPI:2026-10-14T12:30Z', event_type: 'CPI', scheduled_at: '2026-10-14T12:30:00.000Z', source: 'bls.gov schedule (ICS)', pre_event_sent_at: '2026-10-13T05:00:00Z' },
    { id: 2, release_key: 'PPI:2026-10-15T12:30Z', event_type: 'PPI', scheduled_at: '2026-10-15T12:30:00.000Z', source: 'bls.gov schedule (ICS)', pre_event_sent_at: null },
    { id: 3, release_key: 'PCE:2026-09-30T12:30Z', event_type: 'PCE', scheduled_at: '2026-09-30T12:30:00.000Z', source: 'bea.gov schedule (ICS)' },
  ];
  const fresh = [{ release_key: 'CPI:2026-10-20T12:30Z', event_type: 'CPI', scheduled_at: '2026-10-20T12:30:00.000Z' }];
  const r = reconcileCalendar(existing, fresh, new Set(['BLS']), now);
  const byId = Object.fromEntries(r.updates.map((u) => [u.id, u]));
  assert.equal(byId[1].status, 'RESCHEDULED');
  assert.equal(byId[1].rescheduled_to_key, 'CPI:2026-10-20T12:30Z');
  assert.equal(byId[2].status, 'CANCELLED');
  assert.equal(byId[3], undefined, 'BEA not synced -> never cancelled (source failure guard)');
  assert.equal(r.notices.length, 1, 'notice only where a forecast was already sent');
});

test('merged event classification keeps gold flags (caps only when every report is noise)', () => {
  const { mergeClassification } = require('../src/lib/dedup');
  const { classifyItem } = require('../src/lib/classify');
  const a = classifyItem({ title: 'Gold rate today in Mumbai: 24 carat gold price' });
  const b = classifyItem({ title: 'Gold price today in Delhi, 22 carat rates' });
  const m = mergeClassification(JSON.parse(JSON.stringify(a)), b);
  assert.equal(m.gold.localPriceListing, true);
  assert.equal(m.gold.inTitle, true);
  const c = classifyItem({ title: 'Why gold prices are plunging amid the Iran war' });
  const m2 = mergeClassification(JSON.parse(JSON.stringify(a)), c);
  assert.equal(m2.gold.localPriceListing, false);
  assert.equal(m2.gold.priceMove, -1);
});
