"""Strategy base class + Signal dataclass."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any

from backtester.schemas import Candle


class SignalSide(str, Enum):
    """Side of a trade signal."""

    BUY = "buy"
    SELL = "sell"
    HOLD = "hold"


@dataclass
class Signal:
    """A signal emitted by a strategy on a candle.

    `target_qty` is in units of the asset (e.g. BTC). If None, the engine
    sizes the order based on available cash. `stop_loss` / `take_profit`
    are absolute price levels (not percentages) — None means no bracket.
    """

    side: SignalSide
    target_qty: float | None = None
    stop_loss: float | None = None
    take_profit: float | None = None
    reason: str = ""
    timestamp: datetime = field(default_factory=datetime.utcnow)
    metadata: dict[str, Any] = field(default_factory=dict)


class Strategy(ABC):
    """Base class for backtest strategies.

    Lifecycle:
        1. strategy = MyStrategy(...)
        2. for each candle (in order), engine calls on_candle(candle, portfolio)
        3. strategy returns a Signal
        4. engine routes the signal through the execution model
    """

    name: str = "BaseStrategy"

    @abstractmethod
    def on_candle(self, candle: Candle, portfolio: "Portfolio") -> Signal:  # noqa: F821
        """Decide what to do at this candle."""

    def on_start(self, portfolio: "Portfolio") -> None:  # noqa: D401, ARG002
        """Optional hook called once before the loop starts."""
        return None

    def on_finish(self, portfolio: "Portfolio") -> None:  # noqa: D401, ARG002
        """Optional hook called once after the loop ends."""
        return None