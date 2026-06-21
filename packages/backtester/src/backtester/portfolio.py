"""Portfolio: cash + positions + equity curve.

No leverage in v1 (spot only). Positions are tracked in units of the
asset. The equity curve is a sampled series indexed by bar timestamp.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterable

from backtester.schemas import Candle, FillRecord, TradeRecord


@dataclass
class EquityPoint:
    timestamp: datetime
    cash: float
    equity: float
    position_value: float
    position_qty: float  # primary symbol position only (for exposure calc)


class Portfolio:
    """Tracks cash, positions, and equity curve.

    Symbol-agnostic except for a "primary" symbol which is used for
    exposure calculations. Multi-symbol portfolio support is out of
    scope for v1 (the engine pins one symbol per run).
    """

    def __init__(self, initial_cash: float, primary_symbol: str = "BTCUSDT") -> None:
        if initial_cash <= 0:
            raise ValueError("initial_cash must be positive")
        self.initial_cash = initial_cash
        self.primary_symbol = primary_symbol
        self.cash = initial_cash
        self.positions: dict[str, float] = {}  # symbol -> qty
        self.entry_prices: dict[str, float] = {}  # symbol -> avg entry price
        self.entry_timestamps: dict[str, datetime] = {}
        self.fills: list[FillRecord] = []
        self.trades: list[TradeRecord] = []
        self.equity_curve: list[EquityPoint] = []
        self._pending_exit: tuple[str, float, datetime, str] | None = None
        # (symbol, qty, entry_ts, entry_price, accumulated_fees, exit_reason)

    # ---- sizing helpers -------------------------------------------------
    def position_qty(self, symbol: str) -> float:
        return self.positions.get(symbol, 0.0)

    def has_position(self, symbol: str) -> bool:
        return self.positions.get(symbol, 0.0) > 0

    def equity(self, mark_price: float | None = None, timestamp: datetime | None = None) -> float:
        """Mark-to-market equity using `mark_price` for the primary symbol."""
        qty = self.positions.get(self.primary_symbol, 0.0)
        px = mark_price if mark_price is not None else self.entry_prices.get(self.primary_symbol, 0.0)
        return self.cash + qty * px

    def position_value(self, mark_price: float) -> float:
        return self.positions.get(self.primary_symbol, 0.0) * mark_price

    # ---- order application ---------------------------------------------
    def apply_buy(self, fill: FillRecord) -> None:
        """Apply a buy fill: spend cash, increase position."""
        symbol = fill.symbol
        cost = fill.filled_qty * fill.price
        total_cost = cost + fill.fee_paid
        if total_cost > self.cash + 1e-9:
            # Should not happen — engine caps qty to available cash. Defensive.
            # Scale down to what we can actually afford.
            affordable_qty = max(0.0, (self.cash - 0.0) / (fill.price * (1.0 + fill.fee_paid / max(cost, 1e-9) if cost > 0 else 1.0)))
            # Simpler: cap to cash / price, fees on top
            affordable_qty = self.cash / (fill.price * (1.0 + 0.0))
            affordable_qty = max(0.0, affordable_qty * 0.999)  # safety margin
            if affordable_qty <= 0:
                return  # skip
            fill.filled_qty = min(fill.filled_qty, affordable_qty)
            fill.fee_paid = fill.filled_qty * fill.price * 0.001  # approximate (default 10bps)
            cost = fill.filled_qty * fill.price
            total_cost = cost + fill.fee_paid

        prev_qty = self.positions.get(symbol, 0.0)
        prev_entry = self.entry_prices.get(symbol, 0.0)
        new_qty = prev_qty + fill.filled_qty
        if new_qty > 0:
            self.entry_prices[symbol] = (prev_qty * prev_entry + fill.filled_qty * fill.price) / new_qty
            if prev_qty == 0:
                self.entry_timestamps[symbol] = fill.timestamp
        self.positions[symbol] = new_qty
        self.cash -= total_cost
        self.fills.append(fill)

    def apply_sell(self, fill: FillRecord) -> TradeRecord | None:
        """Apply a sell fill: receive cash, reduce position. Returns a TradeRecord if
        the position fully closes, otherwise None."""
        symbol = fill.symbol
        if self.positions.get(symbol, 0.0) <= 0:
            return None

        sell_qty = min(fill.filled_qty, self.positions[symbol])
        proceeds = sell_qty * fill.price
        net_proceeds = proceeds - fill.fee_paid
        prev_qty = self.positions[symbol]
        prev_entry = self.entry_prices.get(symbol, 0.0)
        entry_ts = self.entry_timestamps.get(symbol, fill.timestamp)

        trade: TradeRecord | None = None
        if abs(sell_qty - prev_qty) < 1e-12:
            # Full close
            gross_pnl = sell_qty * (fill.price - prev_entry)
            trade = TradeRecord(
                symbol=symbol,
                entry_ts=entry_ts,
                entry_price=prev_entry,
                exit_ts=fill.timestamp,
                exit_price=fill.price,
                qty=sell_qty,
                pnl=gross_pnl - fill.fee_paid,
                pnl_pct=(fill.price / prev_entry) - 1.0,
                fees=fill.fee_paid,
                exit_reason=fill.reason,
            )
            self.trades.append(trade)
            self.positions.pop(symbol, None)
            self.entry_prices.pop(symbol, None)
            self.entry_timestamps.pop(symbol, None)
        else:
            # Partial close — we still book a trade for the closed portion
            gross_pnl = sell_qty * (fill.price - prev_entry)
            trade = TradeRecord(
                symbol=symbol,
                entry_ts=entry_ts,
                entry_price=prev_entry,
                exit_ts=fill.timestamp,
                exit_price=fill.price,
                qty=sell_qty,
                pnl=gross_pnl - fill.fee_paid,
                pnl_pct=(fill.price / prev_entry) - 1.0,
                fees=fill.fee_paid,
                exit_reason=fill.reason,
            )
            self.trades.append(trade)
            self.positions[symbol] = prev_qty - sell_qty
            # entry_price stays the same for the remaining portion

        self.cash += net_proceeds
        self.fills.append(fill)
        return trade

    def max_buy_qty(self, price: float, fee_bps: float, safety: float = 0.999) -> float:
        """Maximum qty we can afford at `price` given current cash.

        Reserves a small safety fraction to cover slippage + fees without
        forcing the engine to re-margin.
        """
        if price <= 0:
            return 0.0
        # Total cost per unit = price * (1 + fee_bps/10000 + slip_bps/10000)
        # We use a worst-case estimate; engine will refine.
        worst_case = price * (1.0 + 0.002)  # 20bps headroom
        return max(0.0, (self.cash * safety) / worst_case)

    # ---- equity curve ---------------------------------------------------
    def record_equity(self, candle: Candle) -> None:
        qty = self.positions.get(self.primary_symbol, 0.0)
        eq = self.cash + qty * candle.close
        self.equity_curve.append(
            EquityPoint(
                timestamp=candle.timestamp,
                cash=self.cash,
                equity=eq,
                position_value=qty * candle.close,
                position_qty=qty,
            )
        )

    # ---- reporting ------------------------------------------------------
    def trade_count(self) -> int:
        return len(self.trades)

    def winning_trades(self) -> int:
        return sum(1 for t in self.trades if t.pnl > 0)

    def total_fees(self) -> float:
        return sum(f.fee_paid for f in self.fills)

    def realized_pnl(self) -> float:
        return sum(t.pnl for t in self.trades)


__all__ = ["EquityPoint", "Portfolio"]