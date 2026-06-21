"""Tests for execution math (slippage, fees, partial fills, brackets)."""

from __future__ import annotations

import math
from datetime import datetime

import pytest

from backtester.execution import (
    ExecutionConfig,
    ExecutionModel,
    Fill,
    geometric_round_trip_pct,
    round_trip_cost_bps,
)
from backtester.schemas import Candle


def make_candle(open_=100.0, high=110.0, low=90.0, close=105.0):
    return Candle(
        timestamp=datetime(2024, 1, 1),
        open=open_,
        high=high,
        low=low,
        close=close,
        volume=10.0,
    )


def test_buy_pays_positive_slippage():
    cfg = ExecutionConfig(slippage_bps=10, fee_bps=0, top_of_book_usd=1_000_000_000)
    em = ExecutionModel(cfg)
    fill = em.fill_market(
        side="buy",
        requested_qty=1.0,
        reference_price=100.0,
        timestamp=datetime(2024, 1, 1),
    )
    # With huge top_of_book, size_ratio ≈ 0, so slippage ≈ 10 bps
    # Slippage adds 10 bps = 0.1% to price
    assert fill.price == pytest.approx(100.10, rel=1e-4)
    assert fill.slippage_bps == pytest.approx(10.0, rel=1e-4)


def test_sell_receives_negative_slippage():
    cfg = ExecutionConfig(slippage_bps=10, fee_bps=0, top_of_book_usd=1_000_000_000)
    em = ExecutionModel(cfg)
    fill = em.fill_market(
        side="sell",
        requested_qty=1.0,
        reference_price=100.0,
        timestamp=datetime(2024, 1, 1),
    )
    # Slippage subtracts 10 bps = 0.1% from price
    assert fill.price == pytest.approx(99.90, rel=1e-4)


def test_slippage_scales_with_order_size():
    """A larger order relative to top-of-book gets more slippage."""
    cfg = ExecutionConfig(slippage_bps=10, fee_bps=0, top_of_book_usd=100_000)
    em = ExecutionModel(cfg)
    small = em.fill_market("buy", 0.1, 100.0, datetime(2024, 1, 1))
    big = em.fill_market("buy", 1.0, 100.0, datetime(2024, 1, 1))
    # small: notional=10, size_ratio=0.0001, slip ≈ 10*(1.0001) ≈ 10.001
    # big:   notional=100, size_ratio=0.001, slip ≈ 10*(1.001) ≈ 10.01
    assert big.slippage_bps > small.slippage_bps


def test_partial_fill_caps_at_depth_fraction():
    """When notional exceeds max_depth_fraction * top_of_book, qty is capped."""
    cfg = ExecutionConfig(
        slippage_bps=0,
        fee_bps=0,
        top_of_book_usd=10_000,
        max_depth_fraction=0.5,
    )
    em = ExecutionModel(cfg)
    # Try to buy 200 units at $100 = $20k notional. Max is $5k → 50 units.
    fill = em.fill_market("buy", 200.0, 100.0, datetime(2024, 1, 1))
    assert fill.filled_qty == pytest.approx(50.0, rel=1e-6)
    assert fill.requested_qty == pytest.approx(200.0)
    assert not fill.is_filled or fill.filled_qty < fill.requested_qty


def test_partial_fill_does_not_cap_small_order():
    cfg = ExecutionConfig(
        slippage_bps=0,
        fee_bps=0,
        top_of_book_usd=10_000,
        max_depth_fraction=0.5,
    )
    em = ExecutionModel(cfg)
    # 10 units at $100 = $1k notional. Below $5k cap → fully fills.
    fill = em.fill_market("buy", 10.0, 100.0, datetime(2024, 1, 1))
    assert fill.filled_qty == pytest.approx(10.0, rel=1e-6)


def test_fee_math_hand_computed():
    """Fee is (qty * price) * bps / 10000, taken in cash."""
    cfg = ExecutionConfig(slippage_bps=0, fee_bps=10, top_of_book_usd=1_000_000)
    em = ExecutionModel(cfg)
    fill = em.fill_market("buy", 5.0, 100.0, datetime(2024, 1, 1))
    # price = 100.0, qty = 5.0 → notional = 500
    # fee = 500 * 10 / 10000 = 0.5
    assert fill.fee_paid == pytest.approx(0.5, rel=1e-6)


def test_stop_loss_triggers_when_low_touches_level():
    cfg = ExecutionConfig()
    em = ExecutionModel(cfg)
    candle = make_candle(low=95.0)  # low touched 95
    triggered = em.check_brackets(candle, held_qty=1.0, entry_price=100.0, stop_loss=95.0, take_profit=120.0)
    assert triggered == "stop_loss"


def test_take_profit_triggers_when_high_touches_level():
    cfg = ExecutionConfig()
    em = ExecutionModel(cfg)
    candle = make_candle(high=120.0)
    triggered = em.check_brackets(candle, held_qty=1.0, entry_price=100.0, stop_loss=80.0, take_profit=120.0)
    assert triggered == "take_profit"


def test_no_bracket_trigger_when_price_in_range():
    cfg = ExecutionConfig()
    em = ExecutionModel(cfg)
    candle = make_candle(low=95.0, high=105.0)
    triggered = em.check_brackets(candle, held_qty=1.0, entry_price=100.0, stop_loss=80.0, take_profit=120.0)
    assert triggered is None


def test_no_bracket_when_no_position():
    cfg = ExecutionConfig()
    em = ExecutionModel(cfg)
    candle = make_candle(low=10.0)  # would trigger if we had a position
    triggered = em.check_brackets(candle, held_qty=0.0, entry_price=100.0, stop_loss=95.0, take_profit=120.0)
    assert triggered is None


def test_stop_takes_priority_over_take_profit_same_bar():
    """Conservative ordering: SL fires before TP if both hit same bar."""
    cfg = ExecutionConfig()
    em = ExecutionModel(cfg)
    candle = make_candle(low=50.0, high=200.0)
    triggered = em.check_brackets(candle, held_qty=1.0, entry_price=100.0, stop_loss=95.0, take_profit=120.0)
    assert triggered == "stop_loss"


def test_round_trip_cost_helper_defaults():
    """Default 10bps fee + 5bps slippage each way = 30 bps round-trip."""
    cfg = ExecutionConfig()
    assert round_trip_cost_bps(cfg) == pytest.approx(30.0)


def test_geometric_round_trip_helper():
    """A 1% price move with 30bps costs is reduced by the cost."""
    cfg = ExecutionConfig()
    cost = round_trip_cost_bps(cfg)
    net = geometric_round_trip_pct(0.01, cost)
    # (1.01) * (1 - 0.003) / (1 + 0.003) - 1 = 0.003958
    assert net < 0.01
    assert net > 0
    assert net == pytest.approx(0.003958, rel=1e-3)


def test_fill_bracket_applies_slippage():
    """Stop/take-profit fills still get slippage, applied to the trigger level."""
    cfg = ExecutionConfig(slippage_bps=10, fee_bps=0, top_of_book_usd=1_000_000)
    em = ExecutionModel(cfg)
    # Sell triggered at $95 with 10 bps slippage → receive $95 * (1 - 0.001) = $94.905
    fill = em.fill_bracket("sell", 1.0, 95.0, datetime(2024, 1, 1), reason="stop_loss")
    assert fill.price == pytest.approx(95.0 * 0.999, rel=1e-6)
    assert fill.reason == "stop_loss"