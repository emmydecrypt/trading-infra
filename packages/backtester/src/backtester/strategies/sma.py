"""9/21 EMA crossover strategy (SMACross).

Long when fast EMA crosses above slow EMA, exit (full close) when it
crosses below. Uses standard EMA with `adjust=False`. We need at least
`slow_period` bars of warm-up before the strategy emits real signals.
"""

from __future__ import annotations

from collections import deque
from typing import Deque

from backtester.schemas import Candle
from backtester.strategy import Signal, SignalSide, Strategy


class _EMA:
    """Incremental EMA with `adjust=False` (true recursive form)."""

    def __init__(self, period: int) -> None:
        self.period = period
        self.k = 2.0 / (period + 1.0)
        self.value: float | None = None

    def update(self, price: float) -> float | None:
        if self.value is None:
            # Seed with SMA of first `period` samples.
            if not hasattr(self, "_seed_buf"):
                self._seed_buf: Deque[float] = deque(maxlen=self.period)
            self._seed_buf.append(price)
            if len(self._seed_buf) == self.period:
                self.value = sum(self._seed_buf) / self.period
            return self.value
        self.value = price * self.k + self.value * (1.0 - self.k)
        return self.value


class SMACross(Strategy):
    name = "SMACross"

    def __init__(
        self,
        fast_period: int = 9,
        slow_period: int = 21,
        risk_per_trade: float = 1.0,
    ) -> None:
        if fast_period <= 0 or slow_period <= 0:
            raise ValueError("EMA periods must be positive")
        if fast_period >= slow_period:
            raise ValueError("fast_period must be < slow_period")
        self.fast = _EMA(fast_period)
        self.slow = _EMA(slow_period)
        self.fast_period = fast_period
        self.slow_period = slow_period
        self.risk_per_trade = risk_per_trade
        self._prev_diff: float | None = None

    def on_candle(self, candle: Candle, portfolio) -> Signal:  # noqa: D401
        f = self.fast.update(candle.close)
        s = self.slow.update(candle.close)
        if f is None or s is None:
            return Signal(SignalSide.HOLD, reason="warming_up")

        diff = f - s
        prev = self._prev_diff
        self._prev_diff = diff

        held_qty = portfolio.position_qty(candle.symbol) if hasattr(portfolio, "position_qty") else 0.0

        # Cross up -> enter long
        if prev is not None and prev <= 0 < diff and held_qty == 0:
            return Signal(
                SignalSide.BUY,
                target_qty=None,  # engine sizes from cash
                reason=f"ema_cross_up(fast={f:.4f},slow={s:.4f})",
            )
        # Cross down -> exit long
        if prev is not None and prev >= 0 > diff and held_qty > 0:
            return Signal(
                SignalSide.SELL,
                target_qty=held_qty,
                reason=f"ema_cross_down(fast={f:.4f},slow={s:.4f})",
            )

        return Signal(SignalSide.HOLD, reason="no_cross")