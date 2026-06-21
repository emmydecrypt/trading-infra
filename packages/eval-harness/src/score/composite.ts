import type { Metrics } from "../types.js";

/**
 * Weights for the composite leaderboard score.
 *
 *   composite = 0.40 * sharpe
 *             + 0.20 * sortino
 *             + 0.20 * calmar
 *             + 0.10 * profit_factor
 *             + 0.10 * (1 + max_drawdown)
 *
 * Notes on the drawdown term:
 *   - `max_drawdown` is reported as a negative number (e.g. -0.18 for an 18%
 *     peak-to-trough loss). `(1 + max_drawdown)` is therefore in [0, 1] and
 *     equals the fraction of equity retained at the trough.
 *   - A larger drawdown makes this term smaller, which is the intended
 *     penalty. The task spec wrote this term as `-max_drawdown`; with the
 *     negative-sign convention we adopt here the equivalent, well-defined
 *     expression is `(1 + max_drawdown)` so the term is bounded and
 *     monotonic in the right direction.
 *
 * `profit_factor` is unbounded above; a value of 5 contributes 0.5 to the
 * score. Other terms use their natural scales (sharpe/sortino/calmar are
 * unitless risk-adjusted returns).
 */
export const COMPOSITE_WEIGHTS = {
  sharpe: 0.4,
  sortino: 0.2,
  calmar: 0.2,
  profit_factor: 0.1,
  drawdown: 0.1,
} as const;

export function compositeScore(metrics: Metrics): number {
  if (!Number.isFinite(metrics.sharpe) || !Number.isFinite(metrics.sortino)) return 0;
  // Clamp the drawdown term to [0, 1] so an absurdly negative drawdown
  // (e.g. from a broken backtest) cannot push the score to -Infinity.
  const rawDd = Number.isFinite(metrics.max_drawdown) ? metrics.max_drawdown : 0;
  const ddTerm = Math.max(0, Math.min(1, 1 + rawDd));
  const score =
    COMPOSITE_WEIGHTS.sharpe * metrics.sharpe +
    COMPOSITE_WEIGHTS.sortino * metrics.sortino +
    COMPOSITE_WEIGHTS.calmar * metrics.calmar +
    COMPOSITE_WEIGHTS.profit_factor * metrics.profit_factor +
    COMPOSITE_WEIGHTS.drawdown * ddTerm;
  return round6(score);
}

function round6(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 1e6) / 1e6;
}

export function rankAgents<T extends { metrics: Metrics | null }>(
  entries: T[],
  metric: keyof Metrics | "composite",
): T[] {
  const score = (e: T): number => {
    if (!e.metrics) return -Infinity;
    if (metric === "composite") return compositeScore(e.metrics);
    const v = e.metrics[metric];
    return typeof v === "number" && Number.isFinite(v) ? v : -Infinity;
  };
  return [...entries].sort((a, b) => score(b) - score(a));
}