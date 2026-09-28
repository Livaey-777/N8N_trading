'use strict';
/**
 * Forecast evaluation (post-event). Stores accuracy; NEVER changes system weights
 * automatically — calibration is a deliberate, human-reviewed step across many events.
 */
const { round, clamp } = require('./util');

const HORIZON_FIELDS = { '1H': 'ret_1h', '4H': 'ret_4h', '24H': 'ret_24h', '3D': 'ret_3d' };
const BAND = { '1H': 0.15, '4H': 0.15, '24H': 0.3, '3D': 0.5 };

function realizedDirection(ret, horizon) {
  if (ret === null || ret === undefined) return null;
  if (Math.abs(ret) < BAND[horizon]) return 'MIXED';
  return ret > 0 ? 'BULLISH' : 'BEARISH';
}

function isHit(bias, realized) {
  if (!realized || !bias || bias === 'UNDETERMINED') return null;
  if (bias === 'BULLISH' || bias === 'BEARISH') return bias === realized;
  return realized === 'MIXED'; // NEUTRAL / MIXED bias is right when the reaction is muted
}

/**
 * @param {object} forecast {id, pre_event_bias, historical_bias, bias_score, historical:{conditional_on_usd_reaction}}
 * @param {object} metrics  history.reactionMetrics() of the realised reaction
 * @param {object} release  {consensus, actual, surprise}
 * @param {string[]} horizons horizons measurable at this review stage
 */
function evaluateForecast(forecast, metrics, release, horizons) {
  const out = [];
  const cond = forecast.historical && forecast.historical.conditional_on_usd_reaction;
  for (const h of horizons) {
    const ret = metrics[HORIZON_FIELDS[h]];
    const realized = realizedDirection(ret, h);
    if (!realized) continue;
    const hit = isHit(forecast.pre_event_bias, realized);
    const signal = clamp(ret / 0.5, -1, 1);
    const biasScore = Number.isFinite(Number(forecast.bias_score)) ? Number(forecast.bias_score) : 0;
    let analog = null;
    if (cond && metrics.usd_dir && cond[metrics.usd_dir] && cond[metrics.usd_dir].n) {
      const c = cond[metrics.usd_dir];
      const majority = c.bullish_cases > c.bearish_cases && c.bullish_cases > c.mixed_cases ? 'BULLISH'
        : c.bearish_cases > c.bullish_cases && c.bearish_cases > c.mixed_cases ? 'BEARISH' : 'MIXED';
      analog = majority === realized ? 1 : 0;
    }
    let reason = null;
    if (hit === false) {
      const reasons = [];
      if (release.surprise !== null && release.surprise !== undefined && release.surprise !== 0) reasons.push(`release surprise ${release.surprise > 0 ? '+' : ''}${release.surprise} vs consensus shifted the policy-path channel`);
      if (metrics.usd_dir && ((realized === 'BULLISH' && metrics.usd_dir === 'DOWN') || (realized === 'BEARISH' && metrics.usd_dir === 'UP'))) reasons.push(`USD reaction (${metrics.usd_dir}) drove gold ${realized.toLowerCase()} — the conditional scenario applied, not the unconditional bias`);
      if (!reasons.length) reasons.push('competing drivers / pre-positioning not captured by the pre-event components (hypothesis)');
      reason = reasons.join('; ');
    }
    out.push({
      forecast_id: forecast.id, horizon: h, forecast_bias: forecast.pre_event_bias, realized_direction: realized,
      realized_move_pct: ret, hit, prediction_error: round(Math.abs(biasScore - signal), 3), reason_for_error: reason,
      historical_bias: forecast.historical_bias || null, historical_analogy_accuracy: analog,
      actual: release.actual === undefined ? null : release.actual, consensus: release.consensus || null,
      surprise: release.surprise === undefined ? null : release.surprise,
      details: { usd_dir: metrics.usd_dir, usd_move_pct: metrics.usd_move_pct, bias_score: biasScore, realized_signal: round(signal, 3), policy: 'stored for review; weights are not auto-adjusted' },
    });
  }
  return out;
}

module.exports = { evaluateForecast, realizedDirection, isHit, HORIZON_FIELDS };
