import { describe, it, expect } from 'vitest';
import { deriveSignal } from '../src/signal.js';
import type { Candle } from '../src/bitget-client.js';

function syntheticCandles(prices: number[], startTs = 1700000000000, stepMs = 60_000): Candle[] {
  return prices.map((close, i) => ({
    ts: startTs + i * stepMs,
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 100 + i,
  }));
}

describe('deriveSignal', () => {
  it('returns side=none for too-short series', () => {
    const candles = syntheticCandles([100, 101, 102]);
    const sig = deriveSignal(candles);
    expect(sig.side).toBe('none');
    expect(sig.rationale.some((r) => r.includes('insufficient'))).toBe(true);
  });

  it('returns side=long on a sustained uptrend', () => {
    // Use exponential growth so EMA and MACD diverge meaningfully.
    const prices = Array.from({ length: 80 }, (_, i) => 100 * Math.pow(1.01, i));
    const candles = syntheticCandles(prices);
    const sig = deriveSignal(candles);
    expect(sig.side).toBe('long');
    expect(sig.strength).toBeGreaterThan(0);
    expect(sig.indicators.rsi14).not.toBeNull();
    expect(sig.indicators.ema9).not.toBeNull();
    expect(sig.indicators.ema21).not.toBeNull();
    expect(sig.indicators.macd).not.toBeNull();
    expect(sig.price).toBe(prices.at(-1)!);
    expect(sig.asOf).toBe(prices.length * 60_000 + 1700000000000 - 60_000);
  });

  it('returns side=short on a sustained downtrend', () => {
    // Exponential decay so EMA/MACD diverge on the bear side.
    const prices = Array.from({ length: 80 }, (_, i) => 200 * Math.pow(0.99, i));
    const candles = syntheticCandles(prices);
    const sig = deriveSignal(candles);
    expect(sig.side).toBe('short');
    expect(sig.strength).toBeGreaterThan(0);
    // In a sustained downtrend the MACD line itself is negative and RSI is
    // sub-50. The histogram (macd - signal) is typically positive because
    // the signal line lags a falling MACD, so we assert the *MACD line*
    // sign and the *RSI* level — both clearly bearish.
    expect(sig.indicators.macd!.macd).toBeLessThan(0);
    expect(sig.indicators.rsi14!).toBeLessThan(50);
  });

  it('strength is in [0, 1]', () => {
    const prices = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const candles = syntheticCandles(prices);
    const sig = deriveSignal(candles);
    expect(sig.strength).toBeGreaterThanOrEqual(0);
    expect(sig.strength).toBeLessThanOrEqual(1);
  });
});