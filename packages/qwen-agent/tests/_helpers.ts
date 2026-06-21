/**
 * Shared test helpers / fixtures.
 */
import type { McpClientLike, OpenAITool } from "../src/mcp-client.js";
import type { ChatCompletion, QwenClient } from "../src/qwen.js";
import { QwenClient as QwenClientImpl } from "../src/qwen.js";

/** Fake MCP client. Programmable per tool. */
export class FakeMcp implements McpClientLike {
  tools: OpenAITool[] = [
    {
      type: "function",
      function: {
        name: "get_candles",
        description: "Fetch OHLCV candles",
        parameters: {
          type: "object",
          properties: {
            symbol: { type: "string" },
            interval: { type: "string" },
            limit: { type: "number" },
          },
          required: ["symbol", "interval"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_orderbook",
        description: "Fetch order book",
        parameters: {
          type: "object",
          properties: {
            symbol: { type: "string" },
            limit: { type: "number" },
          },
          required: ["symbol"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_signal",
        description: "Compute indicator signal",
        parameters: {
          type: "object",
          properties: {
            symbol: { type: "string" },
            interval: { type: "string" },
          },
          required: ["symbol"],
        },
      },
    },
  ];
  /** Map of tool name → result. */
  results: Map<string, unknown> = new Map();
  /** Map of tool name → throw. */
  errors: Map<string, Error> = new Map();
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  closed = false;
  listToolsCalls = 0;
  /** If true, callTool throws "disconnected". */
  disconnected = false;

  constructor() {
    // Sensible defaults
    this.results.set("get_candles", {
      interval: "1m",
      ohlc: synthCandles(60, 30_000),
    });
    this.results.set("get_orderbook", {
      bids: [
        [29_999, 1.5],
        [29_998, 2.1],
      ],
      asks: [
        [30_001, 1.4],
        [30_002, 1.9],
      ],
    });
    this.results.set("get_signal", {
      side: "long",
      strength: 0.42,
      indicators: { rsi: 56, ema9: 30_010, ema21: 29_900, macd: 12 },
    });
  }

  async listTools(): Promise<OpenAITool[]> {
    this.listToolsCalls++;
    return this.tools;
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args });
    if (this.disconnected) throw new Error("MCP disconnected: pipe closed");
    const e = this.errors.get(name);
    if (e) throw e;
    const r = this.results.get(name);
    if (r === undefined) throw new Error(`No fake result for ${name}`);
    return r;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Programmable fetch mock for Qwen. */
export class FakeQwenFetch {
  responses: ChatCompletion[] = [];
  /** If set, the next N calls throw this error. */
  throwWith: { count: number; err: Error } | null = null;
  calls: Array<{ url: string; body: any }> = [];
  callCount = 0;

  fetchImpl: typeof fetch = async (input, init) => {
    this.callCount++;
    const url = typeof input === "string" ? input : input.toString();
    let body: any = undefined;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = init?.body;
    }
    this.calls.push({ url, body });
    if (this.throwWith && this.throwWith.count > 0) {
      this.throwWith.count--;
      throw this.throwWith.err;
    }
    if (this.responses.length === 0) {
      return new Response(
        JSON.stringify({ error: { message: "no more fake responses" } }),
        { status: 500 }
      );
    }
    const next = this.responses.shift()!;
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/** Helper to build a ChatCompletion. */
export function makeCompletion(opts: {
  content?: string | null;
  toolCalls?: Array<{ id: string; name: string; args: object }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}): ChatCompletion {
  const message: ChatCompletion["choices"][0]["message"] = {
    role: "assistant",
    content: opts.content ?? null,
  };
  if (opts.toolCalls && opts.toolCalls.length > 0) {
    message.tool_calls = opts.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.args),
      },
    }));
  }
  return {
    id: "chatcmpl-test",
    model: "qwen-plus",
    choices: [{ index: 0, message, finish_reason: "stop" }],
    usage: {
      prompt_tokens: opts.usage?.prompt_tokens ?? 100,
      completion_tokens: opts.usage?.completion_tokens ?? 30,
      total_tokens: (opts.usage?.prompt_tokens ?? 100) + (opts.usage?.completion_tokens ?? 30),
    },
  };
}

/** Build a QwenClient whose fetch is the FakeQwenFetch's fetchImpl. */
export function makeQwenClient(fake: FakeQwenFetch): QwenClient {
  return new QwenClientImpl({
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
    model: "qwen-plus",
    fetchImpl: fake.fetchImpl,
  });
}

/** Synthesize N OHLCV candles with a slight uptrend for tests. */
export function synthCandles(n: number, startPrice = 30_000): Array<{
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}> {
  const out = [];
  let p = startPrice;
  for (let i = 0; i < n; i++) {
    const o = p;
    const drift = 0.0005;
    const noise = ((i * 9301 + 49297) % 233280) / 233280 - 0.5;
    const c = o * (1 + drift + noise * 0.004);
    const h = Math.max(o, c) * (1 + Math.abs(noise) * 0.001);
    const l = Math.min(o, c) * (1 - Math.abs(noise) * 0.001);
    out.push({
      ts: 1_700_000_000_000 + i * 60_000,
      o,
      h,
      l,
      c,
      v: 100 + i,
    });
    p = c;
  }
  return out;
}

/** Convenience: a snapshot compatible with buildUserPrompt. */
export function sampleSnapshot() {
  return {
    symbol: "BTCUSDT",
    ts: 1_700_000_000_000,
    candles: { interval: "1m", ohlc: synthCandles(60, 30_000) },
    orderbook: {
      bids: [
        [29_999, 1.5],
        [29_998, 2.1],
      ] as Array<[number, number]>,
      asks: [
        [30_001, 1.4],
        [30_002, 1.9],
      ] as Array<[number, number]>,
    },
  };
}

/** Snapshot for portfolio tests. */
export function samplePortfolio() {
  return {
    cash: 9_500,
    positions: [
      { symbol: "BTCUSDT", qty: 0.01666, avgPrice: 30_000, markPrice: 30_500 },
    ],
    equity: 9_500 + 0.01666 * 30_500,
    realizedPnl: -25,
  };
}

/** Read the env block we need. */
export function withEnv(vars: Record<string, string>, fn: () => void | Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    process.env[k] = vars[k];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}
