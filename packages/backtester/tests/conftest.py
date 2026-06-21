"""Shared test fixtures."""

from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest

# Ensure src/ is on the path so `import backtester` works without install.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from backtester.schemas import Candle  # noqa: E402


FIXTURES_DIR = ROOT / "fixtures"


def make_trending_candles(
    n: int = 50,
    start_price: float = 100.0,
    drift_per_bar: float = 0.5,
    spread: float = 1.0,
    timeframe_seconds: int = 3600,
    symbol: str = "BTCUSDT",
    base_volume: float = 10.0,
) -> list[Candle]:
    """Build a deterministic trending candle series.

    Prices move up by `drift_per_bar` with some sinusoidal noise and a
    tight high/low spread. Used for tests that need predictable
    behavior.
    """
    import math

    candles = []
    base = datetime(2024, 1, 1, 0, 0, 0)
    px = start_price
    for i in range(n):
        noise = math.sin(i / 3.0) * 0.5
        o = px
        c = px + drift_per_bar + noise
        h = max(o, c) + spread
        l = min(o, c) - spread * 0.5
        candles.append(
            Candle(
                timestamp=base + timedelta(seconds=timeframe_seconds * i),
                open=o,
                high=h,
                low=l,
                close=c,
                volume=base_volume,
                symbol=symbol,
            )
        )
        px = c
    return candles


def make_whipsaw_candles(n: int = 80, symbol: str = "BTCUSDT") -> list[Candle]:
    """Build candles that alternate up and down — good for triggering SMA crosses."""
    import math

    candles = []
    base = datetime(2024, 1, 1, 0, 0, 0)
    px = 100.0
    for i in range(n):
        # 5-bar up, 5-bar down, alternating
        period = 10
        phase = (i % period) / period
        drift = 2.0 if phase < 0.5 else -2.0
        noise = math.sin(i / 2.0) * 0.3
        o = px
        c = px + drift + noise
        h = max(o, c) + 1.0
        l = min(o, c) - 1.0
        candles.append(
            Candle(
                timestamp=base + timedelta(hours=i),
                open=o,
                high=h,
                low=l,
                close=c,
                volume=10.0,
                symbol=symbol,
            )
        )
        px = c
    return candles


@pytest.fixture
def trending_candles():
    return make_trending_candles()


@pytest.fixture
def whipsaw_candles():
    return make_whipsaw_candles()


@pytest.fixture
def fixture_csv_path():
    return FIXTURES_DIR / "btcusdt_1h_synth.csv"