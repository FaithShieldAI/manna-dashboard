'use strict';
/**
 * ROI calculations (shared by email campaigns, funnels, overview rollup).
 *
 * roi_pct definition:
 *   - cost > 0:  ((revenue - cost) / cost) * 100, rounded to 1 decimal
 *   - cost == 0 and revenue > 0: null  ("infinite" — reported as null, UI shows ∞)
 *   - cost == 0 and revenue == 0: null (no data)
 * profit_cents = revenue_cents - cost_cents (can be negative)
 */

function roi(costCents, revenueCents) {
  const cost = Number(costCents) || 0;
  const revenue = Number(revenueCents) || 0;
  const profitCents = revenue - cost;
  let roiPct = null;
  if (cost > 0) {
    roiPct = +(((revenue - cost) / cost) * 100).toFixed(1);
  }
  return { cost_cents: cost, revenue_cents: revenue, profit_cents: profitCents, roi_pct: roiPct };
}

/** Sum ROI across a list of { cost_cents, revenue_cents } rows. */
function rollup(rows) {
  const cost = rows.reduce((a, r) => a + (Number(r.cost_cents) || 0), 0);
  const revenue = rows.reduce((a, r) => a + (Number(r.revenue_cents) || 0), 0);
  return roi(cost, revenue);
}

module.exports = { roi, rollup };
