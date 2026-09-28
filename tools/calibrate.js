#!/usr/bin/env node
'use strict';
/**
 * Rebuilds the calibrated-probability cells from the stored history (same library code as the
 * Daily Report workflow) and prints a summary. No network, no AI.
 *
 *   node tools/calibrate.js [--dry-run]
 */
const { withClient } = require('./db');
const { loadEnv } = require('./env');
const { loadConfig } = require('../src/lib/config');
const C = require('../src/lib/calibration');
const { LOAD_SQL, STORE_SQL } = require('../src/workflows/shared/calibration-sql');

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const cfg = loadConfig(loadEnv());
  await withClient(async (c) => {
    const t0 = Date.now();
    const d = (await c.query(LOAD_SQL)).rows[0];
    const proxy = (d.gold || []).some((g) => /paxg|binance/i.test(String(g.src || '')));
    const desk = C.buildDeskCells({
      series: { GOLD: d.gold, USD_PROXY: d.usd, US2Y: d.us2y, US10Y: d.us10y, US10Y_REAL: d.us10y_real, GOLD_COT_NONCOMM_NET: d.cot },
      cfg: cfg.calibration, goldSource: proxy ? 'PROXY (PAXG/USDT daily closes; recent days gold-api spot)' : 'DIRECT',
    });
    const events = C.buildEventCells({ reactions: d.reactions, cfg: cfg.calibration });
    const cells = [...desk, ...events];
    console.log(`built ${cells.length} cells in ${Date.now() - t0} ms (min sample ${cfg.calibration.minSample}, min eval ${cfg.calibration.minEval})`);
    for (const x of cells) {
      const wf = x.walk_forward || {};
      const p = x.status === 'CALIBRATED' ? `B ${x.bullish_pct}% / Be ${x.bearish_pct}% / N ${x.neutral_pct}%` : 'UNAVAILABLE';
      console.log(`${x.kind.padEnd(14)} ${x.horizon.padEnd(10)} ${x.class_key.padEnd(20)} n=${String(x.n).padEnd(4)} ${p.padEnd(30)} ${x.evidence.padEnd(12)} brier ${wf.brier ?? '-'} vs 1/3 ${wf.brier_uniform ?? '-'} vs base ${wf.brier_climatology ?? '-'}${x.reason ? ` · ${x.reason}` : ''}${x.warnings && x.warnings.length ? ` · ⚠ ${x.warnings.join('; ')}` : ''}`);
    }
    if (dryRun) return;
    const r = (await c.query(STORE_SQL, [JSON.stringify({ cells })])).rows[0];
    console.log(`stored ${r.stored} cells (${r.calibrated} CALIBRATED), removed ${r.removed} stale`);
  });
}

main().catch((e) => { console.error(e.message); process.exit(1); });
