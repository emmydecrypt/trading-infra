"""CLI entry point.

Usage examples (see README.md for full list):
    python -m backtester run --strategy sma --symbol BTCUSDT \
        --timeframe 1h --start 2024-01-01 --end 2024-12-31
    python -m backtester run --strategy buy_and_hold --symbol BTCUSDT \
        --timeframe 1d --start 2024-01-01 --end 2024-12-31 \
        --data-path fixtures/btcusdt_1h_synth.csv
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Optional

import typer

from backtester.data import fetch_candles, load_candles_from_csv
from backtester.engine import BacktestEngine
from backtester.execution import ExecutionConfig
from backtester.metrics import MetricsReport
from backtester.strategies import resolve_strategy

app = typer.Typer(help="Realistic crypto backtester.")


def _parse_date(s: str) -> datetime:
    return datetime.fromisoformat(s)


def _format_text_report(result) -> str:
    m: MetricsReport = result.metrics
    lines = [
        "=" * 60,
        "Backtest Report",
        "=" * 60,
        f"Strategy         : {result.config_summary['strategy']}",
        f"Symbol           : {result.config_summary['symbol']}",
        f"Bars processed   : {result.n_bars}",
        f"Trades           : {result.n_trades}",
        f"Initial capital  : ${result.config_summary['initial_capital']:,.2f}",
        f"Slippage (bps)   : {result.config_summary['slippage_bps']}",
        f"Fee (bps)        : {result.config_summary['fee_bps']}",
        f"Latency (ms)     : {result.config_summary['latency_ms']}",
        "-" * 60,
        f"Total return     : {m.total_return * 100:8.2f}%",
        f"Annualized ret   : {m.annualized_return * 100:8.2f}%",
        f"Sharpe           : {m.sharpe:8.3f}",
        f"Sortino          : {m.sortino:8.3f}",
        f"Max drawdown     : {m.max_drawdown * 100:8.2f}%",
        f"Calmar           : {m.calmar:8.3f}",
        f"Win rate         : {m.win_rate * 100:8.2f}%",
        f"Profit factor    : {m.profit_factor:8.3f}",
        f"Exposure         : {m.exposure * 100:8.2f}%",
        f"Total fees       : ${m.total_fees:,.2f}",
        f"Final equity     : ${m.end_equity:,.2f}",
        "-" * 60,
    ]
    if m.notes:
        lines.append("Notes:")
        for note in m.notes:
            lines.append(f"  - {note}")
    return "\n".join(lines)


@app.command()
def run(
    strategy: str = typer.Option(..., "--strategy", help="sma | rsi | buy_and_hold"),
    symbol: str = typer.Option(..., "--symbol", help="e.g. BTCUSDT"),
    timeframe: str = typer.Option("1h", "--timeframe", help="1m | 5m | 15m | 1h | 4h | 1d"),
    start: str = typer.Option(..., "--start", help="ISO date (YYYY-MM-DD)"),
    end: str = typer.Option(..., "--end", help="ISO date (YYYY-MM-DD)"),
    capital: float = typer.Option(10_000.0, "--capital", help="Initial capital (USDT)"),
    slippage_bps: float = typer.Option(5.0, "--slippage-bps"),
    fee_bps: float = typer.Option(10.0, "--fee-bps", help="Taker fee in bps"),
    maker_fee_bps: float = typer.Option(10.0, "--maker-fee-bps"),
    latency_ms: int = typer.Option(100, "--latency-ms"),
    top_of_book_usd: float = typer.Option(50_000.0, "--top-of-book-usd", help="Liquidity assumption"),
    data_path: Optional[Path] = typer.Option(None, "--data-path", help="Offline CSV; skips API fetch"),
    no_cache: bool = typer.Option(False, "--no-cache"),
    output_format: str = typer.Option("json", "--format", help="json | text | both"),
):
    """Run a backtest and print metrics."""
    start_dt = _parse_date(start)
    end_dt = _parse_date(end)

    strategy_cls = resolve_strategy(strategy)
    strat_obj = strategy_cls()

    if data_path is not None:
        candles = load_candles_from_csv(data_path, default_symbol=symbol)
    else:
        candles = fetch_candles(
            symbol=symbol,
            timeframe=timeframe,  # type: ignore[arg-type]
            start=start_dt,
            end=end_dt,
            use_cache=not no_cache,
        )

    if not candles:
        typer.echo("No candles fetched — check symbol/timeframe/dates.", err=True)
        raise typer.Exit(code=1)

    execution = ExecutionConfig(
        slippage_bps=slippage_bps,
        fee_bps=fee_bps,
        maker_fee_bps=maker_fee_bps,
        latency_ms=latency_ms,
        top_of_book_usd=top_of_book_usd,
    )

    engine = BacktestEngine(
        strategy=strat_obj,
        candles=candles,
        execution=execution,
        initial_capital=capital,
        primary_symbol=symbol,
    )
    result = engine.run()

    if output_format in ("json", "both"):
        typer.echo(json.dumps(result.to_dict(), indent=2, default=str))
    if output_format in ("text", "both"):
        typer.echo(_format_text_report(result))


if __name__ == "__main__":
    app()