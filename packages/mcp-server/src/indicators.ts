import type { Candle } from './bitget-client.js';

export interface MACDResult {
  macd: number;
  signal: number;
  histogram: number;
}

export interface IndicatorSet {
  rsi14: number | null;
  ema9: number | null;
  ema21: number | null;
  macd: MACDResult | null;
  /** Bull/bear momentum: +1 long bias, -1 short bias, 0 neutral. */
  bias: number;
}

/**
 * Relative Strength Index using Wilder's smoothing.
 * Returns null when there aren't enough periods (need at least `period + 1` closes).
 */
export function rsi(closes: number[], period: number = 14): number | null {
  if (closes.length <= period) return null;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Exponential Moving Average.
 * Seeded with SMA of the first `period` closes; standard multiplicative
 * smoothing afterwards.
 */
export function ema(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  const k = 2 / (period + 1);

  // Seed: SMA over the first `period` values.
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i]!;
  prev = prev / period;

  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
  }
  return prev;
}

export function emaSeries(values: number[], period: number): (number | null)[] {
  if (values.length < period || period <= 0) {
    return values.map(() => null);
  }
  const k = 2 / (period + 1);
  const out: (number | null)[] = new Array(values.length).fill(null);

  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  seed /= period;
  out[period - 1] = seed;

  for (let i = period; i < values.length; i++) {
    const prev = out[i - 1]!;
    out[i] = values[i]! * k + prev * (1 - k);
  }
  return out;
}

/**
 * MACD = EMA(fast) - EMA(slow); signal = EMA(macdSeries, signalPeriod);
 * histogram = macd - signal.
 */
export function macd(
  closes: number[],
  fast: number = 12,
  slow: number = 26,
  signalPeriod: number = 9,
): MACDResult | null {
  if (closes.length < slow + signalPeriod) return null;
  const macdLine = emaSeries(closes, fast).map((fastVal, i) => {
    if (fastVal == null) return null;
    const slowVal = emaSeries(closes, slow)[i];
    if (slowVal == null) return null;
    return fastVal - slowVal;
  });
  // Drop nulls for signal EMA.
  const numericMacd = macdLine.filter((v): v is number => v !== null);
  if (numericMacd.length < signalPeriod) return null;
  const signalVal = ema(numericMacd, signalPeriod);
  if (signalVal === null) return null;
  const lastMacd = numericMacd[numericMacd.length - 1]!;
  return {
    macd: lastMacd,
    signal: signalVal,
    histogram: lastMacd - signalVal,
  };
}

/**
 * Convenience: compute all standard indicators for a candle list.
 */
export function computeIndicators(candles: Candle[]): IndicatorSet {
  const closes = candles.map((c) => c.close);
  const rsi14 = rsi(closes, 14);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const m = macd(closes, 12, 26, 9);

  let bias = 0;
  if (ema9 != null && ema21 != null) bias += ema9 > ema21 ? 1 : -1;
  if (m != null) bias += m.histogram > 0 ? 1 : -1;
  if (rsi14 != null) bias += rsi14 > 50 ? 1 : -1;

  return { rsi14, ema9, ema21, macd: m, bias };
}