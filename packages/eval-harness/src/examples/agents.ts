// Three example agents shipped with the harness. These double as docs and
// as smoke tests for the submission pipeline.

export const RANDOM_AGENT = `// Random agent — 50% buy, 50% hold at random size.
// Useful as a baseline; expected to lose money on average.
interface MarketData { timestamp: string; symbol: string; price: number; history: number[]; }
interface Portfolio { cash: number; position_qty: number; position_symbol: string | null; entry_price: number; equity: number; }
interface Action { side: 'buy' | 'sell' | 'hold'; symbol: string; size_pct: number; }

function strategy(marketData: MarketData, portfolio: Portfolio): Action {
  const r = Math.random();
  if (r < 0.3) return { side: 'buy', symbol: marketData.symbol, size_pct: 0.2 };
  if (r < 0.5 && portfolio.position_qty > 0) return { side: 'sell', symbol: marketData.symbol, size_pct: 1 };
  return { side: 'hold', symbol: marketData.symbol, size_pct: 0 };
}
`;

export const SMA_CROSS_AGENT = `// SMA crossover — go long when fast SMA crosses above slow SMA.
// Classic trend-following baseline.
interface MarketData { timestamp: string; symbol: string; price: number; history: number[]; }
interface Portfolio { cash: number; position_qty: number; position_symbol: string | null; entry_price: number; equity: number; }
interface Action { side: 'buy' | 'sell' | 'hold'; symbol: string; size_pct: number; }

function strategy(marketData: MarketData, portfolio: Portfolio): Action {
  const h = marketData.history;
  if (h.length < 30) return { side: 'hold', symbol: marketData.symbol, size_pct: 0 };
  const fast = h.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const slow = h.slice(-30).reduce((a, b) => a + b, 0) / 30;
  if (fast > slow && portfolio.position_qty === 0) {
    return { side: 'buy', symbol: marketData.symbol, size_pct: 1 };
  }
  if (fast < slow && portfolio.position_qty > 0) {
    return { side: 'sell', symbol: marketData.symbol, size_pct: 1 };
  }
  return { side: 'hold', symbol: marketData.symbol, size_pct: 0 };
}
`;

export const MOMENTUM_AGENT = `// Momentum — buy when 12-bar return > +2%, sell when < -2%.
interface MarketData { timestamp: string; symbol: string; price: number; history: number[]; }
interface Portfolio { cash: number; position_qty: number; position_symbol: string | null; entry_price: number; equity: number; }
interface Action { side: 'buy' | 'sell' | 'hold'; symbol: string; size_pct: number; }

function strategy(marketData: MarketData, portfolio: Portfolio): Action {
  const h = marketData.history;
  if (h.length < 12) return { side: 'hold', symbol: marketData.symbol, size_pct: 0 };
  const ret = (h[h.length - 1] - h[h.length - 12]) / h[h.length - 12];
  if (ret > 0.02 && portfolio.position_qty === 0) {
    return { side: 'buy', symbol: marketData.symbol, size_pct: 0.5 };
  }
  if (ret < -0.02 && portfolio.position_qty > 0) {
    return { side: 'sell', symbol: marketData.symbol, size_pct: 1 };
  }
  return { side: 'hold', symbol: marketData.symbol, size_pct: 0 };
}
`;

export const EXAMPLES: Record<string, string> = {
  random: RANDOM_AGENT,
  "sma-cross": SMA_CROSS_AGENT,
  momentum: MOMENTUM_AGENT,
};