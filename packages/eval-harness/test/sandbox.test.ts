import { describe, it, expect } from "vitest";
import { callStrategy, compileAgent, stripTypeAnnotations } from "../src/sandbox/runAgent.js";
import type { MarketDataPoint, Portfolio } from "../src/types.js";
import { MOMENTUM_AGENT, RANDOM_AGENT, SMA_CROSS_AGENT } from "../src/examples/agents.js";

const market = (price: number, history: number[]): MarketDataPoint => ({
  timestamp: "2024-06-01T00:00:00Z",
  symbol: "BTCUSDT",
  price,
  history,
});

const portfolio: Portfolio = {
  cash: 1000,
  position_qty: 0,
  position_symbol: null,
  entry_price: 0,
  equity: 1000,
};

describe("sandbox", () => {
  it("strips interface/type annotations before compiling", () => {
    expect(stripTypeAnnotations("interface X { a: number; }")).toBe("");
    expect(stripTypeAnnotations("type X = number;")).toBe("");
    expect(stripTypeAnnotations("function f(a: number): number { return a }")).toBe(
      "function f(a) { return a }",
    );
    expect(stripTypeAnnotations("const x = 1 as number;")).toBe("const x = 1;");
  });

  it("compiles and runs a TypeScript-style agent", () => {
    const r = compileAgent(SMA_CROSS_AGENT);
    expect(r.ok).toBe(true);
    expect(typeof r.strategy).toBe("function");
    const rising = Array.from({ length: 50 }, (_, i) => 100 + i * 0.5);
    const action = callStrategy(r.strategy!, market(125, rising), portfolio);
    expect(action.ok).toBe(true);
    if (action.ok) {
      expect(action.action.side).toBe("buy");
    }
  });

  it("rejects code that does not export a strategy function", () => {
    const r = compileAgent("const x = 1;");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/strategy/);
  });

  it("enforces the 1-second per-call wall-clock budget", () => {
    // Spin in a tight loop; the vm Script runner should kill us at the timeout.
    // The spin lives inside the strategy body so it fires on call, not compile.
    const code = `
      function strategy(marketData, portfolio) {
        const end = Date.now() + 5000;
        while (Date.now() < end) { /* spin */ }
        return { side: 'hold', symbol: 'BTCUSDT', size_pct: 0 };
      }
    `;
    const r = compileAgent(code, { timeoutMs: 200 });
    expect(r.ok).toBe(true);
    const action = callStrategy(r.strategy!, market(100, [100]), portfolio, { timeoutMs: 200 });
    expect(action.ok).toBe(false);
    if (!action.ok) {
      expect(action.error).toMatch(/timed out|timeout|exceeded/i);
    }
  });

  it("captures runtime errors thrown by user code", () => {
    const code = `
      function strategy() { throw new Error('boom'); }
    `;
    const r = compileAgent(code);
    expect(r.ok).toBe(true); // compile succeeds
    expect(r.strategy).not.toBeNull();
    const action = callStrategy(r.strategy!, market(100, [100]), portfolio);
    expect(action.ok).toBe(false);
    if (!action.ok) {
      expect(action.error).toMatch(/boom/);
    }
  });

  it("rejects an action with the wrong shape", () => {
    const code = `
      function strategy() { return { side: 'BUY', size_pct: 2 }; }
    `;
    const r = compileAgent(code);
    const action = callStrategy(r.strategy!, market(100, [100]), portfolio);
    expect(action.ok).toBe(false);
    if (!action.ok) {
      expect(action.error).toMatch(/invalid/);
    }
  });

  it("runs the shipped example agents without throwing", () => {
    for (const code of [RANDOM_AGENT, SMA_CROSS_AGENT, MOMENTUM_AGENT]) {
      const r = compileAgent(code);
      expect(r.ok).toBe(true);
      const m = market(100, Array.from({ length: 50 }, (_, i) => 100 + i));
      const action = callStrategy(r.strategy!, m, portfolio);
      expect(action.ok).toBe(true);
    }
  });
});