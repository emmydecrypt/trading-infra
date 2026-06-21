/**
 * Agent loop: per-tick decision cycle.
 *
 *  1. Fetch market snapshot (candles + orderbook) via MCP.
 *  2. Optionally call get_signal via MCP if the LLM asks for it.
 *  3. Get final action JSON from the LLM.
 *  4. Apply to simulated portfolio.
 *  5. Log to logs/agent.log.
 */
import type { McpClientLike } from "./mcp-client.js";
import type { QwenClient, ChatMessage, ChatCompletion } from "./qwen.js";
import { buildUserPrompt, SYSTEM_PROMPT, type MarketSnapshot } from "./prompt.js";
import { parseAction, type Action, ActionParseError } from "./action.js";
import { Portfolio, type PortfolioSnapshot, type ApplyActionResult } from "./portfolio.js";

export interface AgentLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface AgentDeps {
  mcp: McpClientLike;
  qwen: QwenClient;
  portfolio: Portfolio;
  log: AgentLogger;
  symbol: string;
  /** Candle interval. */
  interval?: string;
  /** Max tool-call rounds per tick (prevent infinite loops). */
  maxToolRounds?: number;
  /** Temperature for Qwen. */
  temperature?: number;
  /** Hook called after each tick (e.g. for emitting live updates). */
  onTick?: (info: TickInfo) => void | Promise<void>;
}

export interface TickInfo {
  ts: number;
  portfolioBefore: PortfolioSnapshot;
  portfolioAfter: PortfolioSnapshot;
  action: Action | null;
  applyResult: ApplyActionResult | null;
  parseError: string | null;
  mcpError: string | null;
  qwenError: string | null;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  toolRounds: number;
  rawAction: string | null;
}

export class Agent {
  private readonly mcp: McpClientLike;
  private readonly qwen: QwenClient;
  private readonly portfolio: Portfolio;
  private readonly log: AgentLogger;
  private readonly symbol: string;
  private readonly interval: string;
  private readonly maxToolRounds: number;
  private readonly temperature: number;
  private readonly onTick?: (info: TickInfo) => void | Promise<void>;
  private totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  constructor(deps: AgentDeps) {
    this.mcp = deps.mcp;
    this.qwen = deps.qwen;
    this.portfolio = deps.portfolio;
    this.log = deps.log;
    this.symbol = deps.symbol;
    this.interval = deps.interval ?? "1m";
    this.maxToolRounds = deps.maxToolRounds ?? 2;
    this.temperature = deps.temperature ?? 0.2;
    this.onTick = deps.onTick;
  }

  /** Total token usage accumulated across all ticks run by this Agent. */
  usage() {
    return { ...this.totalUsage };
  }

  /**
   * Run a single tick. Returns the tick info; throws only on programmer
   * errors. All runtime errors are captured in the TickInfo.
   */
  async runOnce(opts: { tools: { openai: Awaited<ReturnType<McpClientLike["listTools"]>> } }): Promise<TickInfo> {
    const ts = Date.now();
    const before = this.portfolio.snapshot();
    let mcpError: string | null = null;
    let qwenError: string | null = null;
    let parseError: string | null = null;
    let action: Action | null = null;
    let applyResult: ApplyActionResult | null = null;
    let rawAction: string | null = null;
    let toolRounds = 0;
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let market: MarketSnapshot | null = null;

    // 1) Fetch market snapshot via MCP.
    try {
      const [candlesRaw, obRaw] = await Promise.all([
        this.mcp.callTool("get_candles", { symbol: this.symbol, interval: this.interval, limit: 60 }),
        this.mcp.callTool("get_orderbook", { symbol: this.symbol, limit: 10 }),
      ]);
      market = coerceSnapshot(candlesRaw, obRaw, this.symbol, this.interval, ts);
    } catch (err) {
      mcpError = errMsg(err);
      this.log.error("mcp_snapshot_failed", { error: mcpError, symbol: this.symbol });
    }

    if (market) {
      // 2) LLM round(s).
      try {
        const out = await this.runLlm(market, opts.tools.openai);
        action = out.action;
        rawAction = out.rawAction;
        toolRounds = out.toolRounds;
        usage = out.usage;
        if (action) {
          // 4) Apply to portfolio.
          const markPrice = lastPrice(market);
          applyResult = this.portfolio.apply({
            side: action.side,
            symbol: action.symbol,
            size_pct: action.size_pct,
            markPrice,
          });
        } else {
          parseError = out.parseError;
        }
      } catch (err) {
        qwenError = errMsg(err);
        this.log.error("qwen_call_failed", { error: qwenError });
      }
    }

    const after = this.portfolio.snapshot();
    this.totalUsage.prompt_tokens += usage.prompt_tokens;
    this.totalUsage.completion_tokens += usage.completion_tokens;
    this.totalUsage.total_tokens += usage.total_tokens;

    const info: TickInfo = {
      ts,
      portfolioBefore: before,
      portfolioAfter: after,
      action,
      applyResult,
      parseError,
      mcpError,
      qwenError,
      usage,
      toolRounds,
      rawAction,
    };

    this.log.info("tick", {
      ts,
      symbol: this.symbol,
      action,
      applyResult,
      parseError,
      mcpError,
      qwenError,
      usage,
      equity: after.equity,
      cash: after.cash,
      positions: after.positions,
    });

    if (this.onTick) await this.onTick(info);
    return info;
  }

  private async runLlm(
    market: MarketSnapshot,
    openaiTools: Awaited<ReturnType<McpClientLike["listTools"]>>
  ): Promise<{
    action: Action | null;
    rawAction: string | null;
    parseError: string | null;
    toolRounds: number;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }> {
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(this.portfolio.snapshot(), market) },
    ];
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let toolRounds = 0;
    let last: ChatCompletion | null = null;

    for (let i = 0; i <= this.maxToolRounds; i++) {
      last = await this.qwen.chat({
        messages,
        tools: openaiTools,
        tool_choice: "auto",
        temperature: this.temperature,
        max_tokens: 600,
      });
      accumulateUsage(usage, last.usage);
      const choice = last.choices[0];
      if (!choice) throw new Error("Qwen returned no choices");
      const msg = choice.message;
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Final assistant message — should contain the JSON action.
        const raw = msg.content ?? "";
        try {
          return {
            action: parseAction(raw),
            rawAction: raw,
            parseError: null,
            toolRounds: i,
            usage,
          };
        } catch (err) {
          if (err instanceof ActionParseError) {
            return {
              action: null,
              rawAction: raw,
              parseError: err.message,
              toolRounds: i,
              usage,
            };
          }
          throw err;
        }
      }

      // Tool-call round. Append assistant turn and call each tool, then loop.
      toolRounds = i + 1;
      messages.push({
        role: "assistant",
        content: msg.content,
        tool_calls: msg.tool_calls,
      });
      for (const call of msg.tool_calls) {
        let toolResultPayload: unknown;
        try {
          const args = JSON.parse(call.function.arguments || "{}");
          toolResultPayload = await this.mcp.callTool(call.function.name, args);
        } catch (err) {
          toolResultPayload = { error: errMsg(err) };
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify(toolResultPayload).slice(0, 4000),
        });
      }
    }
    // Exhausted tool rounds without a final action.
    return {
      action: null,
      rawAction: last?.choices[0]?.message.content ?? null,
      parseError: `Exceeded ${this.maxToolRounds} tool rounds without final action`,
      toolRounds,
      usage,
    };
  }
}

function accumulateUsage(
  acc: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
  u: ChatCompletion["usage"] | undefined
): void {
  if (!u) return;
  acc.prompt_tokens += u.prompt_tokens ?? 0;
  acc.completion_tokens += u.completion_tokens ?? 0;
  acc.total_tokens += u.total_tokens ?? acc.prompt_tokens + acc.completion_tokens;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

interface RawCandles {
  ohlc?: Array<{ ts?: number; o?: number; h?: number; l?: number; c?: number; v?: number }>;
  interval?: string;
}
interface RawOrderbook {
  bids?: Array<[number, number]>;
  asks?: Array<[number, number]>;
}

function coerceSnapshot(
  candlesRaw: unknown,
  obRaw: unknown,
  symbol: string,
  interval: string,
  ts: number
): MarketSnapshot {
  const c = candlesRaw as RawCandles;
  const o = obRaw as RawOrderbook;
  return {
    symbol,
    ts,
    candles: {
      interval: c?.interval ?? interval,
      ohlc: (c?.ohlc ?? []).map((row) => ({
        ts: Number(row.ts ?? 0),
        o: Number(row.o ?? 0),
        h: Number(row.h ?? 0),
        l: Number(row.l ?? 0),
        c: Number(row.c ?? 0),
        v: Number(row.v ?? 0),
      })),
    },
    orderbook: {
      bids: (o?.bids ?? []).map(([p, q]) => [Number(p), Number(q)] as [number, number]),
      asks: (o?.asks ?? []).map(([p, q]) => [Number(p), Number(q)] as [number, number]),
    },
  };
}

function lastPrice(m: MarketSnapshot): number {
  const last = m.candles.ohlc[m.candles.ohlc.length - 1];
  if (last && last.c > 0) return last.c;
  const mid =
    (m.orderbook.bids[0]?.[0] ?? 0) + (m.orderbook.asks[0]?.[0] ?? 0);
  return mid / 2 || 0;
}
