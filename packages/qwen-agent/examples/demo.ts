/**
 * End-to-end demo of the agent loop with a fully mocked MCP server and
 * mocked Qwen fetch. No real network, no real trades.
 *
 * Run with:
 *   npx tsx examples/demo.ts
 */
import { Agent } from "../src/agent.js";
import { Portfolio } from "../src/portfolio.js";
import { FileLogger } from "../src/logger.js";
import type { McpClientLike, OpenAITool } from "../src/mcp-client.js";
import type { ChatCompletion } from "../src/qwen.js";
import { QwenClient } from "../src/qwen.js";

class FakeMcp implements McpClientLike {
  tick = 0;
  tools: OpenAITool[] = [
    {
      type: "function",
      function: {
        name: "get_candles",
        description: "Fetch OHLCV candles",
        parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
      },
    },
    {
      type: "function",
      function: {
        name: "get_orderbook",
        description: "Fetch order book",
        parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
      },
    },
    {
      type: "function",
      function: {
        name: "get_signal",
        description: "Compute indicator signal",
        parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
      },
    },
  ];
  async listTools() {
    return this.tools;
  }
  async callTool(name: string) {
    if (name === "get_candles") {
      const ohlc = [];
      let p = 30_000;
      for (let i = 0; i < 60; i++) {
        const o = p;
        p = p * 1.0005;
        ohlc.push({ ts: 1_700_000_000_000 + i * 60_000, o, h: o * 1.001, l: o * 0.999, c: p, v: 100 });
      }
      return { interval: "1m", ohlc };
    }
    if (name === "get_orderbook") {
      return {
        bids: [[29_999, 1.5], [29_998, 2.1]],
        asks: [[30_001, 1.4], [30_002, 1.9]],
      };
    }
    if (name === "get_signal") {
      return {
        side: this.tick % 2 === 0 ? "long" : "short",
        strength: 0.5,
        indicators: { rsi: this.tick % 2 === 0 ? 35 : 65 },
      };
    }
    throw new Error(`unknown tool ${name}`);
  }
  async close() {}
}

function cannedCompletion(action: object): ChatCompletion {
  return {
    id: "demo",
    model: "qwen-plus",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(action) },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 850, completion_tokens: 45, total_tokens: 895 },
  };
}

async function main() {
  const log = new FileLogger({ filePath: "logs/demo.log", echo: true });
  const mcp = new FakeMcp();
  const scripted = [
    cannedCompletion({ side: "buy", symbol: "BTCUSDT", size_pct: 20, reasoning: "rsi oversold + bullish ema cross" }),
    cannedCompletion({ side: "hold", symbol: "BTCUSDT", size_pct: 0, reasoning: "chop zone, no edge" }),
    cannedCompletion({ side: "sell", symbol: "BTCUSDT", size_pct: 50, reasoning: "macd bearish divergence" }),
  ];
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify(scripted.shift() ?? cannedCompletion({ side: "hold", symbol: "BTCUSDT", size_pct: 0, reasoning: "x" })), { status: 200 });
  const qwen = new QwenClient({
    baseUrl: "https://demo.invalid/v1",
    apiKey: "demo",
    model: "qwen-plus",
    fetchImpl,
  });
  const portfolio = new Portfolio(10_000);
  const agent = new Agent({ mcp, qwen, portfolio, log, symbol: "BTCUSDT" });
  const tools = await mcp.listTools();
  for (let i = 0; i < 3; i++) {
    mcp.tick = i;
    const info = await agent.runOnce({ tools: { openai: tools } });
    console.log(
      `tick=${i} action=${info.action?.side} size_pct=${info.action?.size_pct} equity=${info.portfolioAfter.equity.toFixed(2)} usage=${info.usage.total_tokens}`
    );
  }
  console.log("\n=== final ===");
  console.log(JSON.stringify(portfolio.snapshot(), null, 2));
  console.log("usage:", agent.usage());
  await log.flush();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
