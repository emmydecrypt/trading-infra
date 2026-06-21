"""Realistic crypto backtester with execution simulation."""

from backtester.engine import BacktestEngine, BacktestResult, run_backtest
from backtester.execution import ExecutionConfig, ExecutionModel
from backtester.metrics import MetricsReport, compute_metrics
from backtester.portfolio import Portfolio
from backtester.strategy import Signal, SignalSide, Strategy
from backtester.strategies import BuyAndHold, RSIReversal, SMACross

__all__ = [
    "BacktestEngine",
    "BacktestResult",
    "ExecutionConfig",
    "ExecutionModel",
    "MetricsReport",
    "Portfolio",
    "Signal",
    "SignalSide",
    "Strategy",
    "BuyAndHold",
    "RSIReversal",
    "SMACross",
    "compute_metrics",
    "run_backtest",
]

__version__ = "0.1.0"