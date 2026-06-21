import { describe, it, expect } from "vitest";
import { runAgentAgainstDatasets } from "../src/sandbox/runner.js";
import { MOMENTUM_AGENT, RANDOM_AGENT, SMA_CROSS_AGENT } from "../src/examples/agents.js";

describe("runner (end-to-end against Python backtester)", () => {
  it(
    "produces a metrics object for the sma-cross agent on BTCUSDT/ETHUSDT/SOLUSDT",
    async () => {
      const result = await runAgentAgainstDatasets(SMA_CROSS_AGENT);
      expect(result.ok).toBe(true);
      expect(result.error).toBeNull();
      expect(result.metrics).toBeTruthy();
      const m = result.metrics!;
      expect(typeof m.sharpe).toBe("number");
      expect(typeof m.sortino).toBe("number");
      expect(typeof m.calmar).toBe("number");
      expect(typeof m.profit_factor).toBe("number");
      expect(typeof m.max_drawdown).toBe("number");
      expect(m.max_drawdown).toBeLessThanOrEqual(0);
      expect(result.duration_ms).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    "produces a metrics object for the random agent",
    async () => {
      const result = await runAgentAgainstDatasets(RANDOM_AGENT);
      expect(result.ok).toBe(true);
      expect(result.metrics).toBeTruthy();
    },
    60_000,
  );

  it(
    "produces a metrics object for the momentum agent",
    async () => {
      const result = await runAgentAgainstDatasets(MOMENTUM_AGENT);
      expect(result.ok).toBe(true);
      expect(result.metrics).toBeTruthy();
    },
    60_000,
  );

  it(
    "records a failure when the agent code throws on every bar",
    async () => {
      const code = `
        function strategy() { throw new Error('always fails'); }
      `;
      const result = await runAgentAgainstDatasets(code);
      expect(result.ok).toBe(false);
      expect(result.metrics).toBeNull();
      expect(result.error).toMatch(/fails/);
    },
    60_000,
  );
});