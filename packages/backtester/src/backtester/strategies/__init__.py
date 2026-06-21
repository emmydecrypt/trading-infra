"""Built-in strategies."""

from backtester.strategies.buy_and_hold import BuyAndHold
from backtester.strategies.rsi import RSIReversal
from backtester.strategies.sma import SMACross

__all__ = ["BuyAndHold", "RSIReversal", "SMACross"]


STRATEGIES: dict[str, type] = {
    "sma": SMACross,
    "rsi": RSIReversal,
    "buy_and_hold": BuyAndHold,
}


def resolve_strategy(name: str) -> type:
    """Look up a strategy class by CLI name."""
    key = name.lower()
    if key not in STRATEGIES:
        raise KeyError(
            f"Unknown strategy {name!r}. Known: {sorted(STRATEGIES)}"
        )
    return STRATEGIES[key]