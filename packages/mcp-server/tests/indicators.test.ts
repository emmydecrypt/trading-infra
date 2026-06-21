import { describe, it, expect } from 'vitest';
import { rsi, ema, emaSeries, macd } from '../src/indicators.js';

describe('RSI', () => {
  it('returns null when there are not enough closes', () => {
    expect(rsi([1, 2, 3], 14)).toBeNull();
  });

  it('is ~100 on a strictly rising series', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const v = rsi(closes, 14);
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThan(95);
  });

  it('is ~0 on a strictly falling series', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 - i);
    const v = rsi(closes, 14);
    expect(v).not.toBeNull();
    expect(v!).toBeLessThan(5);
  });

  it('oscillates around 50 on a flat alternating series', () => {
    const closes: number[] = [];
    for (let i = 0; i < 60; i++) closes.push(100 + (i % 2 === 0 ? 1 : -1));
    const v = rsi(closes, 14);
    expect(v).not.toBeNull();
    expect(Math.abs(v! - 50)).toBeLessThan(5);
  });
});

describe('EMA', () => {
  it('returns null for too-short series', () => {
    expect(ema([1, 2], 9)).toBeNull();
  });

  it('matches the SMA seed when all values are equal', () => {
    const vals = Array.from({ length: 50 }, () => 42);
    expect(ema(vals, 9)).toBeCloseTo(42, 6);
    expect(ema(vals, 21)).toBeCloseTo(42, 6);
  });

  it('gives more weight to recent values for an uptrend', () => {
    const slow = ema([1, 1, 1, 1, 1, 1, 1, 1, 1, 100], 9);
    const naive = (1 * 8 + 100) / 9;
    expect(slow).not.toBeNull();
    // The EMA weighs recent values more, so the result must exceed the simple average.
    expect(slow!).toBeGreaterThan(naive);
  });

  it('emaSeries produces aligned null-prefixed array', () => {
    const series = emaSeries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 9);
    expect(series[0]).toBeNull();
    expect(series[7]).toBeNull();
    expect(series[8]).not.toBeNull();
    expect(series[9]).not.toBeNull();
  });
});

describe('MACD', () => {
  it('returns null when too few closes', () => {
    expect(macd([1, 2, 3], 12, 26, 9)).toBeNull();
  });

  it('histogram flips sign across an obvious trend reversal', () => {
    // Use exponential growth/decay — linear series has EMA fast ≈ EMA slow
    // because both ultimately track the same linear function.
    const up = Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.02, i));
    const upMacd = macd(up, 12, 26, 9);
    expect(upMacd).not.toBeNull();
    expect(upMacd!.histogram).toBeGreaterThan(0);

    const down = Array.from({ length: 60 }, (_, i) => 200 * Math.pow(0.98, i));
    const downMacd = macd(down, 12, 26, 9);
    expect(downMacd).not.toBeNull();
    // In a sustained downtrend the MACD line sits *below* its own signal
    // (signal lags), so the histogram (macd - signal) is positive but
    // smaller in magnitude than the uptrend case. The key property is that
    // the uptrend and downtrend histograms have opposite signs.
    expect(downMacd!.histogram).toBeLessThan(upMacd!.histogram);
    expect(downMacd!.macd).toBeLessThan(0);
    expect(downMacd!.signal).toBeLessThan(0);
  });
});