"""Tests for the data layer and schemas."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pytest

from backtester.data import (
    BITGET_BASE,
    _granularity_for,
    load_candles_from_csv,
)
from backtester.schemas import Candle, VALID_TIMEFRAMES


def test_granularity_mapping():
    assert _granularity_for("1m") == "1min"
    assert _granularity_for("5m") == "5min"
    assert _granularity_for("1h") == "1h"
    assert _granularity_for("4h") == "4h"
    assert _granularity_for("1d") == "1day"


def test_valid_timeframes():
    assert set(VALID_TIMEFRAMES) == {"1m", "5m", "15m", "1h", "4h", "1d"}


def test_candle_validator_low_must_be_lowest():
    with pytest.raises(ValueError):
        Candle(
            timestamp=datetime(2024, 1, 1),
            open=100, high=110, low=120,  # 120 > min(100,110,105) = 100, invalid
            close=105, volume=10,
        )


def test_candle_validator_high_must_be_highest():
    with pytest.raises(ValueError):
        Candle(
            timestamp=datetime(2024, 1, 1),
            open=100, high=95,  # 95 < 100 (open), invalid
            low=90, close=92, volume=10,
        )


def test_candle_accepts_valid_ohlc():
    c = Candle(
        timestamp=datetime(2024, 1, 1),
        open=100, high=110, low=95, close=105, volume=10,
    )
    assert c.open == 100


def test_candle_rejects_negative_prices():
    with pytest.raises(ValueError):
        Candle(
            timestamp=datetime(2024, 1, 1),
            open=-100, high=110, low=95, close=105, volume=10,
        )


def test_load_candles_from_csv(fixture_csv_path):
    candles = load_candles_from_csv(fixture_csv_path, default_symbol="BTCUSDT")
    assert len(candles) > 0
    assert all(c.symbol == "BTCUSDT" for c in candles)
    assert all(isinstance(c.timestamp, datetime) for c in candles)


def test_bitget_base_url():
    assert BITGET_BASE == "https://api.bitget.com"