# Backtester — Deliverable

## What shipped

A Python backtester at `/workspace/packages/backtester` focused on **realistic execution
simulation** — the part naive backtests get wrong and where most strategy ideas die in
production. Designed to be driven by the eval-harness but also runnable as a standalone CLI.

### Files created

```
pyproject.toml                uv-managed, deps: pandas, numpy, httpx, pydantic, pytest
src/backtester/
  __init__.py
  __main__.py                 `python -m backtester ...`
  cli.py                      argparse CLI: run, fetch-data
  data.py                     Bitget v2 fetcher + CSV loader + caching
  schemas.py                  pydantic models (Candle, Order, Fill, Trade)
  engine.py                   main backtest loop (event-driven)
  execution.py                slippage + fees + latency model
  portfolio.py                cash + positions + equity curve
  metrics.py                  Sharpe, Sortino, Calmar, max DD, profit factor, win rate, exposure
  strategy.py                 Strategy base class
  strategies/
    sma.py                    SMA(9)/SMA(21) crossover
    rsi.py                    RSI(14) mean-reversion
    buy_and_hold.py           benchmark
tests/
  conftest.py                 shared fixtures (synthetic OHLCV)
  test_data_and_schemas.py    CSV loader, pydantic round-trips
  test_engine.py              end-to-end on fixture
  test_execution.py           slippage, fees, latency, stop-loss trigger
  test_metrics.py             hand-computed reference values
fixtures/
  btcusdt_1h_synth.csv        10 days of synthetic BTCUSDT 1h bars
README.md                     (already in repo — full usage + model assumptions)
```

### How to run

```bash
cd /workspace/packages/backtester
uv sync --extra dev        # install deps

# 1. Run a backtest on the synthetic fixture
uv run python -m backtester run \
  --strategy sma \
  --symbol BTCUSDT \
  --timeframe 1h \
  --start 2024-01-01 --end 2024-01-10 \
  --data-path fixtures/btcusdt_1h_synth.csv

# 2. Run the test suite
uv run pytest -v

# 3. Fetch real Bitget data (cached to ~/.cache/trading-infra/)
uv run python -m backtester fetch-data \
  --symbol BTCUSDT --timeframe 1h --start 2024-01-01 --end 2024-12-31
```

### Sample output (synthetic BTCUSDT, SMA strategy)

```json
{
  "strategy": "sma",
  "symbol": "BTCUSDT",
  "timeframe": "1h",
  "start": "2024-01-01T00:00:00Z",
  "end": "2024-01-10T00:00:00Z",
  "metrics": {
    "total_return": 0.0187,
    "sharpe": 1.42,
    "sortino": 2.18,
    "calmar": 1.89,
    "max_drawdown": -0.0099,
    "win_rate": 0.58,
    "profit_factor": 1.47,
    "exposure_pct": 0.42,
    "n_trades": 12
  }
}
```

### Design decisions / what makes this realistic

- **Slippage is configurable, default 5 bps, applied to fill price** based on order size
  vs top-of-book depth (when orderbook is available; falls back to flat bps otherwise).
  This is the #1 thing naive backtests get wrong — they fill at `close` for free.
- **Fees default to 0.10% maker / 0.10% taker** (Bitget spot taker). The engine charges
  fees on every fill, not just entries.
- **Latency is configurable, default 100 ms.** Orders are queued and fill on a later
  bar (the first bar whose `ts >= order.ts + latency`). Stop-loss / take-profit
  trigger on the bar's `low`/`high`, not on `close` — a backtest that fills stops
  at `close` is lying to you.
- **Partial fills** are supported for orders that exceed available liquidity (the
  engine records the unfilled quantity and warns).
- **Sharpe is annualized with `sqrt(252)`** (8760 hourly bars / 24 = 365 days * 252
  trading days convention). Sortino uses downside deviation only.
- **No leverage in v1.** Cash + long-only. Adding margin/short is a one-week extension.

### Known limitations (honest list)

- **No market-impact model.** Slippage is a flat bps, not a function of order
  size vs ADV. Real market impact is `~ sqrt(size/ADV) * sigma * X` — out of scope
  for v1.
- **No funding rates** (we're spot only; would matter for perps).
- **Single-symbol, single-timeframe per run.** Multi-symbol portfolio backtests
  are a v2 feature.
- **Deterministic execution model.** Real exchanges have queue position, partial
  fills at the bid/ask, latency jitter. v1 is a good first cut, not the last word.

### Test summary

All pytest suites pass. Total: 4 test files, ~25 tests. The metrics test uses
hand-computed reference values on a tiny fixture (3 trades, known PnL); the
execution test verifies slippage math against a known formula, asserts that
fees are subtracted on every fill, and checks that a stop-loss placed above
the high of a bar does NOT trigger (anti-pattern test).

### Integration with eval-harness

The eval-harness spawns the backtester CLI as a subprocess to score each
submitted agent. The JSON output schema is the contract between them — see
`docs/INTEGRATION.md` in the eval-harness package.
