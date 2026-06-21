#!/usr/bin/env python3
"""
Minimal deterministic backtester for the AI x Crypto eval harness.

Why this exists
---------------
The eval-harness task says it can spawn a Python backtester as a subprocess.
We don't have a separate backtester package checked into this repo, so this
script is the local stand-in. It is deterministic (seeded synthetic prices,
no network) so tests are reproducible.

Input (JSON on stdin or --input file):
{
  "agent_code": "string (TypeScript source exporting strategy)",
  "dataset": { "symbol": "BTCUSDT", "start": "2024-01-01T00:00:00Z", "end": "2024-12-31T23:00:00Z", "interval": "1h" },
  "fee_bps": 10,
  "slippage_bps": 5,
  "seed": 42
}

Output (JSON on stdout):
{
  "ok": true,
  "metrics": {
    "sharpe": <float>,
    "sortino": <float>,
    "calmar": <float>,
    "profit_factor": <float>,
    "max_drawdown": <float>,     # negative number, e.g. -0.18
    "total_return": <float>,     # e.g. 0.42
    "n_trades": <int>
  },
  "equity_curve": [<float>, ...],   # one value per bar
  "trades": [{...}, ...],
  "error": null
}

The Python side does NOT execute the agent code; the harness runs the agent
in a Node vm sandbox and replays the actions into this backtester. This script
only needs to evaluate a deterministic action stream against a price series.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from typing import Iterable

# ---------- Synthetic price generation ----------------------------------------


def generate_prices(symbol: str, n_bars: int, seed: int) -> list[float]:
    """Deterministic geometric-random-walk price series.

    Each symbol has a stable drift/vol profile so results differ across
    BTCUSDT/ETHUSDT/SOLUSDT but remain reproducible across runs.
    """
    import random

    profiles = {
        "BTCUSDT": {"start": 42000.0, "drift": 0.00018, "vol": 0.018},
        "ETHUSDT": {"start": 2200.0, "drift": 0.00015, "vol": 0.024},
        "SOLUSDT": {"start": 95.0, "drift": 0.00022, "vol": 0.038},
    }
    prof = profiles.get(symbol, {"start": 100.0, "drift": 0.0001, "vol": 0.02})
    rng = random.Random(seed + sum(ord(c) for c in symbol))
    price = prof["start"]
    prices = [price]
    for _ in range(n_bars - 1):
        shock = rng.gauss(prof["drift"], prof["vol"])
        price *= math.exp(shock)
        prices.append(price)
    return prices


# ---------- Backtester core ----------------------------------------------------


@dataclass
class Trade:
    timestamp: str
    symbol: str
    side: str
    price: float
    size: float
    pnl: float


def run_backtest(
    actions: list[dict],
    prices: list[float],
    timestamps: list[str],
    symbol: str,
    fee_bps: float,
    slippage_bps: float,
    initial_equity: float = 10_000.0,
) -> dict:
    """Replay an action stream against a price series.

    `actions[i]` should be {side, size_pct} corresponding to bar i. Portfolio
    is fully invested long-only; we keep it simple and verifiable.
    """
    assert len(prices) == len(timestamps), "price/timestamp length mismatch"

    cash = initial_equity
    position_qty = 0.0
    entry_price = 0.0
    equity_curve = [initial_equity]
    trades: list[Trade] = []
    fee = fee_bps / 10_000.0
    slip = slippage_bps / 10_000.0

    for i, (price, ts, action) in enumerate(zip(prices, timestamps, actions)):
        if action is None:
            action = {"side": "hold", "size_pct": 0}
        side = action.get("side", "hold")
        size_pct = float(action.get("size_pct", 0))
        size_pct = max(0.0, min(1.0, size_pct))

        if side == "buy" and cash > 0:
            notional = cash * size_pct
            fill_price = price * (1 + slip)
            qty = notional * (1 - fee) / fill_price
            if qty > 0:
                cash -= notional
                position_qty += qty
                if entry_price == 0:
                    entry_price = fill_price
                else:
                    entry_price = (entry_price * (position_qty - qty) + fill_price * qty) / position_qty
                trades.append(Trade(ts, symbol, "buy", fill_price, qty, 0.0))
        elif side == "sell" and position_qty > 0:
            sell_qty = position_qty * size_pct if size_pct > 0 else position_qty
            sell_qty = min(sell_qty, position_qty)
            fill_price = price * (1 - slip)
            proceeds = fill_price * sell_qty * (1 - fee)
            pnl = (fill_price - entry_price) * sell_qty
            cash += proceeds
            position_qty -= sell_qty
            if position_qty <= 1e-9:
                position_qty = 0.0
                entry_price = 0.0
            trades.append(Trade(ts, symbol, "sell", fill_price, sell_qty, pnl))

        equity = cash + position_qty * price
        equity_curve.append(equity)

    # Force-close any remaining position at the last price for clean metrics.
    if position_qty > 0:
        pnl = (prices[-1] - entry_price) * position_qty
        cash += prices[-1] * position_qty * (1 - fee)
        trades.append(Trade(timestamps[-1], symbol, "sell_close", prices[-1], position_qty, pnl))
        equity_curve[-1] = cash

    metrics = compute_metrics(equity_curve, initial_equity, trades)
    return {
        "ok": True,
        "metrics": metrics,
        "equity_curve": equity_curve,
        "trades": [
            {
                "timestamp": t.timestamp,
                "symbol": t.symbol,
                "side": t.side,
                "price": t.price,
                "size": t.size,
                "pnl": t.pnl,
            }
            for t in trades
        ],
        "error": None,
    }


def compute_metrics(equity: list[float], initial: float, trades: Iterable[Trade]) -> dict:
    if len(equity) < 2:
        return {
            "sharpe": 0.0,
            "sortino": 0.0,
            "calmar": 0.0,
            "profit_factor": 0.0,
            "max_drawdown": 0.0,
            "total_return": 0.0,
            "n_trades": 0,
        }

    rets = [(equity[i] - equity[i - 1]) / equity[i - 1] for i in range(1, len(equity))]
    n = len(rets)
    mean_r = sum(rets) / n
    var_r = sum((r - mean_r) ** 2 for r in rets) / max(n - 1, 1)
    std_r = math.sqrt(var_r)
    downside = [r for r in rets if r < 0]
    dstd = math.sqrt(sum(r * r for r in downside) / max(len(downside), 1)) if downside else 0.0

    # Annualization: assuming hourly bars (matching the BTCUSDT 1h dataset).
    bars_per_year = 365 * 24
    sharpe = (mean_r / std_r) * math.sqrt(bars_per_year) if std_r > 1e-12 else 0.0
    sortino = (mean_r / dstd) * math.sqrt(bars_per_year) if dstd > 1e-12 else 0.0

    peak = equity[0]
    max_dd = 0.0
    for v in equity:
        if v > peak:
            peak = v
        dd = (v - peak) / peak
        if dd < max_dd:
            max_dd = dd

    total_return = (equity[-1] - initial) / initial
    years = n / bars_per_year
    cagr = (equity[-1] / initial) ** (1 / years) - 1 if years > 0 and equity[-1] > 0 and initial > 0 else 0.0
    calmar = cagr / abs(max_dd) if max_dd < -1e-9 else 0.0

    trade_list = list(trades)
    gross_win = sum(t.pnl for t in trade_list if t.pnl > 0)
    gross_loss = -sum(t.pnl for t in trade_list if t.pnl < 0)
    if gross_loss > 1e-9:
        profit_factor = gross_win / gross_loss
    elif gross_win > 1e-9:
        profit_factor = float("inf")
    else:
        profit_factor = 0.0

    # Clamp to JSON-friendly numbers.
    def f(x: float) -> float:
        if math.isinf(x) or math.isnan(x):
            return 0.0
        # keep 6 decimals
        return round(x, 6)

    return {
        "sharpe": f(sharpe),
        "sortino": f(sortino),
        "calmar": f(calmar),
        "profit_factor": f(profit_factor),
        "max_drawdown": f(max_dd),
        "total_return": f(total_return),
        "n_trades": len(trade_list),
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--input", help="JSON input file; omit to read stdin")
    p.add_argument("--output", help="JSON output file; omit to write stdout")
    args = p.parse_args()

    if args.input:
        with open(args.input) as fh:
            payload = json.load(fh)
    else:
        payload = json.load(sys.stdin)

    actions = payload.get("actions") or []
    dataset = payload["dataset"]
    symbol = dataset["symbol"]
    seed = int(payload.get("seed", 42))
    n_bars = payload.get("n_bars", len(actions))

    prices = generate_prices(symbol, n_bars, seed)
    start = dataset.get("start", "2024-01-01T00:00:00Z")
    end = dataset.get("end", "2024-12-31T23:00:00Z")
    from datetime import datetime, timedelta, timezone

    s_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
    e_dt = datetime.fromisoformat(end.replace("Z", "+00:00"))
    span_hours = int((e_dt - s_dt).total_seconds() // 3600)
    timestamps = [
        (s_dt + timedelta(hours=i)).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        for i in range(min(span_hours, n_bars) + 1)
    ]
    timestamps = timestamps[: n_bars]

    fee_bps = float(payload.get("fee_bps", 10))
    slippage_bps = float(payload.get("slippage_bps", 5))

    result = run_backtest(actions, prices, timestamps, symbol, fee_bps, slippage_bps)

    out = json.dumps(result)
    if args.output:
        with open(args.output, "w") as fh:
            fh.write(out)
    else:
        sys.stdout.write(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())