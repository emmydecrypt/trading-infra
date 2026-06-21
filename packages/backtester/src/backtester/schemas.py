"""Pydantic schemas for backtester inputs/outputs."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class Candle(BaseModel):
    """A single OHLCV bar."""

    timestamp: datetime
    open: float = Field(gt=0)
    high: float = Field(gt=0)
    low: float = Field(gt=0)
    close: float = Field(gt=0)
    volume: float = Field(ge=0)
    symbol: str = "BTCUSDT"

    @field_validator("high")
    @classmethod
    def _high_is_highest(cls, v: float, info) -> float:
        o = info.data.get("open")
        l = info.data.get("low")
        c = info.data.get("close")
        if o is not None and l is not None and c is not None:
            if not (v >= o and v >= l and v >= c):
                raise ValueError("high must be >= open, low, close")
        return v

    @field_validator("low")
    @classmethod
    def _low_is_lowest(cls, v: float, info) -> float:
        o = info.data.get("open")
        h = info.data.get("high")
        c = info.data.get("close")
        if o is not None and h is not None and c is not None:
            if not (v <= o and v <= h and v <= c):
                raise ValueError("low must be <= open, high, close")
        return v

    @field_validator("open", "close")
    @classmethod
    def _no_negative(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("price must be positive")
        return v

    @model_validator(mode="after")
    def _ohlc_integrity(self) -> "Candle":
        if not (self.high >= max(self.open, self.low, self.close)):
            raise ValueError("high must be >= open, low, close")
        if not (self.low <= min(self.open, self.high, self.close)):
            raise ValueError("low must be <= open, high, close")
        return self


Timeframe = Literal["1m", "5m", "15m", "1h", "4h", "1d"]

VALID_TIMEFRAMES: tuple[str, ...] = ("1m", "5m", "15m", "1h", "4h", "1d")


class FillRecord(BaseModel):
    """A single fill event."""

    timestamp: datetime
    symbol: str
    side: Literal["buy", "sell"]
    requested_qty: float
    filled_qty: float
    price: float  # price per unit, after slippage
    fee_paid: float
    slippage_bps: float
    reason: str  # "signal", "stop_loss", "take_profit"


class TradeRecord(BaseModel):
    """A completed round-trip trade."""

    symbol: str
    entry_ts: datetime
    entry_price: float
    exit_ts: datetime
    exit_price: float
    qty: float
    pnl: float
    pnl_pct: float
    fees: float
    exit_reason: str  # "signal" | "stop_loss" | "take_profit" | "end_of_data"


class BacktestConfig(BaseModel):
    """Configuration for a single backtest run."""

    strategy: str
    symbol: str
    timeframe: Timeframe
    start: datetime
    end: datetime
    initial_capital: float = Field(gt=0, default=10_000.0)
    slippage_bps: float = Field(ge=0, default=5.0)
    fee_bps: float = Field(ge=0, default=10.0)
    maker_fee_bps: float = Field(ge=0, default=10.0)
    latency_ms: int = Field(ge=0, default=100)
    top_of_book_usd: float = Field(gt=0, default=50_000.0)