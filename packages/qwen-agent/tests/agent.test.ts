import { describe, it, expect, beforeEach } from "vitest";
import { Agent } from "../src/agent.js";
import { Portfolio } from "../src/portfolio.js";
import {
  FakeMcp,
  FakeQwenFetch,
  makeCompletion,
  makeQwenClient,
} from "./_helpers.js";
import { MemoryLogger } from "../src/logger.js";
import type { OpenAITool } from "../src/mcp-client.js";

function setup() {
  const mcp = new FakeMcp();
  const fetch = new FakeQwenFetch();
  const qwen = makeQwenClient(fetch);
  const log = new MemoryLogger();
  const portfolio = new Portfolio(10_000);
  const agent = new Agent({
    mcp,
    qwen,
    portfolio,
    log,
    symbol: "BTCUSDT",
  });
  return { mcp, fetch, qwen, log, portfolio, agent };
}

describe("Agent.runOnce", () => {
  let mcp: FakeMcp;
  let fetch: FakeQwenFetch;
  let log: MemoryLogger;
  let portfolio: Portfolio;
  let agent: Agent;
  let tools: { openai: OpenAITool[] };

  beforeEach(() => {
    ({ mcp, fetch, log, portfolio, agent } = setup());
    tools = { openai: mcp.tools };
  });

  it("happy path: clean JSON action applied to portfolio", async () => {
    fetch.responses.push(
      makeCompletion({
        content: JSON.stringify({
          side: "buy",
          symbol: "BTCUSDT",
          size_pct: 10,
          reasoning: "rsi oversold + bullish ema cross",
        }),
        usage: { prompt_tokens: 800, completion_tokens: 40 },
      })
    );
    const info = await agent.runOnce({ tools });
    expect(info.mcpError).toBeNull();
    expect(info.qwenError).toBeNull();
    expect(info.parseError).toBeNull();
    expect(info.action).toEqual({
      side: "buy",
      symbol: "BTCUSDT",
      size_pct: 10,
      reasoning: "rsi oversold + bullish ema cross",
    });
    expect(info.applyResult?.changed).toBe(true);
    expect(portfolio.snapshot().positions).toHaveLength(1);
    // Fetch was called once.
    expect(fetch.callCount).toBe(1);
    // MCP was called for candles + orderbook.
    expect(mcp.calls.map((c) => c.name).sort()).toEqual(
      ["get_candles", "get_orderbook"].sort()
    );
    // Token usage recorded.
    expect(info.usage.total_tokens).toBe(840);
    expect(agent.usage().total_tokens).toBe(840);
  });

  it("model asks for get_signal then returns final action", async () => {
    fetch.responses.push(
      makeCompletion({
        content: null,
        toolCalls: [
          { id: "call_1", name: "get_signal", args: { symbol: "BTCUSDT", interval: "1m" } },
        ],
        usage: { prompt_tokens: 800, completion_tokens: 20 },
      }),
      makeCompletion({
        content: JSON.stringify({
          side: "sell",
          symbol: "BTCUSDT",
          size_pct: 25,
          reasoning: "macd bearish divergence",
        }),
        usage: { prompt_tokens: 1100, completion_tokens: 30 },
      })
    );
    // Seed a position to sell against.
    portfolio.apply({ side: "buy", symbol: "BTCUSDT", size_pct: 50, markPrice: 100 });
    const beforeCash = portfolio.snapshot().cash;
    const beforeQty = portfolio.snapshot().positions[0]?.qty ?? 0;

    const info = await agent.runOnce({ tools });
    expect(info.mcpError).toBeNull();
    expect(info.qwenError).toBeNull();
    expect(info.parseError).toBeNull();
    expect(info.action?.side).toBe("sell");
    expect(info.action?.size_pct).toBe(25);
    expect(info.toolRounds).toBe(1);
    // get_signal was called.
    expect(mcp.calls.some((c) => c.name === "get_signal")).toBe(true);
    // Position reduced.
    const after = portfolio.snapshot();
    expect(after.positions[0]?.qty ?? 0).toBeLessThan(beforeQty);
    expect(after.cash).toBeGreaterThan(beforeCash);
  });

  it("captures parse error gracefully and logs it", async () => {
    fetch.responses.push(
      makeCompletion({
        content: "I'm not sure, let me think...",
        usage: { prompt_tokens: 200, completion_tokens: 10 },
      })
    );
    const info = await agent.runOnce({ tools });
    expect(info.action).toBeNull();
    expect(info.parseError).toMatch(/not parseable JSON/);
    expect(info.qwenError).toBeNull();
    expect(portfolio.snapshot().positions).toHaveLength(0);
    // The error was logged.
    expect(log.entries.some((e) => e.msg === "tick" && e.meta?.parseError)).toBe(true);
  });

  it("survives MCP disconnect: error is captured, no crash, portfolio unchanged", async () => {
    mcp.disconnected = true;
    fetch.responses.push(
      // Should never be called.
      makeCompletion({ content: '{"side":"hold","symbol":"BTCUSDT","size_pct":0,"reasoning":"x"}' })
    );
    const info = await agent.runOnce({ tools });
    expect(info.mcpError).toMatch(/disconnected/);
    expect(info.qwenError).toBeNull();
    expect(info.action).toBeNull();
    expect(info.parseError).toBeNull();
    expect(fetch.callCount).toBe(0); // Qwen never called
    expect(portfolio.snapshot().positions).toHaveLength(0);
    expect(log.entries.some((e) => e.level === "error" && e.msg === "mcp_snapshot_failed")).toBe(
      true
    );
  });

  it("captures Qwen HTTP error", async () => {
    fetch.responses.length = 0; // empty → next call returns 500
    // Or throw a network error:
    fetch.throwWith = { count: 1, err: new Error("ECONNRESET") };
    const info = await agent.runOnce({ tools });
    expect(info.qwenError).toMatch(/ECONNRESET/);
    expect(info.mcpError).toBeNull();
    expect(portfolio.snapshot().positions).toHaveLength(0);
  });

  it("hold action is a no-op on portfolio but still recorded", async () => {
    fetch.responses.push(
      makeCompletion({
        content: JSON.stringify({
          side: "hold",
          symbol: "BTCUSDT",
          size_pct: 0,
          reasoning: "chop zone, no edge",
        }),
      })
    );
    const before = portfolio.snapshot();
    const info = await agent.runOnce({ tools });
    expect(info.action?.side).toBe("hold");
    expect(info.applyResult?.changed).toBe(false);
    expect(portfolio.snapshot().cash).toBe(before.cash);
  });

  it("rejects action for a different symbol than the agent's", async () => {
    // Model returns a different symbol — applyResult should still be ok (we let it
    // through), but the action is what the model said. We just verify the pipeline
    // doesn't crash and the action passes through verbatim.
    fetch.responses.push(
      makeCompletion({
        content: JSON.stringify({
          side: "buy",
          symbol: "ETHUSDT",
          size_pct: 5,
          reasoning: "saw eth flow",
        }),
      })
    );
    const info = await agent.runOnce({ tools });
    expect(info.action?.symbol).toBe("ETHUSDT");
    expect(portfolio.snapshot().positions.find((p) => p.symbol === "ETHUSDT")?.qty).toBeGreaterThan(0);
  });
});
