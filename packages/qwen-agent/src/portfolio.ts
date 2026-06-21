/**
 * Simulated portfolio. No real trades, no exchange connection. Just a
 * position ledger + cash with average-cost accounting and a snapshot helper.
 */

export interface Position {
  symbol: string;
  qty: number;
  avgPrice: number;
  markPrice: number;
}

export interface PortfolioSnapshot {
  cash: number;
  positions: Position[];
  equity: number;
  realizedPnl: number;
}

export interface ApplyActionResult {
  ok: boolean;
  message: string;
  /** Updated snapshot for convenience / logging. */
  snapshot: PortfolioSnapshot;
  /** True if this action changed positions or cash. */
  changed: boolean;
}

export class Portfolio {
  private cash: number;
  private positions: Map<string, Position>;
  private realizedPnl = 0;

  constructor(initialCash: number) {
    if (!(initialCash >= 0)) {
      throw new Error(`initialCash must be non-negative, got ${initialCash}`);
    }
    this.cash = initialCash;
    this.positions = new Map();
  }

  /** Update the mark price for a position (used for equity/snapshot). */
  mark(symbol: string, markPrice: number): void {
    const p = this.positions.get(symbol);
    if (p) p.markPrice = markPrice;
  }

  /** Pure read-only snapshot. */
  snapshot(): PortfolioSnapshot {
    let equity = this.cash;
    const positions: Position[] = [];
    for (const p of this.positions.values()) {
      equity += p.qty * p.markPrice;
      positions.push({ ...p });
    }
    return {
      cash: this.cash,
      positions,
      equity,
      realizedPnl: this.realizedPnl,
    };
  }

  /**
   * Apply an agent action to the simulated portfolio.
   *
   *  - buy  : spend `size_pct`% of current cash at `markPrice`.
   *  - sell : sell `size_pct`% of held position at `markPrice`.
   *  - hold : no-op.
   */
  apply(args: {
    side: "buy" | "sell" | "hold";
    symbol: string;
    size_pct: number;
    markPrice: number;
  }): ApplyActionResult {
    const { side, symbol, size_pct, markPrice } = args;
    if (!(size_pct >= 0 && size_pct <= 100)) {
      return {
        ok: false,
        message: `size_pct out of range: ${size_pct}`,
        snapshot: this.snapshot(),
        changed: false,
      };
    }
    if (!(markPrice > 0)) {
      return {
        ok: false,
        message: `markPrice must be positive, got ${markPrice}`,
        snapshot: this.snapshot(),
        changed: false,
      };
    }

    if (side === "hold") {
      this.mark(symbol, markPrice);
      return {
        ok: true,
        message: "hold (no-op)",
        snapshot: this.snapshot(),
        changed: false,
      };
    }

    if (side === "buy") {
      const budget = this.cash * (size_pct / 100);
      if (budget <= 0) {
        return {
          ok: false,
          message: "buy ignored: zero budget",
          snapshot: this.snapshot(),
          changed: false,
        };
      }
      const qty = budget / markPrice;
      const existing = this.positions.get(symbol);
      if (existing) {
        const newQty = existing.qty + qty;
        const newAvg =
          (existing.qty * existing.avgPrice + qty * markPrice) / newQty;
        existing.qty = newQty;
        existing.avgPrice = newAvg;
        existing.markPrice = markPrice;
      } else {
        this.positions.set(symbol, {
          symbol,
          qty,
          avgPrice: markPrice,
          markPrice,
        });
      }
      this.cash -= budget;
      return {
        ok: true,
        message: `bought ${qty.toFixed(6)} ${symbol} @ ${markPrice}`,
        snapshot: this.snapshot(),
        changed: true,
      };
    }

    // side === "sell"
    const existing = this.positions.get(symbol);
    if (!existing || existing.qty <= 0) {
      return {
        ok: false,
        message: `sell ignored: no ${symbol} position`,
        snapshot: this.snapshot(),
        changed: false,
      };
    }
    const sellQty = existing.qty * (size_pct / 100);
    if (sellQty <= 0) {
      return {
        ok: false,
        message: "sell ignored: size_pct rounds to zero qty",
        snapshot: this.snapshot(),
        changed: false,
      };
    }
    const proceeds = sellQty * markPrice;
    const cost = sellQty * existing.avgPrice;
    this.realizedPnl += proceeds - cost;
    existing.qty -= sellQty;
    existing.markPrice = markPrice;
    if (existing.qty <= 1e-12) {
      this.positions.delete(symbol);
    }
    this.cash += proceeds;
    return {
      ok: true,
      message: `sold ${sellQty.toFixed(6)} ${symbol} @ ${markPrice} (pnl ${(
        proceeds - cost
      ).toFixed(2)})`,
      snapshot: this.snapshot(),
      changed: true,
    };
  }
}
