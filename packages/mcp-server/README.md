# @bitget/mcp-server

A Model Context Protocol (MCP) server that exposes **Bitget spot market data** and a
**composite trading-signal tool** to any MCP-compatible AI agent. Includes optional
**Solana on-chain** read tools (SOL balance, SPL token balance).

> Part of an AI × Crypto Trading Infra submission for the Bitget hackathon.
> The server is designed to be plugged into Claude, GPT, Qwen, or any agent that
> speaks the MCP wire protocol.

---

## Tools

| Tool | Purpose | Key inputs |
|---|---|---|
| `get_candles` | Recent kline (OHLCV) for a spot symbol | `symbol`, `granularity`, `limit` |
| `get_ticker` | Latest 24h ticker (price, change, volume) | `symbol` |
| `get_orderbook` | L2 order book snapshot | `symbol`, `limit` |
| `get_symbols` | All Bitget spot symbols (base/quote, status) | — |
| `get_signal` | RSI(14) + EMA(9/21) + MACD(12/26/9) composite signal | `symbol`, `granularity`, `limit` |
| `get_sol_balance` | Native SOL balance for a Solana address | `address`, `rpc_url?` |
| `get_spl_token_balance` | SPL token balance (raw + UI amount) | `owner`, `mint`, `rpc_url?` |

All inputs are validated with **zod**; all outputs are JSON. Public Bitget v2 endpoints
are used for the market data — no auth required.

---

## Quick start

```bash
# 1. install
cd packages/mcp-server
npm install

# 2. build
npm run build

# 3. start (stdio transport — wire to your MCP client)
npm start

# 4. (optional) run a smoke test against the live server
npm run example
```

### Wire it into an MCP client

For Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "bitget": {
      "command": "node",
      "args": ["/abs/path/to/packages/mcp-server/dist/index.js"]
    }
  }
}
```

For a custom client (TypeScript):

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['/abs/path/to/packages/mcp-server/dist/index.js'],
});
const client = new Client({ name: 'my-agent', version: '0.1.0' }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
const { content } = await client.callTool('get_candles', { symbol: 'BTCUSDT', granularity: '1h', limit: 50 });
```

See [`examples/client.ts`](./examples/client.ts) for a full working example.

---

## Tool reference

### `get_candles`

```ts
input: {
  symbol: string;          // e.g. 'BTCUSDT'
  granularity: '1m'|'5m'|'15m'|'30m'|'1h'|'4h'|'12h'|'1d'|'1w';  // default '15m'
  limit: number;           // 1..1000, default 100
  no_cache?: boolean;      // bypass local 30s LRU
}
output: Candle[]  // { ts, open, high, low, close, volume }[]
```

### `get_ticker`

```ts
input: { symbol: string; no_cache?: boolean }
output: { symbol, last, change24h, changePct24h, high24h, low24h, volume24h, ts }
```

### `get_orderbook`

```ts
input: { symbol: string; limit?: number /* 1..100, default 20 */; no_cache?: boolean }
output: { symbol, bids: [price, size][], asks: [price, size][], ts }
```

### `get_symbols`

```ts
input: {}
output: { count: number; symbols: { symbol, base, quote, status }[] }
```

### `get_signal`

```ts
input: {
  symbol: string;
  granularity?: '1m'|'5m'|'15m'|'30m'|'1h'|'4h'|'12h'|'1d'|'1w';
  limit?: number /* 35..500, default 100 */;
}
output: {
  symbol: string;
  granularity: string;
  candles: number;
  signal: {
    side: 'long'|'short'|'none';
    strength: number;          // 0..1
    indicators: {
      rsi14: number;           // 0..100
      ema9: number;
      ema21: number;
      ema_cross: 'bullish'|'bearish'|'none';
      macd: { macd, signal, hist };
    };
  };
}
```

### `get_sol_balance`

```ts
input: { address: string /* base58 */; rpc_url?: string }
output: { address, lamports, sol: number, slot }
```

### `get_spl_token_balance`

```ts
input: { owner: string; mint: string; rpc_url?: string }
output: { owner, mint, amount_raw: string, amount_ui: number, decimals, slot }
```

---

## Design notes

- **Public API only** — no Bitget auth headers; the read endpoints don't need them.
- **Rate limit** — internal token-bucket, default 10 req/sec, 3 retries with exponential
  backoff (see [`src/rate-limit.ts`](./src/rate-limit.ts)).
- **Cache** — 30-second TTL LRU per tool, capped at 200 entries, to spare the upstream
  and keep the agent fast (see [`src/cache.ts`](./src/cache.ts)).
- **Indicators** — RSI(14), EMA(9/21), MACD(12/26/9) computed from the raw candles.
  `get_signal` returns a single `side` decision with a `strength` in `[0,1]`.
- **Solana** — uses a public mainnet RPC by default
  (`https://api.mainnet-beta.solana.com`). Pass `rpc_url` to point at a paid/private
  endpoint.
- **stdio transport** — process stays alive on `process.stdin.resume()` because the
  MCP stdio transport blocks on stdin/stdout.

---

## Tests

```bash
npm test          # vitest run
npm run test:watch
```

The suite covers the Bitget client (with mocked fetch), the rate limiter,
the cache (TTL expiry, capacity), the indicator math (RSI/EMA/MACD), the
signal derivation, and the server tool registration.

---

## Layout

```
src/
  index.ts            # process entrypoint
  server.ts           # McpServer + tool registrations
  bitget-client.ts    # Bitget v2 client (retry + rate limit)
  rate-limit.ts       # token-bucket limiter
  cache.ts            # LRU + TTL
  indicators.ts       # RSI / EMA / MACD math
  signal.ts           # deriveSignal(candles) -> composite signal
  solana.ts           # SolanaHelper (SOL + SPL balances)
tests/                # vitest unit tests
examples/client.ts    # end-to-end smoke test
```
