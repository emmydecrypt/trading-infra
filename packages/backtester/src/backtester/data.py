"""Data layer: fetch OHLCV from Bitget v2 public API with caching.

Endpoint: `GET https://api.bitget.com/api/v2/market/candles`
Params: symbol, granularity (e.g. "1h"), startTime, endTime, limit (max 200)

Cache layout:
    ~/.cache/trading-infra/candles/<symbol>_<granularity>_<start>_<end>.csv
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import httpx

from backtester.schemas import VALID_TIMEFRAMES, Candle, Timeframe

DEFAULT_CACHE_DIR = Path.home() / ".cache" / "trading-infra" / "candles"
BITGET_BASE = "https://api.bitget.com"


def _granularity_for(tf: Timeframe) -> str:
    return {
        "1m": "1min",
        "5m": "5min",
        "15m": "15min",
        "1h": "1h",
        "4h": "4h",
        "1d": "1day",
    }[tf]


def _cache_key(symbol: str, tf: Timeframe, start: datetime, end: datetime) -> str:
    raw = f"{symbol}|{tf}|{start.isoformat()}|{end.isoformat()}"
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def _cache_path(symbol: str, tf: Timeframe, start: datetime, end: datetime, cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    fname = f"{symbol}_{_granularity_for(tf)}_{int(start.timestamp())}_{int(end.timestamp())}_{_cache_key(symbol, tf, start, end)}.csv"
    return cache_dir / fname


@dataclass
class FetchProgress:
    fetched: int
    total: int  # -1 if unknown


def _parse_candle_row(row: list[str]) -> Candle:
    """Bitget row format: [ts(ms), open, high, low, close, base_vol, quote_vol]."""
    ts_ms = int(row[0])
    ts = datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc).replace(tzinfo=None)
    return Candle(
        timestamp=ts,
        open=float(row[1]),
        high=float(row[2]),
        low=float(row[3]),
        close=float(row[4]),
        volume=float(row[5]),
    )


def fetch_candles(
    symbol: str,
    timeframe: Timeframe,
    start: datetime,
    end: datetime,
    *,
    cache_dir: Path | None = None,
    use_cache: bool = True,
    client: httpx.Client | None = None,
    progress_cb=None,
) -> list[Candle]:
    """Fetch OHLCV for [start, end] from Bitget v2 public API.

    Uses pagination (200 rows per request) and caches the result as CSV.
    """
    if timeframe not in VALID_TIMEFRAMES:
        raise ValueError(f"Unknown timeframe {timeframe!r}. Valid: {VALID_TIMEFRAMES}")

    if start.tzinfo is not None:
        start = start.astimezone(timezone.utc).replace(tzinfo=None)
    if end.tzinfo is not None:
        end = end.astimezone(timezone.utc).replace(tzinfo=None)
    if end <= start:
        raise ValueError("end must be after start")

    cache_dir = cache_dir or DEFAULT_CACHE_DIR
    path = _cache_path(symbol, timeframe, start, end, cache_dir)

    if use_cache and path.exists():
        rows = _read_csv(path)
        return [_csv_row_to_candle(r) for r in rows]

    # Fetch from API with pagination.
    granularity = _granularity_for(timeframe)
    out: list[Candle] = []
    cursor = int(start.timestamp() * 1000)
    end_ms = int(end.timestamp() * 1000)

    owns_client = client is None
    client = client or httpx.Client(base_url=BITGET_BASE, timeout=15.0)

    try:
        while cursor < end_ms:
            params = {
                "symbol": symbol,
                "granularity": granularity,
                "startTime": str(cursor),
                "endTime": str(end_ms),
                "limit": "200",
            }
            resp = client.get("/api/v2/market/candles", params=params)
            if resp.status_code != 200:
                raise RuntimeError(
                    f"Bitget HTTP {resp.status_code}: {resp.text[:200]}"
                )
            data = resp.json()
            if data.get("code") != "00000":
                raise RuntimeError(f"Bitget error: {data}")
            rows = data.get("data") or []
            if not rows:
                break
            # Bitget returns newest-first; reverse to chronological.
            for row in reversed(rows):
                out.append(_parse_candle_row(row))
            # Advance cursor past the last (oldest) ts we have.
            oldest_ts_ms = int(rows[-1][0])
            cursor = oldest_ts_ms + 1
            if progress_cb is not None:
                progress_cb(FetchProgress(len(out), -1))
            if len(rows) < 200:
                break
            # Respect a soft rate limit (10 req/s per Bitget docs).
            time.sleep(0.12)
    finally:
        if owns_client:
            client.close()

    # Cache as CSV
    if use_cache and out:
        _write_csv(path, out)

    return out


def _csv_row_to_candle(row: dict, default_symbol: str = "BTCUSDT") -> Candle:
    return Candle(
        timestamp=datetime.fromisoformat(row["timestamp"]),
        open=float(row["open"]),
        high=float(row["high"]),
        low=float(row["low"]),
        close=float(row["close"]),
        volume=float(row["volume"]),
        symbol=row.get("symbol", default_symbol),
    )


def _write_csv(path: Path, candles: list[Candle]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["timestamp", "open", "high", "low", "close", "volume"])
        for c in candles:
            w.writerow([c.timestamp.isoformat(), c.open, c.high, c.low, c.close, c.volume])


def _read_csv(path: Path) -> list[dict]:
    with path.open("r", newline="") as f:
        return list(csv.DictReader(f))


def load_candles_from_csv(path: str | Path, default_symbol: str = "BTCUSDT") -> list[Candle]:
    """Load candles from a CSV file (timestamp ISO, OHLCV)."""
    return [_csv_row_to_candle(r, default_symbol) for r in _read_csv(Path(path))]


__all__ = [
    "BITGET_BASE",
    "DEFAULT_CACHE_DIR",
    "FetchProgress",
    "fetch_candles",
    "load_candles_from_csv",
]