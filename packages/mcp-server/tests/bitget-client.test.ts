import { describe, it, expect, vi } from 'vitest';
import { BitgetClient, BitgetApiError } from '../src/bitget-client.js';

function makeOk(data: unknown, code = '00000'): Response {
  return new Response(JSON.stringify({ code, msg: 'success', data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeErr(status: number, body = ''): Response {
  return new Response(body, { status });
}

describe('BitgetClient.getCandles', () => {
  it('parses a v2 candle response into typed candles', async () => {
    const fakeFetch = vi.fn(async () =>
      makeOk([
        ['1700000000000', '100', '110', '95', '105', '12.5'],
        ['1700003600000', '105', '115', '100', '112', '7.0'],
      ]),
    );
    const client = new BitgetClient({ fetchImpl: fakeFetch as unknown as typeof fetch });
    const candles = await client.getCandles('BTCUSDT', '1h', 2);
    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({
      ts: 1700000000000,
      open: 100,
      high: 110,
      low: 95,
      close: 105,
      volume: 12.5,
    });
    const url = new URL(String(fakeFetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/v2/spot/market/candles');
    expect(url.searchParams.get('symbol')).toBe('BTCUSDT');
    expect(url.searchParams.get('granularity')).toBe('1h');
  });

  it('throws BitgetApiError on non-00000 response code', async () => {
    const fakeFetch = vi.fn(async () => makeOk([], '40001'));
    const client = new BitgetClient({ fetchImpl: fakeFetch as unknown as typeof fetch });
    await expect(client.getCandles('BTCUSDT', '1h')).rejects.toBeInstanceOf(BitgetApiError);
  });
});

describe('BitgetClient.getTicker', () => {
  it('parses a v2 ticker response', async () => {
    const fakeFetch = vi.fn(async () =>
      makeOk({
        symbol: 'ETHUSDT',
        lastPr: '3500',
        bidPr: '3499.9',
        askPr: '3500.1',
        change24h: '1.25',
        baseVolume: '12345',
        high24h: '3600',
        low24h: '3400',
        ts: '1700000000000',
      }),
    );
    const client = new BitgetClient({ fetchImpl: fakeFetch as unknown as typeof fetch });
    const t = await client.getTicker('ETHUSDT');
    expect(t.symbol).toBe('ETHUSDT');
    expect(t.lastPrice).toBe(3500);
    expect(t.bestBid).toBe(3499.9);
    expect(t.bestAsk).toBe(3500.1);
    expect(t.change24h).toBe(1.25);
  });
});

describe('BitgetClient.getOrderbook', () => {
  it('parses bids and asks into typed levels', async () => {
    const fakeFetch = vi.fn(async () =>
      makeOk({
        symbol: 'BTCUSDT',
        ts: '1700000000000',
        bids: [['60000', '1.5'], ['59999', '2.0']],
        asks: [['60001', '0.8'], ['60002', '1.2']],
      }),
    );
    const client = new BitgetClient({ fetchImpl: fakeFetch as unknown as typeof fetch });
    const ob = await client.getOrderbook('BTCUSDT', 20);
    expect(ob.symbol).toBe('BTCUSDT');
    expect(ob.bids).toEqual([
      { price: 60000, size: 1.5 },
      { price: 59999, size: 2.0 },
    ]);
    expect(ob.asks).toEqual([
      { price: 60001, size: 0.8 },
      { price: 60002, size: 1.2 },
    ]);
  });
});

describe('BitgetClient.getSymbols', () => {
  it('returns parsed symbol entries', async () => {
    const fakeFetch = vi.fn(async () =>
      makeOk([
        { symbol: 'BTCUSDT', status: 'online' },
        { symbol: 'ETHUSDT', status: 'online' },
      ]),
    );
    const client = new BitgetClient({ fetchImpl: fakeFetch as unknown as typeof fetch });
    const symbols = await client.getSymbols();
    expect(symbols).toEqual([
      { symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', status: 'online' },
      { symbol: 'ETHUSDT', base: 'ETH', quote: 'USDT', status: 'online' },
    ]);
  });
});

describe('BitgetClient retry + backoff', () => {
  it('retries on 429 and eventually succeeds', async () => {
    let calls = 0;
    const fakeFetch = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return makeErr(429);
      return makeOk([
        ['1700000000000', '100', '110', '95', '105', '1'],
      ]);
    });
    const client = new BitgetClient({
      fetchImpl: fakeFetch as unknown as typeof fetch,
      maxRetries: 3,
      initialBackoffMs: 1,
    });
    const candles = await client.getCandles('BTCUSDT', '1h', 1);
    expect(candles).toHaveLength(1);
    expect(fakeFetch).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting retries on 5xx', async () => {
    const fakeFetch = vi.fn(async () => makeErr(503, 'service unavailable'));
    const client = new BitgetClient({
      fetchImpl: fakeFetch as unknown as typeof fetch,
      maxRetries: 2,
      initialBackoffMs: 1,
    });
    await expect(client.getCandles('BTCUSDT', '1h')).rejects.toThrow(/failed after 2 retries/);
    expect(fakeFetch.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('does not retry on 4xx other than 429', async () => {
    const fakeFetch = vi.fn(async () => makeErr(400, 'bad request'));
    const client = new BitgetClient({
      fetchImpl: fakeFetch as unknown as typeof fetch,
      maxRetries: 5,
      initialBackoffMs: 1,
    });
    await expect(client.getCandles('BTCUSDT', '1h')).rejects.toThrow(/HTTP 400/);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });
});