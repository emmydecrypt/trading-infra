import { RateLimiter, sleep } from './rate-limit.js';

export const BITGET_BASE_URL = 'https://api.bitget.com';

export interface Candle {
  /** Unix millis */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Base-asset volume */
  volume: number;
}

export interface Ticker {
  symbol: string;
  lastPrice: number;
  bestBid: number;
  bestAsk: number;
  /** Percent change over the last 24h, e.g. -1.42 means -1.42% */
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  ts: number;
}

export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface Orderbook {
  symbol: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  ts: number;
}

export interface SymbolInfo {
  symbol: string;
  base: string;
  quote: string;
  status: string;
}

export interface BitgetClientOptions {
  baseUrl?: string;
  maxPerSecond?: number;
  maxRetries?: number;
  /** Initial retry delay in ms; doubles on each retry (exp backoff). */
  initialBackoffMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_OPTIONS: Required<Omit<BitgetClientOptions, 'fetchImpl'>> = {
  baseUrl: BITGET_BASE_URL,
  maxPerSecond: 10,
  maxRetries: 3,
  initialBackoffMs: 250,
};

/**
 * Minimal Bitget v2 public REST client. No auth.
 *
 * Endpoints used:
 *   GET /api/v2/spot/market/candles   (kline)
 *   GET /api/v2/spot/market/tickers
 *   GET /api/v2/spot/market/orderbook
 *   GET /api/v2/spot/public/symbols
 */
export class BitgetClient {
  private readonly baseUrl: string;
  private readonly limiter: RateLimiter;
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: BitgetClientOptions = {}) {
    const cfg = { ...DEFAULT_OPTIONS, ...opts };
    this.baseUrl = cfg.baseUrl;
    this.limiter = new RateLimiter(cfg.maxPerSecond);
    this.maxRetries = cfg.maxRetries;
    this.initialBackoffMs = cfg.initialBackoffMs;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getCandles(
    symbol: string,
    granularity: string,
    limit: number = 100,
  ): Promise<Candle[]> {
    const url = new URL(`${this.baseUrl}/api/v2/spot/market/candles`);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('granularity', granularity);
    url.searchParams.set('limit', String(limit));

    const raw = (await this.request(url)) as { data?: unknown };
    const arr = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : null;
    if (!arr) {
      throw new Error('Unexpected candles response shape (not an array)');
    }
    return arr.map((row) => parseCandleRow(row as string[]));
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const url = new URL(`${this.baseUrl}/api/v2/spot/market/tickers`);
    url.searchParams.set('symbol', symbol);
    const raw = (await this.request(url)) as { data: unknown };
    const data = Array.isArray(raw.data) ? raw.data[0] : raw.data;
    return parseTicker(data as Record<string, unknown>);
  }

  async getOrderbook(symbol: string, limit: number = 20): Promise<Orderbook> {
    const url = new URL(`${this.baseUrl}/api/v2/spot/market/orderbook`);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 100)));
    const raw = (await this.request(url)) as { data: Record<string, unknown> };
    return parseOrderbook(raw.data, symbol);
  }

  async getSymbols(): Promise<SymbolInfo[]> {
    const url = new URL(`${this.baseUrl}/api/v2/spot/public/symbols`);
    const raw = (await this.request(url)) as { data: unknown };
    const arr = Array.isArray(raw.data) ? raw.data : [];
    return arr.map((row) => {
      const r = row as Record<string, unknown>;
      const symbol = String(r.symbol ?? '');
      const { base, quote } = splitSymbol(symbol);
      return {
        symbol,
        base,
        quote,
        status: String(r.status ?? 'unknown'),
      };
    });
  }

  /**
   * Generic request method with rate limiting + retry + exponential backoff.
   * Throws on non-2xx responses after exhausting retries.
   */
  async request(url: URL): Promise<unknown> {
    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= this.maxRetries) {
      await this.limiter.acquire();
      const fetchOnce = async (): Promise<unknown> => {
        const res = await this.fetchImpl(url.toString(), {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        });
        if (res.ok) {
          const json = (await res.json()) as { code?: string; msg?: string; data?: unknown };
          if (json && typeof json === 'object' && 'code' in json) {
            const code = json.code as string;
            if (code !== '00000') {
              throw new BitgetApiError(
                `Bitget API error ${code}: ${json.msg ?? 'unknown'}`,
                code,
              );
            }
          }
          return json;
        }
        // Retry on 429 / 5xx; throw unrecoverable on anything else.
        if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
          const text = await res.text().catch(() => '');
          throw new RetryableHttpError(res.status, text || res.statusText);
        }
        const text = await res.text().catch(() => '');
        throw new NonRetryableHttpError(res.status, text || res.statusText);
      };

      try {
        return await fetchOnce();
      } catch (err) {
        lastErr = err;
        if (err instanceof NonRetryableHttpError || err instanceof BitgetApiError) {
          throw err;
        }
        if (attempt >= this.maxRetries) break;
        const delay = this.initialBackoffMs * Math.pow(2, attempt);
        await sleep(delay);
        attempt += 1;
      }
    }
    throw new Error(
      `Bitget request failed after ${this.maxRetries} retries: ${(lastErr as Error)?.message ?? String(lastErr)}`,
    );
  }
}

class NonRetryableHttpError extends Error {
  constructor(public readonly status: number, body: string) {
    super(`HTTP ${status}: ${body}`);
    this.name = 'NonRetryableHttpError';
  }
}

class RetryableHttpError extends Error {
  constructor(public readonly status: number, body: string) {
    super(`HTTP ${status}: ${body}`);
    this.name = 'RetryableHttpError';
  }
}

export class BitgetApiError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'BitgetApiError';
  }
}

/* ---------- parsers ---------- */

const COMMON_QUOTES = ['USDT', 'USDC', 'USD', 'BTC', 'ETH', 'EUR', 'DAI'];

function splitSymbol(symbol: string): { base: string; quote: string } {
  if (symbol.includes('_')) {
    const [base = '', quote = ''] = symbol.split('_');
    return { base, quote };
  }
  for (const q of COMMON_QUOTES) {
    if (symbol.endsWith(q) && symbol.length > q.length) {
      return { base: symbol.slice(0, symbol.length - q.length), quote: q };
    }
  }
  return { base: symbol, quote: '' };
}

function parseCandleRow(row: unknown): Candle {
  if (!Array.isArray(row) || row.length < 6) {
    throw new Error('Invalid candle row');
  }
  const [tsStr, openStr, highStr, lowStr, closeStr, volStr] = row as string[];
  return {
    ts: Number(tsStr),
    open: Number(openStr),
    high: Number(highStr),
    low: Number(lowStr),
    close: Number(closeStr),
    volume: Number(volStr),
  };
}

function parseTicker(data: Record<string, unknown>): Ticker {
  const last = Number(data.lastPr ?? data.close ?? 0);
  const bid = Number(data.bidPr ?? 0);
  const ask = Number(data.askPr ?? 0);
  const changePct = Number(data.change24h ?? data.chgUtc ?? 0);
  const baseVolume = Number(data.baseVolume ?? data.quoteVolume ?? 0);
  const high24h = Number(data.high24h ?? 0);
  const low24h = Number(data.low24h ?? 0);
  const ts = Number(data.ts ?? Date.now());
  return {
    symbol: String(data.symbol ?? ''),
    lastPrice: last,
    bestBid: bid,
    bestAsk: ask,
    change24h: changePct,
    volume24h: baseVolume,
    high24h,
    low24h,
    ts,
  };
}

function parseOrderbook(data: Record<string, unknown>, fallbackSymbol: string): Orderbook {
  const symbol = String(data.symbol ?? fallbackSymbol);
  const ts = Number(data.ts ?? Date.now());
  const bids = Array.isArray(data.bids)
    ? (data.bids as string[][]).map(([p, s]) => ({ price: Number(p), size: Number(s) }))
    : [];
  const asks = Array.isArray(data.asks)
    ? (data.asks as string[][]).map(([p, s]) => ({ price: Number(p), size: Number(s) }))
    : [];
  return { symbol, bids, asks, ts };
}