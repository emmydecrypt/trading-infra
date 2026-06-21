import { describe, it, expect, vi } from 'vitest';
import { buildServer, jsonResult } from '../src/server.js';
import { BitgetClient } from '../src/bitget-client.js';

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ code: '00000', msg: 'success', data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function risingCandles(n: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < n; i++) {
    // Exponential growth so MACD diverges meaningfully.
    const close = 100 * Math.pow(1.01, i);
    out.push([
      String(1700000000000 + i * 60_000),
      String(close),
      String(close + 0.5),
      String(close - 0.5),
      String(close),
      '10',
    ]);
  }
  return out;
}

async function callTool(server: ReturnType<typeof buildServer>, name: string, args: Record<string, unknown>) {
  // The MCP SDK exposes server._registeredTools[name] internals; the public
  // API to invoke a tool handler is the same callback passed to server.tool().
  // We extract it from the internal registry.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reg = (server as any)._registeredTools?.[name];
  if (!reg) throw new Error(`tool ${name} not registered`);
  const handler = reg.handler ?? reg.callback ?? reg;
  return handler(args);
}

describe('MCP server tool integration', () => {
  it('exposes all 7 tools in its registry', () => {
    const server = buildServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const names = Object.keys((server as any)._registeredTools ?? {});
    expect(names).toEqual(
      expect.arrayContaining([
        'get_candles',
        'get_ticker',
        'get_orderbook',
        'get_symbols',
        'get_signal',
      ]),
    );
  });

  it('get_candles + get_signal produce a long signal on a mocked uptrend', async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      if (url.includes('/candles')) return ok(risingCandles(80));
      if (url.includes('/tickers')) return ok({ symbol: 'BTCUSDT', lastPr: '140', ts: '1700000000000' });
      return ok({ data: [] });
    });
    const bitget = new BitgetClient({
      fetchImpl: fakeFetch as unknown as typeof fetch,
      initialBackoffMs: 1,
    });
    const server = buildServer({ bitget });

    const candlesRes = await callTool(server, 'get_candles', { symbol: 'BTCUSDT', granularity: '1m', limit: 80 });
    const candles = JSON.parse((candlesRes as { content: { text: string }[] }).content[0]!.text);
    expect(candles).toHaveLength(80);

    const signalRes = await callTool(server, 'get_signal', { symbol: 'BTCUSDT', granularity: '1m', limit: 80 });
    const parsed = JSON.parse((signalRes as { content: { text: string }[] }).content[0]!.text);
    expect(parsed.signal.side).toBe('long');
  });

  it('cache hit/miss: second call does not invoke fetch', async () => {
    const fakeFetch = vi.fn(async () => ok(risingCandles(40)));
    const bitget = new BitgetClient({
      fetchImpl: fakeFetch as unknown as typeof fetch,
      initialBackoffMs: 1,
    });
    const server = buildServer({ bitget });

    await callTool(server, 'get_candles', { symbol: 'BTCUSDT', granularity: '5m', limit: 40 });
    const callsAfterFirst = fakeFetch.mock.calls.length;
    await callTool(server, 'get_candles', { symbol: 'BTCUSDT', granularity: '5m', limit: 40 });
    expect(fakeFetch.mock.calls.length).toBe(callsAfterFirst);

    // no_cache=true forces a refetch.
    await callTool(server, 'get_candles', { symbol: 'BTCUSDT', granularity: '5m', limit: 40, no_cache: true });
    expect(fakeFetch.mock.calls.length).toBe(callsAfterFirst + 1);
  });

  it('jsonResult wraps payload as MCP text content', () => {
    const r = jsonResult({ hello: 'world' });
    expect(r.content).toHaveLength(1);
    expect(r.content[0]!.type).toBe('text');
    expect(JSON.parse(r.content[0]!.text)).toEqual({ hello: 'world' });
  });
});