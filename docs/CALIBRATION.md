# Calibrated probabilities

Code: `src/lib/calibration.js` (estimator), `src/lib/direction.js` (per-horizon view and confidence),
`src/lib/telegram-direction.js` (GOLD NOW, GOLD DIRECTION DESK, AI ANALYSIS summary), `src/lib/biggest.js`
(scenario probabilities). Storage: `calibration_cells` (`sql/005_calibration.sql`). Tests: `tests/calibration.test.js`.

## Three separate numbers

| Number | Meaning | Source |
|---|---|---|
| **Direction score** (−100…+100) | analytical pressure on gold from the market drivers and news flow of a horizon | deterministic desk |
| **Confidence** (0–100) | how reliable the deterministic assessment is (driver coverage, agreement, price confirmation, data quality) | `direction.js → horizonConfidence` |
| **Probability** (%) | how often gold actually went BULLISH / BEARISH / NEUTRAL in comparable historical situations | `calibration_cells`, only when CALIBRATED |

A probability is never computed from a score or a confidence value, never normalised from them, and never estimated by the AI.
A confidence of 76 is not a "76 % bullish" statement. When no validated cell exists the output is
`PROBABILITY: UNAVAILABLE` with the reason and `DIRECTIONAL EVIDENCE: INSUFFICIENT`.

## Cells

**DESK** — gold's direction over the next 1 / 5 / 20 / 90 days (SHORT / TACTICAL / SWING / STRUCTURAL), conditioned on
the historical *market-driver state* of that horizon (BULLISH if the market-driver score ≥ +0.15, BEARISH if ≤ −0.15,
otherwise NEUTRAL). The state is computed with the same `marketDriverScores()` as the live desk (USD proxy, real and
nominal yields, positioning). News is not part of the condition (no historical news archive). Outcome: forward gold
change against the horizon's flat band (`FLAT_BANDS`: 0.4 / 1.0 / 2.0 / 4.0 %).

**EVENT_SCENARIO** — gold's reaction to a scheduled release, conditioned on the scenario's market confirmation:
USD up after the release → BEARISH (hawkish/hot) scenario, USD down → BULLISH (dovish/soft), USD flat → BASE.
SHORT = the stored first-hours reaction; TACTICAL = 3 days, flat band 0.4 × √3 ≈ 0.69 %.
Release types are also pooled into families (INFLATION = CPI/PCE/PPI, LABOR = NFP/JOLTS). A scenario uses its own
cell when CALIBRATED, otherwise the family cell (labelled "pooled"), otherwise UNAVAILABLE with both reasons.

## Estimator and validation

1. **Non-overlapping cases only.** DESK cases are spaced by the horizon length, so a 20-day window is never counted
   twice; overlapping windows would inflate the sample.
2. **Laplace (add-one) smoothed frequencies.** Small cells are pulled towards 1/3; no class is ever 0 % or 100 %.
3. **Chronological walk-forward check.** After a warm-up (`GI_PROB_WARMUP`, 10 cases) every case is predicted
   from earlier cases only (no look-ahead). The Brier score is compared with an uninformed 1/3 split and with the
   unconditional base rate (climatology).
4. **Status**
   * `n < GI_PROB_MIN_SAMPLE` → UNAVAILABLE ("insufficient calibrated historical evidence: N … (minimum 20)")
   * fewer than `GI_PROB_MIN_EVAL` walk-forward predictions → UNAVAILABLE
   * out-of-sample Brier worse than 1/3 → UNAVAILABLE ("failed walk-forward validation")
   * otherwise CALIBRATED, with warnings: no edge over the base rate, split outcomes, history measured on a PROXY series.
5. **Evidence level**
   * STRONG: edge over climatology > 0.05 Brier, leading class ≥ 55 %, and n ≥ 2 × minimum.
   * MODERATE: any edge and leading class ≥ 45 %.
   * WEAK: otherwise, including calibrated cells without an edge.
   * INSUFFICIENT: the cell is UNAVAILABLE.
6. **Stored per cell**
   * the method, the conditioning and the outcome definition;
   * n, the counts, the time window and the horizon;
   * the class key and status;
   * the probabilities and whole-number percentages (largest remainder, summing to 100), with Wilson 95 % intervals;
   * the walk-forward statistics, evidence level and warnings;
   * the reason, the data source and `built_at`.

### Minimum sample — why 20

With 20 independent cases the 95 % Wilson interval around a 50 % share is about ±21 percentage points. That is the
widest interval that still separates a three-way split. Below 20, percentages mostly reflect noise.
`GI_PROB_MIN_SAMPLE` is configurable (10–500).

| Variable | Default | Range | Meaning |
|---|---|---|---|
| `GI_PROB_MIN_SAMPLE` | 20 | 10–500 | minimum non-overlapping cases per cell |
| `GI_PROB_MIN_EVAL` | 10 | 5–200 | minimum walk-forward predictions |
| `GI_PROB_WARMUP` | 10 | 5–200 | cases used before the first walk-forward prediction |

## Rebuilding

* Automatically: *GI · Daily Report* → Load Calibration Inputs → Build Calibration → Store Calibration (stale cells removed).
* Manually: `node tools/calibrate.js` (`--dry-run` prints without storing).

Weights and thresholds are never retrained automatically. The cells are recomputed from the stored history with fixed rules.

## Results on 2026-09-28 (66 cells, 24 CALIBRATED)

* **DESK SHORT / TACTICAL:** CALIBRATED in all three market states (n 205–717). Mostly WEAK: the market-driver state gives little
  out-of-sample edge over the base rate, and NEUTRAL outcomes dominate (43–53 %). The output says so explicitly.
* **DESK SWING:** BULLISH and NEUTRAL states CALIBRATED but WEAK; BEARISH state failed walk-forward validation.
* **DESK STRUCTURAL:** UNAVAILABLE (12–17 non-overlapping 90-day cases).
* **Events, first hours:**
  * INFLATION:BULLISH 59 / 16 / 25, STRONG, n = 72
  * LABOR:BULLISH 58 / 15 / 27, STRONG, n = 52
  * NFP:BEARISH bearish 67 %, n = 27
  * FOMC:BULLISH bullish 73 %, n = 26
  * CPI:BULLISH bullish 62 %, n = 39
* **Events, 3 days:** mostly WEAK or UNAVAILABLE. The first-hours reaction does not reliably persist.
* **UNAVAILABLE:** most BASE scenarios and the individual types with few releases (e.g. PCE, 6 releases → pooled INFLATION).

Most event history is measured on a proxy series and carries the ⚠ PROXY warning. Proxies are never labelled as true XAUUSD or DXY.

## Where it is shown

* **/now (GOLD NOW):**
  * regime and the tactical current direction (score + confidence);
  * a horizon interpretation, only when the horizons differ;
  * the tactical calibrated probability, with the market state it is conditioned on;
  * an explicit consistency line: whether the history confirms, weakly supports, or does NOT confirm the deterministic lean;
  * drivers, confirmation and invalidation;
  * the GOLD DIRECTION DESK box (per horizon: direction · score · confidence · probability [market state]);
  * data quality.
* **/biggest:** per scenario, a conditional probability for the first hours and for 3 days, next to a separate
  "Rank score — ordering weight, not a probability".
* **/analysis:** direction summary + tactical probability + consistency line before the AI analyses.
* **AI:** receives the cells as facts with the rule "never create, change or estimate a probability; the rank score
  is not a probability". It may only explain them.
