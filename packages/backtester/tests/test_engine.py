"""Tests for the engine: latency, stop-loss trigger, partial fills, end-to-end strategies."""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from backtester.engine import BacktestEngine
from backtester.execution import ExecutionConfig
from backtester.schemas import Candle
from backtester.strategies import BuyAndHold, RSIReversal, SMACross


def test_latency_means_next_bar_fill():
    """A signal at bar i should fill against bar i+1's open, not bar i's close."""
    base = datetime(2024, 1, 1)

    candles = [
        Candle(timestamp=base, open=100.0, high=101.0, low=99.0, close=100.5, volume=10.0, symbol="X"),
        # The big gap on bar 1: open is 110 vs bar 0 close 100.5
        Candle(timestamp=base + timedelta(hours=1), open=110.0, high=111.0, low=109.0, close=110.5, volume=10.0, symbol="X"),
        Candle(timestamp=base + timedelta(hours=2), open=120.0, high=121.0, low=119.0, close=120.5, volume=10.0, symbol="X"),
    ]
    result = BacktestEngine(
        BuyAndHold(),
        candles,
        ExecutionConfig(slippage_bps=0, fee_bps=0, top_of_book_usd=1_000_000, latency_ms=100),
        initial_capital=10_000,
        primary_symbol="X",
    ).run()

    # BuyAndHold signals at bar 0, fills at bar 1's open (110.0)
    assert len(result.fills) >= 2  # entry + end-of-data exit
    entry_fill = result.fills[0]
    assert entry_fill.price == pytest.approx(110.0, rel=1e-6)
    assert entry_fill.timestamp == base + timedelta(hours=1)


def test_stop_loss_triggers_on_next_bar():
    """A position with stop at $95 should be closed when the NEXT bar's low <= 95."""
    from backtester.strategy import Signal, SignalSide, Strategy

    base = datetime(2024, 1, 1)
    candles = [
        # Bar 0: enter at 100, set stop at 95
        Candle(timestamp=base, open=100.0, high=101.0, low=99.0, close=100.5, volume=10.0, symbol="X"),
        # Bar 1: dips to 90 → SL should trigger
        Candle(timestamp=base + timedelta(hours=1), open=99.0, high=99.5, low=90.0, close=92.0, volume=10.0, symbol="X"),
        # Bar 2: irrelevant
        Candle(timestamp=base + timedelta(hours=2), open=92.0, high=93.0, low=91.0, close=92.5, volume=10.0, symbol="X"),
    ]

    class EnterWithStop(Strategy):
        name = "EnterWithStop"

        def __init__(self):
            self._done = False

        def on_candle(self, candle, portfolio):
            if not self._done:
                self._done = True
                return Signal(SignalSide.BUY, target_qty=10.0, stop_loss=95.0, reason="entry")
            return Signal(SignalSide.HOLD)

    result = BacktestEngine(
        EnterWithStop(),
        candles,
        ExecutionConfig(slippage_bps=0, fee_bps=0, top_of_book_usd=1_000_000, latency_ms=0),
        initial_capital=10_000,
        primary_symbol="X",
    ).run()

    # We expect: buy at bar 1 open (99.0, 10 qty) → 990 cost. Then SL fires
    # at bar 1 low (95 trigger) → sell 10 @ 95 → 950 revenue.
    # Total trades = 1 (the SL exit).
    assert result.n_trades == 1
    trade = result.portfolio.trades[0]
    assert trade.exit_reason == "stop_loss"
    # Slippage on bracket sell uses the configured base_slippage_bps; the
    # test config sets slippage_bps=0 so the fill is exactly the trigger
    # price 95.0.
    assert trade.exit_price == pytest.approx(95.0, rel=1e-6)
    # Loss = 10 * (95.0 - 99.0) - 0 fees = -40.0
    assert trade.pnl < 0


def test_take_profit_triggers_on_next_bar():
    from backtester.strategy import Signal, SignalSide, Strategy

    base = datetime(2024, 1, 1)
    candles = [
        Candle(timestamp=base, open=100.0, high=101.0, low=99.0, close=100.5, volume=10.0, symbol="X"),
        Candle(timestamp=base + timedelta(hours=1), open=101.0, high=120.0, low=100.5, close=115.0, volume=10.0, symbol="X"),
        Candle(timestamp=base + timedelta(hours=2), open=115.0, high=116.0, low=114.0, close=115.5, volume=10.0, symbol="X"),
    ]

    class EnterWithTP(Strategy):
        name = "EnterWithTP"

        def __init__(self):
            self._done = False

        def on_candle(self, candle, portfolio):
            if not self._done:
                self._done = True
                return Signal(SignalSide.BUY, target_qty=10.0, take_profit=120.0, reason="entry")
            return Signal(SignalSide.HOLD)

    result = BacktestEngine(
        EnterWithTP(),
        candles,
        ExecutionConfig(slippage_bps=0, fee_bps=0, top_of_book_usd=1_000_000, latency_ms=0),
        initial_capital=10_000,
        primary_symbol="X",
    ).run()

    assert result.n_trades == 1
    assert result.portfolio.trades[0].exit_reason == "take_profit"
    assert result.portfolio.trades[0].pnl > 0


def test_partial_fill_blocks_oversize_buy():
    """When slippage-adjusted notional exceeds cash, buy should be capped."""
    base = datetime(2024, 1, 1)
    candles = [
        Candle(timestamp=base, open=100.0, high=101.0, low=99.0, close=100.5, volume=10.0, symbol="X"),
        Candle(timestamp=base + timedelta(hours=1), open=100.0, high=101.0, low=99.0, close=100.5, volume=10.0, symbol="X"),
    ]
    # Tiny top-of-book means even small orders hit the partial-fill cap.
    result = BacktestEngine(
        BuyAndHold(),
        candles,
        ExecutionConfig(
            slippage_bps=0, fee_bps=0, top_of_book_usd=200.0, max_depth_fraction=0.5,
            latency_ms=0,
        ),
        initial_capital=10_000,
        primary_symbol="X",
    ).run()

    # We tried to buy all-cash-worth of X at $100. Max fill = $200 * 0.5 / 100 = 1 unit.
    entry = result.fills[0]
    assert entry.filled_qty == pytest.approx(1.0, rel=1e-6)
    assert entry.requested_qty > entry.filled_qty


def test_buy_and_hold_runs_end_to_end(fixture_csv_path):
    from backtester.data import load_candles_from_csv
    candles = load_candles_from_csv(fixture_csv_path, default_symbol="BTCUSDT")
    result = BacktestEngine(
        BuyAndHold(),
        candles,
        ExecutionConfig(),
        initial_capital=10_000,
        primary_symbol="BTCUSDT",
    ).run()
    # Bought on bar 0, closed at last bar (end_of_data).
    assert result.n_trades >= 1
    # Should be some equity at end
    assert result.metrics.end_equity > 0


def test_sma_cross_runs_end_to_end(fixture_csv_path):
    from backtester.data import load_candles_from_csv
    candles = load_candles_from_csv(fixture_csv_path, default_symbol="BTCUSDT")
    result = BacktestEngine(
        SMACross(),
        candles,
        ExecutionConfig(),
        initial_capital=10_000,
        primary_symbol="BTCUSDT",
    ).run()
    assert result.n_bars == len(candles)
    # We don't assert trade count since SMA may not cross in fixture;
    # but it must not raise.
    assert result.metrics.end_equity > 0


def test_rsi_reversal_runs_end_to_end(fixture_csv_path):
    from backtester.data import load_candles_from_csv
    candles = load_candles_from_csv(fixture_csv_path, default_symbol="BTCUSDT")
    result = BacktestEngine(
        RSIReversal(),
        candles,
        ExecutionConfig(),
        initial_capital=10_000,
        primary_symbol="BTCUSDT",
    ).run()
    assert result.n_bars == len(candles)
    assert result.metrics.end_equity > 0


def test_sma_cross_with_whipsaw_data(whipsaw_candles):
    """Whipsaw data should produce at least one entry+exit via SMA crosses."""
    result = BacktestEngine(
        SMACross(fast_period=5, slow_period=10),
        whipsaw_candles,
        ExecutionConfig(slippage_bps=0, fee_bps=0, top_of_book_usd=10_000_000, latency_ms=0),
        initial_capital=10_000,
        primary_symbol="BTCUSDT",
    ).run()
    # We expect at least 2 trades (entries + exits) on a whipsaw series.
    assert result.n_trades >= 2


def test_position_closed_at_end_of_data():
    """An open position at the last bar must be closed by the engine."""
    base = datetime(2024, 1, 1)
    candles = [
        Candle(timestamp=base, open=100.0, high=101.0, low=99.0, close=100.5, volume=10.0, symbol="X"),
        Candle(timestamp=base + timedelta(hours=1), open=101.0, high=102.0, low=100.0, close=101.5, volume=10.0, symbol="X"),
    ]
    result = BacktestEngine(
        BuyAndHold(),
        candles,
        ExecutionConfig(slippage_bps=0, fee_bps=0, top_of_book_usd=1_000_000, latency_ms=0),
        initial_capital=10_000,
        primary_symbol="X",
    ).run()
    # Position closed at last bar
    assert result.portfolio.positions == {}
    assert result.n_trades == 1
    assert result.portfolio.trades[0].exit_reason == "end_of_data"


def test_engine_rejects_empty_candles():
    with pytest.raises(ValueError, match="must not be empty"):
        BacktestEngine(BuyAndHold(), [], ExecutionConfig())


def test_signal_at_last_bar_does_not_fill_outside_data():
    """A signal at the final bar cannot fill (no next bar). Position remains open
    and is force-closed by the engine."""
    base = datetime(2024, 1, 1)
    candles = [
        Candle(timestamp=base, open=100.0, high=101.0, low=99.0, close=100.5, volume=10.0, symbol="X"),
    ]
    result = BacktestEngine(
        BuyAndHold(),
        candles,
        ExecutionConfig(slippage_bps=0, fee_bps=0, top_of_book_usd=1_000_000, latency_ms=0),
        initial_capital=10_000,
        primary_symbol="X",
    ).run()
    # Engine must close the position at last close via end_of_data.
    assert result.n_trades == 1
    assert result.portfolio.trades[0].exit_reason == "end_of_data"