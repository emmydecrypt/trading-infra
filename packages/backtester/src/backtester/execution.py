"""Realistic execution model.

The core simulation is the `ExecutionModel` class. It takes an order (side,
target qty, reference price) and the current candle, and returns a Fill
describing what actually happened.

Slippage model
--------------
Slippage scales with order size vs the configured top-of-book depth:

    size_ratio = (qty * price) / top_of_book_usd
    slippage_bps = base_slippage_bps * (1 + size_ratio)

A buy pays `price * (1 + slippage_bps/10_000)`. A sell receives
`price * (1 - slippage_bps/10_000)`. This is a conservative linear
approximation; real price impact is concave (sqrt-ish) for most models.

Partial fills
-------------
If `requested_qty * fill_price > top_of_book_usd * 0.5`, we cap the fill
at that fraction. The remaining qty is reported as not filled and the
order is treated as one-shot (no re-try). This is the standard "if you
cross the spread by more than half the visible depth, you only get half"
approximation used by many retail-grade simulators.

Latency
-------
The engine handles latency at the orchestration level — signals at bar `t`
fill against bar `t+1`. The execution model itself is unaware of ms; it
just takes a `reference_candle` and decides what the fill price is.

Stop loss / take profit
-----------------------
Triggered by checking the candle's `low` (for SL) and `high` (for TP).
If both trigger within the same bar, we use the conservative ordering
(SL first, then TP). The fill price for both is `trigger_price` * (1 ± slippage).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

from backtester.schemas import Candle, FillRecord


@dataclass
class ExecutionConfig:
    """All execution-related knobs in one place."""

    slippage_bps: float = 5.0
    fee_bps: float = 10.0  # taker fee
    maker_fee_bps: float = 10.0
    latency_ms: int = 100
    top_of_book_usd: float = 50_000.0

    # Maximum fraction of top-of-book we allow a single fill to consume.
    # Anything bigger gets capped (partial fill).
    max_depth_fraction: float = 0.5

    def fee_per_unit(self, price: float, maker: bool = False) -> float:
        bps = self.maker_fee_bps if maker else self.fee_bps
        return price * bps / 10_000.0


@dataclass
class Fill:
    """Outcome of attempting to fill an order."""

    filled_qty: float
    price: float  # per unit, AFTER slippage
    fee_paid: float  # total USD fee
    slippage_bps: float  # actual slippage applied
    requested_qty: float = 0.0
    side: str = "buy"
    reason: str = "signal"
    timestamp: datetime = field(default_factory=datetime.utcnow)

    @property
    def is_filled(self) -> bool:
        return self.filled_qty > 0

    @property
    def notional(self) -> float:
        return self.filled_qty * self.price

    def to_record(self, symbol: str) -> FillRecord:
        return FillRecord(
            timestamp=self.timestamp,
            symbol=symbol,
            side=self.side,  # type: ignore[arg-type]
            requested_qty=self.requested_qty,
            filled_qty=self.filled_qty,
            price=self.price,
            fee_paid=self.fee_paid,
            slippage_bps=self.slippage_bps,
            reason=self.reason,
        )


class ExecutionModel:
    """Applies slippage, fees, and partial-fill caps to orders."""

    def __init__(self, config: ExecutionConfig) -> None:
        self.config = config

    def compute_slippage_bps(self, qty: float, price: float) -> float:
        """Slippage scales linearly with order notional vs top-of-book depth."""
        if qty <= 0 or price <= 0:
            return 0.0
        notional = qty * price
        size_ratio = notional / max(self.config.top_of_book_usd, 1e-9)
        return self.config.slippage_bps * (1.0 + size_ratio)

    def max_fillable_qty(self, qty: float, price: float) -> float:
        """Cap a fill at `max_depth_fraction` of top-of-book liquidity."""
        if qty <= 0 or price <= 0:
            return 0.0
        max_notional = self.config.top_of_book_usd * self.config.max_depth_fraction
        return min(qty, max_notional / price)

    def fill_market(
        self,
        side: str,
        requested_qty: float,
        reference_price: float,
        timestamp: datetime,
        reason: str = "signal",
    ) -> Fill:
        """Fill a market order at `reference_price` with slippage + partial-fill.

        For buys, slippage is paid (price rises). For sells, slippage is
        received less (price drops). Fees are always subtracted in cash terms.
        """
        if requested_qty <= 0:
            return Fill(
                filled_qty=0.0,
                price=reference_price,
                fee_paid=0.0,
                slippage_bps=0.0,
                requested_qty=requested_qty,
                side=side,
                reason=reason,
                timestamp=timestamp,
            )

        qty = self.max_fillable_qty(requested_qty, reference_price)
        slip_bps = self.compute_slippage_bps(qty, reference_price)

        if side == "buy":
            fill_price = reference_price * (1.0 + slip_bps / 10_000.0)
            fee = qty * fill_price * self.config.fee_bps / 10_000.0
        elif side == "sell":
            fill_price = reference_price * (1.0 - slip_bps / 10_000.0)
            fee = qty * fill_price * self.config.fee_bps / 10_000.0
        else:
            raise ValueError(f"Unknown side {side!r}")

        return Fill(
            filled_qty=qty,
            price=fill_price,
            fee_paid=fee,
            slippage_bps=slip_bps,
            requested_qty=requested_qty,
            side=side,
            reason=reason,
            timestamp=timestamp,
        )

    def check_brackets(
        self,
        candle: Candle,
        held_qty: float,
        entry_price: float,
        stop_loss: Optional[float],
        take_profit: Optional[float],
    ) -> Optional[str]:
        """Return "stop_loss" / "take_profit" / None depending on whether
        the bar's range touched a bracket level.

        Conservative ordering: if both stop and TP would trigger in the
        same bar, we attribute to the stop first (gap-down risk is the
        worse scenario for a long).
        """
        if held_qty <= 0 or entry_price <= 0:
            return None
        if stop_loss is not None and candle.low <= stop_loss:
            return "stop_loss"
        if take_profit is not None and candle.high >= take_profit:
            return "take_profit"
        return None

    def fill_bracket(
        self,
        side: str,
        qty: float,
        trigger_price: float,
        timestamp: datetime,
        reason: str,
    ) -> Fill:
        """Fill at the bracket trigger price (still subject to slippage)."""
        # Bracket fills still incur slippage — but typically less since
        # the trigger is a known level. Use base slippage, not the
        # size-scaled one.
        slip_bps = self.config.slippage_bps
        if side == "buy":
            fill_price = trigger_price * (1.0 + slip_bps / 10_000.0)
        else:
            fill_price = trigger_price * (1.0 - slip_bps / 10_000.0)
        fee = qty * fill_price * self.config.fee_bps / 10_000.0
        return Fill(
            filled_qty=qty,
            price=fill_price,
            fee_paid=fee,
            slippage_bps=slip_bps,
            requested_qty=qty,
            side=side,
            reason=reason,
            timestamp=timestamp,
        )


def time_after_latency(start: datetime, latency_ms: int) -> datetime:
    """Helper: `start` + `latency_ms`."""
    return start + timedelta(milliseconds=latency_ms)


__all__ = ["ExecutionConfig", "ExecutionModel", "Fill"]


# Math sanity helpers exported for tests
def round_trip_cost_bps(config: ExecutionConfig) -> float:
    """Total cost in bps of a round-trip trade at zero slippage impact.

    Useful for sanity-checking that fee math is sane: defaults
    (10 + 10 + 5 + 5) = 30 bps round-trip before any size impact.
    """
    return 2.0 * (config.fee_bps + config.slippage_bps)


def geometric_round_trip_pct(pnl_pct: float, cost_bps: float) -> float:
    """Apply fixed bps cost to a PnL% via geometric compounding."""
    cost = cost_bps / 10_000.0
    return ((1.0 + pnl_pct) * (1.0 - cost) / (1.0 + cost)) - 1.0


def is_finite(x: float) -> bool:
    return math.isfinite(x)