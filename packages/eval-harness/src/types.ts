// Domain types shared across the harness.

export type Side = "buy" | "sell" | "hold";

export interface Action {
  side: Side;
  symbol: string;
  size_pct: number; // 0..1
}

export interface MarketDataPoint {
  timestamp: string; // ISO 8601
  symbol: string;
  price: number;
  /** Rolling window of recent closes (most recent last). */
  history: number[];
}

export interface Portfolio {
  cash: number;
  position_qty: number;
  position_symbol: string | null;
  entry_price: number;
  equity: number;
}

export interface AgentContext {
  marketData: MarketDataPoint;
  portfolio: Portfolio;
}

export type StrategyFn = (marketData: MarketDataPoint, portfolio: Portfolio) => Action;

export interface Metrics {
  sharpe: number;
  sortino: number;
  calmar: number;
  profit_factor: number;
  max_drawdown: number; // negative
  total_return: number;
  n_trades: number;
}

export interface RunResult {
  ok: boolean;
  metrics: Metrics | null;
  error: string | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
}

export interface AgentRecord {
  id: number;
  name: string;
  code: string;
  author: string;
  created_at: string;
}

export interface RunRecord {
  id: number;
  agent_id: number;
  started_at: string;
  finished_at: string | null;
  metrics_json: string; // serialized RunResult
}