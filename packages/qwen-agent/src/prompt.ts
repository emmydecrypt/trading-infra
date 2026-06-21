/**
 * Prompt builder for the trading agent.
 *
 * System prompt is fixed (persona + output contract). User prompt is rebuilt
 * each tick from the portfolio state + market snapshot.
 */
import type { PortfolioSnapshot } from "./portfolio.js";

export interface MarketSnapshot {
  symbol: string;
  ts: number;
  candles: {
    interval: string;
    ohlc: Array<{ ts: number; o: number; h: number; l: number; c: number; v: number }>;
  };
  orderbook: {
    bids: Array<[number, number]>;
    asks: Array<[number, number]>;
  };
  signal?: unknown; // from get_signal tool, optional at prompt-build time
}

export const SYSTEM_PROMPT = `You are an autonomous crypto trading analyst. You manage a simulated portfolio.

Decision loop:
1. Inspect the market snapshot in the user message (candles, orderbook).
2. If you want indicator data (RSI/EMA/MACD), call the get_signal tool.
3. Return exactly ONE action as a JSON object (no prose, no code fence):
   {"side": "buy"|"sell"|"hold", "symbol": "<SYMBOL>", "size_pct": <0..100>, "reasoning": "<short>"}

Rules:
- side "hold" → size_pct MUST be 0.
- size_pct is a percentage of available CASH for buys, or of held position for sells. Cap at 100.
- reasoning must be <240 chars and cite at least one data point (indicator, price level, etc.).
- Be conservative: prefer "hold" when signal is weak.
- You may also call get_signal at most once per decision.`;

/**
 * Build the user message for one tick.
 */
export function buildUserPrompt(
  portfolio: PortfolioSnapshot,
  market: MarketSnapshot
): string {
  const lastCandles = market.candles.ohlc.slice(-5);
  const last = lastCandles[lastCandles.length - 1];
  const topBid = market.orderbook.bids[0]?.[0];
  const topAsk = market.orderbook.asks[0]?.[0];
  const spread =
    topBid !== undefined && topAsk !== undefined
      ? ((topAsk - topBid) / topAsk) * 10_000
      : null;

  return [
    `# Tick @ ${new Date(market.ts).toISOString()}`,
    `Symbol: ${market.symbol}`,
    `Interval: ${market.candles.interval}`,
    ``,
    `## Portfolio`,
    `- Cash: ${portfolio.cash.toFixed(2)} USDT`,
    `- Positions: ${
      portfolio.positions.length === 0
        ? "(none)"
        : portfolio.positions
            .map(
              (p) =>
                `${p.symbol}: ${p.qty.toFixed(6)} @ avg ${p.avgPrice.toFixed(2)} (mkt ${p.markPrice.toFixed(2)})`
            )
            .join("; ")
    }`,
    `- Equity: ${portfolio.equity.toFixed(2)} USDT`,
    `- Realized PnL: ${portfolio.realizedPnl.toFixed(2)} USDT`,
    ``,
    `## Market (last 5 of ${market.candles.ohlc.length} candles)`,
    ...lastCandles.map(
      (c) =>
        `  ${new Date(c.ts).toISOString()}  O=${c.o} H=${c.h} L=${c.l} C=${c.c} V=${c.v}`
    ),
    ``,
    `## Orderbook (top 3)`,
    ...market.orderbook.bids
      .slice(0, 3)
      .map(([p, q]) => `  bid ${p} x ${q}`),
    ...market.orderbook.asks
      .slice(0, 3)
      .map(([p, q]) => `  ask ${p} x ${q}`),
    spread !== null ? `\nSpread (bps): ${spread.toFixed(2)}` : "",
    last
      ? `\nLast close: ${last.c}\nReturn since first of these 5: ${(
          ((last.c - lastCandles[0].o) / lastCandles[0].o) *
          100
        ).toFixed(3)}%`
      : "",
    ``,
    `## Task`,
    `Decide and return ONE JSON action per the system contract.`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
