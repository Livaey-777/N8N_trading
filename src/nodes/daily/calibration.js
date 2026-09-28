'use strict';
// Daily rebuild of the calibrated-probability cells from the stored history (same code as
// tools/calibrate.js). Empirical, walk-forward validated; a cell without enough evidence is UNAVAILABLE.
const { loadConfig } = require('../../lib/config');
const C = require('../../lib/calibration');

const cfg = loadConfig($env);
const d = $input.first().json;
const t0 = Date.now();
const proxy = (d.gold || []).some((g) => /paxg|binance/i.test(String(g.src || '')));
const desk = C.buildDeskCells({
  series: { GOLD: d.gold, USD_PROXY: d.usd, US2Y: d.us2y, US10Y: d.us10y, US10Y_REAL: d.us10y_real, GOLD_COT_NONCOMM_NET: d.cot },
  cfg: cfg.calibration, goldSource: proxy ? 'PROXY (PAXG/USDT daily closes; recent days gold-api spot)' : 'DIRECT',
});
const events = C.buildEventCells({ reactions: d.reactions, cfg: cfg.calibration });
const cells = [...desk, ...events];
return [{
  json: {
    store: { cells },
    summary: { cells: cells.length, calibrated: cells.filter((x) => x.status === 'CALIBRATED').length, ms: Date.now() - t0, min_sample: cfg.calibration.minSample },
  },
}];
