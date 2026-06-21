import { describe, it, expect } from "vitest";
import { Portfolio } from "../src/portfolio.js";

describe("Portfolio", () => {
  it("starts with given cash and no positions", () => {
    const p = new Portfolio(10_000);
    const s = p.snapshot();
    expect(s.cash).toBe(10_000);
    expect(s.positions).toEqual([]);
    expect(s.equity).toBe(10_000);
    expect(s.realizedPnl).toBe(0);
  });

  it("rejects negative initial cash", () => {
    expect(() => new Portfolio(-1)).toThrow();
  });

  it("buy allocates size_pct% of cash and creates a position", () => {
    const p = new Portfolio(10_000);
    const r = p.apply({ side: "buy", symbol: "BTCUSDT", size_pct: 50, markPrice: 100 });
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    const s = p.snapshot();
    expect(s.cash).toBeCloseTo(5_000, 6);
    expect(s.positions).toHaveLength(1);
    expect(s.positions[0].symbol).toBe("BTCUSDT");
    expect(s.positions[0].qty).toBeCloseTo(50, 6);
    expect(s.positions[0].avgPrice).toBe(100);
    expect(s.equity).toBeCloseTo(10_000, 6);
  });

  it("buy is average-cost on top of existing position", () => {
    const p = new Portfolio(10_000);
    p.apply({ side: "buy", symbol: "BTCUSDT", size_pct: 10, markPrice: 100 });
    p.apply({ side: "buy", symbol: "BTCUSDT", size_pct: 10, markPrice: 200 });
    const s = p.snapshot();
    // First buy: 10% of 10000 = 1000 -> 10 qty @ 100; cash=9000
    // Second buy: 10% of 9000 = 900 -> 4.5 qty @ 200; cash=8100
    // Total qty = 14.5, total cost = 1900, avg = 1900/14.5 = 131.034...
    expect(s.positions[0].qty).toBeCloseTo(14.5, 6);
    expect(s.positions[0].avgPrice).toBeCloseTo(1900 / 14.5, 3);
    expect(s.cash).toBeCloseTo(8_100, 6);
  });

  it("sell reduces position and books realized pnl", () => {
    const p = new Portfolio(10_000);
    p.apply({ side: "buy", symbol: "BTCUSDT", size_pct: 50, markPrice: 100 });
    const before = p.snapshot();
    const r = p.apply({ side: "sell", symbol: "BTCUSDT", size_pct: 50, markPrice: 150 });
    expect(r.ok).toBe(true);
    const s = p.snapshot();
    // Sold 25 qty at 150 vs avg 100 → +50 per unit, total +1250 realized pnl
    expect(s.realizedPnl).toBeCloseTo(before.realizedPnl + 1250, 4);
    // Cash: 5000 + 25*150 = 8750
    expect(s.cash).toBeCloseTo(8_750, 4);
  });

  it("sell of full position removes it and books full pnl", () => {
    const p = new Portfolio(10_000);
    p.apply({ side: "buy", symbol: "BTCUSDT", size_pct: 20, markPrice: 100 });
    const r = p.apply({ side: "sell", symbol: "BTCUSDT", size_pct: 100, markPrice: 200 });
    expect(r.ok).toBe(true);
    const s = p.snapshot();
    expect(s.positions).toHaveLength(0);
    // Bought 20 qty @ 100 (cost 2000, cash 8000), sold 20 @ 200 (proceeds 4000, cash 12000)
    expect(s.cash).toBeCloseTo(12_000, 4);
    expect(s.realizedPnl).toBeCloseTo(2_000, 4);
  });

  it("sell with no position is a no-op (ok=false)", () => {
    const p = new Portfolio(10_000);
    const r = p.apply({ side: "sell", symbol: "BTCUSDT", size_pct: 50, markPrice: 100 });
    expect(r.ok).toBe(false);
    expect(r.changed).toBe(false);
    expect(p.snapshot().cash).toBe(10_000);
  });

  it("hold is a no-op", () => {
    const p = new Portfolio(10_000);
    const r = p.apply({ side: "hold", symbol: "BTCUSDT", size_pct: 0, markPrice: 100 });
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(false);
  });

  it("rejects size_pct out of range or non-positive mark", () => {
    const p = new Portfolio(10_000);
    expect(
      p.apply({ side: "buy", symbol: "BTCUSDT", size_pct: 150, markPrice: 100 }).ok
    ).toBe(false);
    expect(
      p.apply({ side: "buy", symbol: "BTCUSDT", size_pct: 10, markPrice: 0 }).ok
    ).toBe(false);
    expect(
      p.apply({ side: "buy", symbol: "BTCUSDT", size_pct: -1, markPrice: 100 }).ok
    ).toBe(false);
  });

  it("mark() updates markPrice for equity calc but not avgPrice", () => {
    const p = new Portfolio(10_000);
    p.apply({ side: "buy", symbol: "BTCUSDT", size_pct: 50, markPrice: 100 });
    p.mark("BTCUSDT", 200);
    const s = p.snapshot();
    expect(s.positions[0].markPrice).toBe(200);
    expect(s.positions[0].avgPrice).toBe(100);
    expect(s.equity).toBeCloseTo(5_000 + 50 * 200, 4);
  });
});
