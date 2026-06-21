import { describe, it, expect } from "vitest";
import { compositeScore, rankAgents } from "../src/score/composite.js";
import type { Metrics } from "../src/types.js";

const M = (overrides: Partial<Metrics> = {}): Metrics => ({
  sharpe: 0,
  sortino: 0,
  calmar: 0,
  profit_factor: 0,
  max_drawdown: 0,
  total_return: 0,
  n_trades: 0,
  ...overrides,
});

describe("composite score", () => {
  it("applies the documented weights: 0.4 sharpe + 0.2 sortino + 0.2 calmar + 0.1 pf + 0.1 (1+dd)", () => {
    const m = M({ sharpe: 1, sortino: 1, calmar: 1, profit_factor: 1, max_drawdown: 0 });
    // 0.4*1 + 0.2*1 + 0.2*1 + 0.1*1 + 0.1*(1+0) = 1.0
    expect(compositeScore(m)).toBeCloseTo(1.0, 6);
    const m2 = M({ sharpe: 1, sortino: 1, calmar: 1, profit_factor: 1, max_drawdown: -1 });
    // dd term at -1 contributes 0, so total = 0.9
    expect(compositeScore(m2)).toBeCloseTo(0.9, 6);
  });

  it("penalizes large drawdowns (max_drawdown is negative)", () => {
    const good = M({ sharpe: 1, sortino: 1, calmar: 1, profit_factor: 1, max_drawdown: -0.1 });
    const bad = M({ sharpe: 1, sortino: 1, calmar: 1, profit_factor: 1, max_drawdown: -0.5 });
    expect(compositeScore(good)).toBeGreaterThan(compositeScore(bad));
  });

  it("drawdown term contributes (1 + max_drawdown) * 0.1 — 0 dd gives 0.1, total loss gives 0", () => {
    const zero = M({ max_drawdown: 0 });
    const half = M({ max_drawdown: -0.5 });
    const total = M({ max_drawdown: -1 });
    // baseline term contribution = weight * (1 + dd)
    expect(compositeScore(zero) - compositeScore({ ...zero, max_drawdown: -1e6 })).toBeCloseTo(0.1, 6);
    expect(compositeScore(half) - compositeScore(total)).toBeCloseTo(0.5 * 0.1, 6);
  });

  it("returns 0 when sharpe/sortino are non-finite (avoids NaN poisoning the leaderboard)", () => {
    const m = M({ sharpe: Number.NaN, sortino: 1 });
    expect(compositeScore(m)).toBe(0);
  });

  it("ranks agents in descending order by composite by default", () => {
    const agents = [
      { id: 1, metrics: M({ sharpe: 0.5 }) },
      { id: 2, metrics: M({ sharpe: 2.0 }) },
      { id: 3, metrics: M({ sharpe: 1.0 }) },
    ];
    const ranked = rankAgents(agents, "composite");
    expect(ranked.map((a) => a.id)).toEqual([2, 3, 1]);
  });

  it("ranks by an arbitrary metric when requested", () => {
    const agents = [
      { id: 1, metrics: M({ max_drawdown: -0.3 }) },
      { id: 2, metrics: M({ max_drawdown: -0.05 }) },
      { id: 3, metrics: M({ max_drawdown: -0.1 }) },
    ];
    // max_drawdown is negative; higher (closer to 0) is better.
    const ranked = rankAgents(agents, "max_drawdown");
    expect(ranked.map((a) => a.id)).toEqual([2, 3, 1]);
  });

  it("treats null metrics as -Infinity so they sort to the bottom", () => {
    const agents = [
      { id: 1, metrics: null },
      { id: 2, metrics: M({ sharpe: 0.1 }) },
    ];
    const ranked = rankAgents(agents, "composite");
    expect(ranked.map((a) => a.id)).toEqual([2, 1]);
  });
});