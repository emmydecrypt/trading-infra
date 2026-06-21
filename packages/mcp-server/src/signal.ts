import { computeIndicators, type IndicatorSet } from './indicators.js';
import type { Candle } from './bitget-client.js';

export type SignalSide = 'long' | 'short' | 'none';

export interface Signal {
  side: SignalSide;
  /** 0..1 confidence in the call */
  strength: number;
  /** Plain-English reasoning the agent can pass to a downstream LLM */
  rationale: string[];
  indicators: IndicatorSet;
  /** The candle timestamp that produced this signal */
  asOf: number;
  /** Latest close used as the reference price */
  price: number;
}

/**
 * Derive a long/short/none signal from a candle series using
 * RSI(14) + EMA(9/21) crossover + MACD(12/26/9).
 *
 * Each indicator votes (+1 long, -1 short, 0 neutral) and the votes are
 * summed.  +2 or +3 → long, -2 or -3 → short, otherwise none.
 * Strength is |sum|/3, clamped to [0, 1].
 */
export function deriveSignal(candles: Candle[]): Signal {
  if (candles.length < 35) {
    // Need at least ~35 candles for MACD to stabilise.
    const ind = computeIndicators(candles);
    return {
      side: 'none',
      strength: 0,
      rationale: ['insufficient candle history (need >= 35)'],
      indicators: ind,
      asOf: candles.at(-1)?.ts ?? 0,
      price: candles.at(-1)?.close ?? 0,
    };
  }

  const ind = computeIndicators(candles);
  const votes: number[] = [];

  // RSI
  if (ind.rsi14 !== null) {
    if (ind.rsi14 > 55) votes.push(1);
    else if (ind.rsi14 < 45) votes.push(-1);
    else votes.push(0);
  }

  // EMA crossover
  if (ind.ema9 !== null && ind.ema21 !== null) {
    votes.push(ind.ema9 > ind.ema21 ? 1 : ind.ema9 < ind.ema21 ? -1 : 0);
  }

  // MACD histogram AND MACD line: weighted -2..+2 votes so that a sustained
  // trend where the histogram lags but the MACD line is already negative
  // still pushes the sum over the threshold.
  if (ind.macd !== null) {
    const histo = ind.macd.histogram;
    const line = ind.macd.macd;
    let vote = 0;
    if (histo > 0) vote += 1;
    else if (histo < 0) vote -= 1;
    if (line > 0) vote += 1;
    else if (line < 0) vote -= 1;
    // Vote range -2..+2; do NOT clamp so MACD counts double when both agree.
    votes.push(vote);
  }

  const sum = votes.reduce((a, b) => a + b, 0);
  // Strength is the absolute vote sum normalised against the max possible (4).
  const strength = Math.min(1, Math.abs(sum) / 4);

  let side: SignalSide = 'none';
  if (sum >= 2) side = 'long';
  else if (sum <= -2) side = 'short';

  const rationale: string[] = [];
  if (ind.rsi14 !== null) {
    rationale.push(`RSI(14)=${ind.rsi14.toFixed(2)} ${ind.rsi14 > 55 ? '(overbought lean)' : ind.rsi14 < 45 ? '(oversold lean)' : '(neutral)'}`);
  }
  if (ind.ema9 !== null && ind.ema21 !== null) {
    rationale.push(`EMA9=${ind.ema9.toFixed(4)} vs EMA21=${ind.ema21.toFixed(4)} (${ind.ema9 > ind.ema21 ? 'bullish' : 'bearish'} cross)`);
  }
  if (ind.macd !== null) {
    rationale.push(`MACD hist=${ind.macd.histogram.toFixed(4)} (${ind.macd.histogram > 0 ? 'bullish' : 'bearish'})`);
  }

  return {
    side,
    strength,
    rationale,
    indicators: ind,
    asOf: candles.at(-1)!.ts,
    price: candles.at(-1)!.close,
  };
}