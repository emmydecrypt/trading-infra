"""RSI(14) mean-reversion strategy.

Long when RSI crosses up through 30 (oversold reversal), exit when RSI
crosses down through 70 (overbought). Wilder smoothing.
"""

from __future__ import annotations

from backtester.schemas import Candle
from backtester.strategy import Signal, SignalSide, Strategy


class _RSI:
    """Wilder RSI."""

    def __init__(self, period: int = 14) -> None:
        self.period = period
        self._prev_close: float | None = None
        self._gains: list[float] = []
        self._losses: list[float] = []
        self._avg_gain: float | None = None
        self._avg_loss: float | None = None
        self.value: float | None = None

    def update(self, close: float) -> float | None:
        if self._prev_close is None:
            self._prev_close = close
            return None
        change = close - self._prev_close
        self._prev_close = close
        gain = max(change, 0.0)
        loss = max(-change, 0.0)
        self._gains.append(gain)
        self._losses.append(loss)

        if len(self._gains) <= self.period:
            if len(self._gains) == self.period:
                self._avg_gain = sum(self._gains) / self.period
                self._avg_loss = sum(self._losses) / self.period
                self._compute()
            return self.value

        # Wilder smoothing
        self._avg_gain = (self._avg_gain * (self.period - 1) + gain) / self.period
        self._avg_loss = (self._avg_loss * (self.period - 1) + loss) / self.period
        self._compute()
        return self.value

    def _compute(self) -> None:
        if self._avg_loss == 0:
            self.value = 100.0
        else:
            rs = self._avg_gain / self._avg_loss
            self.value = 100.0 - (100.0 / (1.0 + rs))


class RSIReversal(Strategy):
    name = "RSIReversal"

    def __init__(self, period: int = 14, low: float = 30.0, high: float = 70.0) -> None:
        self.rsi = _RSI(period)
        self.period = period
        self.low = low
        self.high = high
        self._prev: float | None = None

    def on_candle(self, candle: Candle, portfolio) -> Signal:  # noqa: D401
        v = self.rsi.update(candle.close)
        if v is None:
            return Signal(SignalSide.HOLD, reason="warming_up")
        prev = self._prev
        self._prev = v

        held_qty = portfolio.position_qty(candle.symbol) if hasattr(portfolio, "position_qty") else 0.0

        if prev is not None and prev <= self.low < v and held_qty == 0:
            return Signal(SignalSide.BUY, target_qty=None, reason=f"rsi_rebound({v:.1f})")
        if prev is not None and prev >= self.high > v and held_qty > 0:
            return Signal(SignalSide.SELL, target_qty=held_qty, reason=f"rsi_exit({v:.1f})")
        return Signal(SignalSide.HOLD, reason=f"rsi={v:.1f}")