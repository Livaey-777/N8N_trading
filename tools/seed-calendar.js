'use strict';
/**
 * Seeds macro_releases from locally saved copies of the OFFICIAL calendars (same parsers as the
 * n8n Pre-Event workflow). Used when the official sites are temporarily unreachable; the workflow's
 * own calendar sync later refreshes the same rows (idempotent upsert by release_key).
 *
 *   node tools/seed-calendar.js --bls=<bls.ics> --bea=<bea.ics> --fomc=<fomccalendars.htm> [--ff=<ff_calendar_thisweek.json>]
 */
const fs = require('fs');
const { releasesFromIcs, releasesFromFomcPage, mergeCalendar } = require('../src/lib/calendar');
const { withClient } = require('./db');

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const read = (p) => (p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

async function main() {
  const official = [];
  if (read(args.bls)) official.push(...releasesFromIcs(read(args.bls), 'BLS'));
  if (read(args.bea)) official.push(...releasesFromIcs(read(args.bea), 'BEA'));
  if (read(args.fomc)) official.push(...releasesFromFomcPage(read(args.fomc)));
  const ff = read(args.ff) ? JSON.parse(read(args.ff)) : [];
  const now = Date.now();
  const releases = mergeCalendar(official, ff).filter((r) => {
    const t = Date.parse(r.scheduled_at);
    return t >= now - 14 * 86400000 && t <= now + 21 * 86400000;
  });
  await withClient(async (c) => {
    let n = 0;
    for (const r of releases) {
      await c.query(`INSERT INTO macro_releases (release_key, event_type, country, title, scheduled_at, impact, consensus, previous,
          consensus_num, previous_num, source, consensus_source, details)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (release_key) DO UPDATE SET title = EXCLUDED.title, impact = EXCLUDED.impact,
          consensus = coalesce(EXCLUDED.consensus, macro_releases.consensus), previous = coalesce(EXCLUDED.previous, macro_releases.previous),
          details = macro_releases.details || EXCLUDED.details, updated_at = now()`,
      [r.release_key, r.event_type, r.country || 'US', r.title, r.scheduled_at, r.impact || 'MEDIUM', r.consensus || null, r.previous || null,
        r.consensus_num ?? null, r.previous_num ?? null, `${r.source} [local copy]`, r.consensus_source || null, JSON.stringify(r.details || {})]);
      n++;
    }
    const up = await c.query("SELECT event_type, impact, scheduled_at FROM macro_releases WHERE scheduled_at > now() ORDER BY scheduled_at LIMIT 8");
    console.log(`upserted ${n} releases from official calendar copies (${official.length} parsed)`);
    for (const r of up.rows) console.log(`  ${new Date(r.scheduled_at).toISOString()} ${r.event_type} ${r.impact}`);
  });
}

main().catch((e) => { console.error(e.message); process.exit(1); });
