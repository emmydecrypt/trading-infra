import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Action, MarketDataPoint, Metrics, Portfolio, RunResult } from "../types.js";
import { compileAgent, callStrategy } from "./runAgent.js";

export interface DatasetConfig {
  symbol: string;
  start: string;
  end: string;
  interval: "1h";
  /** Number of bars to evaluate; defaults to the full dataset. */
  n_bars?: number;
  seed?: number;
}

export interface RunnerOptions {
  backtesterPath?: string;
  timeoutMs?: number;
  /** Python executable. Defaults to `python3`. */
  pythonBin?: string;
}

/**
 * The fixed eval dataset used by the harness. Three symbols across 2024.
 */
export const DEFAULT_DATASETS: DatasetConfig[] = [
  { symbol: "BTCUSDT", start: "2024-01-01T00:00:00Z", end: "2024-12-31T23:00:00Z", interval: "1h" },
  { symbol: "ETHUSDT", start: "2024-01-01T00:00:00Z", end: "2024-12-31T23:00:00Z", interval: "1h" },
  { symbol: "SOLUSDT", start: "2024-01-01T00:00:00Z", end: "2024-12-31T23:00:00Z", interval: "1h" },
];

const DEFAULT_N_BARS = 365 * 24; // 1 year of hourly bars

export interface BacktesterResponse {
  ok: boolean;
  metrics: Metrics | null;
  error: string | null;
}

interface BacktesterRaw {
  ok: boolean;
  metrics: Metrics | null;
  error: string | null;
}

export async function runAgentAgainstDatasets(
  code: string,
  opts: RunnerOptions = {},
): Promise<RunResult> {
  const start = Date.now();
  const started_at = new Date(start).toISOString();
  const compile = compileAgent(code, { timeoutMs: opts.timeoutMs });
  if (!compile.ok || !compile.strategy) {
    return {
      ok: false,
      metrics: null,
      error: compile.error,
      started_at,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - start,
    };
  }

  const strategy = compile.strategy;
  const allMetrics: Metrics[] = [];
  for (const ds of DEFAULT_DATASETS) {
    const result = await runOneDataset(strategy, ds, opts);
    if (result.metrics) allMetrics.push(result.metrics);
    else {
      return {
        ok: false,
        metrics: null,
        error: `${ds.symbol}: ${result.error ?? "unknown"}`,
        started_at,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - start,
      };
    }
  }

  const metrics = averageMetrics(allMetrics);
  return {
    ok: true,
    metrics,
    error: null,
    started_at,
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - start,
  };
}

async function runOneDataset(
  strategy: ReturnType<typeof compileAgent>["strategy"],
  ds: DatasetConfig,
  opts: RunnerOptions,
): Promise<BacktesterResponse> {
  if (!strategy) return { ok: false, metrics: null, error: "no strategy" };
  const nBars = ds.n_bars ?? DEFAULT_N_BARS;
  const seed = ds.seed ?? 42;

  // Step 1: replay the strategy bar-by-bar to produce an action stream.
  const actions: Action[] = [];
  let portfolio: Portfolio = {
    cash: 10_000,
    position_qty: 0,
    position_symbol: null,
    entry_price: 0,
    equity: 10_000,
  };
  let price = startingPriceFor(ds.symbol);
  let lastTimestamp = ds.start;

  for (let i = 0; i < nBars; i++) {
    // Drift the price deterministically based on bar index so we don't need
    // network access and the agent sees a consistent feed.
    price = price * Math.exp(0.0001 + 0.01 * pseudoNoise(seed, i));
    lastTimestamp = addHour(lastTimestamp);
    const history = recentHistory(price, 20, seed, i);
    const marketData: MarketDataPoint = {
      timestamp: lastTimestamp,
      symbol: ds.symbol,
      price,
      history,
    };
    const res = callStrategy(strategy, marketData, portfolio, { timeoutMs: opts.timeoutMs });
    if (!res.ok) return { ok: false, metrics: null, error: res.error };
    actions.push(res.action);
    // Update portfolio mirror so the next call sees consistent state.
    portfolio = applyToMirror(portfolio, res.action, price);
  }

  // Step 2: feed actions to the Python backtester as a subprocess.
  const payload = {
    actions,
    dataset: ds,
    n_bars: nBars,
    seed,
    fee_bps: 10,
    slippage_bps: 5,
  };
  const raw = await invokeBacktester(payload, opts);
  if (!raw.ok || !raw.metrics) {
    return { ok: false, metrics: null, error: raw.error ?? "backtester failed" };
  }
  return { ok: true, metrics: raw.metrics, error: null };
}

function startingPriceFor(symbol: string): number {
  return symbol === "BTCUSDT" ? 42000 : symbol === "ETHUSDT" ? 2200 : 95;
}

function recentHistory(current: number, n: number, seed: number, i: number): number[] {
  const out: number[] = [];
  for (let k = n; k > 0; k--) {
    out.push(current * Math.exp(-0.001 * k + 0.005 * pseudoNoise(seed, i - k)));
  }
  out.push(current);
  return out;
}

function pseudoNoise(seed: number, i: number): number {
  // Deterministic pseudo-random in [-1, 1]; not cryptographic, just stable.
  const x = Math.sin(seed * 9301 + i * 49297) * 233280;
  const f = x - Math.floor(x);
  return f * 2 - 1;
}

function addHour(iso: string): string {
  const d = new Date(iso);
  d.setUTCHours(d.getUTCHours() + 1);
  return d.toISOString();
}

function applyToMirror(p: Portfolio, a: Action, price: number): Portfolio {
  if (a.side === "buy" && p.cash > 0) {
    const notional = p.cash * a.size_pct;
    const qty = notional / price;
    return {
      cash: p.cash - notional,
      position_qty: p.position_qty + qty,
      position_symbol: a.symbol,
      entry_price: p.entry_price || price,
      equity: p.cash - notional + (p.position_qty + qty) * price,
    };
  }
  if (a.side === "sell" && p.position_qty > 0) {
    const qty = p.position_qty * (a.size_pct > 0 ? a.size_pct : 1);
    return {
      cash: p.cash + qty * price,
      position_qty: p.position_qty - qty,
      position_symbol: p.position_qty - qty > 1e-9 ? p.position_symbol : null,
      entry_price: p.entry_price,
      equity: p.cash + qty * price + (p.position_qty - qty) * price,
    };
  }
  return { ...p, equity: p.cash + p.position_qty * price };
}

function averageMetrics(arr: Metrics[]): Metrics {
  if (arr.length === 0) {
    return {
      sharpe: 0,
      sortino: 0,
      calmar: 0,
      profit_factor: 0,
      max_drawdown: 0,
      total_return: 0,
      n_trades: 0,
    };
  }
  const acc = arr.reduce(
    (a, m) => ({
      sharpe: a.sharpe + m.sharpe,
      sortino: a.sortino + m.sortino,
      calmar: a.calmar + m.calmar,
      profit_factor: a.profit_factor + m.profit_factor,
      max_drawdown: a.max_drawdown + m.max_drawdown,
      total_return: a.total_return + m.total_return,
      n_trades: a.n_trades + m.n_trades,
    }),
    {
      sharpe: 0,
      sortino: 0,
      calmar: 0,
      profit_factor: 0,
      max_drawdown: 0,
      total_return: 0,
      n_trades: 0,
    },
  );
  const n = arr.length;
  return {
    sharpe: round6(acc.sharpe / n),
    sortino: round6(acc.sortino / n),
    calmar: round6(acc.calmar / n),
    profit_factor: round6(acc.profit_factor / n),
    max_drawdown: round6(acc.max_drawdown / n),
    total_return: round6(acc.total_return / n),
    n_trades: acc.n_trades,
  };
}

function round6(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 1e6) / 1e6;
}

function invokeBacktester(
  payload: object,
  opts: RunnerOptions,
): Promise<BacktesterRaw> {
  const py = opts.pythonBin ?? "python3";
  const scriptPath = opts.backtesterPath ?? defaultBacktesterPath();
  return new Promise((resolve) => {
    const child = spawn(py, [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, metrics: null, error: "backtester timeout" });
    }, 120_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, metrics: null, error: `spawn failed: ${err.message}` });
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (!stdout) {
        resolve({ ok: false, metrics: null, error: stderr || "empty backtester output" });
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as BacktesterRaw;
        resolve(parsed);
      } catch (err) {
        resolve({ ok: false, metrics: null, error: `bad backtester JSON: ${(err as Error).message}` });
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function defaultBacktesterPath(): string {
  // Resolve relative to this module's file (src/sandbox/runner.ts).
  const here = fileURLToPath(new URL(".", import.meta.url));
  return path.resolve(here, "..", "..", "backtester", "backtester.py");
}