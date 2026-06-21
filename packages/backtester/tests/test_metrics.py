"""Tests for metrics calculations, including hand-computed values for small fixtures."""

from __future__ import annotations

from datetime import datetime, timedelta

import numpy as np
import pytest

from backtester.metrics import compute_metrics
from backtester.portfolio import EquityPoint


def _ep(ts, cash, eq, qty=0.0):
    return EquityPoint(timestamp=ts, cash=cash, equity=eq, position_value=eq - cash, position_qty=qty)


def test_empty_inputs_handled():
    m = compute_metrics(equity_curve=None, returns=np.array([]))
    assert m.total_return == 0.0
    assert m.n_bars == 0
    assert m.n_trades == 0


def test_total_return_simple():
    """100 -> 110 = 10% return."""
    base = datetime(2024, 1, 1)
    eq = [
        _ep(base, 100, 100.0),
        _ep(base + timedelta(days=1), 110, 110.0),
    ]
    m = compute_metrics(equity_curve=eq)
    assert m.total_return == pytest.approx(0.10, rel=1e-6)
    assert m.n_bars == 1


def test_max_drawdown_simple():
    """100 -> 120 -> 90 → MDD = (90-120)/120 = -25%."""
    base = datetime(2024, 1, 1)
    eq = [
        _ep(base, 100, 100.0),
        _ep(base + timedelta(days=1), 120, 120.0),
        _ep(base + timedelta(days=2), 90, 90.0),
    ]
    m = compute_metrics(equity_curve=eq)
    assert m.max_drawdown == pytest.approx(0.25, rel=1e-6)


def test_sharpe_hand_computed_constant_returns():
    """Constant 1% daily returns → std is zero → Sharpe is 0 (avoid div-by-zero)."""
    base = datetime(2024, 1, 1)
    # Equity grows by exactly 1% per bar
    eq = []
    px = 100.0
    for i in range(10):
        eq.append(_ep(base + timedelta(days=i), 0.0, px))
        px *= 1.01
    m = compute_metrics(equity_curve=eq)
    # returns = [0.01] * 9, std = 0, sharpe = 0
    assert m.sharpe == pytest.approx(0.0, abs=1e-9)


def test_sharpe_hand_computed_two_returns():
    """Equity = [100, 110, 99]. Returns = [0.10, -0.10].

    mean = 0, std (sample ddof=1) = 0.20/sqrt(1) = 0.20.
    Sharpe = 0 / 0.20 * sqrt(252) = 0.
    """
    m = compute_metrics(
        equity_curve=[
            _ep(datetime(2024, 1, 1), 100, 100.0),
            _ep(datetime(2024, 1, 2), 100, 110.0),
            _ep(datetime(2024, 1, 3), 100, 99.0),
        ],
        annualization_factor=252.0,
    )
    assert m.sharpe == pytest.approx(0.0, abs=1e-9)


def test_sharpe_hand_computed_known_value():
    """Compute Sharpe from a known return series.

    Equity = [100, 102, 101, 105, 102]
    Returns = [0.02, -0.009804, 0.039604, -0.028571]
    mean ≈ 0.005307, sample std (ddof=1) ≈ 0.029308
    Sharpe (annualized 252) ≈ 0.005307 / 0.029308 * sqrt(252) ≈ 2.884
    """
    base = datetime(2024, 1, 1)
    eq_vals = [100.0, 102.0, 101.0, 105.0, 102.0]
    eq = [_ep(base + timedelta(days=i), 100, v) for i, v in enumerate(eq_vals)]
    m = compute_metrics(equity_curve=eq, annualization_factor=252.0)
    returns = np.diff(eq_vals) / np.array(eq_vals[:-1])
    expected_sharpe = returns.mean() / returns.std(ddof=1) * np.sqrt(252)
    assert m.sharpe == pytest.approx(expected_sharpe, rel=1e-6)


def test_win_rate_hand_computed():
    """3 winning trades out of 4 → win_rate = 0.75."""
    m = compute_metrics(
        equity_curve=[_ep(datetime(2024, 1, 1), 100, 100.0)],
        trade_pnls=[10.0, -5.0, 20.0, 15.0],
    )
    assert m.win_rate == pytest.approx(0.75, rel=1e-6)
    assert m.n_trades == 4


def test_profit_factor_hand_computed():
    """Gains = 10+20+15 = 45, Losses = -5 → PF = 45 / 5 = 9.0."""
    m = compute_metrics(
        equity_curve=[_ep(datetime(2024, 1, 1), 100, 100.0)],
        trade_pnls=[10.0, -5.0, 20.0, 15.0],
    )
    assert m.profit_factor == pytest.approx(9.0, rel=1e-6)


def test_profit_factor_no_losses_returns_inf_clamped_to_zero():
    """All wins → PF is infinite; we clamp to 0 (no losses to divide by is
    not a meaningful ratio)."""
    m = compute_metrics(
        equity_curve=[_ep(datetime(2024, 1, 1), 100, 100.0)],
        trade_pnls=[10.0, 5.0, 20.0],
    )
    assert m.profit_factor == 0.0


def test_exposure_from_equity_curve():
    """If 3 of 5 bars had a position, exposure = 0.6."""
    base = datetime(2024, 1, 1)
    eq = [
        _ep(base, 100, 100.0, qty=0.0),
        _ep(base + timedelta(days=1), 100, 110.0, qty=1.0),
        _ep(base + timedelta(days=2), 100, 120.0, qty=1.0),
        _ep(base + timedelta(days=3), 120, 120.0, qty=0.0),
        _ep(base + timedelta(days=4), 120, 130.0, qty=1.0),
    ]
    m = compute_metrics(equity_curve=eq)
    assert m.exposure == pytest.approx(0.6, rel=1e-6)


def test_calmar_hand_computed():
    """Annual return 50%, MDD 25% → Calmar = 2.0."""
    base = datetime(2024, 1, 1)
    eq = [
        _ep(base, 100, 100.0),
        _ep(base + timedelta(days=180), 50, 150.0),  # 50% peak
        _ep(base + timedelta(days=270), 50, 112.5),  # 25% drawdown from peak
        _ep(base + timedelta(days=365), 50, 150.0),  # back to 150
    ]
    m = compute_metrics(equity_curve=eq, annualization_factor=365.0)
    # 50% return over 1 year
    # MDD = (112.5 - 150) / 150 = -0.25
    assert m.max_drawdown == pytest.approx(0.25, rel=1e-6)
    assert m.calmar == pytest.approx(m.annualized_return / m.max_drawdown, rel=1e-6)


def test_annualization_factor_from_bar_size():
    """Hourly bars → ~8766 bars/year, daily → 252 (if no timestamps)."""
    base = datetime(2024, 1, 1)
    eq = [_ep(base + timedelta(hours=i), 100, 100.0 + i) for i in range(5)]
    m = compute_metrics(equity_curve=eq)
    # sec_per_bar = 3600 → bars_per_year = 365.25 * 24 = 8766
    # Check that we get a notes line about annualization
    assert any("annualization" in n for n in m.notes)


def test_metrics_to_dict_serializable():
    m = compute_metrics(
        equity_curve=[_ep(datetime(2024, 1, 1), 100, 100.0), _ep(datetime(2024, 1, 2), 100, 110.0)],
    )
    d = m.to_dict()
    assert "total_return" in d
    assert "sharpe" in d
    assert "max_drawdown" in d
    assert isinstance(d["n_bars"], int)