"""Buy on the first bar, hold forever."""

from __future__ import annotations

from backtester.schemas import Candle
from backtester.strategy import Signal, SignalSide, Strategy


class BuyAndHold(Strategy):
    name = "BuyAndHold"

    def __init__(self) -> None:
        self._bought = False

    def on_candle(self, candle: Candle, portfolio) -> Signal:  # noqa: D401
        if self._bought:
            return Signal(SignalSide.HOLD, reason="holding")
        self._bought = True
        return Signal(SignalSide.BUY, target_qty=None, reason="buy_and_hold_entry")