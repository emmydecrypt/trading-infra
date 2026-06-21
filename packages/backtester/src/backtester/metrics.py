"""Performance metrics.

All return-based metrics assume a sequence of periodic returns and use
`sqrt(annualization_factor)` for Sharpe / Sortino. The annualization
factor defaults to 252 (trading days/year) — appropriate for daily bars
and a defensible default for sub-daily bars too (with caveats; see README).

Returns can come from either:
  - `equity_curve` (EquityPoint list with timestamps and equity values), or
  - `returns` (plain numpy array of period returns).

If timestamps are supplied, we use actual elapsed time between samples
for the `trading_days` count. Otherwise we assume consecutive bars.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Iterable

import numpy as np

from backtester.portfolio import EquityPoint


@dataclass
class MetricsReport:
    """Container for backtest metrics — JSON-serializable."""

    total_return: float
    annualized_return: float
    sharpe: float
    sortino: float
    max_drawdown: float
    calmar: float
    win_rate: float
    profit_factor: float
    exposure: float
    n_trades: int
    n_bars: int
    start_equity: float
    end_equity: float
    total_fees: float
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def _drawdown_stats(equity: np.ndarray) -> tuple[float, float]:
    """Return (max_drawdown as positive fraction, argmax index relative to peak)."""
    if len(equity) == 0:
        return 0.0, 0
    peaks = np.maximum.accumulate(equity)
    drawdowns = (equity - peaks) / np.maximum(peaks, 1e-12)
    mdd = float(-drawdowns.min()) if len(drawdowns) else 0.0
    return max(mdd, 0.0), int(np.argmin(drawdowns)) if len(drawdowns) else 0


def _annualization_factor(n_bars: int, seconds_per_bar: float | None = None) -> float:
    """How many bars per year.

    If `seconds_per_bar` is given, derive exact factor. Otherwise default
    to 252 (the standard for daily bars, also a reasonable default for
    sub-daily with caveats).
    """
    if seconds_per_bar and seconds_per_bar > 0:
        bars_per_year = (365.25 * 24 * 3600) / seconds_per_bar
    else:
        bars_per_year = 252.0
    return float(bars_per_year)


def _seconds_per_bar(timestamps: Iterable) -> float | None:
    """Median seconds between consecutive timestamps, or None if can't compute."""
    ts = list(timestamps)
    if len(ts) < 2:
        return None
    deltas = []
    for i in range(1, len(ts)):
        a = ts[i - 1]
        b = ts[i]
        try:
            delta = (b - a).total_seconds()
        except AttributeError:
            return None
        if delta > 0:
            deltas.append(delta)
    if not deltas:
        return None
    return float(np.median(deltas))


def compute_metrics(
    equity_curve: list[EquityPoint] | None = None,
    returns: np.ndarray | None = None,
    timestamps: Iterable | None = None,
    trade_pnls: list[float] | None = None,
    total_fees: float = 0.0,
    initial_capital: float | None = None,
    annualization_factor: float | None = None,
) -> MetricsReport:
    """Compute the standard backtest metrics.

    Pass EITHER `equity_curve` (preferred, uses per-bar equity) OR `returns`.
    Returns are assumed to be simple returns per bar (not log returns).
    """
    notes: list[str] = []

    if equity_curve is not None and len(equity_curve) > 0:
        ts = [p.timestamp for p in equity_curve]
        eq = np.array([p.equity for p in equity_curve], dtype=float)
        returns = np.diff(eq) / np.maximum(eq[:-1], 1e-12)
        timestamps = ts[1:]
    elif returns is None:
        returns = np.array([], dtype=float)

    returns = np.asarray(returns, dtype=float)
    returns = returns[np.isfinite(returns)]

    n_bars = len(returns)
    if n_bars == 0:
        # Still compute trade-based metrics if any
        pnls_arr = np.array(trade_pnls or [], dtype=float)
        if len(pnls_arr) > 0:
            wins = pnls_arr[pnls_arr > 0]
            losses = pnls_arr[pnls_arr < 0]
            win_rate = float(len(wins) / len(pnls_arr))
            if len(losses) > 0 and losses.sum() != 0:
                profit_factor = float(wins.sum()) / float(-losses.sum())
            elif len(wins) > 0:
                profit_factor = 0.0  # clamped inf
            else:
                profit_factor = 0.0
            return MetricsReport(
                total_return=0.0,
                annualized_return=0.0,
                sharpe=0.0,
                sortino=0.0,
                max_drawdown=0.0,
                calmar=0.0,
                win_rate=win_rate,
                profit_factor=profit_factor if np.isfinite(profit_factor) else 0.0,
                exposure=0.0,
                n_trades=len(pnls_arr),
                n_bars=0,
                start_equity=float(initial_capital or 0.0),
                end_equity=float(initial_capital or 0.0),
                total_fees=float(total_fees),
                notes=["no_returns_but_have_trades"],
            )
        return MetricsReport(
            total_return=0.0,
            annualized_return=0.0,
            sharpe=0.0,
            sortino=0.0,
            max_drawdown=0.0,
            calmar=0.0,
            win_rate=0.0,
            profit_factor=0.0,
            exposure=0.0,
            n_trades=0,
            n_bars=0,
            start_equity=float(initial_capital or 0.0),
            end_equity=float(initial_capital or 0.0),
            total_fees=float(total_fees),
            notes=["no_data"],
        )

    sec_per_bar = _seconds_per_bar(timestamps) if timestamps is not None else None
    af = annualization_factor if annualization_factor is not None else _annualization_factor(n_bars, sec_per_bar)
    if sec_per_bar is not None and annualization_factor is None:
        notes.append(f"annualization_factor={af:.1f} (derived from bar size)")

    if equity_curve is not None and len(equity_curve) >= 2:
        start_equity = float(equity_curve[0].equity)
        end_equity = float(equity_curve[-1].equity)
    elif initial_capital is not None:
        start_equity = float(initial_capital)
        end_equity = float(initial_capital * float(np.prod(1.0 + returns)))
    else:
        start_equity = 1.0
        end_equity = float(np.prod(1.0 + returns))

    total_return = (end_equity / start_equity) - 1.0 if start_equity > 0 else 0.0

    # Annualized return via geometric compounding
    if n_bars > 0 and start_equity > 0:
        years = n_bars / af
        if years > 0:
            annualized = (end_equity / start_equity) ** (1.0 / years) - 1.0
        else:
            annualized = 0.0
    else:
        annualized = 0.0

    # Sharpe: mean(r) / std(r) * sqrt(af)
    mean_r = float(np.mean(returns))
    std_r = float(np.std(returns, ddof=1)) if n_bars > 1 else 0.0
    # Treat ~zero std (floating-point noise on constant series) as zero
    # to avoid divide-by-near-zero exploding the Sharpe to nonsense.
    sharpe = (mean_r / std_r * np.sqrt(af)) if std_r > 1e-12 else 0.0

    # Sortino: mean(r) / downside_std * sqrt(af)
    downside = returns[returns < 0]
    dstd = float(np.std(downside, ddof=1)) if len(downside) > 1 else 0.0
    sortino = (mean_r / dstd * np.sqrt(af)) if dstd > 1e-12 else 0.0

    # Max drawdown
    if equity_curve is not None and len(equity_curve) >= 2:
        eq_full = np.array([p.equity for p in equity_curve], dtype=float)
        mdd, _ = _drawdown_stats(eq_full)
    else:
        # Reconstruct equity from returns
        eq_full = start_equity * np.cumprod(1.0 + returns)
        mdd, _ = _drawdown_stats(eq_full)

    calmar = (annualized / mdd) if mdd > 0 else 0.0

    # Trade stats
    pnls = np.array(trade_pnls or [], dtype=float)
    n_trades = int(len(pnls))
    win_rate = 0.0
    profit_factor = 0.0
    if n_trades > 0:
        wins = pnls[pnls > 0]
        losses = pnls[pnls < 0]
        win_rate = float(len(wins) / n_trades)
        if len(losses) > 0 and losses.sum() != 0:
            profit_factor = float(wins.sum()) / float(-losses.sum())
        elif len(wins) > 0:
            profit_factor = float("inf")
        else:
            profit_factor = 0.0
        if not np.isfinite(profit_factor):
            profit_factor = 0.0

    # Exposure: fraction of bars with open position
    if equity_curve is not None and len(equity_curve) > 0:
        in_pos = sum(1 for p in equity_curve if p.position_qty > 0)
        exposure = in_pos / len(equity_curve)
    else:
        exposure = 0.0

    return MetricsReport(
        total_return=total_return,
        annualized_return=annualized,
        sharpe=sharpe,
        sortino=sortino,
        max_drawdown=mdd,
        calmar=calmar,
        win_rate=win_rate,
        profit_factor=profit_factor,
        exposure=exposure,
        n_trades=n_trades,
        n_bars=n_bars,
        start_equity=start_equity,
        end_equity=end_equity,
        total_fees=total_fees,
        notes=notes,
    )


__all__ = ["MetricsReport", "compute_metrics"]