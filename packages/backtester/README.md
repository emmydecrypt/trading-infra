# backtester

A realistic crypto backtester focused on **honest execution simulation** — slippage,
fees, latency, partial fills, and stop-loss/take-profit mechanics that naive
backtests routinely ignore.

Built as part of an AI x Crypto trading infra submission for the Bitget hackathon.
It pairs with the [`mcp-server`](../mcp-server) (live market data + signals) and
shares the Bitget v2 public API conventions.

## Why "realistic"?

A backtest that fills every market order at `close`, charges no slippage, and
ignores latency will *systematically overstate returns* — typically by 10-30%
annualized for medium-frequency strategies on liquid pairs, and dramatically more
on illiquid altcoin books. This package is built around the assumption that
**execution is part of the edge**, so we model it explicitly:

| Effect       | How it's modeled                                          |
|--------------|-----------------------------------------------------------|
| Slippage     | Configurable bps (default 5), scaled by order size vs top-of-book depth. |
| Fees         | Separate maker/taker bps (default 10/10 for Bitget spot). |
| Latency      | Configurable ms delay; signal at bar *t* fills on bar *t+1* at that bar's open. |
| Partial fill | If the requested qty exceeds available liquidity at the venue, the order fills what it can and the rest is canceled. |
| Stop / TP    | Triggers checked against the *next bar's* high/low, not assumed at close. |

## Install

The package uses `uv`. From `/workspace/packages/backtester`:

```bash
uv sync --extra dev
source .venv/bin/activate
```

Or with plain pip:

```bash
pip install -e ".[dev]"
```

## Run an example

```bash
python -m backtester run \
  --strategy sma \
  --symbol BTCUSDT \
  --timeframe 1h \
  --start 2024-01-01 \
  --end 2024-12-31 \
  --capital 10000 \
  --slippage-bps 5 \
  --fee-bps 10 \
  --latency-ms 100 \
  --format both
```

This prints a JSON report of metrics + a human-readable text summary. With
`--format both` both are written to stdout; with `--format json` only the JSON
result.

You can also pass `--data-path fixtures/btcusdt_1h_synth.csv` to run offline
against the bundled synthetic fixture (used in tests).

## Metrics

| Metric       | What it is                                            | Formula (annualized where applicable) |
|--------------|-------------------------------------------------------|---------------------------------------|
| Total return | `(final/initial) - 1`                                 | —                                     |
| Sharpe       | Risk-adjusted return                                  | `mean(daily_ret) / std(daily_ret) * sqrt(252)` |
| Sortino      | Like Sharpe but only penalizes downside volatility   | `mean / downside_std * sqrt(252)`     |
| Max drawdown | Worst peak-to-trough equity drop                      | `(equity - peak) / peak`              |
| Win rate     | Fraction of round-trip trades with positive PnL       | —                                     |
| Profit factor| `sum(gains) / sum(|losses|)`                          | —                                     |
| Calmar       | Annualized return / abs(max drawdown)                 | `(final/initial)^(252/N) - 1` / `|mdd|` |
| Exposure     | Fraction of bars with open position                   | —                                     |

All return metrics assume **no leverage** (spot only, v1) and a **252-day** trading
year for daily-bar annualization. For higher-frequency bars, we still annualize
by `sqrt(252)` (a common simplification — see "Limitations" below).

## CLI flags

```
python -m backtester run [OPTIONS]

  --strategy       sma | rsi | buy_and_hold         [required]
  --symbol         e.g. BTCUSDT                     [required unless --data-path]
  --timeframe      1m | 5m | 15m | 1h | 4h | 1d      [default: 1h]
  --start          ISO date                         [required]
  --end            ISO date                         [required]
  --capital        starting cash USDT              [default: 10000]
  --slippage-bps   slippage in basis points          [default: 5]
  --fee-bps        taker fee in bps                  [default: 10]
  --maker-fee-bps  maker fee in bps                  [default: 10]
  --latency-ms     latency between signal and fill   [default: 100]
  --format         json | text | both                [default: json]
  --data-path      offline CSV path (skips Bitget fetch)
  --no-cache       disable HTTP cache
```

## Architecture

```
src/backtester/
├── __init__.py
├── __main__.py        # python -m backtester
├── cli.py             # typer CLI
├── data.py            # Bitget v2 OHLCV fetch + on-disk cache
├── execution.py       # slippage / fee / latency / partial fill / SL/TP
├── portfolio.py       # cash + positions + equity curve
├── strategy.py        # Strategy base + Signal dataclass
├── strategies/
│   ├── __init__.py
│   ├── sma.py         # 9/21 EMA crossover
│   ├── rsi.py         # RSI reversal
│   └── buy_and_hold.py
├── engine.py          # the main loop that ties it all together
├── metrics.py         # Sharpe, Sortino, drawdown, etc.
└── schemas.py         # pydantic models for inputs/outputs
```

## Model assumptions (and where they break)

Be honest about what this model does *not* capture:

- **Order book depth** is approximated by a single "liquidity USD" knob per
  symbol/timeframe. Real depth is price-curve-shaped. Large market orders
  against thin books should use a proper L2 walk — we don't.
- **Funding rates / borrow costs** are not modeled (spot only).
- **Slippage** is linear in order size. Real slippage is concave (price impact
  grows with `sqrt(qty)` for most impact models).
- **Latency** is a fixed delay. Real latency is stochastic and includes
  network, exchange ack, and match-engine round-trip.
- **Stop / TP fills** assume the trigger level is touched within the bar.
  We do not model slippage on the stop fill itself (it already applies
  via the same model).
- **Annualization** uses `sqrt(252)` even for sub-daily bars. This is a
  simplification — the correct factor depends on bar autocorrelation. For
  high-frequency strategies the Sharpe ratio becomes less meaningful
  in any case; treat sub-daily results with caution.
- **No look-ahead**: signals at bar *t* fill at bar *t+1*'s open (modulo
  latency), with the bar *t+1* OHLC determining SL/TP. This is correct.
- **No partial fills within a bar** for SL/TP — we conservatively assume
  one fill attempt per bar.

## Tests

```bash
uv run pytest -v
```

The test suite includes hand-computed fixture checks for the metrics module,
so small synthetic series produce known-good Sharpe / max-drawdown numbers.