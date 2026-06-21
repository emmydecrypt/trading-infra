import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BitgetClient } from './bitget-client.js';
import { TTLCache } from './cache.js';
import { deriveSignal } from './signal.js';
import { SolanaHelper } from './solana.js';

const CACHE_TTL_MS = 30_000;
const candlesCache = new TTLCache<object>(CACHE_TTL_MS, 200);
const orderbookCache = new TTLCache<object>(CACHE_TTL_MS, 200);
const tickerCache = new TTLCache<object>(CACHE_TTL_MS, 200);

export interface ServerDeps {
  bitget?: BitgetClient;
  solana?: SolanaHelper;
}

export function buildServer(deps: ServerDeps = {}): McpServer {
  const bitget = deps.bitget ?? new BitgetClient();
  const solana = deps.solana;

  const server = new McpServer({
    name: 'bitget-mcp-server',
    version: '0.1.0',
  });

  /* ---------- get_candles ---------- */
  server.tool(
    'get_candles',
    'Fetch recent kline/candlestick data for a Bitget spot symbol.',
    {
      symbol: z.string().describe('Bitget spot symbol, e.g. BTCUSDT'),
      granularity: z
        .enum(['1m', '5m', '15m', '30m', '1h', '4h', '12h', '1d', '1w'])
        .default('15m'),
      limit: z.number().int().min(1).max(1000).default(100),
      no_cache: z.boolean().optional().describe('Bypass the local cache'),
    },
    async ({ symbol, granularity, limit, no_cache }) => {
      const key = `candles:${symbol}:${granularity}:${limit}`;
      if (!no_cache && candlesCache.has(key)) {
        return jsonResult(candlesCache.get(key));
      }
      const candles = await bitget.getCandles(symbol, granularity, limit);
      candlesCache.set(key, candles);
      return jsonResult(candles);
    },
  );

  /* ---------- get_ticker ---------- */
  server.tool(
    'get_ticker',
    'Get the latest 24h ticker for a Bitget spot symbol.',
    {
      symbol: z.string().describe('Bitget spot symbol, e.g. ETHUSDT'),
      no_cache: z.boolean().optional(),
    },
    async ({ symbol, no_cache }) => {
      const key = `ticker:${symbol}`;
      if (!no_cache && tickerCache.has(key)) {
        return jsonResult(tickerCache.get(key));
      }
      const ticker = await bitget.getTicker(symbol);
      tickerCache.set(key, ticker);
      return jsonResult(ticker);
    },
  );

  /* ---------- get_orderbook ---------- */
  server.tool(
    'get_orderbook',
    'Get the current L2 orderbook for a Bitget spot symbol.',
    {
      symbol: z.string().describe('Bitget spot symbol, e.g. BTCUSDT'),
      limit: z.number().int().min(1).max(100).default(20),
      no_cache: z.boolean().optional(),
    },
    async ({ symbol, limit, no_cache }) => {
      const key = `ob:${symbol}:${limit}`;
      if (!no_cache && orderbookCache.has(key)) {
        return jsonResult(orderbookCache.get(key));
      }
      const ob = await bitget.getOrderbook(symbol, limit);
      orderbookCache.set(key, ob);
      return jsonResult(ob);
    },
  );

  /* ---------- get_symbols ---------- */
  server.tool(
    'get_symbols',
    'List all Bitget spot trading symbols (base/quote pairs and status).',
    {},
    async () => {
      const symbols = await bitget.getSymbols();
      return jsonResult({ count: symbols.length, symbols });
    },
  );

  /* ---------- get_signal ---------- */
  server.tool(
    'get_signal',
    'Compute a composite trading signal (RSI14, EMA9/21 cross, MACD12/26/9) from recent candles.',
    {
      symbol: z.string().describe('Bitget spot symbol, e.g. SOLUSDT'),
      granularity: z
        .enum(['1m', '5m', '15m', '30m', '1h', '4h', '12h', '1d', '1w'])
        .default('15m'),
      limit: z.number().int().min(35).max(500).default(100),
    },
    async ({ symbol, granularity, limit }) => {
      const candles = await bitget.getCandles(symbol, granularity, limit);
      const signal = deriveSignal(candles);
      return jsonResult({ symbol, granularity, candles: candles.length, signal });
    },
  );

  /* ---------- get_sol_balance ---------- */
  server.tool(
    'get_sol_balance',
    'Get the native SOL balance for a Solana address (mainnet).',
    {
      address: z.string().describe('Base58 Solana wallet address'),
      rpc_url: z.string().optional().describe('Override the Solana RPC URL'),
    },
    async ({ address, rpc_url }) => {
      const helper = rpc_url ? new SolanaHelper({ rpcUrl: rpc_url }) : solana ?? new SolanaHelper();
      const bal = await helper.getSolBalance(address);
      return jsonResult(bal);
    },
  );

  /* ---------- get_spl_token_balance ---------- */
  server.tool(
    'get_spl_token_balance',
    'Get the SPL token balance (raw + UI) for a wallet / mint pair on Solana mainnet.',
    {
      owner: z.string().describe('Base58 Solana wallet address'),
      mint: z.string().describe('Base58 SPL token mint address'),
      rpc_url: z.string().optional().describe('Override the Solana RPC URL'),
    },
    async ({ owner, mint, rpc_url }) => {
      const helper = rpc_url ? new SolanaHelper({ rpcUrl: rpc_url }) : solana ?? new SolanaHelper();
      const bal = await helper.getSplTokenBalance(owner, mint);
      return jsonResult(bal);
    },
  );

  return server;
}

export function jsonResult(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

export async function startServer(deps: ServerDeps = {}): Promise<void> {
  const server = buildServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep the process alive — MCP over stdio blocks on stdin.
  process.stdin.resume();
}