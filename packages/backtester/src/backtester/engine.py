"""Backtest engine — the main orchestration loop.

Flow per bar:
    1. Mark-to-market equity at `candle.close`, record equity point.
    2. Call `strategy.on_candle(candle, portfolio)`.
    3. If signal is HOLD, continue.
    4. Otherwise, fill signal at *next* bar's open (latency) — but
       we check the *current* bar's range first for stop/tp triggers.
    5. Book the fill via `portfolio.apply_*`.

The "next bar" semantics is what makes this realistic: at the moment
the strategy sees bar `t`, the order cannot fill at bar `t`'s close — by
the time the order reaches the exchange, bar `t` is closed. The fill
happens at bar `t+1`'s open (we conservatively skip if `t+1` doesn't
exist within the data range).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable, Iterable

from backtester.execution import ExecutionConfig, ExecutionModel
from backtester.metrics import MetricsReport, compute_metrics
from backtester.portfolio import Portfolio
from backtester.schemas import Candle, FillRecord
from backtester.strategy import Signal, SignalSide, Strategy


@dataclass
class BacktestResult:
    """Output of a backtest run."""

    config_summary: dict
    metrics: MetricsReport
    n_bars: int
    n_trades: int
    equity_curve: list[tuple[datetime, float]] = field(default_factory=list)
    fills: list[FillRecord] = field(default_factory=list)
    portfolio: object | None = None  # type: ignore[type-arg]

    def to_dict(self) -> dict:
        return {
            "config": self.config_summary,
            "metrics": self.metrics.to_dict(),
            "n_bars": self.n_bars,
            "n_trades": self.n_trades,
        }


class BacktestEngine:
    """Runs a strategy against a candle series."""

    def __init__(
        self,
        strategy: Strategy,
        candles: list[Candle],
        execution: ExecutionConfig,
        initial_capital: float = 10_000.0,
        primary_symbol: str = "BTCUSDT",
        progress_cb: Callable[[int, int], None] | None = None,
    ) -> None:
        if not candles:
            raise ValueError("candles list must not be empty")
        self.strategy = strategy
        # Normalize candles: ensure each one has `symbol` set.
        normalized = []
        for c in candles:
            if not getattr(c, "symbol", None):
                normalized.append(c.model_copy(update={"symbol": primary_symbol}))
            else:
                normalized.append(c)
        self.candles = sorted(normalized, key=lambda c: c.timestamp)
        self.execution = ExecutionModel(execution)
        self.config = execution
        self.initial_capital = initial_capital
        self.portfolio = Portfolio(initial_capital, primary_symbol=primary_symbol)
        self.primary_symbol = primary_symbol
        self.progress_cb = progress_cb

        # Per-position bracket state (open positions track their entry).
        # Keyed by symbol.
        self._brackets: dict[str, tuple[float | None, float | None]] = {}

    def _get_brackets(self, symbol: str) -> tuple[float | None, float | None]:
        return self._brackets.get(symbol, (None, None))

    def _set_brackets(self, symbol: str, sl: float | None, tp: float | None) -> None:
        self._brackets[symbol] = (sl, tp)

    def _clear_brackets(self, symbol: str) -> None:
        self._brackets.pop(symbol, None)

    def run(self) -> BacktestResult:
        self.strategy.on_start(self.portfolio)

        n = len(self.candles)
        # Step through the candles; the `pending_signal` represents a signal
        # emitted at bar `i` that will fill against bar `i+1`.
        pending_signal: Signal | None = None
        pending_emit_ts: datetime | None = None

        for i, candle in enumerate(self.candles):
            # 1. Mark-to-market + record equity at the current bar.
            self.portfolio.record_equity(candle)

            # 2. Apply pending fill against this bar (if any).
            if pending_signal is not None and pending_signal.side != SignalSide.HOLD:
                held_qty = self.portfolio.position_qty(self.primary_symbol)
                entry_price = self.portfolio.entry_prices.get(self.primary_symbol, 0.0)
                sl, tp = self._get_brackets(self.primary_symbol)

                # Check bracket first — bracket has priority over a new signal.
                # This implements "if SL/TP triggers, ignore the new entry signal".
                bracket_hit = self.execution.check_brackets(
                    candle=candle,
                    held_qty=held_qty,
                    entry_price=entry_price,
                    stop_loss=sl,
                    take_profit=tp,
                )

                if bracket_hit == "stop_loss" and held_qty > 0:
                    trigger = sl  # type: ignore[assignment]
                    fill = self.execution.fill_bracket(
                        side="sell",
                        qty=held_qty,
                        trigger_price=trigger,
                        timestamp=candle.timestamp,
                        reason="stop_loss",
                    )
                    rec = fill.to_record(self.primary_symbol)
                    self.portfolio.apply_sell(rec)
                    self._clear_brackets(self.primary_symbol)
                    pending_signal = None
                elif bracket_hit == "take_profit" and held_qty > 0:
                    trigger = tp  # type: ignore[assignment]
                    fill = self.execution.fill_bracket(
                        side="sell",
                        qty=held_qty,
                        trigger_price=trigger,
                        timestamp=candle.timestamp,
                        reason="take_profit",
                    )
                    rec = fill.to_record(self.primary_symbol)
                    self.portfolio.apply_sell(rec)
                    self._clear_brackets(self.primary_symbol)
                    pending_signal = None
                else:
                    # Apply the pending signal at this bar's open (best
                    # estimate of the fill price given latency).
                    self._apply_signal(
                        pending_signal,
                        reference_price=candle.open,
                        timestamp=candle.timestamp,
                    )
                pending_signal = None

            # 2b. After any fill at this bar, check brackets on the
            # current bar's range while a position is held. This catches
            # the case where a BUY was filled at bar N's open and the SL
            # is also inside bar N's range.
            if self.portfolio.has_position(self.primary_symbol) and pending_signal is None:
                held_qty = self.portfolio.position_qty(self.primary_symbol)
                entry_price = self.portfolio.entry_prices.get(self.primary_symbol, 0.0)
                sl, tp = self._get_brackets(self.primary_symbol)
                bracket_hit = self.execution.check_brackets(
                    candle=candle,
                    held_qty=held_qty,
                    entry_price=entry_price,
                    stop_loss=sl,
                    take_profit=tp,
                )
                if bracket_hit == "stop_loss" and sl is not None:
                    fill = self.execution.fill_bracket(
                        side="sell",
                        qty=held_qty,
                        trigger_price=sl,
                        timestamp=candle.timestamp,
                        reason="stop_loss",
                    )
                    rec = fill.to_record(self.primary_symbol)
                    self.portfolio.apply_sell(rec)
                    self._clear_brackets(self.primary_symbol)
                elif bracket_hit == "take_profit" and tp is not None:
                    fill = self.execution.fill_bracket(
                        side="sell",
                        qty=held_qty,
                        trigger_price=tp,
                        timestamp=candle.timestamp,
                        reason="take_profit",
                    )
                    rec = fill.to_record(self.primary_symbol)
                    self.portfolio.apply_sell(rec)
                    self._clear_brackets(self.primary_symbol)

            # 3. Ask the strategy for a fresh signal.
            signal = self.strategy.on_candle(candle, self.portfolio)
            # Stash brackets from the signal so they apply to the
            # *resulting* position (used if signal is BUY).
            if signal.stop_loss is not None or signal.take_profit is not None:
                # Only meaningful on BUY (or when closing — we ignore for SELL).
                if signal.side == SignalSide.BUY:
                    self._set_brackets(
                        self.primary_symbol, signal.stop_loss, signal.take_profit
                    )

            if signal.side != SignalSide.HOLD:
                pending_signal = signal
                pending_emit_ts = candle.timestamp

            if self.progress_cb is not None:
                self.progress_cb(i + 1, n)

        # End of data — close any open position at last close.
        if self.portfolio.has_position(self.primary_symbol):
            last = self.candles[-1]
            held_qty = self.portfolio.position_qty(self.primary_symbol)
            fill = self.execution.fill_market(
                side="sell",
                requested_qty=held_qty,
                reference_price=last.close,
                timestamp=last.timestamp,
                reason="end_of_data",
            )
            rec = fill.to_record(self.primary_symbol)
            self.portfolio.apply_sell(rec)
            self._clear_brackets(self.primary_symbol)
            # Final equity point at last close.
            self.portfolio.record_equity(last)
        # If a pending signal never got a next bar to fill against, force
        # fill it at the last bar's close. This is the conservative
        # end-of-data behavior: positions still get booked so the run is
        # not silently dropped. The position is then closed in the same
        # end-of-data pass above; if it was a BUY and we never held
        # anything before, the next end-of-data pass will close it.
        if pending_signal is not None and pending_signal.side != SignalSide.HOLD:
            last = self.candles[-1]
            self._apply_signal(
                pending_signal,
                reference_price=last.close,
                timestamp=last.timestamp,
            )
            # Immediately close the resulting position so the run completes cleanly.
            if self.portfolio.has_position(self.primary_symbol):
                held_qty = self.portfolio.position_qty(self.primary_symbol)
                fill = self.execution.fill_market(
                    side="sell",
                    requested_qty=held_qty,
                    reference_price=last.close,
                    timestamp=last.timestamp,
                    reason="end_of_data",
                )
                rec = fill.to_record(self.primary_symbol)
                self.portfolio.apply_sell(rec)
                self._clear_brackets(self.primary_symbol)
                self.portfolio.record_equity(last)
            pending_signal = None

        self.strategy.on_finish(self.portfolio)

        # Build result.
        equity_curve = [(p.timestamp, p.equity) for p in self.portfolio.equity_curve]
        trade_pnls = [t.pnl for t in self.portfolio.trades]
        metrics = compute_metrics(
            equity_curve=self.portfolio.equity_curve,
            trade_pnls=trade_pnls,
            total_fees=self.portfolio.total_fees(),
            initial_capital=self.initial_capital,
        )

        return BacktestResult(
            config_summary={
                "strategy": self.strategy.name,
                "symbol": self.primary_symbol,
                "initial_capital": self.initial_capital,
                "slippage_bps": self.config.slippage_bps,
                "fee_bps": self.config.fee_bps,
                "latency_ms": self.config.latency_ms,
            },
            metrics=metrics,
            n_bars=len(self.candles),
            n_trades=self.portfolio.trade_count(),
            equity_curve=equity_curve,
            fills=self.portfolio.fills,
            portfolio=self.portfolio,
        )

    # ------------------------------------------------------------------
    def _apply_signal(self, signal: Signal, reference_price: float, timestamp: datetime) -> None:
        """Fill a pending signal against `reference_price`."""
        if signal.side == SignalSide.BUY:
            # Size from cash unless strategy specified a qty.
            target_qty = signal.target_qty
            if target_qty is None:
                target_qty = self.portfolio.max_buy_qty(
                    reference_price,
                    fee_bps=self.config.fee_bps,
                )
            if target_qty <= 0:
                return
            fill = self.execution.fill_market(
                side="buy",
                requested_qty=target_qty,
                reference_price=reference_price,
                timestamp=timestamp,
                reason=signal.reason or "signal",
            )
            rec = fill.to_record(self.primary_symbol)
            self.portfolio.apply_buy(rec)
            # Attach brackets from the signal to the resulting position so
            # subsequent bars can check against the stop / target.
            if signal.stop_loss is not None or signal.take_profit is not None:
                self._set_brackets(
                    self.primary_symbol, signal.stop_loss, signal.take_profit
                )
        elif signal.side == SignalSide.SELL:
            held = self.portfolio.position_qty(self.primary_symbol)
            if held <= 0:
                return
            qty = signal.target_qty if signal.target_qty is not None else held
            qty = min(qty, held)
            fill = self.execution.fill_market(
                side="sell",
                requested_qty=qty,
                reference_price=reference_price,
                timestamp=timestamp,
                reason=signal.reason or "signal",
            )
            rec = fill.to_record(self.primary_symbol)
            self.portfolio.apply_sell(rec)
            # If we fully closed, clear brackets.
            if not self.portfolio.has_position(self.primary_symbol):
                self._clear_brackets(self.primary_symbol)


def run_backtest(
    strategy: Strategy,
    candles: Iterable[Candle],
    execution: ExecutionConfig,
    initial_capital: float = 10_000.0,
    primary_symbol: str = "BTCUSDT",
) -> BacktestResult:
    """Convenience: build an engine and run."""
    eng = BacktestEngine(
        strategy=strategy,
        candles=list(candles),
        execution=execution,
        initial_capital=initial_capital,
        primary_symbol=primary_symbol,
    )
    return eng.run()


__all__ = ["BacktestEngine", "BacktestResult", "run_backtest"]